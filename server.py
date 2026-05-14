#!/usr/bin/env python3
"""Local GUI server for reading recovered Codex /side conversations."""

from __future__ import annotations

import argparse
import errno
import json
import mimetypes
import os
import re
import sqlite3
import sys
import time
from dataclasses import asdict
from dataclasses import dataclass
from datetime import datetime
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
MAIN_THREAD_FILTERS = {"all", "with_side", "with_forks", "forked"}
SQLITE_OPEN_ATTEMPTS = 5
SQLITE_OPEN_RETRY_SECONDS = 0.08
MAX_EVENT_BLOCK_CHARS = 120000
OMITTED_IMAGE_RESULT_LABEL = "(base64 image result omitted; saved path/status is shown when available)"
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
    timestamp: int | None
    time: str | None
    source: str
    phase: str | None = None
    item_id: str | None = None


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


def local_time(ts: int | None) -> str | None:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts).astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")


def timestamp_from_iso(value: Any) -> int | None:
    if not isinstance(value, str):
        return None
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


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


class SideConversationReader:
    def __init__(self, codex_home: Path = DEFAULT_CODEX_HOME) -> None:
        self.codex_home = codex_home
        self.logs_db = codex_home / "logs_2.sqlite"
        self.state_db = codex_home / "state_5.sqlite"
        self.history_path = codex_home / "history.jsonl"

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

    def list_threads(self) -> list[SideThreadSummary]:
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
            summaries.append(
                SideThreadSummary(
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
            )
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

    def list_main_threads(self, list_filter: str = "all") -> list[MainThreadSummary]:
        normalized_filter = list_filter if list_filter in MAIN_THREAD_FILTERS else "all"
        rows = self.main_thread_rows()
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
                if (parent := parent_thread_id_from_source(row["source"]))
            }
            rows = [row for row in rows if row["id"] in parent_ids]
        elif normalized_filter == "forked":
            rows = [
                row
                for row in rows
                if parent_thread_id_from_source(row["source"]) is not None
            ]
        return [self.main_summary_from_row(row) for row in rows]

    def main_thread_rows(self) -> list[sqlite3.Row]:
        with connect_readonly(self.state_db) as conn:
            return conn.execute(
                f"""
                select {MAIN_THREAD_SELECT_COLUMNS}
                from threads
                order by coalesce(updated_at_ms, updated_at * 1000) desc, id desc
                """
            ).fetchall()

    def get_main_thread(self, thread_id: str) -> dict[str, Any]:
        row = self.main_thread_row(thread_id)
        messages = self.rollout_messages(row["rollout_path"])
        messages.append(thread_metadata_message(row))
        messages.extend(self.response_metadata_messages(thread_id))
        messages = finalize_messages(messages)
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
            "related": self.related_for_main_thread(thread_id),
            "recovery_note": "Read from Codex's saved rollout transcript for this persisted session.",
        }

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

    def main_summary_from_row(
        self, row: sqlite3.Row, messages: list[Message] | None = None
    ) -> MainThreadSummary:
        user_count = sum(1 for message in messages or [] if message.role == "user")
        assistant_count = sum(1 for message in messages or [] if message.role == "assistant")
        preview_source = row["title"] or row["first_user_message"] or Path(row["rollout_path"]).stem
        source = row["source"] or None
        model = row["model"] or None
        app_version = row["cli_version"] or None
        parent_thread_id = parent_thread_id_from_source(source)
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
            parent_thread_id = parent_thread_id_from_source(current_row["source"])
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
                source_rows = conn.execute(
                    f"""
                    select {MAIN_THREAD_SELECT_COLUMNS}
                    from threads
                    where source like '%thread_spawn%'
                    order by created_at
                    """
                ).fetchall()
        except sqlite3.Error:
            return []

        summaries: list[MainThreadSummary] = []
        for row in source_rows:
            if parent_thread_id_from_source(row["source"]) == parent_thread_id:
                child_ids.add(row["id"])

        for row in self.main_rows_by_ids(child_ids):
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
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                message = self.message_from_rollout_event(item)
                if message is not None and message.text.strip():
                    messages.append(message)
        return finalize_messages(messages)

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


def event_message_from_payload(payload: dict[str, Any], timestamp: int | None) -> Message | None:
    payload_type = payload.get("type")
    if not isinstance(payload_type, str):
        return None
    if payload_type == "context_compacted":
        return event_message("Context Compacted", [], [], timestamp, "rollout event_msg", "compaction")
    if payload_type == "thread_rolled_back":
        return event_message(
            "Thread Rolled Back",
            [("Turns Removed", payload.get("num_turns"))],
            [],
            timestamp,
            "rollout event_msg",
            "rollback",
        )
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
        return [], value, "text"
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
    return [line for line in metadata_text.splitlines() if line.strip()], output_text or "(empty)", "text"


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
            return value, "text"
        if isinstance(parsed, dict | list):
            return json.dumps(parsed, ensure_ascii=False, indent=2), "json"
        return value, "text"
    if isinstance(value, dict | list):
        return json.dumps(value, ensure_ascii=False, indent=2), "json"
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


def message_sort_key(message: Message) -> tuple[int, int, str]:
    role_order = {"event": 0, "user": 1, "thinking": 2, "tool": 3, "assistant": 4}
    return (
        message.timestamp if message.timestamp is not None else 0,
        role_order.get(message.role, 9),
        message.item_id or "",
    )


def finalize_messages(messages: list[Message]) -> list[Message]:
    deduped = dedupe_messages(messages)
    deduped.sort(key=message_sort_key)
    return merge_tool_outputs(deduped)


def dedupe_messages(messages: list[Message]) -> list[Message]:
    by_signature: dict[tuple[str, str, int | None], Message] = {}
    order: list[tuple[str, str, int | None]] = []
    for message in messages:
        signature = (message.role, message.text, message.timestamp)
        current = by_signature.get(signature)
        if current is None:
            by_signature[signature] = message
            order.append(signature)
            continue
        if message_priority(message) > message_priority(current):
            by_signature[signature] = message
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
            elif path == "/api/threads":
                self.send_json([asdict(item) for item in self.reader.list_threads()])
            elif path.startswith("/api/threads/"):
                thread_id = unquote(path.removeprefix("/api/threads/"))
                self.send_json(self.reader.get_thread(thread_id))
            elif path == "/api/main-threads":
                params = parse_qs(parsed.query)
                list_filter = params.get("filter", ["all"])[0]
                self.send_json(
                    [asdict(item) for item in self.reader.list_main_threads(list_filter)]
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
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
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
