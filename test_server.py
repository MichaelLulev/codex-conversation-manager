import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import server


def json_line(item):
    return json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n"


def session_meta_line(thread_id="source-thread"):
    return json_line(
        {
            "timestamp": "2026-06-02T12:00:00.000Z",
            "type": "session_meta",
            "payload": {"id": thread_id},
        }
    )


def response_message_line(role, text):
    return json_line(
        {
            "timestamp": "2026-06-02T12:00:00.000Z",
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": role,
                "content": [{"type": "input_text", "text": text}],
            },
        }
    )


def event_line(payload):
    return json_line(
        {
            "timestamp": "2026-06-02T12:00:00.000Z",
            "type": "event_msg",
            "payload": payload,
        }
    )


class SyntheticForkTests(unittest.TestCase):
    def test_strip_leading_session_meta_removes_source_meta(self):
        user_line = response_message_line("user", "hello")

        copied = server.strip_leading_session_meta([session_meta_line(), user_line])

        self.assertEqual(copied, [user_line])

    def test_append_interrupted_boundary_for_user_message_prefix(self):
        lines, added = server.append_interrupted_boundary_if_needed(
            [response_message_line("user", "continue from here")],
            "2026-06-02T12:01:00.000Z",
        )

        self.assertTrue(added)
        marker = json.loads(lines[-2])
        event = json.loads(lines[-1])
        self.assertEqual(marker["payload"]["role"], "user")
        self.assertEqual(
            marker["payload"]["content"][0]["text"],
            server.TURN_ABORTED_MARKER_TEXT,
        )
        self.assertEqual(event["payload"]["type"], "turn_aborted")
        self.assertEqual(event["payload"]["reason"], "interrupted")
        self.assertIsNone(event["payload"]["turn_id"])
        self.assertEqual(server.fork_interrupt_state(lines), (False, None))

    def test_no_interruption_when_turn_complete_after_user(self):
        lines, added = server.append_interrupted_boundary_if_needed(
            [
                response_message_line("user", "hello"),
                response_message_line("assistant", "done"),
                event_line({"type": "turn_complete", "turn_id": "turn-1"}),
            ],
            "2026-06-02T12:01:00.000Z",
        )

        self.assertFalse(added)
        self.assertEqual(len(lines), 3)

    def test_legacy_prefix_with_assistant_answer_still_counts_as_mid_turn(self):
        lines, added = server.append_interrupted_boundary_if_needed(
            [
                response_message_line("user", "hello"),
                response_message_line("assistant", "done"),
            ],
            "2026-06-02T12:01:00.000Z",
        )

        self.assertTrue(added)
        self.assertEqual(len(lines), 4)
        event = json.loads(lines[-1])
        self.assertEqual(event["payload"]["type"], "turn_aborted")

    def test_no_interruption_when_turn_aborted_after_user(self):
        lines, added = server.append_interrupted_boundary_if_needed(
            [
                response_message_line("user", "hello"),
                response_message_line("assistant", "partial"),
                event_line({"type": "turn_aborted", "reason": "interrupted"}),
            ],
            "2026-06-02T12:01:00.000Z",
        )

        self.assertFalse(added)
        self.assertEqual(len(lines), 3)

    def test_open_explicit_turn_preserves_turn_id(self):
        lines, added = server.append_interrupted_boundary_if_needed(
            [
                event_line({"type": "task_started", "turn_id": "turn-123"}),
                response_message_line("user", "run command"),
                response_message_line("assistant", "working"),
            ],
            "2026-06-02T12:01:00.000Z",
        )

        self.assertTrue(added)
        event = json.loads(lines[-1])
        self.assertEqual(event["payload"]["turn_id"], "turn-123")

    def test_context_turn_aborted_marker_is_not_treated_as_user_turn(self):
        lines, added = server.append_interrupted_boundary_if_needed(
            [server.interrupted_marker_line("2026-06-02T12:01:00.000Z")],
            "2026-06-02T12:02:00.000Z",
        )

        self.assertFalse(added)
        self.assertEqual(len(lines), 1)


