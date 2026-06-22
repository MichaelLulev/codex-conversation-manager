#!/usr/bin/env python3
"""Desktop shell for Codex Conversation Manager."""

from __future__ import annotations

import argparse
import errno
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.request import urlopen

from server import DEFAULT_CODEX_HOME


APP_NAME = "Codex Conversation Manager"
PROJECT_ROOT = Path(__file__).resolve().parent
ICON_PATH = PROJECT_ROOT / "assets" / "codex-conversation-manager.png"
DEFAULT_ZOOM = 1.0
MIN_ZOOM = 0.5
MAX_ZOOM = 2.0
ZOOM_STEP = 0.1


def require_gui() -> tuple[object, object, object]:
    try:
        import gi

        gi.require_version("Gdk", "3.0")
        gi.require_version("Gtk", "3.0")
        gi.require_version("WebKit2", "4.1")
        from gi.repository import Gdk
        from gi.repository import Gtk
        from gi.repository import WebKit2
    except Exception as exc:  # pragma: no cover - depends on desktop packages.
        raise RuntimeError(
            "GTK 3 and WebKit2GTK 4.1 are required for the desktop app. "
            "The web server can still be run with `python3 server.py`."
        ) from exc
    return Gdk, Gtk, WebKit2


class LocalAppServer:
    def __init__(self, host: str, port: int, codex_home: Path) -> None:
        self.host = host
        self.port = find_available_port(host, port)
        self.codex_home = codex_home
        self.process: subprocess.Popen[bytes] | None = None

    @property
    def url(self) -> str:
        return f"http://{self.host}:{self.port}/"

    def start(self) -> None:
        if self.process is not None:
            if self.process.poll() is None:
                return
            self.process = None
        env = os.environ.copy()
        env.setdefault("PYTHONUNBUFFERED", "1")
        self.process = subprocess.Popen(
            [
                sys.executable,
                str(PROJECT_ROOT / "server.py"),
                "--host",
                self.host,
                "--port",
                str(self.port),
                "--codex-home",
                str(self.codex_home),
            ],
            cwd=str(PROJECT_ROOT),
            env=env,
        )
        self.wait_ready()

    def wait_ready(self, timeout: float = 10.0) -> None:
        deadline = time.monotonic() + timeout
        last_error: Exception | None = None
        while time.monotonic() < deadline:
            if self.process and self.process.poll() is not None:
                raise RuntimeError(f"Backend exited with status {self.process.returncode}")
            try:
                with urlopen(self.url + "api/status", timeout=0.5) as response:
                    if response.status == 200:
                        return
            except Exception as exc:
                last_error = exc
            time.sleep(0.1)
        self.stop()
        raise RuntimeError(f"Backend did not become ready at {self.url}: {last_error}")

    def stop(self) -> None:
        if self.process is None:
            return
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=2)
        self.process = None

    def restart(self) -> None:
        self.stop()
        self.start()


