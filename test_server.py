import json
import unittest

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


if __name__ == "__main__":
    unittest.main()
