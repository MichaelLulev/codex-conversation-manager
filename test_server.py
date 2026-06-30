import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

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


def turn_context_line():
    return json_line(
        {
            "timestamp": "2026-06-02T12:00:00.000Z",
            "type": "turn_context",
            "payload": {"cwd": "/tmp"},
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


class PatchDiffTests(unittest.TestCase):
    def test_patch_apply_message_includes_saved_update_diff(self):
        message = server.patch_apply_message(
            {
                "type": "patch_apply_end",
                "status": "completed",
                "success": True,
                "changes": {
                    "/tmp/example.py": {
                        "type": "update",
                        "unified_diff": "@@ -1,1 +1,1 @@\n-old\n+new\n",
                    }
                },
            },
            None,
        )

        self.assertIn("**Diff**", message.text)
        self.assertIn("```diff", message.text)
        self.assertIn("diff --git a/tmp/example.py b/tmp/example.py", message.text)
        self.assertIn("-old", message.text)
        self.assertIn("+new", message.text)

    def test_patch_apply_message_preserves_nested_code_fences(self):
        message = server.patch_apply_message(
            {
                "type": "patch_apply_end",
                "status": "completed",
                "success": True,
                "changes": {
                    "/tmp/workflows.md": {
                        "type": "update",
                        "unified_diff": "@@ -1,3 +1,3 @@\n ```bash\n-old\n+new\n ```\n",
                    }
                },
            },
            None,
        )

        self.assertIn("````diff", message.text)
        self.assertIn("```bash", message.text)
        self.assertNotIn("``\\`bash", message.text)

    def test_patch_changes_diff_synthesizes_add_and_delete_diffs(self):
        diff = server.patch_changes_diff(
            {
                "/tmp/new.txt": {"type": "add", "content": "one\ntwo\n"},
                "/tmp/old.txt": {"type": "delete", "content": "gone\n"},
            }
        )

        self.assertIsNotNone(diff)
        assert diff is not None
        self.assertIn("new file mode 100644", diff)
        self.assertIn("--- /dev/null", diff)
        self.assertIn("+++ b/tmp/new.txt", diff)
        self.assertIn("+one", diff)
        self.assertIn("deleted file mode 100644", diff)
        self.assertIn("--- a/tmp/old.txt", diff)
        self.assertIn("+++ /dev/null", diff)
        self.assertIn("-gone", diff)

    def test_diff_filter_key_is_additive(self):
        message = server.Message(
            role="assistant",
            text="Here is the change:\n\n```diff\n-old\n+new\n```",
            timestamp=None,
            time=None,
            source="test",
        )

        self.assertEqual(server.message_filter_key(message), "assistant")
        self.assertEqual(server.message_filter_keys(message), {"assistant", "diff"})

    def test_diff_filter_key_ignores_plain_plus_minus_text(self):
        message = server.Message(
            role="assistant",
            text="Use + to add and - to subtract.",
            timestamp=None,
            time=None,
            source="test",
        )

        self.assertEqual(server.message_filter_keys(message), {"assistant"})

    def test_diff_only_markdown_extracts_only_diff_fences(self):
        text = "\n".join(
            [
                "**Patch Applied**",
                "Changed Files:",
                "```json",
                '{"path": "example.py"}',
                "```",
                "",
                "```diff",
                "-old",
                "+new",
                "```",
                "",
                "Stdout: ok",
            ]
        )

        self.assertEqual(server.diff_only_markdown(text), "```diff\n-old\n+new\n```")

    def test_message_text_for_diff_filter_uses_only_diff_text(self):
        message = server.Message(
            role="event",
            text="Metadata should be hidden.\n\n```diff\n-old\n+new\n```",
            timestamp=None,
            time=None,
            source="test",
            phase="patch",
        )

        self.assertEqual(
            server.message_text_for_filters(message, {"diff"}),
            "```diff\n-old\n+new\n```",
        )
        self.assertEqual(server.message_text_for_filters(message, {"patch"}), message.text)


class MainSegmentTests(unittest.TestCase):
    def message(self, index):
        return server.Message(
            role="user",
            text=f"message {index}",
            timestamp=None,
            time=None,
            source="test",
        )

    def compaction(self, ordinal, message_index):
        return server.CompactionCheckpoint(
            ordinal=ordinal,
            line_number=ordinal * 10,
            copy_line_count=ordinal * 10 - 1,
            timestamp=None,
            time=None,
            kind="compacted",
            label="Compacted summary",
            summary=f"compaction {ordinal}",
            message_index=message_index,
        )

    def rollback(self, ordinal, message_index):
        return server.RollbackCheckpoint(
            ordinal=ordinal,
            line_number=ordinal * 20,
            copy_line_count=ordinal * 20 - 1,
            timestamp=None,
            time=None,
            rollback_turns=1,
            summary=f"rollback {ordinal}",
            message_index=message_index,
        )

    def test_segments_start_at_compaction_boundaries(self):
        messages = [self.message(index) for index in range(6)]
        compactions = [self.compaction(1, 1), self.compaction(2, 4)]

        segments = server.conversation_segments(messages, compactions)

        self.assertEqual(
            [(segment.start_message_index, segment.end_message_index) for segment in segments],
            [(0, 0), (1, 3), (4, 5)],
        )
        self.assertEqual([segment.id for segment in segments], ["segment-1", "segment-2", "segment-3"])
        self.assertEqual(segments[1].boundary_compaction["ordinal"], 1)
        self.assertEqual(segments[2].boundary_compaction["ordinal"], 2)

    def test_segments_without_compactions_cover_full_conversation(self):
        messages = [self.message(index) for index in range(3)]

        segments = server.conversation_segments(messages, [])

        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0].start_message_index, 0)
        self.assertEqual(segments[0].end_message_index, 2)
        self.assertEqual(segments[0].message_count, 3)

    def test_segment_message_dicts_keep_global_indexes(self):
        messages = [self.message(index) for index in range(4)]
        compactions = [self.compaction(1, 2)]
        segments = server.conversation_segments(messages, compactions)

        message_dicts = server.message_dicts_for_segment(messages, segments, segments[1])

        self.assertEqual([item["text"] for item in message_dicts], ["message 2", "message 3"])
        self.assertEqual([item["global_message_index"] for item in message_dicts], [2, 3])
        self.assertEqual({item["segment_id"] for item in message_dicts}, {"segment-2"})

    def test_segment_message_dicts_omit_collapsed_event_text(self):
        messages = [
            self.message(0),
            server.Message(
                role="event",
                text="Large event payload\nwith details",
                timestamp=None,
                time=None,
                source="test",
                phase="context",
            ),
            server.Message(
                role="event",
                text="Patch event\n\n```diff\n-old\n+new\n```",
                timestamp=None,
                time=None,
                source="test",
                phase="patch",
            ),
        ]
        segments = server.conversation_segments(messages, [])

        message_dicts = server.message_dicts_for_segment(messages, segments, segments[0])

        self.assertEqual(message_dicts[0]["text"], "message 0")
        self.assertFalse(message_dicts[0]["text_omitted"])
        self.assertEqual(message_dicts[1]["text"], "")
        self.assertTrue(message_dicts[1]["text_omitted"])
        self.assertFalse(message_dicts[1]["text_loaded"])
        self.assertEqual(message_dicts[1]["text_preview"], "Large event payload")
        self.assertEqual(message_dicts[1]["text_length"], len("Large event payload\nwith details"))
        self.assertIn("```diff", message_dicts[2]["text"])
        self.assertFalse(message_dicts[2]["text_omitted"])

    def test_checkpoint_dicts_include_containing_segment(self):
        messages = [self.message(index) for index in range(6)]
        compactions = [self.compaction(1, 1), self.compaction(2, 4)]
        rollbacks = [self.rollback(1, 5)]
        segments = server.conversation_segments(messages, compactions)

        rollback_dicts = server.checkpoint_dicts_with_segments(rollbacks, segments)

        self.assertEqual(rollback_dicts[0]["message_index"], 5)
        self.assertEqual(rollback_dicts[0]["global_message_index"], 5)
        self.assertEqual(rollback_dicts[0]["segment_id"], "segment-3")


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


