#!/usr/bin/env python3
"""Dashboard for the bots: click Apply in your browser instead of typing commands.

  .venv/bin/python ui/server.py                 # opens http://127.0.0.1:8765
  .venv/bin/python ui/server.py --port 9000 --no-browser

Each click runs that bot's own run.py, unchanged, inside a pseudo-terminal, so its questions
("log in, then press Enter", "Apply to X? [y/N/q]") show up on the page with buttons to answer them.
Only reachable from this machine.
"""
import argparse
import codecs
import json
import os
import pty
import re
import select
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import webbrowser
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import yaml

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
ACTIONS = ("apply", "dry-run", "login", "refer")
STATUSES = ("applied", "already_applied", "skipped", "needs_manual", "external", "failed")
PYTHON = ROOT / ".venv" / "bin" / "python"
SHOT_RE = re.compile(r"\[([\w.-]+\.png)\]")
FIRST = ("instahyre", "cutshort", "hirist")


def bots():
    """Every bot folder (one with a run.py), so a new bot shows up without touching this file."""
    found = sorted(path.parent.name for path in ROOT.glob("*/run.py"))
    return [b for b in FIRST if b in found] + [b for b in found if b not in FIRST]


class Run:
    """One run.py process and everything it has printed."""

    def __init__(self, bot, action, argv):
        self.bot, self.action = bot, action
        self.id = f"{bot}-{time.time_ns()}"
        self.started, self.ended = time.time(), None
        self.stopped = False
        self.text = ""
        self.fd, tty = pty.openpty()
        try:
            self.proc = subprocess.Popen(
                [str(PYTHON if PYTHON.exists() else sys.executable), "run.py", *argv],
                cwd=ROOT / bot,
                stdin=tty,
                stdout=tty,
                stderr=tty,
                start_new_session=True,  # its own process group, so Stop can clean up everything it started
                env={**os.environ, "PYTHONUNBUFFERED": "1"},
            )
        except OSError:
            os.close(self.fd)
            raise
        finally:
            os.close(tty)
        threading.Thread(target=self._pump, daemon=True).start()

    @property
    def running(self):
        return self.proc.poll() is None

    def _pump(self):
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        while True:
            ready, _, _ = select.select([self.fd], [], [], 0.5)
            if ready:
                try:
                    data = os.read(self.fd, 4096)
                except OSError:  # macOS: EIO once nothing holds the terminal open any more
                    data = b""
                if not data:
                    break
                self.text += decoder.decode(data)
            elif self.proc.poll() is not None:
                break  # exited, but something it started still holds the terminal open
        self.proc.wait()
        self.ended = time.time()
        os.close(self.fd)

    def send(self, text):
        """Type a line into the bot, as if at its terminal."""
        if self.running:
            os.write(self.fd, (text + "\n").encode())

    def stop(self):
        """Like Ctrl-C: the bot closes its browser and exits. Escalate if it doesn't."""
        if self.running:
            self.stopped = True
            self.proc.send_signal(signal.SIGINT)
            threading.Thread(target=self._kill_if_stuck, daemon=True).start()

    def _kill_if_stuck(self):
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                self.proc.wait(timeout=10)
                break
            except subprocess.TimeoutExpired:
                self._signal_group(sig)
        self._signal_group(signal.SIGTERM)  # e.g. the login Chrome window it was waiting on

    def _signal_group(self, sig):
        try:
            os.killpg(self.proc.pid, sig)
        except (ProcessLookupError, PermissionError):
            pass

    def summary(self):
        return {
            "id": self.id,
            "action": self.action,
            "running": self.running,
            "exit": self.proc.returncode,
            "stopped": self.stopped,
            "started": self.started,
            "ended": self.ended,
        }


runs = {}  # bot -> its latest Run
runs_lock = threading.Lock()


def start(bot, action, confirm=False, assist=False, max_apply=None):
    if not (ROOT / bot / "config.yaml").exists():
        raise ValueError(f"{bot}/config.yaml is missing: copy {bot}/config.example.yaml to it and edit it.")
    if action == "login":
        argv = ["login"]
    elif action == "refer":
        argv = ["refer", *(["--confirm"] if confirm else []), *(["--max", str(int(max_apply))] if max_apply else [])]
    else:
        argv = ["run"]
        if action == "dry-run":
            argv.append("--dry-run")
        if action == "apply" and confirm:
            argv.append("--confirm")
        if action == "apply" and assist:
            argv.append("--assist")
        if max_apply:
            argv += ["--max", str(int(max_apply))]
    with runs_lock:
        if bot in runs and runs[bot].running:
            raise ValueError(f"{bot} is already running.")
        runs[bot] = Run(bot, action, argv)


def query(bot, sql, args=()):
    path = ROOT / bot / "data" / "jobs.db"
    if not path.exists():
        return []
    try:
        with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2)) as db:
            return db.execute(sql, args).fetchall()
    except sqlite3.Error:
        return []