def create_state_db(home: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(home / "state_5.sqlite")
    conn.execute(
        """
        create table threads (
            id text primary key,
            rollout_path text not null,
            created_at integer not null,
            updated_at integer not null,
            title text not null default '',
            first_user_message text not null default '',
            cwd text not null default '',
            model text,
            cli_version text not null default '',
            archived integer not null default 0,
            archived_at integer,
            source text not null default 'cli',
            model_provider text not null default 'openai',
            sandbox_policy text not null default 'read-only',
            approval_mode text not null default 'never',
            tokens_used integer not null default 0,
            has_user_event integer not null default 0,
            git_sha text,
            git_branch text,
            git_origin_url text,
            agent_nickname text,
            agent_role text,
            memory_mode text not null default 'enabled',
            reasoning_effort text,
            agent_path text,
            created_at_ms integer,
            updated_at_ms integer,
            thread_source text,
            preview text not null default ''
        )
        """
    )
    conn.execute(
        """
        create table thread_spawn_edges (
            parent_thread_id text not null,
            child_thread_id text not null,
            status text not null default 'open',
            created_at integer not null default 0,
            updated_at integer not null default 0,
            primary key (parent_thread_id, child_thread_id)
        )
        """
    )
    conn.commit()
    return conn


def create_rollout(home: Path, thread_id: str, minute: int) -> Path:
    rollout_dir = home / "sessions" / "2026" / "06" / "02"
    rollout_dir.mkdir(parents=True, exist_ok=True)
    rollout_path = rollout_dir / f"rollout-2026-06-02T12-{minute:02d}-00-{thread_id}.jsonl"
    rollout_path.write_text(
        session_meta_line(thread_id)
        + response_message_line("user", f"hello from {thread_id}")
        + response_message_line("assistant", "done"),
        encoding="utf-8",
    )
    return rollout_path


def insert_thread(conn: sqlite3.Connection, thread_id: str, rollout_path: Path, title: str) -> None:
    conn.execute(
        """
        insert into threads (
            id, rollout_path, created_at, updated_at, title, first_user_message,
            cwd, model, cli_version, archived, archived_at, source, model_provider,
            sandbox_policy, approval_mode, tokens_used, has_user_event, memory_mode,
            created_at_ms, updated_at_ms, thread_source, preview
        )
        values (?, ?, 1780401600, 1780401600, ?, ?, ?, 'gpt-test', 'test',
            0, null, 'cli', 'openai', 'read-only', 'never', 0, 1, 'enabled',
            1780401600000, 1780401600000, 'user', ?)
        """,
        (
            thread_id,
            str(rollout_path),
            title,
            f"hello from {thread_id}",
            str(rollout_path.parent),
            title,
        ),
    )
    conn.commit()


class ArchiveConversationTests(unittest.TestCase):
    def test_archive_moves_rollout_updates_state_and_filters_active_list(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir)
            conn = create_state_db(home)
            thread_id = "00000000-0000-0000-0000-000000000101"
            rollout_path = create_rollout(home, thread_id, 0)
            insert_thread(conn, thread_id, rollout_path, "Archive me")
            conn.close()

            reader = server.SideConversationReader(home)
            active_before = reader.list_main_threads("all")
            self.assertEqual([item.id for item in active_before], [thread_id])

            result = reader.archive_main_thread(thread_id, str(rollout_path))

            archived_path = home / "archived_sessions" / rollout_path.name
            self.assertFalse(rollout_path.exists())
            self.assertTrue(archived_path.exists())
            self.assertEqual(result["archived_count"], 1)
            self.assertEqual(result["descendant_errors"], [])
            self.assertTrue(Path(result["state_db_backup"]).exists())

            with sqlite3.connect(home / "state_5.sqlite") as verify:
                row = verify.execute(
                    "select archived, archived_at, rollout_path from threads where id = ?",
                    (thread_id,),
                ).fetchone()
            self.assertEqual(row[0], 1)
            self.assertIsNotNone(row[1])
            self.assertEqual(row[2], str(archived_path))
            self.assertEqual(reader.list_main_threads("all"), [])
            archived = reader.list_main_threads("archived")
            self.assertEqual([item.id for item in archived], [thread_id])

    def test_archive_also_archives_spawned_descendants(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir)
            conn = create_state_db(home)
            parent_id = "00000000-0000-0000-0000-000000000201"
            child_id = "00000000-0000-0000-0000-000000000202"
            grandchild_id = "00000000-0000-0000-0000-000000000203"
            parent_path = create_rollout(home, parent_id, 0)
            child_path = create_rollout(home, child_id, 1)
            grandchild_path = create_rollout(home, grandchild_id, 2)
            insert_thread(conn, parent_id, parent_path, "Parent")
            insert_thread(conn, child_id, child_path, "Child")
            insert_thread(conn, grandchild_id, grandchild_path, "Grandchild")
            conn.execute(
                "insert into thread_spawn_edges (parent_thread_id, child_thread_id) values (?, ?)",
                (parent_id, child_id),
            )
            conn.execute(
                "insert into thread_spawn_edges (parent_thread_id, child_thread_id) values (?, ?)",
                (child_id, grandchild_id),
            )
            conn.commit()
            conn.close()

            reader = server.SideConversationReader(home)
            result = reader.archive_main_thread(parent_id, str(parent_path))

            archived_ids = [item["id"] for item in result["archived_threads"]]
            self.assertEqual(archived_ids, [parent_id, grandchild_id, child_id])
            self.assertFalse(parent_path.exists())
            self.assertFalse(child_path.exists())
            self.assertFalse(grandchild_path.exists())
            self.assertTrue((home / "archived_sessions" / parent_path.name).exists())
            self.assertTrue((home / "archived_sessions" / child_path.name).exists())
            self.assertTrue((home / "archived_sessions" / grandchild_path.name).exists())

            with sqlite3.connect(home / "state_5.sqlite") as verify:
                rows = verify.execute(
                    "select id, archived from threads order by id"
                ).fetchall()
            self.assertEqual(rows, [(parent_id, 1), (child_id, 1), (grandchild_id, 1)])
            self.assertEqual(reader.list_main_threads("all"), [])
            self.assertEqual(
                {item.id for item in reader.list_main_threads("archived")},
                {parent_id, child_id, grandchild_id},
            )


class AskCodexCancellationTests(unittest.TestCase):
    def test_cancel_before_registration_marks_request_cancelled_on_registration(self):
        request_id = "test-prelaunch-cancel"
        result = server.cancel_ask_codex_request(request_id)
        self.assertTrue(result["cancelled"])
        self.assertFalse(result["process_started"])
        state = server.register_ask_codex_request(request_id)
        try:
            self.assertTrue(state.cancelled)
        finally:
            server.unregister_ask_codex_request(request_id, state)

    def test_cancel_ask_codex_request_terminates_registered_process(self):
        request_id = "test-cancel-request"
        state = server.register_ask_codex_request(request_id)
        process = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(60)"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        try:
            cancelled_before_attach = server.attach_ask_codex_process(
                request_id,
                state,
                process,
            )
            self.assertFalse(cancelled_before_attach)
            result = server.cancel_ask_codex_request(request_id)
            self.assertTrue(result["cancelled"])
            self.assertTrue(result["process_started"])
            process.wait(timeout=5)
            self.assertIsNotNone(process.returncode)
            self.assertNotEqual(process.returncode, 0)
        finally:
            if process.poll() is None:
                server.terminate_process_group(process, server.signal.SIGKILL)
                process.wait(timeout=5)
            server.unregister_ask_codex_request(request_id, state)


if __name__ == "__main__":
    unittest.main()