def create_two_turn_rollout(home: Path, thread_id: str) -> Path:
    rollout_dir = home / "sessions" / "2026" / "06" / "02"
    rollout_dir.mkdir(parents=True, exist_ok=True)
    rollout_path = rollout_dir / f"rollout-2026-06-02T12-30-00-{thread_id}.jsonl"
    rollout_path.write_text(
        session_meta_line(thread_id)
        + response_message_line("user", "first prompt")
        + response_message_line("assistant", "first answer")
        + event_line({"type": "turn_complete", "turn_id": "turn-1"})
        + event_line({"type": "task_started", "turn_id": "turn-2"})
        + turn_context_line()
        + response_message_line("user", "second prompt")
        + event_line({"type": "user_message", "message": "second prompt"})
        + response_message_line("assistant", "second answer"),
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


class ConversationForkTests(unittest.TestCase):
    def test_fork_before_message_excludes_target_user_prompt_without_interruption(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir)
            conn = create_state_db(home)
            thread_id = "00000000-0000-0000-0000-000000000301"
            rollout_path = create_two_turn_rollout(home, thread_id)
            insert_thread(conn, thread_id, rollout_path, "Fork source")
            conn.close()

            reader = server.SideConversationReader(home)
            target = next(
                item for item in reader.rollout_messages(str(rollout_path))
                if item.text == "second prompt" and item.source == "rollout event_msg"
            )
            result = reader.create_fork_before_message(thread_id, target.line_number)

            self.assertFalse(result["interrupted_boundary_added"])
            fork_path = Path(result["rollout_path"])
            fork_text = fork_path.read_text(encoding="utf-8")
            self.assertIn("first prompt", fork_text)
            self.assertIn("first answer", fork_text)
            self.assertNotIn("second prompt", fork_text)
            self.assertNotIn("turn-2", fork_text)
            self.assertNotIn(server.TURN_ABORTED_MARKER_TEXT, fork_text)

            fork_lines = [json.loads(line) for line in fork_text.splitlines() if line.strip()]
            self.assertEqual(fork_lines[0]["type"], "session_meta")
            self.assertEqual(fork_lines[0]["payload"]["id"], result["id"])
            self.assertEqual(fork_lines[0]["payload"]["forked_from_id"], thread_id)

            fork_messages = [
                item for item in reader.rollout_messages(str(fork_path))
                if item.role in {"user", "assistant"}
            ]
            self.assertEqual([item.text for item in fork_messages], ["first prompt", "first answer"])

    def test_fork_after_assistant_response_excludes_next_user_turn_without_interruption(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir)
            conn = create_state_db(home)
            thread_id = "00000000-0000-0000-0000-000000000302"
            rollout_path = create_two_turn_rollout(home, thread_id)
            insert_thread(conn, thread_id, rollout_path, "Fork source")
            conn.close()

            reader = server.SideConversationReader(home)
            target = next(
                item for item in reader.rollout_messages(str(rollout_path))
                if item.text == "first answer"
            )
            result = reader.create_fork_after_assistant_response(thread_id, target.line_number)

            self.assertFalse(result["interrupted_boundary_added"])
            fork_path = Path(result["rollout_path"])
            fork_text = fork_path.read_text(encoding="utf-8")
            self.assertIn("first prompt", fork_text)
            self.assertIn("first answer", fork_text)
            self.assertIn("turn_complete", fork_text)
            self.assertNotIn("second prompt", fork_text)
            self.assertNotIn("turn-2", fork_text)
            self.assertNotIn(server.TURN_ABORTED_MARKER_TEXT, fork_text)

            fork_messages = [
                item for item in reader.rollout_messages(str(fork_path))
                if item.role in {"user", "assistant"}
            ]
            self.assertEqual([item.text for item in fork_messages], ["first prompt", "first answer"])

    def test_fork_after_assistant_response_requires_completed_boundary(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir)
            conn = create_state_db(home)
            thread_id = "00000000-0000-0000-0000-000000000303"
            rollout_dir = home / "sessions" / "2026" / "06" / "02"
            rollout_dir.mkdir(parents=True, exist_ok=True)
            rollout_path = rollout_dir / f"rollout-2026-06-02T12-31-00-{thread_id}.jsonl"
            rollout_path.write_text(
                session_meta_line(thread_id)
                + response_message_line("user", "first prompt")
                + response_message_line("assistant", "first answer"),
                encoding="utf-8",
            )
            insert_thread(conn, thread_id, rollout_path, "Fork source")
            conn.close()

            reader = server.SideConversationReader(home)
            target = next(
                item for item in reader.rollout_messages(str(rollout_path))
                if item.text == "first answer"
            )
            with self.assertRaisesRegex(ValueError, "no completed turn boundary"):
                reader.create_fork_after_assistant_response(thread_id, target.line_number)


class ExportTests(unittest.TestCase):
    def test_save_export_file_writes_unique_file_under_downloads(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            with mock.patch.dict(os.environ, {"HOME": temp_dir}):
                first = server.save_export_file({
                    "filename": "../../conversation:one?.md",
                    "content": "# first\n",
                })
                second = server.save_export_file({
                    "filename": "../../conversation:one?.md",
                    "content": "# second\n",
                })

            first_path = Path(first["path"])
            second_path = Path(second["path"])
            expected_dir = Path(temp_dir) / "Downloads" / server.EXPORTS_DIR_NAME
            self.assertEqual(first_path.parent, expected_dir)
            self.assertEqual(second_path.parent, expected_dir)
            self.assertNotEqual(first_path, second_path)
            self.assertEqual(first_path.read_text(encoding="utf-8"), "# first\n")
            self.assertEqual(second_path.read_text(encoding="utf-8"), "# second\n")


class AskCodexPromptTests(unittest.TestCase):
    def test_build_prompt_includes_ask_history_before_question(self):
        prompt = server.build_ask_codex_prompt(
            question="follow up?",
            history="Turn 1\nQuestion: first?\nAnswer: first.",
            context="MSG 1\nhello",
            kind="main",
            thread_id="thread-1",
            title="Thread",
            context_truncated=False,
        )

        self.assertLess(prompt.index("Previous Ask Codex exchange:"), prompt.index("Question:\nfollow up?"))


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
