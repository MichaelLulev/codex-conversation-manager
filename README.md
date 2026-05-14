# Codex Conversation Reader

A local web GUI for reading Codex CLI conversations.

The app is read-only. It reads:

- `~/.codex/logs_2.sqlite`
- `~/.codex/state_5.sqlite`
- `~/.codex/history.jsonl`
- `~/.codex/sessions/**/rollout-*.jsonl`

It does not modify Codex files.

## Run

Desktop app:

```bash
cd ~/Projects/CodexSideReader
./desktop_app.py
```

The desktop launcher is installed as **Codex Conversation Reader**. It starts
the local backend internally and stops it when the window closes.
Launcher logs are written to
`~/.cache/codex-conversation-reader/desktop.log`.
The launcher and app window use the icon in
`assets/codex-conversation-reader.png`.

Desktop zoom:

- `Ctrl++` zooms in
- `Ctrl+-` zooms out
- `Ctrl+0` resets to 100%

You can also start with a custom zoom:

```bash
./desktop_app.py --zoom 1.15
```

Web server:

```bash
cd ~/Projects/CodexSideReader
python3 server.py
```

Open:

```text
http://127.0.0.1:8765/
```

If that port is already in use, the server automatically chooses the next available port and prints the URL.

Optional:

```bash
python3 server.py --port 8899 --codex-home ~/.codex
```

## What It Shows

The **Main** tab lists persisted top-level Codex sessions from `state_5.sqlite` and reads their user-facing transcript messages from each session's rollout JSONL file.

The **Side** tab finds ephemeral side-thread IDs by looking for the side-conversation boundary marker in `logs_2.sqlite`, then excludes normal persisted threads from `state_5.sqlite`.

When related conversations are available, the reader shows a **Related** panel above the transcript:

- forked/subagent conversations spawned from the selected main session
- side conversations inferred to belong to the selected main session
- parent conversations when viewing a forked or side conversation

For side conversations, it reconstructs:

- user prompts from `history.jsonl`
- assistant messages from websocket response events in `logs_2.sqlite`
- basic metadata such as time, model, working directory, and thread ID when available

Side conversation recovery is best-effort from logs, not an official Codex transcript format.