def bot_state(bot, since):
    cfg_path = ROOT / bot / "config.yaml"
    try:
        cfg = (yaml.safe_load(cfg_path.read_text()) or {}) if cfg_path.exists() else {}
    except yaml.YAMLError:
        cfg = {}  # run.py will report the mistake when it starts
    limits = cfg.get("limits") or {}
    counts = query(
        bot,
        "SELECT status, COUNT(*), SUM(date(ts) = date('now', 'localtime')) FROM jobs GROUP BY status",
    )
    total = {status: n for status, n, _ in counts}
    today = {status: n_today for status, _, n_today in counts}
    state = {
        "config_ok": cfg_path.exists(),
        "can_refer": bool(cfg.get("referral")),  # the bot has a referral: section (LinkedIn)
        "referral_text": {"note": (cfg.get("referral") or {}).get("connect_note") or "",
                          "message": (cfg.get("referral") or {}).get("message") or ""} if cfg.get("referral") else None,
        "applied_today": today.get("applied") or 0,
        "applied_total": total.get("applied", 0),
        "needs_manual": total.get("needs_manual", 0),
        "max_per_day": limits.get("max_per_day"),
        "max_per_run": limits.get("max_per_run"),
        "run": None,
        "log": None,
    }
    run = runs.get(bot)
    if run:
        # The page sends "<run id>:<chars it has>" and gets only what's new, or the whole log for a new run.
        run_id, _, have = since.partition(":")
        text = run.text
        offset = int(have) if run_id == run.id and have.isdigit() and int(have) <= len(text) else 0
        state["run"] = run.summary()
        state["log"] = {"reset": offset == 0, "text": text[offset:], "size": len(text)}
    return state


def history(bot=None, status=None, limit=200):
    sql, args = "SELECT ts, status, title, company, url, note FROM jobs", []
    if status:
        sql += " WHERE status=?"
        args.append(status)
    sql += " ORDER BY ts DESC LIMIT ?"
    rows = []
    for b in [bot] if bot else bots():
        for ts, st, title, company, url, note in query(b, sql, (*args, limit)):
            shot = SHOT_RE.search(note or "")
            rows.append({
                "bot": b, "ts": ts, "status": st, "title": title, "company": company, "url": url,
                "note": SHOT_RE.sub("", note or "").strip(),
                "shot": f"/shot/{b}/{shot.group(1)}" if shot else None,
            })
    rows.sort(key=lambda r: r["ts"] or "", reverse=True)
    return rows[:limit]


def referrals(limit=200):
    """Everyone a bot asked for a referral (LinkedIn's contacts table), newest first."""
    rows = []
    for b in bots():
        sql = """SELECT updated, status, name, headline, company, profile, title, job_url, note
                 FROM contacts ORDER BY updated DESC LIMIT ?"""
        for ts, st, name, headline, company, profile, title, job_url, note in query(b, sql, (limit,)):
            rows.append({"bot": b, "ts": ts, "status": st, "name": name, "headline": headline, "company": company,
                         "profile": profile, "title": title, "job_url": job_url, "note": note})
    rows.sort(key=lambda r: r["ts"] or "", reverse=True)
    return rows[:limit]


