# Codex Conversation Manager

An unofficial Linux-first local GUI for browsing and managing Codex CLI conversation history.

The app reads Codex CLI data from your local `~/.codex` directory and presents main conversations, side conversations, forks, rollbacks, compactions, tool calls, thinking traces, exports, and message-level search in a desktop or browser UI.

This project is not affiliated with OpenAI.

## Safety And Privacy

Codex conversations can contain private prompts, source code, command output, paths, tokens pasted into chat, and other sensitive data. This app is designed to run locally and does not upload your Codex history.

The local web server binds to `127.0.0.1` by default. Do not expose it to a network unless you understand the privacy risk.

The app reads:

- `~/.codex/logs_2.sqlite`
- `~/.codex/state_5.sqlite`
- `~/.codex/history.jsonl`
- `~/.codex/sessions/**/rollout-*.jsonl`

Some features modify Codex CLI's local files:

- creating forks writes new Codex session records and rollout files
- creating rollbacks appends Codex rollback markers
- archiving moves rollout files under `~/.codex/archived_sessions` and updates Codex state
- exports write files under `~/Downloads/Codex Conversation Manager/`

These write actions are intended to match observed Codex CLI behavior, but they rely on local Codex storage internals. Back up `~/.codex` before using write actions on important conversations.

Do not publish your `~/.codex` directory, exported conversations, screenshots, Playwright dumps, logs, or local SQLite files.

## Features

- Browse main Codex conversations and recovered side conversations.
- View related side conversations, forks, parent conversations, rollbacks, and compactions.
- Search the conversation list by metadata or full conversation text.
- Search inside a selected conversation, including code blocks with horizontal scrolling to matches.
- Filter visible transcript content, including tool calls, thinking traces, events, metadata, and assistant final/interim messages.
- Render Markdown, code blocks, tables, Hebrew/English mixed text, links, tool output, and recovered patch diffs.
- Export the currently filtered conversation as Markdown, plain text, or JSON.
- Ask Codex about the current conversation or selected text through the local `codex` CLI.
- Create Codex-compatible forks from selected messages, before messages, before compactions, or before rollbacks.
- Create rollback markers from the GUI.
- Archive conversations and spawned descendants.

## Requirements

Linux is the only currently tested platform.

The web UI uses only Python's standard library at runtime.

Desktop mode additionally requires GTK 3, PyGObject, and WebKit2GTK 4.1. On Debian/Ubuntu-like systems, the packages are typically:

```bash
sudo apt install python3-gi gir1.2-gtk-3.0 gir1.2-webkit2-4.1
```

The **Ask Codex** feature requires the `codex` CLI to be installed and authenticated.

The browser UI may work on macOS or WSL if Codex CLI uses the same `~/.codex` storage layout there, but those platforms are not currently tested. Native Windows is not supported.

## Run

Desktop app:

```bash
git clone https://github.com/MichaelLulev/codex-conversation-manager.git
cd codex-conversation-manager
./desktop_app.py
```

The desktop shell starts the local backend internally and stops it when the window closes. Launcher logs are written to:

```text
~/.cache/codex-conversation-manager/desktop.log
```

Desktop shortcuts:

- `Ctrl+R` or `F5` reloads the GUI page
- `Ctrl+Shift+R` or `Ctrl+F5` restarts the local backend server and reloads the GUI page
- `Ctrl++` zooms in
- `Ctrl+-` zooms out
- `Ctrl+0` resets to 100%

You can also start with a custom zoom:

```bash
./desktop_app.py --zoom 1.15
```

Web server:

```bash
python3 server.py
```

Open the printed local URL, usually:

```text
http://127.0.0.1:8765/
```

If that port is already in use, the server automatically chooses the next available port and prints the URL.

Optional:

```bash
python3 server.py --port 8899 --codex-home ~/.codex
```

## Desktop Launcher

`launch-desktop.sh` starts the desktop app with the Wayland/XWayland environment variables that were useful on the original development system. It resolves the project directory relative to the script location, so it works from any clone path.

If your desktop environment needs a `.desktop` file, point it at:

```text
/path/to/codex-conversation-manager/launch-desktop.sh
```

## How Side Conversations Are Recovered

Normal main conversations are listed from `state_5.sqlite` and rendered from each session's rollout JSONL file.

Side conversations are best-effort. The app infers side-thread IDs from boundary markers in `logs_2.sqlite`, excludes normal persisted threads from `state_5.sqlite`, then reconstructs text from `history.jsonl` and websocket response events in `logs_2.sqlite`.

Because this is not an official Codex transcript API, side conversation recovery can be incomplete when Codex CLI changes its internal storage.

## Ask Codex

Ask Codex sends a compact export of the currently selected conversation, or the selected text plus context, to:

```bash
codex exec --sandbox read-only --ephemeral
```

The request uses your local Codex CLI installation and authentication. The app does not require an OpenAI API key.

Follow-up questions include the previous Ask Codex Q/A turns for the currently selected conversation. This Ask history is kept only in the current GUI session.

## Development

Run the test suite and syntax checks:

```bash
python3 -m py_compile server.py desktop_app.py test_server.py
node --check static/app.js
node --check static/search-worker.js
python3 -m unittest -v
```

Before publishing changes, confirm that only intended source files are tracked:

```bash
git status --short --ignored
git ls-files
```