def find_available_port(host: str, port: int) -> int:
    last_error: OSError | None = None
    for candidate in range(port, min(port + 50, 65536)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind((host, candidate))
            except OSError as exc:
                if exc.errno != errno.EADDRINUSE:
                    raise
                last_error = exc
                continue
            return candidate
    if last_error is not None:
        raise last_error
    raise OSError(f"No valid port found starting at {port}")


class DesktopApp:
    def __init__(self, app_server: LocalAppServer, zoom: float = DEFAULT_ZOOM) -> None:
        self.app_server = app_server
        self.Gdk, self.Gtk, self.WebKit2 = require_gui()
        self.WebKit2.WebContext.get_default().clear_cache()
        self.zoom = clamp_zoom(zoom)

        self.window = self.Gtk.Window(title=APP_NAME)
        self.window.set_default_size(1280, 860)
        self.window.set_position(self.Gtk.WindowPosition.CENTER)
        if ICON_PATH.exists():
            self.window.set_icon_from_file(str(ICON_PATH))
        self.window.connect("destroy", self.on_destroy)
        self.window.connect("key-press-event", self.on_key_press)

        self.webview = self.WebKit2.WebView()
        self.webview.set_zoom_level(self.zoom)
        self.webview.load_uri(f"{app_server.url}?desktop={int(time.time())}")
        self.window.add(self.webview)

    def run(self) -> None:
        signal.signal(signal.SIGINT, signal.SIG_DFL)
        self.window.show_all()
        self.Gtk.main()

    def on_destroy(self, *_args: object) -> None:
        self.app_server.stop()
        self.Gtk.main_quit()

    def on_key_press(self, _widget: object, event: object) -> bool:
        control = bool(event.state & self.Gdk.ModifierType.CONTROL_MASK)
        shift = bool(event.state & self.Gdk.ModifierType.SHIFT_MASK)
        if event.keyval == self.Gdk.KEY_F5:
            if control:
                self.reset_server_and_reload()
            else:
                self.reload()
            return True
        if not control:
            return False

        if event.keyval in {self.Gdk.KEY_r, self.Gdk.KEY_R}:
            if shift:
                self.reset_server_and_reload()
            else:
                self.reload()
            return True
        if event.keyval in {
            self.Gdk.KEY_plus,
            self.Gdk.KEY_KP_Add,
            self.Gdk.KEY_equal,
        }:
            self.change_zoom(ZOOM_STEP)
            return True
        if event.keyval in {self.Gdk.KEY_minus, self.Gdk.KEY_KP_Subtract}:
            self.change_zoom(-ZOOM_STEP)
            return True
        if event.keyval in {self.Gdk.KEY_0, self.Gdk.KEY_KP_0}:
            self.set_zoom(DEFAULT_ZOOM)
            return True
        return False

    def change_zoom(self, delta: float) -> None:
        self.set_zoom(self.webview.get_zoom_level() + delta)

    def set_zoom(self, zoom: float) -> None:
        self.zoom = clamp_zoom(zoom)
        self.webview.set_zoom_level(self.zoom)
        percent = round(self.zoom * 100)
        self.window.set_title(f"{APP_NAME} - {percent}%")

    def reload(self) -> None:
        self.webview.reload()

    def reset_server_and_reload(self) -> None:
        self.window.set_title(f"{APP_NAME} - resetting server")
        self.flush_gui_events()
        try:
            self.app_server.restart()
        except Exception as exc:
            self.show_error("Server reset failed", str(exc))
            self.set_zoom(self.zoom)
            return
        self.webview.load_uri(f"{self.app_server.url}?desktop={int(time.time())}")
        self.set_zoom(self.zoom)

    def flush_gui_events(self) -> None:
        while self.Gtk.events_pending():
            self.Gtk.main_iteration_do(False)

    def show_error(self, title: str, message: str) -> None:
        dialog = self.Gtk.MessageDialog(
            transient_for=self.window,
            flags=self.Gtk.DialogFlags.MODAL,
            message_type=self.Gtk.MessageType.ERROR,
            buttons=self.Gtk.ButtonsType.CLOSE,
            text=title,
        )
        dialog.format_secondary_text(message)
        dialog.run()
        dialog.destroy()


def clamp_zoom(zoom: float) -> float:
    return min(MAX_ZOOM, max(MIN_ZOOM, zoom))


def run_check(host: str, port: int, codex_home: Path) -> int:
    require_gui()
    app_server = LocalAppServer(host, port, codex_home)
    app_server.start()
    try:
        with urlopen(app_server.url + "api/status", timeout=5) as response:
            if response.status != 200:
                print(f"Health check failed: HTTP {response.status}", file=sys.stderr)
                return 1
        print(f"Desktop app check OK: {app_server.url}")
        return 0
    finally:
        app_server.stop()


def main() -> int:
    parser = argparse.ArgumentParser(description=f"Run {APP_NAME} as a desktop app.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8765, type=int)
    parser.add_argument("--codex-home", default=str(DEFAULT_CODEX_HOME))
    parser.add_argument(
        "--zoom",
        default=DEFAULT_ZOOM,
        type=float,
        help="initial desktop window zoom level, for example 0.9 or 1.25",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify GUI dependencies and local backend startup without opening a window",
    )
    args = parser.parse_args()

    codex_home = Path(args.codex_home).expanduser()
    if args.check:
        return run_check(args.host, args.port, codex_home)

    app_server = LocalAppServer(args.host, args.port, codex_home)
    app_server.start()
    print(f"{APP_NAME} running at {app_server.url}")
    print(f"Reading Codex data from {codex_home}")
    try:
        DesktopApp(app_server, args.zoom).run()
    except Exception:
        app_server.stop()
        raise
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
