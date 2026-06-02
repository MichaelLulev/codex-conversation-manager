#!/usr/bin/env python3
"""Local GUI server for reading recovered Codex /side conversations."""

from __future__ import annotations

import argparse
import errno
import json
import mimetypes
import os
import re
import signal
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import asdict
from dataclasses import dataclass
from datetime import datetime
from datetime import timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs
from urllib.parse import quote
from urllib.parse import unquote
from urllib.parse import urlparse
from http.server import BaseHTTPRequestHandler
from http.server import ThreadingHTTPServer


PROJECT_ROOT = Path(__file__).resolve().parent
STATIC_ROOT = PROJECT_ROOT / "static"
ASSET_ROOT = PROJECT_ROOT / "assets"
DEFAULT_CODEX_HOME = Path(os.environ.get("CODEX_HOME", "~/.codex")).expanduser()
SIDE_BOUNDARY_MARKER = "Side conversation boundary."
WEBSOCKET_MARKER = "websocket event:"
MAIN_THREAD_FILTERS = {"all", "with_side", "with_forks", "forked", "with_rollback", "archived"}
SQLITE_OPEN_ATTEMPTS = 5
SQLITE_OPEN_RETRY_SECONDS = 0.08
MAX_EVENT_BLOCK_CHARS = 120000
DUPLICATE_MESSAGE_WINDOW_SECONDS = 0.05
ASK_CODEX_MAX_QUESTION_CHARS = 8000
ASK_CODEX_TIMEOUT_SECONDS = 300
ASK_CODEX_OUTPUT_TAIL_CHARS = 12000
ASK_CODEX_CANCEL_TOMBSTONE_SECONDS = 600
ASK_CODEX_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,120}$")
SESSIONS_SUBDIR = "sessions"
ARCHIVED_SESSIONS_SUBDIR = "archived_sessions"
OMITTED_IMAGE_RESULT_LABEL = "(base64 image result omitted; saved path/status is shown when available)"
TURN_ABORTED_GUIDANCE = (
    "The user interrupted the previous turn on purpose. Any running unified exec "
    "processes may still be running in the background. If any tools/commands were "
    "aborted, they may have partially executed."
)
TURN_ABORTED_MARKER_TEXT = f"<turn_aborted>\n{TURN_ABORTED_GUIDANCE}\n</turn_aborted>"
MAIN_THREAD_SELECT_COLUMNS = """
    id, rollout_path, created_at, updated_at, title, first_user_message,
    cwd, model, cli_version, archived, archived_at, source, model_provider,
    sandbox_policy, approval_mode, tokens_used, has_user_event, git_sha,
    git_branch, git_origin_url, agent_nickname, agent_role, memory_mode,
    reasoning_effort, agent_path, created_at_ms, updated_at_ms, thread_source
"""


@dataclass
class Message:
    role: str
    text: str
    timestamp: int | float | None
    time: str | None
    source: str
    phase: str | None = None
    item_id: str | None = None
    line_number: int | None = None
    rolled_back: bool = False
    rolled_back_at: str | None = None
    rolled_back_by_timestamp: int | float | None = None
    rollback_group: str | None = None
    rollback_turns: int | None = None


@dataclass
class SideThreadSummary:
    id: str
    started_at: int | None
    ended_at: int | None
    started: str | None
    ended: str | None
    log_rows: int
    user_count: int
    assistant_count: int
    message_count: int
    preview: str
    cwd: str | None
    model: str | None
    app_version: str | None
    has_persisted_thread: bool
    parent_thread_id: str | None = None
    kind: str = "side"
    meta_label: str = ""
    search_match: str | None = None


@dataclass
class CompactionCheckpoint:
    ordinal: int
    line_number: int
    copy_line_count: int
    timestamp: int | float | None
    time: str | None
    kind: str
    label: str
    summary: str
    message_index: int | None = None


@dataclass
class RollbackCheckpoint:
    ordinal: int
    line_number: int
    copy_line_count: int
    timestamp: int | float | None
    time: str | None
    rollback_turns: int | None
    summary: str
    message_index: int | None = None


@dataclass
class MainThreadSummary:
    id: str
    started_at: int | None
    ended_at: int | None
    updated_at: int | None
    started: str | None
    ended: str | None
    updated: str | None
    user_count: int
    assistant_count: int
    message_count: int
    preview: str
    cwd: str | None
    model: str | None
    app_version: str | None
    archived: bool
    source: str | None
    rollout_path: str | None
    parent_thread_id: str | None = None
    agent_nickname: str | None = None
    agent_role: str | None = None
    has_persisted_thread: bool = True
    kind: str = "main"
    meta_label: str = ""
    search_match: str | None = None


@dataclass
class ArchiveCandidate:
    thread_id: str
    source_path: Path
    archived_path: Path
    before_stat: os.stat_result


@dataclass
class AskCodexProcessState:
    process: subprocess.Popen[str] | None = None
    cancelled: bool = False


ASK_CODEX_PROCESS_LOCK = threading.Lock()
ASK_CODEX_PROCESS_BY_ID: dict[str, AskCodexProcessState] = {}
ASK_CODEX_CANCELLED_AT: dict[str, float] = {}


class AskCodexCancelled(RuntimeError):
    pass


def local_time(ts: int | float | None) -> str | None:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts).astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")


def timestamp_from_iso(value: Any) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def utc_timestamp_ms(value: datetime | None = None) -> str:
    dt = value or datetime.now(timezone.utc)
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def new_thread_id() -> str:
    uuid7 = getattr(uuid, "uuid7", None)
    return str(uuid7() if uuid7 else uuid.uuid4())


def codex_exec_binary() -> str:
    configured = os.environ.get("CODEX_READER_CODEX_BIN") or os.environ.get("CODEX_REAL_COMMAND")
    if configured:
        path = Path(configured).expanduser()
        if path.exists():
            return str(path)
        found = shutil.which(configured)
        if found:
            return found
    local_real = Path.home() / ".npm-global" / "bin" / "codex"
    if local_real.exists():
        return str(local_real)
    found = shutil.which("codex")
    if not found:
        raise FileNotFoundError("codex")
    return found


def trim_text(value: str, max_chars: int) -> tuple[str, bool]:
    if len(value) <= max_chars:
        return value, False
    head_chars = max_chars // 2
    tail_chars = max_chars - head_chars
    omitted = len(value) - max_chars
    trimmed = (
        value[:head_chars].rstrip()
        + f"\n\n[... {omitted} characters omitted from the middle ...]\n\n"
        + value[-tail_chars:].lstrip()
    )
    return trimmed, True


def ask_codex_request_id(payload: dict[str, Any]) -> str:
    value = payload.get("request_id")
    if value is None:
        return new_thread_id()
    if not isinstance(value, str) or not ASK_CODEX_REQUEST_ID_RE.fullmatch(value):
        raise ValueError("Invalid Ask Codex request id")
    return value


def register_ask_codex_request(request_id: str) -> AskCodexProcessState:
    with ASK_CODEX_PROCESS_LOCK:
        purge_ask_codex_cancel_tombstones_locked()
        if request_id in ASK_CODEX_PROCESS_BY_ID:
            raise ValueError("Ask Codex request id is already active")
        state = AskCodexProcessState(cancelled=request_id in ASK_CODEX_CANCELLED_AT)
        ASK_CODEX_CANCELLED_AT.pop(request_id, None)
        ASK_CODEX_PROCESS_BY_ID[request_id] = state
        return state


def attach_ask_codex_process(
    request_id: str,
    state: AskCodexProcessState,
    process: subprocess.Popen[str],
) -> bool:
    with ASK_CODEX_PROCESS_LOCK:
        current = ASK_CODEX_PROCESS_BY_ID.get(request_id)
        if current is not state:
            return True
        state.process = process
        return state.cancelled


def unregister_ask_codex_request(request_id: str, state: AskCodexProcessState) -> None:
    with ASK_CODEX_PROCESS_LOCK:
        if ASK_CODEX_PROCESS_BY_ID.get(request_id) is state:
            ASK_CODEX_PROCESS_BY_ID.pop(request_id, None)
        ASK_CODEX_CANCELLED_AT.pop(request_id, None)


def cancel_ask_codex_request(request_id: str) -> dict[str, Any]:
    if not ASK_CODEX_REQUEST_ID_RE.fullmatch(request_id):
        raise ValueError("Invalid Ask Codex request id")
    with ASK_CODEX_PROCESS_LOCK:
        purge_ask_codex_cancel_tombstones_locked()
        state = ASK_CODEX_PROCESS_BY_ID.get(request_id)
        if state is None:
            ASK_CODEX_CANCELLED_AT[request_id] = time.monotonic()
            return {
                "request_id": request_id,
                "cancelled": True,
                "process_started": False,
            }
        state.cancelled = True
        process = state.process
    if process is not None:
        request_process_termination(process)
    return {
        "request_id": request_id,
        "cancelled": True,
        "process_started": process is not None,
    }


def purge_ask_codex_cancel_tombstones_locked() -> None:
    cutoff = time.monotonic() - ASK_CODEX_CANCEL_TOMBSTONE_SECONDS
    for request_id, cancelled_at in list(ASK_CODEX_CANCELLED_AT.items()):
        if cancelled_at < cutoff:
            ASK_CODEX_CANCELLED_AT.pop(request_id, None)


def request_process_termination(process: subprocess.Popen[str]) -> None:
    terminate_process_group(process, signal.SIGTERM)
    killer = threading.Thread(
        target=force_kill_process_after_delay,
        args=(process, 2.0),
        daemon=True,
    )
    killer.start()


def force_kill_process_after_delay(process: subprocess.Popen[str], delay_seconds: float) -> None:
    time.sleep(delay_seconds)
    if process.poll() is None:
        terminate_process_group(process, signal.SIGKILL)


def terminate_process_group(process: subprocess.Popen[str], sig: signal.Signals) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, sig)
    except ProcessLookupError:
        return
    except OSError:
        try:
            if sig == signal.SIGKILL:
                process.kill()
            else:
                process.terminate()
        except OSError:
            return


def ask_codex_about_conversation(payload: dict[str, Any], codex_home: Path) -> dict[str, Any]:
    request_id = ask_codex_request_id(payload)
    process_state = register_ask_codex_request(request_id)
    question_value = payload.get("question")
    context_value = payload.get("context")
    try:
        if process_state.cancelled:
            raise AskCodexCancelled("Ask Codex was stopped")
        if not isinstance(question_value, str) or not question_value.strip():
            raise ValueError("Missing question")
        if not isinstance(context_value, str) or not context_value.strip():
            raise ValueError("Missing conversation context")

        question, question_truncated = trim_text(question_value.strip(), ASK_CODEX_MAX_QUESTION_CHARS)
        context = context_value
        context_truncated_server = False
        client_truncated = bool(payload.get("context_truncated"))
        prompt = build_ask_codex_prompt(
            question=question,
            context=context,
            kind=payload.get("kind"),
            thread_id=payload.get("thread_id"),
            title=payload.get("title"),
            context_truncated=client_truncated or context_truncated_server,
        )

        codex_bin = codex_exec_binary()
        env = os.environ.copy()
        env["CODEX_HOME"] = str(codex_home)
        env["NO_COLOR"] = "1"

        with tempfile.TemporaryDirectory(prefix="codex-reader-ask-") as tmp_dir:
            output_path = Path(tmp_dir) / "answer.txt"
            command = [
                codex_bin,
                "exec",
                "--sandbox",
                "read-only",
                "--ephemeral",
                "--color",
                "never",
                "--cd",
                str(PROJECT_ROOT),
                "--output-last-message",
                str(output_path),
                "-",
            ]
            process = subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                cwd=PROJECT_ROOT,
                env=env,
                start_new_session=True,
            )
            if attach_ask_codex_process(request_id, process_state, process):
                request_process_termination(process)
            try:
                stdout, stderr = process.communicate(
                    input=prompt,
                    timeout=ASK_CODEX_TIMEOUT_SECONDS,
                )
            except subprocess.TimeoutExpired as exc:
                request_process_termination(process)
                try:
                    stdout, stderr = process.communicate(timeout=3)
                except subprocess.TimeoutExpired:
                    terminate_process_group(process, signal.SIGKILL)
                    stdout, stderr = process.communicate()
                raise TimeoutError("Codex did not finish before the 5 minute timeout") from exc

            if process_state.cancelled:
                raise AskCodexCancelled("Ask Codex was stopped")

            answer = ""
            if output_path.exists():
                answer = output_path.read_text(encoding="utf-8", errors="replace").strip()
            if not answer:
                answer = (stdout or "").strip()
            if process.returncode != 0:
                details = "\n".join(
                    item.strip()
                    for item in [stderr, stdout]
                    if item and item.strip()
                )
                details = details[-ASK_CODEX_OUTPUT_TAIL_CHARS:] if details else "No output"
                raise RuntimeError(f"Codex failed with exit code {process.returncode}: {details}")
            if not answer:
                raise RuntimeError("Codex finished without an answer")

        return {
            "answer": answer,
            "context_chars": len(context),
            "context_truncated": client_truncated or context_truncated_server,
            "question_truncated": question_truncated,
            "request_id": request_id,
        }
    finally:
        unregister_ask_codex_request(request_id, process_state)


def build_ask_codex_prompt(
    *,
    question: str,
    context: str,
    kind: Any,
    thread_id: Any,
    title: Any,
    context_truncated: bool,
) -> str:
    metadata = [
        f"Conversation type: {kind if isinstance(kind, str) else 'unknown'}",
        f"Thread ID: {thread_id if isinstance(thread_id, str) else 'unknown'}",
        f"Title: {title if isinstance(title, str) and title else 'unknown'}",
        f"Context truncated: {'yes' if context_truncated else 'no'}",
    ]
    return (
        "You are answering a question about a saved Codex conversation compact tagged export.\n"
        "Use only the provided export and metadata. Do not inspect files, run commands, "
        "modify files, browse the web, or infer facts that are not supported by the export.\n"
        "If the export is insufficient, say what is missing. When useful, refer to message "
        "numbers from MSG headers or role headings from the export. In MSG headers, r is role, "
        "stage is assistant stage, t is time, and nav is the GUI scroll target. When a reference should be clickable in "
        "the GUI, use markdown links with the nav target from the MSG header, for example "
        "[message 123](codex-message:123). To link to specific text inside a message, use a "
        "short exact quote as the label and URL-encode it in the text parameter, for example "
        "[quoted text](codex-message:123?text=quoted%20text).\n\n"
        "Question:\n"
        f"{question}\n\n"
        "Conversation metadata:\n"
        + "\n".join(f"- {item}" for item in metadata)
        + "\n\nConversation compact export:\n"
        f"{context}\n"
    )


def parent_thread_id_from_source(source: str | None) -> str | None:
    if not source or "thread_spawn" not in source:
        return None
    try:
        payload = json.loads(source)
    except json.JSONDecodeError:
        return None
    spawn = payload.get("subagent", {}).get("thread_spawn", {})
    parent = spawn.get("parent_thread_id")
    return parent if isinstance(parent, str) else None


def sqlite_readonly_uri(path: Path, *, immutable: bool = False) -> str:
    params = "mode=ro"
    if immutable:
        params += "&immutable=1"
    return f"file:{quote(str(path.expanduser().resolve()), safe='/')}?{params}"