def save_referral_text(bot, note, message):
    """Write referral.connect_note and referral.message into the bot's config.yaml, leaving the rest of the
    file (and its comments) as it is. Checks the result reads back as exactly that, else leaves the file alone."""
    path = ROOT / bot / "config.yaml"
    original = path.read_text()
    lines = original.split("\n")
    start = next((i for i, line in enumerate(lines) if re.match(r"^referral:\s*(#.*)?$", line)), None)
    if start is None:
        raise ValueError(f"{bot}/config.yaml has no referral: section.")
    end = next((i for i in range(start + 1, len(lines)) if re.match(r"^[^\s#]", lines[i])), len(lines))
    section = lines[start:end]

    def key_line(key):
        return next((i for i, line in enumerate(section) if re.match(rf"^\s+{key}:", line)), None)

    k = key_line("connect_note")
    if k is None:
        raise ValueError("couldn't find referral.connect_note in config.yaml.")
    indent = re.match(r"^(\s+)", section[k]).group(1)
    section[k] = f"{indent}connect_note: {json.dumps(note, ensure_ascii=False)}"  # a JSON string is a YAML string

    k = key_line("message")
    if k is None:
        raise ValueError("couldn't find referral.message in config.yaml.")
    indent = re.match(r"^(\s+)", section[k]).group(1)
    stop = k + 1
    if re.match(r"^\s+message:\s*[|>]", section[k]):  # a block: the lines indented deeper than the key
        while stop < len(section) and (not section[stop].strip() or len(section[stop]) - len(section[stop].lstrip()) > len(indent)):
            stop += 1
        while stop > k + 1 and not section[stop - 1].strip():
            stop -= 1  # keep the blank lines between this and whatever follows
    body = [f"{indent}  {line}".rstrip() for line in message.split("\n")]
    section[k:stop] = [f"{indent}message: |", *body]

    updated = "\n".join(lines[:start] + section + lines[end:])
    try:
        rc = (yaml.safe_load(updated) or {}).get("referral") or {}
    except yaml.YAMLError as e:
        raise ValueError(f"couldn't save: {e}")
    if (rc.get("connect_note") or "") != note or (rc.get("message") or "").strip() != message.strip():
        raise ValueError("couldn't save the text without changing its meaning; edit config.yaml by hand.")
    path.write_text(updated)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, body, ctype="application/json"):
        if not isinstance(body, bytes):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _from_this_page(self):
        """Refuse other websites poking at localhost (DNS rebinding, cross-site requests)."""
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin")
        return host in self.server.hosts and (origin is None or urlsplit(origin).netloc == host)

    def do_GET(self):
        if not self._from_this_page():
            return self._send(403, {"error": "forbidden"})
        url = urlsplit(self.path)
        params = {k: v[0] for k, v in parse_qs(url.query).items()}
        if url.path == "/":
            return self._send(200, (HERE / "index.html").read_bytes(), "text/html; charset=utf-8")
        if url.path == "/api/state":
            return self._send(200, {bot: bot_state(bot, params.get(bot, "")) for bot in bots()})
        if url.path == "/api/referrals":
            return self._send(200, referrals())
        if url.path == "/api/history":
            bot = params.get("bot") if params.get("bot") in bots() else None
            status = params.get("status") if params.get("status") in STATUSES else None
            return self._send(200, history(bot, status))
        parts = url.path.split("/")
        if len(parts) == 4 and parts[1] == "shot" and parts[2] in bots() and re.fullmatch(r"[\w.-]+\.png", parts[3]):
            path = ROOT / parts[2] / "data" / "screenshots" / parts[3]
            if path.is_file():
                return self._send(200, path.read_bytes(), "image/png")
        self._send(404, {"error": "not found"})

    def do_POST(self):
        # Needing a JSON body means a plain cross-site form can't trigger a run either.
        json_body = self.headers.get("Content-Type", "").split(";")[0].strip().lower() == "application/json"
        if not self._from_this_page() or not json_body:
            return self._send(403, {"error": "forbidden"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        except ValueError:
            return self._send(400, {"error": "bad JSON"})
        bot = body.get("bot")
        if bot not in bots():
            return self._send(400, {"error": "unknown bot"})
        run = runs.get(bot)
        try:
            if self.path == "/api/start":
                if body.get("action") not in ACTIONS:
                    return self._send(400, {"error": "unknown action"})
                start(bot, body["action"], body.get("confirm"), body.get("assist"), body.get("max"))
            elif self.path == "/api/send":
                text = str(body.get("text", ""))
                if len(text) > 200 or any(c < " " for c in text):
                    return self._send(400, {"error": "answer must be one short line"})
                if run:
                    run.send(text)
            elif self.path == "/api/stop":
                if run:
                    run.stop()
            elif self.path == "/api/referral-text":
                note, message = str(body.get("note", "")).strip(), str(body.get("message", "")).strip()
                if len(note) > 300 or len(message) > 3000:
                    return self._send(400, {"error": "the note can be 300 characters, the message 3000"})
                if not message:
                    return self._send(400, {"error": "the message can't be empty"})
                save_referral_text(bot, note, message)
            else:
                return self._send(404, {"error": "not found"})
        except (ValueError, OSError) as e:
            return self._send(409, {"error": str(e)})
        self._send(200, {"ok": True})


def stop_all():
    live = [run for run in runs.values() if run.running]
    for run in live:
        run.stop()
    for run in live:
        try:
            run.proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            run._signal_group(signal.SIGKILL)


def quit_on_signal(signum, frame):
    raise KeyboardInterrupt


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true", help="don't open the page")
    args = parser.parse_args()

    url = f"http://127.0.0.1:{args.port}/"
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError:
        if not args.no_browser:
            webbrowser.open(url)
        sys.exit(f"Port {args.port} is in use. If the dashboard is already running, it's at {url}")
    server.daemon_threads = True
    server.hosts = {f"127.0.0.1:{args.port}", f"localhost:{args.port}"}

    # Closing the Terminal window (SIGHUP) should stop the bots too, not leave them running unseen.
    # Handling SIGINT here also means the bots start with it working (an ignored one is inherited), so Stop works.
    for sig in (signal.SIGINT, signal.SIGHUP, signal.SIGTERM):
        signal.signal(sig, quit_on_signal)
    print(f"Job bots dashboard: {url}\nLeave this window open while you use it; Ctrl-C here quits.")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping...")
    finally:
        stop_all()
        server.server_close()


if __name__ == "__main__":
    sys.exit(main())