def open_readonly_connection(path: Path, *, immutable: bool = False) -> sqlite3.Connection:
    conn = sqlite3.connect(sqlite_readonly_uri(path, immutable=immutable), uri=True, timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.execute("pragma busy_timeout = 5000")
    conn.execute("pragma query_only = on")
    return conn


def transient_sqlite_open_error(exc: sqlite3.OperationalError) -> bool:
    message = str(exc).lower()
    return (
        "unable to open database file" in message
        or "database is locked" in message
        or "database table is locked" in message
    )


def connect_readonly(path: Path) -> sqlite3.Connection:
    if not path.exists():
        raise FileNotFoundError(path)
    last_error: sqlite3.OperationalError | None = None
    for attempt in range(SQLITE_OPEN_ATTEMPTS):
        try:
            return open_readonly_connection(path)
        except sqlite3.OperationalError as exc:
            last_error = exc
            if not transient_sqlite_open_error(exc):
                raise
            if attempt + 1 < SQLITE_OPEN_ATTEMPTS:
                time.sleep(SQLITE_OPEN_RETRY_SECONDS * (attempt + 1))
    if last_error and "unable to open database file" in str(last_error).lower():
        try:
            return open_readonly_connection(path, immutable=True)
        except sqlite3.OperationalError:
            pass
    if last_error:
        raise last_error
    raise sqlite3.OperationalError(f"unable to open database file: {path}")


def connect_writable(path: Path) -> sqlite3.Connection:
    if not path.exists():
        raise FileNotFoundError(path)
    conn = sqlite3.connect(path, timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.execute("pragma busy_timeout = 5000")
    conn.execute("pragma foreign_keys = on")
    return conn


class SideConversationReader:
    def __init__(self, codex_home: Path = DEFAULT_CODEX_HOME) -> None:
        self.codex_home = codex_home
        self.logs_db = codex_home / "logs_2.sqlite"
        self.state_db = codex_home / "state_5.sqlite"
        self.history_path = codex_home / "history.jsonl"
        self.rollout_rollback_cache: dict[str, tuple[int, int, bool]] = {}
        self.rollout_parent_cache: dict[str, tuple[int, int, str | None]] = {}
        self.rollout_search_text_cache: dict[str, tuple[int, int, str, list[tuple[str, str]]]] = {}

    def status(self) -> dict[str, Any]:
        return {
            "codex_home": str(self.codex_home),
            "logs_db": str(self.logs_db),
            "state_db": str(self.state_db),
            "history_path": str(self.history_path),
            "logs_db_exists": self.logs_db.exists(),
            "state_db_exists": self.state_db.exists(),
            "history_path_exists": self.history_path.exists(),
        }

    def persisted_thread_ids(self) -> set[str]:
        if not self.state_db.exists():
            return set()
        try:
            with connect_readonly(self.state_db) as conn:
                return {row["id"] for row in conn.execute("select id from threads")}
        except sqlite3.Error:
            return set()

    def side_candidates(self) -> list[dict[str, Any]]:
        persisted = self.persisted_thread_ids()
        with connect_readonly(self.logs_db) as conn:
            rows = conn.execute(
                """
                select thread_id, min(ts) as started_at, max(ts) as ended_at, count(*) as log_rows
                     , min(process_uuid) as process_uuid
                from logs
                where thread_id is not null
                  and thread_id != ''
                  and feedback_log_body like ?
                group by thread_id
                order by min(ts) desc
                """,
                (f"%{SIDE_BOUNDARY_MARKER}%",),
            ).fetchall()
        candidates: list[dict[str, Any]] = []
        for row in rows:
            thread_id = row["thread_id"]
            has_persisted_thread = thread_id in persisted
            if has_persisted_thread:
                continue
            candidates.append(
                {
                    "id": thread_id,
                    "started_at": row["started_at"],
                    "ended_at": row["ended_at"],
                    "log_rows": row["log_rows"],
                    "process_uuid": row["process_uuid"],
                    "has_persisted_thread": has_persisted_thread,
                }
            )
        return candidates

    def history_entries(self, thread_ids: set[str] | None = None) -> dict[str, list[Message]]:
        entries: dict[str, list[Message]] = {}
        if not self.history_path.exists():
            return entries
        with self.history_path.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(item, dict):
                    continue
                session_id = item.get("session_id")
                text = item.get("text")
                ts = item.get("ts")
                if not isinstance(session_id, str) or not isinstance(text, str):
                    continue
                if thread_ids is not None and session_id not in thread_ids:
                    continue
                timestamp = int(ts) if isinstance(ts, int | float) else None
                entries.setdefault(session_id, []).append(
                    Message(
                        role="user",
                        text=text,
                        timestamp=timestamp,
                        time=local_time(timestamp),
                        source="history.jsonl",
                    )
                )
        return entries

    def list_threads(self, query: str = "", full_text: bool = False) -> list[SideThreadSummary]:
        normalized_query = normalize_search_query(query)
        candidates = self.side_candidates()
        ids = {candidate["id"] for candidate in candidates}
        history = self.history_entries(ids)
        summaries: list[SideThreadSummary] = []
        for candidate in candidates:
            thread_id = candidate["id"]
            assistant = self.assistant_messages(thread_id)
            messages = self.conversation(thread_id, history.get(thread_id), assistant)
            user_count = sum(1 for message in messages if message.role == "user")
            assistant_count = sum(1 for message in messages if message.role == "assistant")
            preview = self.preview_text(messages)
            metadata = self.thread_metadata(thread_id)
            parent_thread_id = self.side_parent_thread_id(
                thread_id,
                candidate["started_at"],
                metadata.get("cwd"),
                candidate.get("process_uuid"),
            )
            summary = SideThreadSummary(
                id=thread_id,
                started_at=candidate["started_at"],
                ended_at=candidate["ended_at"],
                started=local_time(candidate["started_at"]),
                ended=local_time(candidate["ended_at"]),
                log_rows=candidate["log_rows"],
                user_count=user_count,
                assistant_count=assistant_count,
                message_count=len(messages),
                preview=preview,
                cwd=metadata.get("cwd"),
                model=metadata.get("model"),
                app_version=metadata.get("app_version"),
                has_persisted_thread=candidate["has_persisted_thread"],
                parent_thread_id=parent_thread_id,
                meta_label=f"{user_count} user, {assistant_count} assistant",
            )
            if normalized_query:
                summary_match = summary_matches_search(summary, normalized_query)
                text_match = (
                    conversation_match_snippet(messages, normalized_query)
                    if full_text and not summary_match
                    else None
                )
                if not summary_match and not text_match:
                    continue
                summary.search_match = text_match
            summaries.append(summary)
        return summaries

    def get_thread(self, thread_id: str) -> dict[str, Any]:
        candidates = {item["id"]: item for item in self.side_candidates()}
        if thread_id not in candidates:
            raise KeyError(thread_id)
        candidate = candidates[thread_id]
        history = self.history_entries({thread_id}).get(thread_id, [])
        assistant = self.assistant_messages(thread_id)
        messages = self.conversation(thread_id, history, assistant)
        metadata = self.thread_metadata(thread_id)
        user_count = sum(1 for message in messages if message.role == "user")
        assistant_count = sum(1 for message in messages if message.role == "assistant")
        parent_thread_id = self.side_parent_thread_id(
            thread_id,
            candidate["started_at"],
            metadata.get("cwd"),
            candidate.get("process_uuid"),
        )
        summary = SideThreadSummary(
            id=thread_id,
            started_at=candidate["started_at"],
            ended_at=candidate["ended_at"],
            started=local_time(candidate["started_at"]),
            ended=local_time(candidate["ended_at"]),
            log_rows=candidate["log_rows"],
            user_count=user_count,
            assistant_count=assistant_count,
            message_count=len(messages),
            preview=self.preview_text(messages),
            cwd=metadata.get("cwd"),
            model=metadata.get("model"),
            app_version=metadata.get("app_version"),
            has_persisted_thread=candidate["has_persisted_thread"],
            parent_thread_id=parent_thread_id,
            meta_label=f"{user_count} user, {assistant_count} assistant",
        )
        return {
            "summary": asdict(summary),
            "metadata": metadata,
            "messages": [asdict(message) for message in messages],
            "related": self.related_for_side_thread(thread_id, parent_thread_id),
            "recovery_note": (
                "Recovered from Codex diagnostic logs and prompt history. "
                "This is not a normal resumable Codex transcript."
            ),
        }

    def list_main_threads(
        self, list_filter: str = "all", query: str = "", full_text: bool = False
    ) -> list[MainThreadSummary]:
        normalized_query = normalize_search_query(query)
        normalized_filter = list_filter if list_filter in MAIN_THREAD_FILTERS else "all"
        archived_filter = normalized_filter == "archived"
        rows = self.main_thread_rows(archived=archived_filter)
        if normalized_filter == "with_side":
            parent_ids = {
                item.parent_thread_id
                for item in self.list_threads()
                if item.parent_thread_id
            }
            rows = [row for row in rows if row["id"] in parent_ids]
        elif normalized_filter == "with_forks":
            parent_ids = {
                parent
                for row in rows
                if (parent := self.main_parent_thread_id(row))
            }
            rows = [row for row in rows if row["id"] in parent_ids]
        elif normalized_filter == "forked":
            rows = [
                row
                for row in rows
                if self.main_parent_thread_id(row) is not None
            ]
        elif normalized_filter == "with_rollback":
            rows = [row for row in rows if self.rollout_has_rollback(row["rollout_path"])]
        summaries: list[MainThreadSummary] = []
        for row in rows:
            summary = self.main_summary_from_row(row)
            if normalized_query:
                summary_match = summary_matches_search(summary, normalized_query)
                text_match = (
                    self.main_thread_match_snippet(row, normalized_query)
                    if full_text and not summary_match
                    else None
                )
                if not summary_match and not text_match:
                    continue
                summary.search_match = text_match
            summaries.append(summary)
        return summaries

    def main_thread_match_snippet(self, row: sqlite3.Row, normalized_query: str) -> str | None:
        lower_text, entries = self.rollout_search_index(row["rollout_path"])
        if normalized_query not in lower_text:
            return None
        return search_indexed_text_match_snippet(entries, normalized_query)

    def rollout_has_rollback(self, rollout_path: str | None) -> bool:
        if not rollout_path:
            return False
        path = Path(rollout_path).expanduser()
        try:
            stat = path.stat()
        except OSError:
            return False

        cache_key = str(path)
        cached = self.rollout_rollback_cache.get(cache_key)
        if cached and cached[0] == stat.st_mtime_ns and cached[1] == stat.st_size:
            return cached[2]

        has_rollback = False
        try:
            with path.open("r", encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    if "thread_rolled_back" in line:
                        has_rollback = True
                        break
        except OSError:
            has_rollback = False
        self.rollout_rollback_cache[cache_key] = (stat.st_mtime_ns, stat.st_size, has_rollback)
        return has_rollback

    def rollout_forked_from_id(self, rollout_path: str | None) -> str | None:
        if not rollout_path:
            return None
        path = Path(rollout_path).expanduser()
        try:
            stat = path.stat()
        except OSError:
            return None

        cache_key = str(path)
        cached = self.rollout_parent_cache.get(cache_key)
        if cached and cached[0] == stat.st_mtime_ns and cached[1] == stat.st_size:
            return cached[2]

        parent_thread_id: str | None = None
        try:
            with path.open("r", encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    if '"session_meta"' not in line:
                        continue
                    try:
                        item = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if item.get("type") != "session_meta":
                        continue
                    payload = item.get("payload")
                    if not isinstance(payload, dict):
                        break
                    forked_from_id = payload.get("forked_from_id")
                    if isinstance(forked_from_id, str) and forked_from_id:
                        parent_thread_id = forked_from_id
                    break
        except OSError:
            parent_thread_id = None
        self.rollout_parent_cache[cache_key] = (stat.st_mtime_ns, stat.st_size, parent_thread_id)
        return parent_thread_id

    def rollout_compaction_checkpoints(
        self, rollout_path: str | None
    ) -> list[CompactionCheckpoint]:
        if not rollout_path:
            return []
        path = Path(rollout_path).expanduser()
        if not path.exists():
            return []

        checkpoints: list[CompactionCheckpoint] = []
        last_compacted_line: int | None = None
        try:
            with path.open("r", encoding="utf-8", errors="replace") as handle:
                for line_number, line in enumerate(handle, start=1):
                    stripped = line.strip()
                    if not stripped or "compacted" not in stripped:
                        continue
                    try:
                        item = json.loads(stripped)
                    except json.JSONDecodeError:
                        continue
                    payload = item.get("payload")
                    if not isinstance(payload, dict):
                        continue
                    item_type = item.get("type")
                    kind: str | None = None
                    if item_type == "compacted":
                        kind = "compacted"
                        last_compacted_line = line_number
                    elif (
                        item_type == "event_msg"
                        and payload.get("type") == "context_compacted"
                    ):
                        if (
                            last_compacted_line is not None
                            and line_number - last_compacted_line <= 8
                        ):
                            continue
                        kind = "context_compacted"
                    if kind is None:
                        continue
                    timestamp = timestamp_from_iso(item.get("timestamp"))
                    checkpoints.append(
                        CompactionCheckpoint(
                            ordinal=len(checkpoints) + 1,
                            line_number=line_number,
                            copy_line_count=line_number - 1,
                            timestamp=timestamp,
                            time=local_time(timestamp),
                            kind=kind,
                            label=(
                                "Compacted summary"
                                if kind == "compacted"
                                else "Compaction event"
                            ),
                            summary=compaction_checkpoint_summary(payload, kind),
                        )
                    )
        except OSError:
            return []
        return checkpoints

    def rollout_rollback_checkpoints(
        self, rollout_path: str | None
    ) -> list[RollbackCheckpoint]:
        if not rollout_path:
            return []
        path = Path(rollout_path).expanduser()
        if not path.exists():
            return []

        checkpoints: list[RollbackCheckpoint] = []
        try:
            with path.open("r", encoding="utf-8", errors="replace") as handle:
                for line_number, line in enumerate(handle, start=1):
                    stripped = line.strip()
                    if not stripped or "thread_rolled_back" not in stripped:
                        continue
                    try:
                        item = json.loads(stripped)
                    except json.JSONDecodeError:
                        continue
                    payload = item.get("payload")
                    if (
                        item.get("type") != "event_msg"
                        or not isinstance(payload, dict)
                        or payload.get("type") != "thread_rolled_back"
                    ):
                        continue
                    rollback_turns_value = payload.get("num_turns")
                    rollback_turns = (
                        int(rollback_turns_value)
                        if isinstance(rollback_turns_value, int | float)
                        else None
                    )
                    timestamp = timestamp_from_iso(item.get("timestamp"))
                    count = rollback_turns if rollback_turns is not None else "unknown"
                    turn_label = "turn" if rollback_turns == 1 else "turns"
                    checkpoints.append(
                        RollbackCheckpoint(
                            ordinal=len(checkpoints) + 1,
                            line_number=line_number,
                            copy_line_count=line_number - 1,
                            timestamp=timestamp,
                            time=local_time(timestamp),
                            rollback_turns=rollback_turns,
                            summary=f"Rolled back {count} {turn_label}",
                        )
                    )
        except OSError:
            return []
        return checkpoints

    def attach_compaction_message_indexes(
        self, checkpoints: list[CompactionCheckpoint], messages: list[Message]
    ) -> None:
        used: set[int] = set()
        for checkpoint in checkpoints:
            for index, message in enumerate(messages):
                if index in used or message.role != "event" or message.phase != "compaction":
                    continue
                if checkpoint.timestamp is not None and message.timestamp is not None:
                    if abs(float(message.timestamp) - float(checkpoint.timestamp)) > 0.001:
                        continue
                checkpoint.message_index = index
                used.add(index)
                break

    def attach_rollback_message_indexes(
        self, checkpoints: list[RollbackCheckpoint], messages: list[Message]
    ) -> None:
        used: set[int] = set()
        for checkpoint in checkpoints:
            for index, message in enumerate(messages):
                if index in used or message.role != "event" or message.phase != "rollback":
                    continue
                if checkpoint.timestamp is not None and message.timestamp is not None:
                    if abs(float(message.timestamp) - float(checkpoint.timestamp)) > 0.001:
                        continue
                checkpoint.message_index = index
                used.add(index)
                break

    def main_parent_thread_id(self, row: sqlite3.Row) -> str | None:
        return parent_thread_id_from_source(row["source"]) or self.rollout_forked_from_id(row["rollout_path"])

    def main_thread_rows(self, archived: bool = False) -> list[sqlite3.Row]:
        with connect_readonly(self.state_db) as conn:
            return conn.execute(
                f"""
                select {MAIN_THREAD_SELECT_COLUMNS}
                from threads
                where archived = ?
                order by coalesce(updated_at_ms, updated_at * 1000) desc, id desc
                """,
                (1 if archived else 0,),
            ).fetchall()

    def get_main_thread(self, thread_id: str) -> dict[str, Any]:
        row = self.main_thread_row(thread_id)
        messages = self.rollout_messages(row["rollout_path"])
        compactions = self.rollout_compaction_checkpoints(row["rollout_path"])
        rollbacks = self.rollout_rollback_checkpoints(row["rollout_path"])
        messages.append(thread_metadata_message(row))
        messages.extend(self.response_metadata_messages(thread_id))
        messages = finalize_messages(messages)
        self.attach_compaction_message_indexes(compactions, messages)
        self.attach_rollback_message_indexes(rollbacks, messages)
        summary = self.main_summary_from_row(row, messages)
        return {
            "summary": asdict(summary),
            "metadata": {
                "cwd": row["cwd"],
                "model": row["model"],
                "app_version": row["cli_version"],
                "source": row["source"],
                "rollout_path": row["rollout_path"],
                "model_provider": row["model_provider"],
                "reasoning_effort": row["reasoning_effort"],
                "sandbox_policy": row["sandbox_policy"],
                "approval_mode": row["approval_mode"],
                "memory_mode": row["memory_mode"],
                "git_branch": row["git_branch"],
                "git_sha": row["git_sha"],
                "git_origin_url": row["git_origin_url"],
            },
            "messages": [asdict(message) for message in messages],
            "compactions": [asdict(checkpoint) for checkpoint in compactions],
            "rollbacks": [asdict(checkpoint) for checkpoint in rollbacks],
            "related": self.related_for_main_thread(thread_id),
            "recovery_note": "Read from Codex's saved rollout transcript for this persisted session.",
        }

    def search_thread(
        self,
        kind: str,
        thread_id: str,
        query: str,
        filters: set[str] | None = None,
    ) -> dict[str, Any]:
        normalized_query = query.strip()
        if not normalized_query:
            return {"matchGroups": [], "totalMatches": 0}

        if kind == "main":
            row = self.main_thread_row(thread_id)
            messages = self.rollout_messages(row["rollout_path"])
            messages.append(thread_metadata_message(row))
            messages.extend(self.response_metadata_messages(thread_id))
            messages = finalize_messages(messages)
        else:
            candidates = {item["id"]: item for item in self.side_candidates()}
            if thread_id not in candidates:
                raise KeyError(thread_id)
            history = self.history_entries({thread_id}).get(thread_id, [])
            messages = self.conversation(thread_id, history, self.assistant_messages(thread_id))

        lower_query = normalized_query.lower()
        match_groups: list[dict[str, int]] = []
        total_matches = 0
        for index, message in enumerate(messages):
            if filters is not None and message_filter_key(message) not in filters:
                continue
            count = count_occurrences(message.text.lower(), lower_query)
            if count > 0:
                match_groups.append({"messageIndex": index, "count": count})
                total_matches += count
        return {"matchGroups": match_groups, "totalMatches": total_matches}

    def main_thread_row(self, thread_id: str) -> sqlite3.Row:
        with connect_readonly(self.state_db) as conn:
            row = conn.execute(
                f"""
                select {MAIN_THREAD_SELECT_COLUMNS}
                from threads
                where id = ?
                """,
                (thread_id,),
            ).fetchone()
        if row is None:
            raise KeyError(thread_id)
        return row

    def create_fork_before_compaction(
        self, thread_id: str, line_number: int
    ) -> dict[str, Any]:
        row = self.main_thread_row(thread_id)
        rollout_path = row["rollout_path"]
        if not rollout_path:
            raise ValueError("Conversation does not have a rollout path")
        source_path = Path(rollout_path).expanduser()
        if not source_path.exists():
            raise FileNotFoundError(source_path)

        checkpoints = self.rollout_compaction_checkpoints(rollout_path)
        checkpoint = next(
            (item for item in checkpoints if item.line_number == line_number),
            None,
        )
        if checkpoint is None:
            raise ValueError("Compaction checkpoint was not found in this conversation")
        if checkpoint.copy_line_count <= 0:
            raise ValueError("Cannot fork before the first rollout line")

        fork = self.create_synthetic_fork(
            row=row,
            source_thread_id=thread_id,
            source_path=source_path,
            prefix_line_count=checkpoint.copy_line_count,
            checkpoint=checkpoint,
        )
        fork["checkpoint"] = asdict(checkpoint)
        return fork

    def create_fork_before_rollback(
        self, thread_id: str, line_number: int
    ) -> dict[str, Any]:
        row = self.main_thread_row(thread_id)
        rollout_path = row["rollout_path"]
        if not rollout_path:
            raise ValueError("Conversation does not have a rollout path")
        source_path = Path(rollout_path).expanduser()
        if not source_path.exists():
            raise FileNotFoundError(source_path)

        checkpoints = self.rollout_rollback_checkpoints(rollout_path)
        checkpoint = next(
            (item for item in checkpoints if item.line_number == line_number),
            None,
        )
        if checkpoint is None:
            raise ValueError("Rollback marker was not found in this conversation")
        if checkpoint.copy_line_count <= 0:
            raise ValueError("Cannot fork before the first rollout line")

        fork = self.create_synthetic_fork(
            row=row,
            source_thread_id=thread_id,
            source_path=source_path,
            prefix_line_count=checkpoint.copy_line_count,
            checkpoint=checkpoint,
            title=fork_title_from_source(row, "Undo rollback"),
        )
        fork["rollback"] = asdict(checkpoint)
        return fork

    def create_fork_from_message(
        self, thread_id: str, line_number: int
    ) -> dict[str, Any]:
        row = self.main_thread_row(thread_id)
        rollout_path = row["rollout_path"]
        if not rollout_path:
            raise ValueError("Conversation does not have a rollout path")
        source_path = Path(rollout_path).expanduser()
        if not source_path.exists():
            raise FileNotFoundError(source_path)

        before_stat = source_path.stat()
        messages = self.rollout_messages(rollout_path)
        if source_stat_changed(before_stat, source_path.stat()):
            raise ValueError("Conversation changed while preparing fork; refresh and try again")
        target = next((item for item in messages if item.line_number == line_number), None)
        if target is None:
            raise ValueError("Target message was not found in this conversation")
        if target.role != "user":
            raise ValueError("Forks from a message can only target a user message")

        if line_number <= 0:
            raise ValueError("Cannot fork before the first rollout line")

        fork = self.create_synthetic_fork(
            row=row,
            source_thread_id=thread_id,
            source_path=source_path,
            prefix_line_count=line_number,
            title=fork_title_from_message(target),
        )
        fork["line_number"] = line_number
        fork["target"] = asdict(target)
        return fork

    def create_synthetic_fork(
        self,
        *,
        row: sqlite3.Row,
        source_thread_id: str,
        source_path: Path,
        prefix_line_count: int,
        checkpoint: CompactionCheckpoint | RollbackCheckpoint | None = None,
        title: str | None = None,
    ) -> dict[str, Any]:
        if prefix_line_count <= 0:
            raise ValueError("Cannot fork before the first rollout line")

        before_stat = source_path.stat()
        lines = source_path.read_text(encoding="utf-8", errors="replace").splitlines(True)
        if source_stat_changed(before_stat, source_path.stat()):
            raise ValueError("Conversation changed while preparing fork; refresh and try again")
        if prefix_line_count > len(lines):
            raise ValueError("Fork point is outside the rollout file")

        source_session_meta = first_session_meta_line(lines)
        if source_session_meta is None:
            raise ValueError("Source rollout does not contain session metadata")

        created_at = datetime.now(timezone.utc)
        timestamp = utc_timestamp_ms(created_at)
        fork_id = new_thread_id()
        new_path = self.new_rollout_path(fork_id, created_at)
        new_meta_line = synthetic_fork_session_meta_line(
            source_session_meta,
            source_thread_id=source_thread_id,
            fork_thread_id=fork_id,
            timestamp=timestamp,
            row=row,
        )
        copied_lines = strip_leading_session_meta(lines[:prefix_line_count])
        copied_lines, interrupted_boundary_added = append_interrupted_boundary_if_needed(
            copied_lines,
            timestamp,
        )
        self.write_synthetic_rollout(new_path, new_meta_line, copied_lines, fork_id)

        backup_path: str | None = None
        try:
            backup_path = str(self.backup_state_db())
            self.insert_synthetic_thread_row(
                source_thread_id=source_thread_id,
                fork_thread_id=fork_id,
                rollout_path=new_path,
                created_at=created_at,
                checkpoint=checkpoint,
                prefix_lines=copied_lines,
                title=title,
            )
        except Exception:
            try:
                new_path.unlink()
            except OSError:
                pass
            raise

        self.rollout_parent_cache.pop(str(new_path), None)
        return {
            "id": fork_id,
            "parent_thread_id": source_thread_id,
            "rollout_path": str(new_path),
            "resume_command": f"codex resume {fork_id}",
            "state_db_backup": backup_path,
            "interrupted_boundary_added": interrupted_boundary_added,
        }

    def create_rollback_to_message(
        self, thread_id: str, line_number: int
    ) -> dict[str, Any]:
        row = self.main_thread_row(thread_id)
        rollout_path = row["rollout_path"]
        if not rollout_path:
            raise ValueError("Conversation does not have a rollout path")
        source_path = Path(rollout_path).expanduser()
        if not source_path.exists():
            raise FileNotFoundError(source_path)

        before_stat = source_path.stat()
        messages = self.rollout_messages(rollout_path)
        target = next((item for item in messages if item.line_number == line_number), None)
        if target is None:
            raise ValueError("Target message was not found in this conversation")
        if target.role != "user":
            raise ValueError("Rollbacks can only target a user message")
        if target.rolled_back:
            raise ValueError("Target message is already inside a rollback")

        later_active_user_turns = [
            message
            for message in messages
            if (
                message.role == "user"
                and not message.rolled_back
                and message.line_number is not None
                and message.line_number > line_number
            )
        ]
        rollback_turns = len(later_active_user_turns)
        if rollback_turns <= 0:
            raise ValueError("There are no later active user turns to roll back")

        current_stat = source_path.stat()
        if (
            current_stat.st_mtime_ns != before_stat.st_mtime_ns
            or current_stat.st_size != before_stat.st_size
        ):
            raise ValueError("Conversation changed while preparing rollback; refresh and try again")

        created_at = datetime.now(timezone.utc)
        timestamp = utc_timestamp_ms(created_at)
        state_backup_path = str(self.backup_state_db())
        rollout_backup_path = str(self.backup_rollout_file(source_path))

        current_stat = source_path.stat()
        if (
            current_stat.st_mtime_ns != before_stat.st_mtime_ns
            or current_stat.st_size != before_stat.st_size
        ):
            raise ValueError("Conversation changed while preparing rollback; refresh and try again")

        marker = rollback_event_line(timestamp, rollback_turns)
        with source_path.open("a", encoding="utf-8") as handle:
            handle.write(marker)
            handle.flush()
            os.fsync(handle.fileno())

        state_update_error: str | None = None
        try:
            self.mark_thread_updated(thread_id, created_at)
        except sqlite3.Error as exc:
            state_update_error = str(exc)

        self.rollout_rollback_cache.pop(str(source_path), None)
        return {
            "thread_id": thread_id,
            "line_number": line_number,
            "rollback_turns": rollback_turns,
            "timestamp": timestamp,
            "time": local_time(created_at.timestamp()),
            "rollout_path": str(source_path),
            "rollout_backup": rollout_backup_path,
            "state_db_backup": state_backup_path,
            "state_update_error": state_update_error,
        }

    def archive_main_thread(
        self,
        thread_id: str,
        expected_rollout_path: str | None = None,
    ) -> dict[str, Any]:
        row = self.main_thread_row(thread_id)
        if bool(row["archived"]):
            raise ValueError("Conversation is already archived")
        root_candidate = self.archive_candidate_from_row(row, expected_rollout_path)

        descendant_errors: list[dict[str, str]] = []
        descendant_candidates: list[ArchiveCandidate] = []
        seen_thread_ids = {thread_id}
        for descendant_id in self.thread_spawn_descendant_ids(thread_id):
            if descendant_id in seen_thread_ids:
                continue
            seen_thread_ids.add(descendant_id)
            try:
                descendant_row = self.main_thread_row(descendant_id)
            except (KeyError, sqlite3.Error) as exc:
                descendant_errors.append(self.archive_descendant_error(descendant_id, exc))
                continue
            if bool(descendant_row["archived"]):
                continue
            try:
                descendant_candidates.append(self.archive_candidate_from_row(descendant_row))
            except (OSError, ValueError) as exc:
                descendant_errors.append(self.archive_descendant_error(descendant_id, exc))

        candidates = [root_candidate]
        for candidate in descendant_candidates:
            try:
                if source_stat_changed(candidate.before_stat, candidate.source_path.stat()):
                    raise ValueError("Conversation changed while preparing archive")
                candidates.append(candidate)
            except (OSError, ValueError) as exc:
                descendant_errors.append(self.archive_descendant_error(candidate.thread_id, exc))

        if source_stat_changed(root_candidate.before_stat, root_candidate.source_path.stat()):
            raise ValueError("Conversation changed while preparing archive; refresh and try again")
        backup_path = str(self.backup_state_db())

        archived_at = datetime.now(timezone.utc)
        archived_threads: list[dict[str, str | bool | int | None]] = []
        archive_order = [root_candidate, *reversed(candidates[1:])]
        for candidate in archive_order:
            try:
                archived_threads.append(self.archive_candidate(candidate, archived_at))
            except (OSError, sqlite3.Error, KeyError, ValueError) as exc:
                if candidate.thread_id == thread_id:
                    raise
                descendant_errors.append(self.archive_descendant_error(candidate.thread_id, exc))

        return {
            "id": thread_id,
            "archived": True,
            "rollout_path": str(root_candidate.archived_path),
            "previous_rollout_path": str(root_candidate.source_path),
            "archived_at": int(archived_at.timestamp()),
            "archived_time": local_time(archived_at.timestamp()),
            "archived_threads": archived_threads,
            "archived_count": len(archived_threads),
            "descendant_errors": descendant_errors,
            "state_db_backup": backup_path,
        }

    def archive_candidate_from_row(
        self,
        row: sqlite3.Row,
        expected_rollout_path: str | None = None,
    ) -> ArchiveCandidate:
        thread_id = row["id"]
        rollout_path = row["rollout_path"]
        if not rollout_path:
            raise ValueError("Conversation does not have a rollout path")

        source_path = Path(rollout_path).expanduser()
        if expected_rollout_path:
            expected_path = Path(expected_rollout_path).expanduser()
            if expected_path.resolve() != source_path.resolve():
                raise ValueError("Conversation rollout path changed; refresh and try again")
        if not source_path.exists():
            raise FileNotFoundError(source_path)

        before_stat = source_path.stat()
        archived_path = self.archive_rollout_path(thread_id, source_path)
        if archived_path.exists():
            raise FileExistsError(archived_path)
        return ArchiveCandidate(
            thread_id=thread_id,
            source_path=source_path,
            archived_path=archived_path,
            before_stat=before_stat,
        )

    def archive_candidate(
        self,
        candidate: ArchiveCandidate,
        archived_at: datetime,
    ) -> dict[str, str | bool | int | None]:
        if source_stat_changed(candidate.before_stat, candidate.source_path.stat()):
            raise ValueError("Conversation changed while preparing archive")
        candidate.archived_path.parent.mkdir(parents=True, exist_ok=True)
        os.rename(candidate.source_path, candidate.archived_path)
        try:
            archived_stat = candidate.archived_path.stat()
            self.mark_thread_archived(
                candidate.thread_id,
                candidate.archived_path,
                archived_at,
                archived_stat,
            )
        except Exception:
            try:
                os.rename(candidate.archived_path, candidate.source_path)
            except OSError:
                pass
            raise

        self.clear_rollout_caches(candidate.source_path)
        self.clear_rollout_caches(candidate.archived_path)
        return {
            "id": candidate.thread_id,
            "archived": True,
            "rollout_path": str(candidate.archived_path),
            "previous_rollout_path": str(candidate.source_path),
            "archived_at": int(archived_at.timestamp()),
            "archived_time": local_time(archived_at.timestamp()),
        }

    def archive_descendant_error(self, thread_id: str, exc: BaseException) -> dict[str, str]:
        return {"id": thread_id, "error": str(exc) or exc.__class__.__name__}

    def thread_spawn_descendant_ids(self, thread_id: str) -> list[str]:
        try:
            with connect_readonly(self.state_db) as conn:
                return [
                    row["child_thread_id"]
                    for row in conn.execute(
                        """
                        with recursive subtree(child_thread_id, depth) as (
                            select child_thread_id, 1
                            from thread_spawn_edges
                            where parent_thread_id = ?
                            union all
                            select edge.child_thread_id, subtree.depth + 1
                            from thread_spawn_edges as edge
                            join subtree on edge.parent_thread_id = subtree.child_thread_id
                        )
                        select child_thread_id
                        from subtree
                        order by depth asc, child_thread_id asc
                        """,
                        (thread_id,),
                    )
                ]
        except sqlite3.Error:
            return []

    def archive_rollout_path(self, thread_id: str, rollout_path: Path) -> Path:
        sessions_root = (self.codex_home / SESSIONS_SUBDIR).resolve()
        canonical_source = rollout_path.resolve()
        try:
            canonical_source.relative_to(sessions_root)
        except ValueError as exc:
            raise ValueError("Only active Codex session rollout files can be archived") from exc

        file_name = rollout_path.name
        if not (
            file_name.startswith("rollout-")
            and file_name.endswith(f"-{thread_id}.jsonl")
        ):
            raise ValueError("Rollout filename does not match the conversation id")
        return self.codex_home / ARCHIVED_SESSIONS_SUBDIR / file_name

    def mark_thread_archived(
        self,
        thread_id: str,
        archived_path: Path,
        archived_at: datetime,
        archived_stat: os.stat_result,
    ) -> None:
        archived_epoch = int(archived_at.timestamp())
        updated_epoch = int(archived_stat.st_mtime)
        updated_millis = archived_stat.st_mtime_ns // 1_000_000
        with connect_writable(self.state_db) as conn:
            result = conn.execute(
                """
                update threads
                set rollout_path = ?,
                    archived = 1,
                    archived_at = ?,
                    updated_at = ?,
                    updated_at_ms = ?
                where id = ?
                """,
                (
                    str(archived_path),
                    archived_epoch,
                    updated_epoch,
                    updated_millis,
                    thread_id,
                ),
            )
            if result.rowcount == 0:
                raise KeyError(thread_id)

    def clear_rollout_caches(self, rollout_path: Path) -> None:
        cache_key = str(rollout_path)
        self.rollout_parent_cache.pop(cache_key, None)
        self.rollout_rollback_cache.pop(cache_key, None)
        self.rollout_search_text_cache.pop(cache_key, None)

    def new_rollout_path(self, thread_id: str, created_at: datetime) -> Path:
        local_created_at = created_at.astimezone()
        directory = (
            self.codex_home
            / SESSIONS_SUBDIR
            / local_created_at.strftime("%Y")
            / local_created_at.strftime("%m")
            / local_created_at.strftime("%d")
        )
        filename = f"rollout-{local_created_at.strftime('%Y-%m-%dT%H-%M-%S')}-{thread_id}.jsonl"
        return directory / filename

    def write_synthetic_rollout(
        self,
        rollout_path: Path,
        session_meta_line: dict[str, Any],
        copied_lines: list[str],
        expected_thread_id: str,
    ) -> None:
        rollout_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = rollout_path.with_name(f".{rollout_path.name}.tmp")
        if rollout_path.exists():
            raise FileExistsError(rollout_path)
        try:
            with temp_path.open("x", encoding="utf-8") as handle:
                handle.write(json.dumps(session_meta_line, ensure_ascii=False, separators=(",", ":")))
                handle.write("\n")
                handle.writelines(copied_lines)
            validate_rollout_jsonl(temp_path, expected_thread_id)
            os.replace(temp_path, rollout_path)
        finally:
            try:
                temp_path.unlink()
            except FileNotFoundError:
                pass

    def backup_rollout_file(self, rollout_path: Path) -> Path:
        backup_name = (
            f"{rollout_path.name}.codex-side-reader-backup-"
            f"{datetime.now().astimezone().strftime('%Y%m%d-%H%M%S-%f')}.jsonl"
        )
        backup_path = rollout_path.with_name(backup_name)
        shutil.copy2(rollout_path, backup_path)
        return backup_path

    def backup_state_db(self) -> Path:
        backup_name = (
            f"{self.state_db.name}.codex-side-reader-backup-"
            f"{datetime.now().astimezone().strftime('%Y%m%d-%H%M%S-%f')}.sqlite"
        )
        backup_path = self.state_db.with_name(backup_name)
        with open_readonly_connection(self.state_db) as source:
            with sqlite3.connect(backup_path) as target:
                source.backup(target)
        return backup_path

    def insert_synthetic_thread_row(
        self,
        *,
        source_thread_id: str,
        fork_thread_id: str,
        rollout_path: Path,
        created_at: datetime,
        checkpoint: CompactionCheckpoint | RollbackCheckpoint | None,
        prefix_lines: list[str],
        title: str | None = None,
    ) -> None:
        epoch_seconds = int(created_at.timestamp())
        epoch_millis = int(created_at.timestamp() * 1000)
        with connect_writable(self.state_db) as conn:
            source = conn.execute(
                "select * from threads where id = ?",
                (source_thread_id,),
            ).fetchone()
            if source is None:
                raise KeyError(source_thread_id)
            columns = [
                item["name"]
                for item in conn.execute("pragma table_info(threads)").fetchall()
            ]
            values = {column: source[column] for column in columns}
            values.update(
                {
                    "id": fork_thread_id,
                    "rollout_path": str(rollout_path),
                    "created_at": epoch_seconds,
                    "updated_at": epoch_seconds,
                    "source": "cli",
                    "thread_source": "user",
                    "title": title or fork_title_from_source(source),
                    "archived": 0,
                    "archived_at": None,
                    "tokens_used": token_count_from_rollout_lines(prefix_lines)
                    or (source["tokens_used"] if "tokens_used" in source.keys() else 0),
                    "agent_nickname": None,
                    "agent_role": None,
                    "agent_path": None,
                    "created_at_ms": epoch_millis,
                    "updated_at_ms": epoch_millis,
                }
            )
            values = {column: values.get(column) for column in columns}
            placeholders = ", ".join("?" for _ in columns)
            column_sql = ", ".join(columns)
            conn.execute(
                f"insert into threads ({column_sql}) values ({placeholders})",
                [values[column] for column in columns],
            )

    def mark_thread_updated(self, thread_id: str, updated_at: datetime) -> None:
        epoch_seconds = int(updated_at.timestamp())
        epoch_millis = int(updated_at.timestamp() * 1000)
        with connect_writable(self.state_db) as conn:
            columns = {
                item["name"]
                for item in conn.execute("pragma table_info(threads)").fetchall()
            }
            assignments: list[str] = []
            params: list[int | str] = []
            if "updated_at" in columns:
                assignments.append("updated_at = ?")
                params.append(epoch_seconds)
            if "updated_at_ms" in columns:
                assignments.append("updated_at_ms = ?")
                params.append(epoch_millis)
            if not assignments:
                return
            params.append(thread_id)
            conn.execute(
                f"update threads set {', '.join(assignments)} where id = ?",
                params,
            )

    def main_summary_from_row(
        self, row: sqlite3.Row, messages: list[Message] | None = None
    ) -> MainThreadSummary:
        user_count = sum(1 for message in messages or [] if message.role == "user")
        assistant_count = sum(1 for message in messages or [] if message.role == "assistant")
        preview_source = row["title"] or row["first_user_message"] or Path(row["rollout_path"]).stem
        source = row["source"] or None
        model = row["model"] or None
        app_version = row["cli_version"] or None
        parent_thread_id = self.main_parent_thread_id(row)
        agent_nickname = row["agent_nickname"] or None
        agent_role = row["agent_role"] or None
        meta_parts = ["fork" if parent_thread_id else "main"]
        if agent_role:
            meta_parts.append(agent_role)
        if agent_nickname:
            meta_parts.append(agent_nickname)
        if source and not parent_thread_id:
            meta_parts.append(source)
        if model:
            meta_parts.append(model)
        elif app_version:
            meta_parts.append(app_version)
        if bool(row["archived"]):
            meta_parts.append("archived")
        return MainThreadSummary(
            id=row["id"],
            started_at=row["created_at"],
            ended_at=row["updated_at"],
            updated_at=row["updated_at"],
            started=local_time(row["created_at"]),
            ended=local_time(row["updated_at"]),
            updated=local_time(row["updated_at"]),
            user_count=user_count,
            assistant_count=assistant_count,
            message_count=len(messages or []),
            preview=compact(preview_source),
            cwd=row["cwd"] or None,
            model=model,
            app_version=app_version,
            archived=bool(row["archived"]),
            source=source,
            rollout_path=row["rollout_path"] or None,
            parent_thread_id=parent_thread_id,
            agent_nickname=agent_nickname,
            agent_role=agent_role,
            meta_label=" | ".join(meta_parts),
        )

    def related_for_main_thread(self, thread_id: str) -> dict[str, Any]:
        parents: list[dict[str, Any]] = []
        try:
            current_row = self.main_thread_row(thread_id)
            parent_thread_id = self.main_parent_thread_id(current_row)
            if parent_thread_id:
                parent_row = self.main_thread_row(parent_thread_id)
                parents.append(asdict(self.main_summary_from_row(parent_row)))
        except KeyError:
            pass
        forks = [asdict(item) for item in self.fork_children(thread_id)]
        side_threads = [
            asdict(item)
            for item in self.list_threads()
            if item.parent_thread_id == thread_id
        ]
        side_threads.sort(key=lambda item: (item["started_at"] or 0, item["id"]))
        return {
            "parents": parents,
            "forks": forks,
            "side": side_threads,
        }

    def related_for_side_thread(
        self, thread_id: str, parent_thread_id: str | None
    ) -> dict[str, Any]:
        parents: list[dict[str, Any]] = []
        if parent_thread_id:
            try:
                parent_row = self.main_thread_row(parent_thread_id)
                parents.append(asdict(self.main_summary_from_row(parent_row)))
            except KeyError:
                pass
        return {
            "parents": parents,
            "forks": [],
            "side": [],
        }

    def fork_children(self, parent_thread_id: str) -> list[MainThreadSummary]:
        child_ids: set[str] = set()
        try:
            with connect_readonly(self.state_db) as conn:
                child_ids.update(
                    row["child_thread_id"]
                    for row in conn.execute(
                        "select child_thread_id from thread_spawn_edges where parent_thread_id = ?",
                        (parent_thread_id,),
                    )
                )
        except sqlite3.Error:
            child_ids = set()

        summaries: list[MainThreadSummary] = []
        seen: set[str] = set()
        for row in self.main_thread_rows():
            if row["id"] in child_ids or self.main_parent_thread_id(row) == parent_thread_id:
                if row["id"] in seen:
                    continue
                seen.add(row["id"])
                summaries.append(self.main_summary_from_row(row))
        summaries.sort(key=lambda item: (item.started_at or 0, item.id))
        return summaries

    def main_rows_by_ids(self, thread_ids: set[str]) -> list[sqlite3.Row]:
        if not thread_ids:
            return []
        placeholders = ",".join("?" for _ in thread_ids)
        with connect_readonly(self.state_db) as conn:
            return conn.execute(
                f"""
                select {MAIN_THREAD_SELECT_COLUMNS}
                from threads
                where id in ({placeholders})
                """,
                tuple(thread_ids),
            ).fetchall()

    def side_parent_thread_id(
        self,
        side_thread_id: str,
        started_at: int | None,
        cwd: str | None,
        process_uuid: str | None,
    ) -> str | None:
        if started_at is None:
            return None
        process_thread_ids = self.thread_ids_for_process(process_uuid, side_thread_id)
        try:
            candidates = self.parent_candidates_for_side(started_at, cwd, process_thread_ids)
            if not candidates and cwd:
                candidates = self.parent_candidates_for_side(started_at, cwd, set())
        except sqlite3.Error:
            return None
        if not candidates:
            return None

        def score(row: sqlite3.Row) -> tuple[int, int, int]:
            cwd_score = 1 if cwd and row["cwd"] == cwd else 0
            process_score = 1 if row["id"] in process_thread_ids else 0
            distance = abs(int(row["updated_at"]) - started_at)
            return (process_score, cwd_score, -distance)

        candidates.sort(key=score, reverse=True)
        return candidates[0]["id"]

    def thread_ids_for_process(self, process_uuid: str | None, side_thread_id: str) -> set[str]:
        if not process_uuid:
            return set()
        try:
            with connect_readonly(self.logs_db) as conn:
                return {
                    row["thread_id"]
                    for row in conn.execute(
                        """
                        select distinct thread_id
                        from logs
                        where process_uuid = ?
                          and thread_id is not null
                          and thread_id != ''
                          and thread_id != ?
                        """,
                        (process_uuid, side_thread_id),
                    )
                }
        except sqlite3.Error:
            return set()

    def parent_candidates_for_side(
        self, started_at: int, cwd: str | None, process_thread_ids: set[str]
    ) -> list[sqlite3.Row]:
        filters = ["created_at <= ?", "updated_at >= ?"]
        params: list[Any] = [started_at, started_at]
        if process_thread_ids:
            placeholders = ",".join("?" for _ in process_thread_ids)
            filters.append(f"id in ({placeholders})")
            params.extend(process_thread_ids)
        elif cwd:
            filters.append("cwd = ?")
            params.append(cwd)
        query = f"""
            select {MAIN_THREAD_SELECT_COLUMNS}
            from threads
            where {' and '.join(filters)}
        """
        with connect_readonly(self.state_db) as conn:
            rows = conn.execute(query, tuple(params)).fetchall()
        if cwd:
            exact = [row for row in rows if row["cwd"] == cwd]
            if exact:
                return exact
        return list(rows)

    def rollout_messages(self, rollout_path: str | None) -> list[Message]:
        if not rollout_path:
            return []
        path = Path(rollout_path).expanduser()
        if not path.exists():
            return []
        messages: list[Message] = []
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for line_number, line in enumerate(handle, start=1):
                line = line.strip()
                if not line:
                    continue
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                message = self.message_from_rollout_event(item)
                if message is not None and message.text.strip():
                    message.line_number = line_number
                    messages.append(message)
        messages = finalize_messages(messages)
        annotate_rolled_back_messages(messages)
        return messages

    def rollout_search_index(self, rollout_path: str | None) -> tuple[str, list[tuple[str, str]]]:
        if not rollout_path:
            return "", []
        path = Path(rollout_path).expanduser()
        try:
            stat = path.stat()
        except OSError:
            return "", []

        cache_key = str(path)
        cached = self.rollout_search_text_cache.get(cache_key)
        if cached and cached[0] == stat.st_mtime_ns and cached[1] == stat.st_size:
            return cached[2], cached[3]

        entries = []
        for message in self.rollout_messages(str(path)):
            if not message.text.strip():
                continue
            display_text = normalize_display_text(message.text)
            entries.append((display_text, display_text.lower()))
        lower_text = "\n".join(entry[1] for entry in entries)
        self.rollout_search_text_cache[cache_key] = (
            stat.st_mtime_ns,
            stat.st_size,
            lower_text,
            entries,
        )
        return lower_text, entries

    def message_from_rollout_event(self, item: dict[str, Any]) -> Message | None:
        payload = item.get("payload")
        if not isinstance(payload, dict):
            return None
        timestamp = timestamp_from_iso(item.get("timestamp"))
        item_type = item.get("type")
        if item_type == "session_meta":
            return session_meta_message(payload, timestamp)
        if item_type == "turn_context":
            return turn_context_message(payload, timestamp)
        if item_type == "compacted":
            return compacted_message(payload, timestamp)
        if item_type == "response_item":
            return message_from_response_item(payload, timestamp, "rollout")
        if item_type != "event_msg":
            return None
        payload_type = payload.get("type")
        if payload_type == "user_message":
            text = user_message_text(payload)
            if not isinstance(text, str):
                return None
            return Message(
                role="user",
                text=text,
                timestamp=timestamp,
                time=local_time(timestamp),
                source="rollout event_msg",
            )
        if payload_type == "agent_message":
            text = payload.get("message")
            if not isinstance(text, str):
                return None
            text = append_memory_citation(text, payload.get("memory_citation"))
            return Message(
                role="assistant",
                text=text,
                timestamp=timestamp,
                time=local_time(timestamp),
                source="rollout event_msg",
                phase=payload.get("phase") if isinstance(payload.get("phase"), str) else None,
            )
        if payload_type == "agent_reasoning":
            text = payload.get("text")
            if not isinstance(text, str):
                return None
            return Message(
                role="thinking",
                text=text,
                timestamp=timestamp,
                time=local_time(timestamp),
                source="rollout agent_reasoning",
            )
        return event_message_from_payload(payload, timestamp)

    def conversation(
        self,
        thread_id: str,
        user_messages: list[Message] | None = None,
        assistant_messages: list[Message] | None = None,
    ) -> list[Message]:
        user_messages = list(user_messages or self.history_entries({thread_id}).get(thread_id, []))
        assistant_messages = list(assistant_messages or self.assistant_messages(thread_id))
        if not user_messages:
            user_messages = self.user_messages_from_submissions(thread_id)
        messages = user_messages + assistant_messages
        return finalize_messages(messages)

    def preview_text(self, messages: list[Message]) -> str:
        for message in messages:
            if message.role == "user" and message.text.strip():
                return compact(message.text)
        for message in messages:
            if message.text.strip():
                return compact(message.text)
        return "(no recovered prompt)"

    def thread_metadata(self, thread_id: str) -> dict[str, str | None]:
        metadata: dict[str, str | None] = {"cwd": None, "model": None, "app_version": None}
        try:
            with connect_readonly(self.logs_db) as conn:
                rows = conn.execute(
                    """
                    select feedback_log_body
                    from logs
                    where thread_id = ?
                    order by ts, ts_nanos
                    limit 80
                    """,
                    (thread_id,),
                ).fetchall()
        except sqlite3.Error:
            return metadata
        for row in rows:
            body = row["feedback_log_body"] or ""
            if metadata["cwd"] is None:
                match = re.search(r'cwd: Some\("((?:\\.|[^"\\])*)"\)', body)
                if match:
                    metadata["cwd"] = unescape_debug_string(match.group(1))
                else:
                    match = re.search(r"\bcwd=([^}: ]+)", body)
                    if match:
                        metadata["cwd"] = match.group(1)
            if metadata["model"] is None:
                match = re.search(r"model(?:=|: Some\()\"?([A-Za-z0-9_.-]+)", body)
                if match:
                    metadata["model"] = match.group(1)
            if metadata["app_version"] is None:
                match = re.search(r'app\.version=([0-9A-Za-z_.-]+)', body)
                if match:
                    metadata["app_version"] = match.group(1)
            if all(metadata.values()):
                break
        return metadata

    def assistant_messages(self, thread_id: str) -> list[Message]:
        try:
            with connect_readonly(self.logs_db) as conn:
                rows = conn.execute(
                    """
                    select ts, feedback_log_body
                    from logs
                    where thread_id = ?
                      and feedback_log_body like ?
                      and (
                        feedback_log_body like '%response.output_item.done%'
                        or feedback_log_body like '%response.output_text.done%'
                        or feedback_log_body like '%response.reasoning_summary_text.done%'
                        or feedback_log_body like '%response.custom_tool_call_input.done%'
                        or feedback_log_body like '%response.completed%'
                        or feedback_log_body like '%codex.rate_limits%'
                      )
                    order by ts, ts_nanos
                    """,
                    (thread_id, f"%{WEBSOCKET_MARKER}%"),
                ).fetchall()
        except sqlite3.Error:
            return []

        by_item_id: dict[str, Message] = {}
        fallback: list[Message] = []
        for row in rows:
            event = parse_websocket_event(row["feedback_log_body"] or "")
            if not event:
                continue
            timestamp = int(row["ts"])
            message = message_from_event(event, timestamp)
            if not message or not message.text.strip():
                continue
            key = message.item_id or f"{message.timestamp}:{message.text}"
            current = by_item_id.get(key)
            if current is None or source_priority(message.source) > source_priority(current.source):
                by_item_id[key] = message
            elif message.item_id is None:
                fallback.append(message)

        messages = list(by_item_id.values()) + fallback
        deduped: list[Message] = []
        seen: set[tuple[str | None, str, int | None]] = set()
        for message in sorted(messages, key=lambda item: (item.timestamp or 0, item.item_id or "")):
            signature = (message.item_id, message.text, message.timestamp)
            loose_signature = (None, message.text, message.timestamp)
            if signature in seen or loose_signature in seen:
                continue
            seen.add(signature)
            deduped.append(message)
        return deduped

    def response_metadata_messages(self, thread_id: str) -> list[Message]:
        try:
            with connect_readonly(self.logs_db) as conn:
                rows = conn.execute(
                    """
                    select ts, feedback_log_body
                    from logs
                    where thread_id = ?
                      and feedback_log_body like ?
                      and (
                        feedback_log_body like '%response.completed%'
                        or feedback_log_body like '%codex.rate_limits%'
                      )
                    order by ts, ts_nanos
                    """,
                    (thread_id, f"%{WEBSOCKET_MARKER}%"),
                ).fetchall()
        except sqlite3.Error:
            return []

        messages = []
        for row in rows:
            event = parse_websocket_event(row["feedback_log_body"] or "")
            if not event:
                continue
            message = message_from_event(event, int(row["ts"]))
            if message is not None and message.text.strip():
                messages.append(message)
        return dedupe_messages(messages)

    def user_messages_from_submissions(self, thread_id: str) -> list[Message]:
        messages: list[Message] = []
        try:
            with connect_readonly(self.logs_db) as conn:
                rows = conn.execute(
                    """
                    select ts, feedback_log_body
                    from logs
                    where thread_id = ?
                      and feedback_log_body like '%Submission sub=Submission%'
                      and feedback_log_body like '%items: [Text { text:%'
                    order by ts, ts_nanos
                    """,
                    (thread_id,),
                ).fetchall()
        except sqlite3.Error:
            return messages
        seen: set[str] = set()
        for row in rows:
            text = extract_submission_text(row["feedback_log_body"] or "")
            if not text or text in seen:
                continue
            seen.add(text)
            timestamp = int(row["ts"])
            messages.append(
                Message(
                    role="user",
                    text=text,
                    timestamp=timestamp,
                    time=local_time(timestamp),
                    source="logs_2.sqlite submission",
                )
            )
        return messages


def parse_websocket_event(body: str) -> dict[str, Any] | None:
    marker_index = body.find(WEBSOCKET_MARKER)
    if marker_index == -1:
        return None
    payload = body[marker_index + len(WEBSOCKET_MARKER) :].strip()
    if not payload.startswith("{"):
        return None
    try:
        return json.loads(payload)
    except json.JSONDecodeError:
        return None


def user_message_text(payload: dict[str, Any]) -> str | None:
    text = payload.get("message")
    if not isinstance(text, str):
        return None
    sections: list[str] = []
    for key, label in (
        ("images", "Images"),
        ("local_images", "Local Images"),
        ("text_elements", "Text Elements"),
    ):
        value = payload.get(key)
        if value:
            sections.append(f"**{label}**\n```json\n{escape_code_fence(safe_json(value))}\n```")
    if sections:
        return f"{text}\n\n" + "\n\n".join(sections)
    return text


def append_memory_citation(text: str, citation: Any) -> str:
    if citation is None or citation == "":
        return text
    return (
        f"{text}\n\n"
        "**Memory Citation**\n"
        f"```json\n{escape_code_fence(safe_json(citation))}\n```"
    )


def first_session_meta_line(lines: list[str]) -> dict[str, Any] | None:
    for line in lines:
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            return None
        if item.get("type") != "session_meta":
            return None
        payload = item.get("payload")
        if not isinstance(payload, dict):
            return None
        return item
    return None


def source_stat_changed(before_stat: os.stat_result, current_stat: os.stat_result) -> bool:
    return (
        current_stat.st_mtime_ns != before_stat.st_mtime_ns
        or current_stat.st_size != before_stat.st_size
    )


def parse_rollout_json_line(line: str) -> dict[str, Any] | None:
    if not line.strip():
        return None
    try:
        item = json.loads(line)
    except json.JSONDecodeError:
        return None
    return item if isinstance(item, dict) else None


def strip_leading_session_meta(lines: list[str]) -> list[str]:
    copied = list(lines)
    for index, line in enumerate(copied):
        if not line.strip():
            continue
        item = parse_rollout_json_line(line)
        if item is None:
            return copied
        if item.get("type") == "session_meta":
            return copied[:index] + copied[index + 1 :]
        return copied
    return copied


def response_item_is_real_user_message(payload: dict[str, Any]) -> bool:
    if payload.get("type") != "message" or payload.get("role") != "user":
        return False
    text = response_content_text(payload.get("content"))
    return bool(text.strip()) and not is_context_input_text(text)


def event_item_is_real_user_message(payload: dict[str, Any]) -> bool:
    if payload.get("type") != "user_message":
        return False
    text = user_message_text(payload)
    return isinstance(text, str) and bool(text.strip()) and not is_context_input_text(text)


def fork_interrupt_state(lines: list[str]) -> tuple[bool, str | None]:
    saw_user_message = False
    has_turn_boundary_after_last_user = False
    active_turn_id: str | None = None
    explicit_turn_open = False

    for line in lines:
        item = parse_rollout_json_line(line)
        if item is None:
            continue
        payload = item.get("payload")
        if not isinstance(payload, dict):
            continue

        item_type = item.get("type")
        if item_type == "response_item":
            if response_item_is_real_user_message(payload):
                saw_user_message = True
                has_turn_boundary_after_last_user = False
            continue

        if item_type != "event_msg":
            continue

        payload_type = payload.get("type")
        if payload_type == "user_message" and event_item_is_real_user_message(payload):
            saw_user_message = True
            has_turn_boundary_after_last_user = False
        elif payload_type in {"turn_started", "task_started"}:
            value = payload.get("turn_id")
            active_turn_id = value if isinstance(value, str) and value else None
            explicit_turn_open = active_turn_id is not None
        elif payload_type in {"turn_complete", "task_complete", "turn_aborted", "task_aborted"}:
            explicit_turn_open = False
            active_turn_id = None
            if saw_user_message:
                has_turn_boundary_after_last_user = True

    if explicit_turn_open:
        return True, active_turn_id
    return saw_user_message and not has_turn_boundary_after_last_user, None


def interrupted_marker_line(timestamp: str) -> str:
    item = {
        "timestamp": timestamp,
        "type": "response_item",
        "payload": {
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": TURN_ABORTED_MARKER_TEXT}],
        },
    }
    return json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n"


def turn_aborted_event_line(timestamp: str, turn_id: str | None) -> str:
    item = {
        "timestamp": timestamp,
        "type": "event_msg",
        "payload": {
            "type": "turn_aborted",
            "turn_id": turn_id,
            "reason": "interrupted",
        },
    }
    return json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n"


def append_interrupted_boundary_if_needed(
    lines: list[str],
    timestamp: str,
) -> tuple[list[str], bool]:
    needs_interrupt, turn_id = fork_interrupt_state(lines)
    if not needs_interrupt:
        return lines, False
    return (
        lines + [interrupted_marker_line(timestamp), turn_aborted_event_line(timestamp, turn_id)],
        True,
    )


def synthetic_fork_session_meta_line(
    source_session_meta: dict[str, Any],
    *,
    source_thread_id: str,
    fork_thread_id: str,
    timestamp: str,
    row: sqlite3.Row,
) -> dict[str, Any]:
    source_payload = source_session_meta.get("payload")
    payload = dict(source_payload if isinstance(source_payload, dict) else {})
    payload.update(
        {
            "id": fork_thread_id,
            "forked_from_id": source_thread_id,
            "timestamp": timestamp,
            "cwd": row["cwd"] or payload.get("cwd") or str(Path.home()),
            "originator": payload.get("originator") or "codex-tui",
            "cli_version": row["cli_version"] or payload.get("cli_version") or "",
            "source": "cli",
            "thread_source": "user",
            "model_provider": row["model_provider"] or payload.get("model_provider"),
        }
    )
    for key in ("agent_nickname", "agent_role", "agent_path", "agent_type"):
        payload.pop(key, None)
    return {
        "timestamp": timestamp,
        "type": "session_meta",
        "payload": payload,
    }


def validate_rollout_jsonl(path: Path, expected_thread_id: str) -> None:
    first: dict[str, Any] | None = None
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid JSONL at line {line_number}: {exc}") from exc
            if first is None:
                first = item
    if first is None:
        raise ValueError("Generated rollout file is empty")
    payload = first.get("payload")
    if first.get("type") != "session_meta" or not isinstance(payload, dict):
        raise ValueError("Generated rollout does not start with session metadata")
    if payload.get("id") != expected_thread_id:
        raise ValueError("Generated rollout session metadata has the wrong thread id")


def rollback_event_line(timestamp: str, rollback_turns: int) -> str:
    item = {
        "timestamp": timestamp,
        "type": "event_msg",
        "payload": {
            "type": "thread_rolled_back",
            "num_turns": rollback_turns,
        },
    }
    return json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n"


def token_count_from_rollout_lines(lines: list[str]) -> int:
    total = 0
    for line in lines:
        if "token_count" not in line or "total_token_usage" not in line:
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        payload = item.get("payload")
        if item.get("type") != "event_msg" or not isinstance(payload, dict):
            continue
        if payload.get("type") != "token_count":
            continue
        usage = (
            payload.get("info", {})
            if isinstance(payload.get("info"), dict)
            else {}
        ).get("total_token_usage")
        if not isinstance(usage, dict):
            continue
        value = usage.get("total_tokens")
        if isinstance(value, int | float):
            total = max(0, int(value))
    return total


def fork_title_from_source(row: sqlite3.Row, prefix: str = "Fork before compaction") -> str:
    title = row["title"] if "title" in row.keys() else ""
    first_user_message = (
        row["first_user_message"] if "first_user_message" in row.keys() else ""
    )
    source = title or first_user_message or row["id"]
    return compact(f"{prefix}: {source}", 180)


def fork_title_from_message(message: Message) -> str:
    return compact(f"Fork from message: {message.text}", 180)


def session_meta_message(payload: dict[str, Any], timestamp: int | None) -> Message:
    fields = [
        ("Thread ID", payload.get("id")),
        ("Forked From", payload.get("forked_from_id")),
        ("Timestamp", payload.get("timestamp")),
        ("CWD", payload.get("cwd")),
        ("Originator", payload.get("originator")),
        ("CLI Version", payload.get("cli_version")),
        ("Source", payload.get("source")),
        ("Thread Source", payload.get("thread_source")),
        ("Model Provider", payload.get("model_provider")),
    ]
    blocks = []
    base_instructions = payload.get("base_instructions")
    if isinstance(base_instructions, dict) and base_instructions.get("text"):
        blocks.append(("Base Instructions", base_instructions.get("text")))
    return event_message("Session Metadata", fields, blocks, timestamp, "rollout session_meta", "session")


def thread_metadata_message(row: sqlite3.Row) -> Message:
    fields = [
        ("Thread ID", row["id"]),
        ("Source", row["source"]),
        ("Thread Source", row["thread_source"]),
        ("Model", row["model"]),
        ("Model Provider", row["model_provider"]),
        ("Reasoning Effort", row["reasoning_effort"]),
        ("CWD", row["cwd"]),
        ("Sandbox Policy", row["sandbox_policy"]),
        ("Approval Mode", row["approval_mode"]),
        ("Memory Mode", row["memory_mode"]),
        ("Agent Nickname", row["agent_nickname"]),
        ("Agent Role", row["agent_role"]),
        ("Agent Path", row["agent_path"]),
        ("Archived", bool(row["archived"])),
        ("Archived At", local_time(row["archived_at"])),
        ("Tokens Used", row["tokens_used"]),
        ("Has User Event", bool(row["has_user_event"])),
        ("Git Branch", row["git_branch"]),
        ("Git SHA", row["git_sha"]),
        ("Git Origin URL", row["git_origin_url"]),
        ("Rollout Path", row["rollout_path"]),
    ]
    return event_message(
        "Thread Metadata",
        fields,
        [],
        row["created_at"],
        "state_5.sqlite threads",
        "thread",
    )


def turn_context_message(payload: dict[str, Any], timestamp: int | None) -> Message:
    fields = [
        ("Turn ID", payload.get("turn_id")),
        ("CWD", payload.get("cwd")),
        ("Date", payload.get("current_date")),
        ("Timezone", payload.get("timezone")),
        ("Model", payload.get("model")),
        ("Reasoning Effort", payload.get("effort")),
        ("Approval Policy", payload.get("approval_policy")),
        ("Personality", payload.get("personality")),
        ("Realtime Active", payload.get("realtime_active")),
        ("Summary", payload.get("summary")),
    ]
    blocks = []
    for key, label in (
        ("sandbox_policy", "Sandbox Policy"),
        ("permission_profile", "Permission Profile"),
        ("collaboration_mode", "Collaboration Mode"),
        ("truncation_policy", "Truncation Policy"),
    ):
        if key in payload:
            blocks.append((label, payload.get(key)))
    return event_message("Turn Context", fields, blocks, timestamp, "rollout turn_context", "context")


def compacted_message(payload: dict[str, Any], timestamp: int | None) -> Message:
    replacement_history = payload.get("replacement_history")
    fields = [
        ("Replacement Items", len(replacement_history) if isinstance(replacement_history, list) else None),
    ]
    blocks = []
    message = payload.get("message")
    if isinstance(message, str) and message.strip():
        blocks.append(("Compaction Message", message))
    if isinstance(replacement_history, list):
        blocks.append(("Replacement History", replacement_history))
    return event_message("Context Compacted", fields, blocks, timestamp, "rollout compacted", "compaction")


def compaction_checkpoint_summary(payload: dict[str, Any], kind: str) -> str:
    if kind == "compacted":
        message = payload.get("message")
        if isinstance(message, str) and message.strip():
            return compact(message, 110)
        replacement_history = payload.get("replacement_history")
        if isinstance(replacement_history, list):
            return f"{len(replacement_history)} replacement history items"
    return "Context compaction checkpoint"


def event_message_from_payload(payload: dict[str, Any], timestamp: int | None) -> Message | None:
    payload_type = payload.get("type")
    if not isinstance(payload_type, str):
        return None
    if payload_type == "context_compacted":
        return event_message("Context Compacted", [], [], timestamp, "rollout event_msg", "compaction")
    if payload_type == "thread_rolled_back":
        rollback_turns_value = payload.get("num_turns")
        rollback_turns = (
            int(rollback_turns_value)
            if isinstance(rollback_turns_value, int | float)
            else None
        )
        message = event_message(
            "Thread Rolled Back",
            [("Turns Removed", payload.get("num_turns"))],
            [],
            timestamp,
            "rollout event_msg",
            "rollback",
        )
        message.rollback_turns = rollback_turns
        return message
    if payload_type == "turn_aborted":
        return event_message(
            "Turn Aborted",
            [
                ("Turn ID", payload.get("turn_id")),
                ("Reason", payload.get("reason")),
                ("Completed At", local_time_from_epoch(payload.get("completed_at"))),
                ("Duration", format_duration_ms(payload.get("duration_ms"))),
            ],
            [],
            timestamp,
            "rollout event_msg",
            "aborted",
        )
    if payload_type == "error":
        return event_message(
            "Error",
            [("Error Info", payload.get("codex_error_info"))],
            [("Message", payload.get("message"))],
            timestamp,
            "rollout event_msg",
            "error",
        )
    if payload_type == "task_started":
        return event_message(
            "Turn Started",
            [
                ("Turn ID", payload.get("turn_id")),
                ("Started At", local_time_from_epoch(payload.get("started_at"))),
                ("Context Window", payload.get("model_context_window")),
                ("Collaboration Mode", payload.get("collaboration_mode_kind")),
            ],
            [],
            timestamp,
            "rollout event_msg",
            "turn",
        )
    if payload_type == "task_complete":
        return event_message(
            "Turn Complete",
            [
                ("Turn ID", payload.get("turn_id")),
                ("Completed At", local_time_from_epoch(payload.get("completed_at"))),
                ("Duration", format_duration_ms(payload.get("duration_ms"))),
                ("Time To First Token", format_duration_ms(payload.get("time_to_first_token_ms"))),
            ],
            [("Last Agent Message", payload.get("last_agent_message"))],
            timestamp,
            "rollout event_msg",
            "turn",
        )
    if payload_type == "token_count":
        return event_message(
            "Token Count",
            [],
            [("Info", payload.get("info")), ("Rate Limits", payload.get("rate_limits"))],
            timestamp,
            "rollout event_msg",
            "usage",
        )
    if payload_type == "patch_apply_end":
        return patch_apply_message(payload, timestamp)
    if payload_type == "exec_command_end":
        return exec_command_end_message(payload, timestamp)
    if payload_type == "web_search_end":
        return event_message(
            "Web Search Finished",
            [("Call ID", payload.get("call_id")), ("Query", payload.get("query"))],
            [("Action", payload.get("action"))],
            timestamp,
            "rollout event_msg",
            "search",
        )
    if payload_type == "image_generation_end":
        return image_generation_message(payload, timestamp, "rollout event_msg", "image")
    if payload_type == "view_image_tool_call":
        return view_image_tool_message(payload, timestamp)
    if payload_type == "mcp_tool_call_end":
        return mcp_tool_call_end_message(payload, timestamp)
    if payload_type == "item_completed":
        return event_message(
            "Item Completed",
            [
                ("Thread ID", payload.get("thread_id")),
                ("Turn ID", payload.get("turn_id")),
                ("Completed At", local_time_from_millis(payload.get("completed_at_ms"))),
            ],
            [("Item", payload.get("item"))],
            timestamp,
            "rollout event_msg",
            "item",
        )
    return None


def message_from_response_item(
    payload: dict[str, Any],
    timestamp: int | None,
    source_prefix: str,
) -> Message | None:
    payload_type = payload.get("type")
    if not isinstance(payload_type, str):
        return None
    if payload_type in {"function_call", "custom_tool_call"}:
        return tool_call_message(payload, payload_type, timestamp, source_prefix)
    if payload_type in {"function_call_output", "custom_tool_call_output"}:
        return tool_output_message(payload, payload_type, timestamp, source_prefix)
    if payload_type == "image_generation_call":
        return image_generation_message(payload, timestamp, source_prefix, "image")
    if payload_type == "message":
        return response_item_message(payload, timestamp, source_prefix)
    if payload_type == "reasoning":
        return response_item_reasoning_message(payload, timestamp, source_prefix)
    if payload_type.endswith("_call") and payload_type not in {"message"}:
        return generic_tool_event_message(payload, payload_type, timestamp, source_prefix)
    return None


def response_item_message(
    payload: dict[str, Any],
    timestamp: int | None,
    source_prefix: str,
) -> Message | None:
    role = payload.get("role")
    if not isinstance(role, str):
        return None
    text = response_content_text(payload.get("content"))
    if not text.strip():
        return None
    item_id = payload.get("id") if isinstance(payload.get("id"), str) else None
    phase = payload.get("phase") if isinstance(payload.get("phase"), str) else None
    source = f"{source_prefix} response_item message"

    if role == "assistant":
        return Message(
            role="assistant",
            text=text,
            timestamp=timestamp,
            time=local_time(timestamp),
            source=source,
            phase=phase,
            item_id=item_id,
        )
    if role == "user" and not is_context_input_text(text):
        return Message(
            role="user",
            text=text,
            timestamp=timestamp,
            time=local_time(timestamp),
            source=source,
            phase=phase,
            item_id=item_id,
        )
    return context_message(role, text, timestamp, source)


def response_item_reasoning_message(
    payload: dict[str, Any],
    timestamp: int | None,
    source_prefix: str,
) -> Message | None:
    summary = payload.get("summary")
    if not isinstance(summary, list):
        return None
    parts = [
        item.get("text")
        for item in summary
        if isinstance(item, dict) and isinstance(item.get("text"), str) and item.get("text", "").strip()
    ]
    if not parts:
        return None
    return Message(
        role="thinking",
        text="\n\n".join(parts),
        timestamp=timestamp,
        time=local_time(timestamp),
        source=f"{source_prefix} response_item reasoning summary",
    )


def tool_call_message(
    payload: dict[str, Any],
    payload_type: str,
    timestamp: int | None,
    source_prefix: str,
) -> Message | None:
    name = payload.get("name")
    if not isinstance(name, str) or not name:
        name = readable_tool_name(payload_type)
    call_id = payload.get("call_id")
    status = payload.get("status")
    fields = []
    if isinstance(status, str) and status:
        fields.append(("Status", status))
    if isinstance(call_id, str) and call_id:
        fields.append(("Call ID", call_id))
    block_label = "Arguments" if payload_type == "function_call" else "Input"
    block_value = payload.get("arguments") if payload_type == "function_call" else payload.get("input")
    text = format_tool_text(
        f"Tool call: {name}",
        fields,
        [(block_label, block_value)],
    )
    return Message(
        role="tool",
        text=text,
        timestamp=timestamp,
        time=local_time(timestamp),
        source=f"{source_prefix} {payload_type}",
        phase="call",
        item_id=tool_item_id(call_id, "call"),
    )


def tool_output_message(
    payload: dict[str, Any],
    payload_type: str,
    timestamp: int | None,
    source_prefix: str,
) -> Message | None:
    call_id = payload.get("call_id")
    title_target = compact(call_id, 42) if isinstance(call_id, str) and call_id else readable_tool_name(payload_type)
    fields = [("Call ID", call_id)] if isinstance(call_id, str) and call_id else []
    text = format_tool_output_text(
        f"Tool output: {title_target}",
        fields,
        payload.get("output"),
    )
    return Message(
        role="tool",
        text=text,
        timestamp=timestamp,
        time=local_time(timestamp),
        source=f"{source_prefix} {payload_type}",
        phase="output",
        item_id=tool_item_id(call_id, "output"),
    )


def generic_tool_event_message(
    payload: dict[str, Any],
    payload_type: str,
    timestamp: int | None,
    source_prefix: str,
) -> Message | None:
    name = readable_tool_name(payload_type)
    status = payload.get("status")
    fields = [("Status", status)] if isinstance(status, str) and status else []
    block_items = []
    for key in ("action", "input", "arguments", "query", "prompt"):
        if key in payload:
            block_items.append((key.replace("_", " ").title(), payload.get(key)))
    if not block_items:
        block_items = [("Event", {key: value for key, value in payload.items() if key != "type"})]
    text = format_tool_text(f"Tool call: {name}", fields, block_items)
    return Message(
        role="tool",
        text=text,
        timestamp=timestamp,
        time=local_time(timestamp),
        source=f"{source_prefix} {payload_type}",
        phase="call",
    )


def event_message(
    title: str,
    fields: list[tuple[str, Any]],
    blocks: list[tuple[str, Any]],
    timestamp: int | None,
    source: str,
    phase: str,
) -> Message:
    return Message(
        role="event",
        text=format_event_text(title, fields, blocks),
        timestamp=timestamp,
        time=local_time(timestamp),
        source=source,
        phase=phase,
    )


def format_event_text(
    title: str,
    fields: list[tuple[str, Any]],
    blocks: list[tuple[str, Any]],
) -> str:
    lines = [f"**{title}**"]
    for label, value in fields:
        if value is None or value == "":
            continue
        lines.append(f"{label}: {format_inline_value(value)}")
    for label, value in blocks:
        if value is None or value == "":
            continue
        block_text, language = format_event_value(value)
        lines.extend(["", f"**{label}**", f"```{language}", escape_code_fence(block_text), "```"])
    return "\n".join(lines).strip()


def patch_apply_message(payload: dict[str, Any], timestamp: int | None) -> Message:
    fields = [
        ("Call ID", payload.get("call_id")),
        ("Turn ID", payload.get("turn_id")),
        ("Status", payload.get("status")),
        ("Success", payload.get("success")),
    ]
    blocks = [
        ("Changed Files", summarize_patch_changes(payload.get("changes"))),
        ("Stdout", payload.get("stdout")),
        ("Stderr", payload.get("stderr")),
    ]
    return event_message("Patch Applied", fields, blocks, timestamp, "rollout event_msg", "patch")


def summarize_patch_changes(value: Any) -> Any:
    if not isinstance(value, dict):
        return value
    changes = []
    for path, change in value.items():
        if isinstance(change, dict):
            summary: dict[str, Any] = {"path": path}
            for key in ("type", "mode", "old_path", "new_path"):
                if key in change:
                    summary[key] = change[key]
            content = change.get("content")
            if isinstance(content, str):
                summary["content_chars"] = len(content)
                summary["content_preview"] = compact(content.replace("\n", " "), 240)
            changes.append(summary)
        else:
            changes.append({"path": path, "change": change})
    return changes


def exec_command_end_message(payload: dict[str, Any], timestamp: int | None) -> Message:
    call_id = payload.get("call_id")
    parsed = payload.get("parsed_cmd")
    command_name = command_preview(parsed) or command_preview(payload.get("command")) or "command"
    fields = [
        ("Call ID", call_id),
        ("Turn ID", payload.get("turn_id")),
        ("Process ID", payload.get("process_id")),
        ("CWD", payload.get("cwd")),
        ("Status", payload.get("status")),
        ("Exit Code", payload.get("exit_code")),
        ("Duration", format_duration_value(payload.get("duration"))),
        ("Source", payload.get("source")),
    ]
    blocks = [
        ("Parsed Command", parsed),
        ("Command", payload.get("command")),
        ("Stdout", payload.get("stdout")),
        ("Stderr", payload.get("stderr")),
        ("Aggregated Output", payload.get("aggregated_output")),
        ("Formatted Output", payload.get("formatted_output")),
    ]
    return Message(
        role="tool",
        text=format_event_text(f"Command finished: {command_name}", fields, blocks),
        timestamp=timestamp,
        time=local_time(timestamp),
        source="rollout event_msg exec_command_end",
        phase="command end",
        item_id=tool_item_id(call_id, "command_end"),
    )


def command_preview(value: Any) -> str | None:
    if isinstance(value, list) and value:
        first = value[0]
        if isinstance(first, dict) and isinstance(first.get("cmd"), str):
            return compact(first["cmd"], 80)
        return compact(" ".join(str(item) for item in value), 80)
    if isinstance(value, str):
        return compact(value, 80)
    return None


def image_generation_message(
    payload: dict[str, Any],
    timestamp: int | None,
    source: str,
    phase: str,
) -> Message:
    call_id = payload.get("call_id") or payload.get("id")
    result = payload.get("result")
    result_note = None
    if isinstance(result, str) and result:
        result_note = f"{OMITTED_IMAGE_RESULT_LABEL} ({len(result)} chars)"
    fields = [
        ("Call ID", call_id),
        ("Status", payload.get("status")),
        ("Saved Path", payload.get("saved_path")),
        ("Result", result_note),
    ]
    blocks = [("Revised Prompt", payload.get("revised_prompt"))]
    return event_message("Image Generation", fields, blocks, timestamp, source, phase)


def view_image_tool_message(payload: dict[str, Any], timestamp: int | None) -> Message:
    call_id = payload.get("call_id")
    text = format_tool_text(
        "Tool call: view image",
        [
            ("Call ID", call_id),
            ("Path", payload.get("path")),
        ],
        [],
    )
    return Message(
        role="tool",
        text=text,
        timestamp=timestamp,
        time=local_time(timestamp),
        source="rollout event_msg view_image_tool_call",
        phase="call",
        item_id=tool_item_id(call_id, "call"),
    )


def mcp_tool_call_end_message(payload: dict[str, Any], timestamp: int | None) -> Message:
    call_id = payload.get("call_id")
    text = format_tool_text(
        "MCP tool call finished",
        [
            ("Call ID", call_id),
            ("Duration", format_duration_value(payload.get("duration"))),
        ],
        [
            ("Invocation", payload.get("invocation")),
            ("Result", payload.get("result")),
        ],
    )
    return Message(
        role="tool",
        text=text,
        timestamp=timestamp,
        time=local_time(timestamp),
        source="rollout event_msg mcp_tool_call_end",
        phase="call + output",
        item_id=tool_item_id(call_id, "call"),
    )


def custom_tool_input_message(event: dict[str, Any], timestamp: int) -> Message | None:
    value = event.get("input")
    if not isinstance(value, str) or not value.strip():
        return None
    item_id = event.get("item_id")
    text = format_tool_text(
        "Tool input: custom tool",
        [("Item ID", item_id)] if isinstance(item_id, str) and item_id else [],
        [("Input", value)],
    )
    return Message(
        role="tool",
        text=text,
        timestamp=timestamp,
        time=local_time(timestamp),
        source="logs_2.sqlite response.custom_tool_call_input.done",
        phase="call",
        item_id=tool_item_id(item_id, "input"),
    )


def tool_item_id(value: Any, phase: str) -> str | None:
    return f"{value}:{phase}" if isinstance(value, str) and value else None


def readable_tool_name(payload_type: str) -> str:
    if payload_type.endswith("_call"):
        payload_type = payload_type.removesuffix("_call")
    if payload_type.endswith("_output"):
        payload_type = payload_type.removesuffix("_output")
    return payload_type.replace("_", " ")


def format_inline_value(value: Any) -> str:
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, int | float):
        return str(value)
    if isinstance(value, str):
        return value
    return compact(json.dumps(sanitize_value(value), ensure_ascii=False), 160)


def format_event_value(value: Any) -> tuple[str, str]:
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return "(empty)", "text"
        return truncate_block(value), "text"
    return truncate_block(safe_json(value)), "json"


def safe_json(value: Any) -> str:
    return json.dumps(sanitize_value(value), ensure_ascii=False, indent=2)


def sanitize_value(value: Any, key: str | None = None) -> Any:
    if isinstance(value, str):
        if key == "result" and len(value) > 10000:
            return f"{OMITTED_IMAGE_RESULT_LABEL} ({len(value)} chars)"
        if is_large_data_image(value):
            return f"(base64 image data omitted; {len(value)} chars)"
        return truncate_block(value)
    if isinstance(value, dict):
        return {str(item_key): sanitize_value(item_value, str(item_key)) for item_key, item_value in value.items()}
    if isinstance(value, list):
        return [sanitize_value(item) for item in value]
    return value


def truncate_block(value: str) -> str:
    if len(value) <= MAX_EVENT_BLOCK_CHARS:
        return value
    return f"{value[:MAX_EVENT_BLOCK_CHARS].rstrip()}\n\n... truncated {len(value) - MAX_EVENT_BLOCK_CHARS} chars ..."


def is_large_data_image(value: str) -> bool:
    return len(value) > 1000 and value.startswith("data:image/") and ";base64," in value[:100]


def local_time_from_epoch(value: Any) -> str | None:
    if isinstance(value, int | float):
        return local_time(int(value))
    return None


def local_time_from_millis(value: Any) -> str | None:
    if isinstance(value, int | float):
        return local_time(int(value / 1000))
    return None


def format_duration_ms(value: Any) -> str | None:
    if not isinstance(value, int | float):
        return None
    if value < 1000:
        return f"{value:.0f} ms"
    return f"{value / 1000:.2f} s"


def format_duration_value(value: Any) -> str | None:
    if isinstance(value, dict):
        secs = value.get("secs")
        nanos = value.get("nanos")
        if isinstance(secs, int | float) or isinstance(nanos, int | float):
            seconds = (secs if isinstance(secs, int | float) else 0) + (
                (nanos if isinstance(nanos, int | float) else 0) / 1_000_000_000
            )
            return f"{seconds:.3f} s"
    return format_inline_value(value) if value is not None else None


def format_tool_text(
    title: str,
    fields: list[tuple[str, Any]],
    blocks: list[tuple[str, Any]],
) -> str:
    lines = [f"**{title}**"]
    for label, value in fields:
        if value is None or value == "":
            continue
        lines.append(f"{label}: {value}")
    for label, value in blocks:
        block_text, language = format_tool_value(value)
        lines.extend(["", f"**{label}**", f"```{language}", escape_code_fence(block_text), "```"])
    return "\n".join(lines).strip()


def format_tool_output_text(title: str, fields: list[tuple[str, Any]], value: Any) -> str:
    lines = [f"**{title}**"]
    for label, field_value in fields:
        if field_value is None or field_value == "":
            continue
        lines.append(f"{label}: {field_value}")

    metadata_lines, output_text, language = split_tool_output(value)
    if metadata_lines:
        lines.extend(["", "**Run Info**", *metadata_lines])
    lines.extend(["", "**Output**", f"```{language}", escape_code_fence(output_text), "```"])
    return "\n".join(lines).strip()


def split_tool_output(value: Any) -> tuple[list[str], str, str]:
    if value is None:
        return [], "(empty)", "text"
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return [], "(empty)", "text"
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict) and "output" in parsed:
            metadata = metadata_lines(parsed.get("metadata"))
            output_text, language = format_tool_value(parsed.get("output"))
            return metadata, output_text, language
        terminal_split = split_terminal_output(value)
        if terminal_split is not None:
            return terminal_split
        return [], truncate_block(value), "text"
    if isinstance(value, dict) and "output" in value:
        metadata = metadata_lines(value.get("metadata"))
        output_text, language = format_tool_value(value.get("output"))
        return metadata, output_text, language
    output_text, language = format_tool_value(value)
    return [], output_text, language


def split_terminal_output(value: str) -> tuple[list[str], str, str] | None:
    normalized = value.replace("\r\n", "\n")
    marker = "\nOutput:\n"
    if normalized.startswith("Output:\n"):
        return [], normalized.removeprefix("Output:\n"), "text"
    marker_index = normalized.find(marker)
    if marker_index == -1:
        return None
    metadata_text = normalized[:marker_index].strip("\n")
    output_text = normalized[marker_index + len(marker) :]
    return [line for line in metadata_text.splitlines() if line.strip()], truncate_block(output_text or "(empty)"), "text"


def metadata_lines(value: Any) -> list[str]:
    if value is None or value == "":
        return []
    if isinstance(value, dict):
        lines: list[str] = []
        for key, item in value.items():
            label = str(key).replace("_", " ").title()
            if isinstance(item, dict | list):
                rendered = json.dumps(item, ensure_ascii=False)
            else:
                rendered = str(item)
            lines.append(f"{label}: {rendered}")
        return lines
    if isinstance(value, list):
        return [str(item) for item in value]
    return [str(value)]


def format_tool_value(value: Any) -> tuple[str, str]:
    if value is None:
        return "(empty)", "text"
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return "(empty)", "text"
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            return truncate_block(value), "text"
        if isinstance(parsed, dict | list):
            return safe_json(parsed), "json"
        return truncate_block(value), "text"
    if isinstance(value, dict | list):
        return safe_json(value), "json"
    return str(value), "text"


def escape_code_fence(value: str) -> str:
    return value.replace("```", "``\\`")


def response_completed_message(event: dict[str, Any], timestamp: int) -> Message | None:
    response = event.get("response")
    if not isinstance(response, dict):
        return None
    fields = [
        ("Response ID", response.get("id")),
        ("Status", response.get("status")),
        ("Model", response.get("model")),
    ]
    blocks = [
        ("Usage", response.get("usage")),
        ("Incomplete Details", response.get("incomplete_details")),
        ("Error", response.get("error")),
    ]
    return event_message(
        "Response Completed",
        fields,
        blocks,
        timestamp,
        "logs_2.sqlite response.completed",
        "response",
    )


def rate_limits_message(event: dict[str, Any], timestamp: int) -> Message:
    fields = [
        ("Plan Type", event.get("plan_type")),
        ("Credits", event.get("credits")),
        ("Promo", event.get("promo")),
    ]
    blocks = [
        ("Rate Limits", event.get("rate_limits")),
        ("Code Review Rate Limits", event.get("code_review_rate_limits")),
        ("Additional Rate Limits", event.get("additional_rate_limits")),
    ]
    return event_message(
        "Rate Limits",
        fields,
        blocks,
        timestamp,
        "logs_2.sqlite codex.rate_limits",
        "usage",
    )


def message_from_event(event: dict[str, Any], timestamp: int) -> Message | None:
    event_type = event.get("type")
    item_id = event.get("item_id")
    if event_type == "response.output_item.done":
        item = event.get("item")
        if not isinstance(item, dict):
            return None
        tool_message = message_from_response_item(
            item,
            timestamp,
            "logs_2.sqlite response.output_item.done",
        )
        if tool_message is not None:
            item_identifier = item.get("id")
            if tool_message.item_id is None and isinstance(item_identifier, str):
                tool_message.item_id = item_identifier
            return tool_message
        if item.get("type") != "message" or item.get("role") != "assistant":
            return None
        text = content_text(item.get("content"))
        return Message(
            role="assistant",
            text=text,
            timestamp=timestamp,
            time=local_time(timestamp),
            source="logs_2.sqlite response.output_item.done",
            phase=item.get("phase") if isinstance(item.get("phase"), str) else None,
            item_id=item.get("id") if isinstance(item.get("id"), str) else item_id,
        )
    if event_type == "response.output_text.done":
        text = event.get("text")
        if not isinstance(text, str):
            return None
        return Message(
            role="assistant",
            text=text,
            timestamp=timestamp,
            time=local_time(timestamp),
            source="logs_2.sqlite response.output_text.done",
            item_id=item_id if isinstance(item_id, str) else None,
        )
    if event_type == "response.reasoning_summary_text.done":
        text = event.get("text")
        if not isinstance(text, str):
            return None
        summary_index = event.get("summary_index")
        reasoning_item_id = item_id if isinstance(item_id, str) else "reasoning"
        if isinstance(summary_index, int):
            reasoning_item_id = f"{reasoning_item_id}:summary:{summary_index}"
        return Message(
            role="thinking",
            text=text,
            timestamp=timestamp,
            time=local_time(timestamp),
            source="logs_2.sqlite response.reasoning_summary_text.done",
            item_id=reasoning_item_id,
        )
    if event_type == "response.custom_tool_call_input.done":
        return custom_tool_input_message(event, timestamp)
    if event_type == "response.completed":
        return response_completed_message(event, timestamp)
    if event_type == "codex.rate_limits":
        return rate_limits_message(event, timestamp)
    return None


def message_sort_key(message: Message) -> tuple[float]:
    return (float(message.timestamp if message.timestamp is not None else 0),)


def message_filter_key(message: Message) -> str:
    if message.rolled_back:
        return "rolledBack"
    if message.role in {"user", "assistant", "thinking", "tool"}:
        return message.role
    if message.role != "event":
        return "otherEvent"
    phase = message.phase or ""
    if phase == "compaction":
        return "compaction"
    if phase in {"rollback", "aborted", "error"}:
        return "important"
    if phase in {
        "patch",
        "search",
        "image",
        "response",
        "thread",
        "session",
        "context",
        "turn",
        "usage",
    }:
        return phase
    return "otherEvent"


def normalize_search_query(value: str) -> str:
    return normalize_display_text(str(value or "")).lower()


def normalize_display_text(value: str) -> str:
    return " ".join(str(value or "").split())


def summary_matches_search(summary: Any, normalized_query: str) -> bool:
    values = [
        getattr(summary, "id", None),
        getattr(summary, "preview", None),
        getattr(summary, "started", None),
        getattr(summary, "ended", None),
        getattr(summary, "updated", None),
        getattr(summary, "cwd", None),
        getattr(summary, "model", None),
        getattr(summary, "app_version", None),
        getattr(summary, "source", None),
        getattr(summary, "meta_label", None),
    ]
    return normalized_query in normalize_search_query(" ".join(str(item) for item in values if item))


def conversation_match_snippet(messages: list[Message], normalized_query: str) -> str | None:
    return search_text_match_snippet(
        [message.text for message in messages if message.text.strip()],
        normalized_query,
    )


def search_text_match_snippet(
    values: list[str], normalized_query: str, limit: int = 180
) -> str | None:
    if not normalized_query:
        return None
    for value in values:
        normalized = normalize_display_text(value)
        if not normalized:
            continue
        snippet = search_normalized_text_match_snippet(
            normalized,
            normalized.lower(),
            normalized_query,
            limit,
        )
        if snippet:
            return snippet
    return None


def search_indexed_text_match_snippet(
    entries: list[tuple[str, str]], normalized_query: str, limit: int = 180
) -> str | None:
    for display_text, lower_text in entries:
        snippet = search_normalized_text_match_snippet(
            display_text,
            lower_text,
            normalized_query,
            limit,
        )
        if snippet:
            return snippet
    return None


def search_normalized_text_match_snippet(
    display_text: str, lower_text: str, normalized_query: str, limit: int = 180
) -> str | None:
    if not normalized_query:
        return None
    match_at = lower_text.find(normalized_query)
    if match_at == -1:
        return None
    context = max(24, (limit - len(normalized_query)) // 2)
    start = max(0, match_at - context)
    end = min(len(display_text), match_at + len(normalized_query) + context)
    snippet = display_text[start:end].strip()
    if start > 0:
        snippet = f"...{snippet}"
    if end < len(display_text):
        snippet = f"{snippet}..."
    return snippet


def count_occurrences(text: str, query: str) -> int:
    if not query:
        return 0
    count = 0
    start = text.find(query)
    while start != -1:
        count += 1
        start = text.find(query, start + len(query))
    return count


def finalize_messages(messages: list[Message]) -> list[Message]:
    deduped = dedupe_messages(messages)
    deduped.sort(key=message_sort_key)
    return merge_tool_outputs(deduped)


def annotate_rolled_back_messages(messages: list[Message]) -> None:
    for rollback_index, message in enumerate(messages):
        if message.role != "event" or message.phase != "rollback":
            continue
        turns_to_mark = message.rollback_turns or 1
        if turns_to_mark <= 0:
            continue
        ranges = rollback_turn_ranges(messages, rollback_index, turns_to_mark)
        if not ranges:
            continue
        rolled_back_at = message.time or local_time(message.timestamp)
        rollback_group = rollback_group_id(message.timestamp, rollback_index)
        for start, end in ranges:
            for candidate in messages[start:end]:
                if candidate.role not in {"user", "assistant", "thinking", "tool"}:
                    continue
                candidate.rolled_back = True
                candidate.rolled_back_at = rolled_back_at
                candidate.rolled_back_by_timestamp = message.timestamp
                candidate.rollback_group = rollback_group


def rollback_group_id(timestamp: int | float | None, fallback_index: int) -> str:
    if timestamp is not None:
        return f"rollback-{timestamp}"
    return f"rollback-index-{fallback_index}"


def rollback_turn_ranges(
    messages: list[Message],
    rollback_index: int,
    turns_to_mark: int,
) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    range_end = rollback_index
    search_index = rollback_index - 1
    while turns_to_mark > 0 and search_index >= 0:
        while search_index >= 0 and not is_active_user_message(messages[search_index]):
            search_index -= 1
        if search_index < 0:
            break
        ranges.append((search_index, range_end))
        range_end = search_index
        search_index -= 1
        turns_to_mark -= 1
    return ranges


def is_active_user_message(message: Message) -> bool:
    return message.role == "user" and not message.rolled_back


def dedupe_messages(messages: list[Message]) -> list[Message]:
    by_signature: dict[tuple[str, str, int | None], Message] = {}
    recent_by_content: dict[tuple[str, str | None, str], tuple[int, Message]] = {}
    order: list[tuple[str, str, int | None]] = []
    for message in messages:
        content_signature = (message.role, message.phase, message.text)
        recent = recent_by_content.get(content_signature)
        if recent is not None:
            recent_index, recent_message = recent
            recent_timestamp = recent_message.timestamp
            current_timestamp = message.timestamp
            if (
                recent_timestamp is not None
                and current_timestamp is not None
                and abs(float(current_timestamp) - float(recent_timestamp))
                <= DUPLICATE_MESSAGE_WINDOW_SECONDS
            ):
                if message_priority(message) > message_priority(recent_message):
                    recent_order_signature = order[recent_index]
                    by_signature[recent_order_signature] = message
                    recent_by_content[content_signature] = (recent_index, message)
                continue

        signature = (message.role, message.text, message.timestamp)
        current = by_signature.get(signature)
        if current is None:
            by_signature[signature] = message
            order.append(signature)
            recent_by_content[content_signature] = (len(order) - 1, message)
            continue
        if message_priority(message) > message_priority(current):
            by_signature[signature] = message
            recent_by_content[content_signature] = (order.index(signature), message)
    return [by_signature[signature] for signature in order]


def message_priority(message: Message) -> int:
    source = message.source
    if "rollout event_msg" in source:
        return 5
    if "state_5.sqlite" in source:
        return 4
    if "logs_2.sqlite response.output_item.done" in source:
        return 3
    if "logs_2.sqlite response.output_text.done" in source:
        return 2
    return 1


def merge_tool_outputs(messages: list[Message]) -> list[Message]:
    outputs_by_call_id: dict[str, Message] = {}
    for message in messages:
        if message.role != "tool" or message.phase != "output":
            continue
        call_id = tool_message_call_id(message)
        if call_id:
            outputs_by_call_id[call_id] = message

    if not outputs_by_call_id:
        return messages

    consumed_outputs: set[int] = set()
    merged: list[Message] = []
    for message in messages:
        if message.role == "tool" and message.phase == "call":
            call_id = tool_message_call_id(message)
            output = outputs_by_call_id.get(call_id or "")
            if output is not None:
                merged.append(
                    Message(
                        role=message.role,
                        text=f"{message.text}\n\n{output.text}",
                        timestamp=message.timestamp,
                        time=message.time,
                        source=message.source,
                        phase="call + output",
                        item_id=message.item_id,
                        line_number=message.line_number,
                    )
                )
                consumed_outputs.add(id(output))
                continue
        if message.role == "tool" and message.phase == "output" and id(message) in consumed_outputs:
            continue
        merged.append(message)
    return merged


def tool_message_call_id(message: Message) -> str | None:
    if not message.item_id or ":" not in message.item_id:
        return None
    call_id, phase = message.item_id.rsplit(":", 1)
    if phase not in {"call", "output", "input"}:
        return None
    return call_id or None


def context_message(role: str, text: str, timestamp: int | None, source: str) -> Message:
    return event_message(
        "Context Message",
        [("Role", role)],
        [("Content", text)],
        timestamp,
        source,
        "context",
    )


def is_context_input_text(value: str) -> bool:
    stripped = value.lstrip()
    context_prefixes = (
        "# AGENTS.md instructions",
        "<environment_context>",
        "<permissions instructions>",
        "<developer_context>",
        "<turn_aborted>",
        "<subagent_notification>",
        "<user_shell_command>",
    )
    return stripped.startswith(context_prefixes)


def response_content_text(content: Any) -> str:
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    attachments: list[Any] = []
    for item in content:
        if not isinstance(item, dict):
            continue
        if isinstance(item.get("text"), str):
            parts.append(item["text"])
        elif item.get("type") == "input_image":
            attachments.append(item)
    if attachments:
        parts.append(
            "**Content Attachments**\n"
            f"```json\n{escape_code_fence(safe_json(attachments))}\n```"
        )
    return "\n\n".join(part for part in parts if part.strip()).strip()


def content_text(content: Any) -> str:
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for item in content:
        if isinstance(item, dict) and isinstance(item.get("text"), str):
            parts.append(item["text"])
    return "\n".join(parts).strip()


def source_priority(source: str) -> int:
    if "output_item.done" in source:
        return 3
    if "output_text.done" in source:
        return 2
    return 1


def extract_submission_text(body: str) -> str | None:
    match = re.search(r'Text \{ text: "((?:\\.|[^"\\])*)"', body)
    if not match:
        return None
    return unescape_debug_string(match.group(1))


def unescape_debug_string(value: str) -> str:
    try:
        return bytes(value, "utf-8").decode("unicode_escape")
    except UnicodeDecodeError:
        return value


def compact(text: str, limit: int = 140) -> str:
    normalized = " ".join(text.split())
    if len(normalized) <= limit:
        return normalized
    return normalized[: limit - 1].rstrip() + "..."


def parse_filter_param(value: str) -> set[str]:
    return {item for item in value.split(",") if item}


def parse_bool_param(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes", "on"}


class AppHandler(BaseHTTPRequestHandler):
    reader = SideConversationReader()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path == "/":
                self.send_static_file(STATIC_ROOT / "index.html")
            elif path == "/favicon.ico":
                self.send_asset_file(ASSET_ROOT / "codex-conversation-reader.png")
            elif path.startswith("/static/"):
                rel = Path(unquote(path.removeprefix("/static/")))
                self.send_static_file(STATIC_ROOT / rel)
            elif path.startswith("/assets/"):
                rel = Path(unquote(path.removeprefix("/assets/")))
                self.send_asset_file(ASSET_ROOT / rel)
            elif path == "/api/status":
                self.send_json(self.status_payload())
            elif path == "/api/search":
                params = parse_qs(parsed.query)
                thread_id = params.get("thread_id", [None])[0]
                kind = params.get("kind", ["side"])[0]
                query = params.get("q", [""])[0]
                filter_values = params.get("filters", [])
                filters = parse_filter_param(filter_values[0]) if filter_values else None
                if not thread_id:
                    self.send_error_json(400, "Missing thread_id")
                    return
                if kind not in {"main", "side"}:
                    self.send_error_json(400, "Invalid kind")
                    return
                self.send_json(self.reader.search_thread(kind, thread_id, query, filters))
            elif path == "/api/threads":
                params = parse_qs(parsed.query)
                query = params.get("q", [""])[0]
                full_text = parse_bool_param(params.get("full_text", ["0"])[0])
                self.send_json(
                    [asdict(item) for item in self.reader.list_threads(query, full_text)]
                )
            elif path.startswith("/api/threads/"):
                thread_id = unquote(path.removeprefix("/api/threads/"))
                self.send_json(self.reader.get_thread(thread_id))
            elif path == "/api/main-threads":
                params = parse_qs(parsed.query)
                list_filter = params.get("filter", ["all"])[0]
                query = params.get("q", [""])[0]
                full_text = parse_bool_param(params.get("full_text", ["0"])[0])
                self.send_json(
                    [
                        asdict(item)
                        for item in self.reader.list_main_threads(list_filter, query, full_text)
                    ]
                )
            elif path.startswith("/api/main-threads/"):
                thread_id = unquote(path.removeprefix("/api/main-threads/"))
                self.send_json(self.reader.get_main_thread(thread_id))
            elif path == "/api/export":
                params = parse_qs(parsed.query)
                thread_id = params.get("thread_id", [None])[0]
                kind = params.get("kind", ["side"])[0]
                if not thread_id:
                    self.send_error_json(400, "Missing thread_id")
                    return
                if kind == "main":
                    self.send_json(self.reader.get_main_thread(thread_id))
                else:
                    self.send_json(self.reader.get_thread(thread_id))
            else:
                self.send_error_json(404, "Not found")
        except KeyError:
            self.send_error_json(404, "Conversation not found")
        except FileNotFoundError as exc:
            self.send_error_json(500, f"Missing Codex file: {exc}")
        except sqlite3.Error as exc:
            self.send_error_json(500, f"SQLite error: {exc}")
        except OSError as exc:
            self.send_error_json(500, f"I/O error: {exc}")

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/ask-codex/cancel":
                payload = self.read_json_body()
                request_id = payload.get("request_id")
                if not isinstance(request_id, str):
                    self.send_error_json(400, "Missing Ask Codex request id")
                    return
                self.send_json(cancel_ask_codex_request(request_id), status=200)
                return
            if path == "/api/ask-codex":
                self.send_json(
                    ask_codex_about_conversation(self.read_json_body(), self.reader.codex_home),
                    status=200,
                )
                return
            create_rollback_suffix = "/rollback-to-message"
            fork_message_suffix = "/fork-from-message"
            rollback_suffix = "/fork-before-rollback"
            compaction_suffix = "/fork-before-compaction"
            archive_suffix = "/archive"
            if path.startswith("/api/main-threads/") and path.endswith(archive_suffix):
                thread_id = unquote(
                    path.removeprefix("/api/main-threads/")[: -len(archive_suffix)]
                ).strip("/")
                if not thread_id:
                    self.send_error_json(400, "Missing thread id")
                    return
                payload = self.read_json_body()
                expected_rollout_path = payload.get("rollout_path")
                if expected_rollout_path is not None and not isinstance(expected_rollout_path, str):
                    self.send_error_json(400, "Invalid rollout_path")
                    return
                self.send_json(
                    self.reader.archive_main_thread(thread_id, expected_rollout_path),
                    status=200,
                )
                return
            if path.startswith("/api/main-threads/") and path.endswith(create_rollback_suffix):
                thread_id = unquote(
                    path.removeprefix("/api/main-threads/")[: -len(create_rollback_suffix)]
                ).strip("/")
                if not thread_id:
                    self.send_error_json(400, "Missing thread id")
                    return
                payload = self.read_json_body()
                line_number = payload.get("line_number")
                if not isinstance(line_number, int):
                    self.send_error_json(400, "Missing target line_number")
                    return
                self.send_json(
                    self.reader.create_rollback_to_message(thread_id, line_number),
                    status=201,
                )
                return
            if path.startswith("/api/main-threads/") and path.endswith(fork_message_suffix):
                thread_id = unquote(
                    path.removeprefix("/api/main-threads/")[: -len(fork_message_suffix)]
                ).strip("/")
                if not thread_id:
                    self.send_error_json(400, "Missing thread id")
                    return
                payload = self.read_json_body()
                line_number = payload.get("line_number")
                if not isinstance(line_number, int):
                    self.send_error_json(400, "Missing target line_number")
                    return
                self.send_json(
                    self.reader.create_fork_from_message(thread_id, line_number),
                    status=201,
                )
                return
            if path.startswith("/api/main-threads/") and path.endswith(rollback_suffix):
                thread_id = unquote(
                    path.removeprefix("/api/main-threads/")[: -len(rollback_suffix)]
                ).strip("/")
                if not thread_id:
                    self.send_error_json(400, "Missing thread id")
                    return
                payload = self.read_json_body()
                line_number = payload.get("line_number")
                if not isinstance(line_number, int):
                    self.send_error_json(400, "Missing rollback line_number")
                    return
                self.send_json(
                    self.reader.create_fork_before_rollback(thread_id, line_number),
                    status=201,
                )
                return
            if path.startswith("/api/main-threads/") and path.endswith(compaction_suffix):
                thread_id = unquote(
                    path.removeprefix("/api/main-threads/")[: -len(compaction_suffix)]
                ).strip("/")
                if not thread_id:
                    self.send_error_json(400, "Missing thread id")
                    return
                payload = self.read_json_body()
                line_number = payload.get("line_number")
                if not isinstance(line_number, int):
                    self.send_error_json(400, "Missing compaction line_number")
                    return
                self.send_json(
                    self.reader.create_fork_before_compaction(thread_id, line_number),
                    status=201,
                )
                return
            self.send_error_json(404, "Not found")
        except ValueError as exc:
            self.send_error_json(400, str(exc))
        except KeyError:
            self.send_error_json(404, "Conversation not found")
        except FileExistsError as exc:
            self.send_error_json(409, f"Generated rollout already exists: {exc}")
        except FileNotFoundError as exc:
            self.send_error_json(500, f"Missing Codex file: {exc}")
        except AskCodexCancelled as exc:
            self.send_error_json(499, str(exc))
        except TimeoutError as exc:
            self.send_error_json(504, str(exc))
        except RuntimeError as exc:
            self.send_error_json(500, str(exc))
        except sqlite3.Error as exc:
            self.send_error_json(500, f"SQLite error: {exc}")
        except OSError as exc:
            self.send_error_json(500, f"I/O error: {exc}")

    def read_json_body(self) -> dict[str, Any]:
        length_value = self.headers.get("Content-Length", "0")
        try:
            length = int(length_value)
        except ValueError as exc:
            raise ValueError("Invalid Content-Length") from exc
        if length <= 0:
            return {}
        body = self.rfile.read(length)
        try:
            payload = json.loads(body.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError("Invalid JSON body") from exc
        if not isinstance(payload, dict):
            raise ValueError("JSON body must be an object")
        return payload

    def log_message(self, fmt: str, *args: object) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def status_payload(self) -> dict[str, Any]:
        payload = self.reader.status()
        host = self.headers.get("Host")
        if not host:
            bind_host, bind_port = self.server.server_address[:2]
            host = f"{bind_host}:{bind_port}"
        payload["server_url"] = f"http://{host}/"
        return payload

    def send_static_file(self, path: Path) -> None:
        self.send_project_file(STATIC_ROOT, path)

    def send_asset_file(self, path: Path) -> None:
        self.send_project_file(ASSET_ROOT, path)

    def send_project_file(self, root: Path, path: Path) -> None:
        root_resolved = root.resolve()
        resolved = path.resolve()
        try:
            resolved.relative_to(root_resolved)
        except ValueError:
            self.send_error_json(403, "Forbidden")
            return
        if not resolved.exists() or not resolved.is_file():
            self.send_error_json(404, "Not found")
            return
        body = resolved.read_bytes()
        content_type = mimetypes.guess_type(str(resolved))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        try:
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            return

    def send_empty(self) -> None:
        self.send_response(204)
        self.send_header("Content-Length", "0")
        try:
            self.end_headers()
        except (BrokenPipeError, ConnectionResetError):
            return

    def send_json(self, payload: Any, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        try:
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            return

    def send_error_json(self, status: int, message: str) -> None:
        self.send_json({"error": message}, status=status)


def main() -> int:
    parser = argparse.ArgumentParser(description="Read Codex main and side conversations.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8765, type=int)
    parser.add_argument("--codex-home", default=str(DEFAULT_CODEX_HOME))
    args = parser.parse_args()

    AppHandler.reader = SideConversationReader(Path(args.codex_home).expanduser())
    server, port = create_server(args.host, args.port)
    if port != args.port:
        print(f"Port {args.port} is unavailable; using {port}.")
    print(f"Codex Conversation Reader running at http://{args.host}:{port}/")
    print(f"Reading Codex data from {Path(args.codex_home).expanduser()}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
    finally:
        server.server_close()
    return 0


def create_server(host: str, port: int) -> tuple[ThreadingHTTPServer, int]:
    last_error: OSError | None = None
    for candidate in range(port, min(port + 50, 65536)):
        try:
            return ThreadingHTTPServer((host, candidate), AppHandler), candidate
        except OSError as exc:
            if exc.errno != errno.EADDRINUSE:
                raise
            last_error = exc
    if last_error is not None:
        raise last_error
    raise OSError(f"No valid port found starting at {port}")


if __name__ == "__main__":
    raise SystemExit(main())
