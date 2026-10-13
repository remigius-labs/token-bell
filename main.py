"""Token Bell, a Claude usage tracker for the Quick Access Menu: backend.

Runs Omarchy's agent usage script (vendor/claude-usage) every few minutes, hands the panel the plan
limits, and announces a limit's reset when its bell is on. Signing in is left to Claude Code
itself (`claude auth login`), which the plugin installs and drives for people who don't have it.
"""
import asyncio
import json
import os
import re
import signal
import time
from datetime import datetime

import decky

FLUSH_S = 0.5
USAGE_POLL_S = 300
STATE_FILE = os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "state.json")
CLAUDE_INSTALL = "curl -fsSL https://claude.ai/install.sh | bash"  # Anthropic's installer, into ~/.local
DEFAULT_BELLS = {"Session (5-hour)": True, "Weekly (7-day)": True, "Fable Weekly": True}  # others don't ring


def child_env():
    """Environment for the programs we start: the deck user's, without Decky's bundled libraries."""
    env = dict(os.environ)
    orig = env.pop("LD_LIBRARY_PATH_ORIG", None)  # Decky is a PyInstaller bundle
    if orig:
        env["LD_LIBRARY_PATH"] = orig
    else:
        env.pop("LD_LIBRARY_PATH", None)
    env.pop("LD_PRELOAD", None)
    home = decky.DECKY_USER_HOME
    env["HOME"] = home
    env["USER"] = decky.DECKY_USER
    env["PATH"] = f"{home}/.local/bin:" + env.get("PATH", "/usr/local/bin:/usr/bin:/bin")
    if saved().get("config_dir"):
        env["CLAUDE_CONFIG_DIR"] = saved()["config_dir"]
    return env


def saved():
    try:
        with open(STATE_FILE) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def claude_dir():
    """Where Claude Code keeps its login; "config_dir" in state.json points it elsewhere."""
    return saved().get("config_dir") or os.environ.get("CLAUDE_CONFIG_DIR") \
        or os.path.join(decky.DECKY_USER_HOME, ".claude")


def claude_bin():
    path = os.path.join(decky.DECKY_USER_HOME, ".local/bin/claude")
    return path if os.access(path, os.X_OK) else None


def signed_in():
    return os.path.exists(os.path.join(claude_dir(), ".credentials.json"))


class Login:
    """Signs in through Claude Code's own `claude auth login`. It offers two pages: one that hands
    the result straight back to it on this machine (for Steam's browser), and one that shows a code
    to type in (for a phone, behind the QR code)."""

    def __init__(self, usage):
        self.usage = usage
        self.state = {"step": "idle"}  # idle | installing | starting | code | checking | error
        self.proc = None
        self.task = None

    def set(self, step, **extra):
        self.state = {"step": step, **extra}
        self.usage.dirty = True

    def start(self):
        if self.state["step"] in ("installing", "starting", "checking"):
            return
        self.cancel()
        self.task = asyncio.create_task(self.run())

    async def run(self):
        try:
            if not claude_bin():
                self.set("installing")
                proc = await asyncio.create_subprocess_shell(
                    CLAUDE_INSTALL, env=child_env(), start_new_session=True,
                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
                await asyncio.wait_for(proc.wait(), 600)
                if not claude_bin():
                    return self.set("error", error="Couldn't install Claude Code. Check the internet connection.")
            self.set("starting")
            # Claude Code hands the same-machine page to $BROWSER; catch it instead of opening it
            os.makedirs(decky.DECKY_PLUGIN_RUNTIME_DIR, exist_ok=True)
            grab = os.path.join(decky.DECKY_PLUGIN_RUNTIME_DIR, "browser.sh")
            local = os.path.join(decky.DECKY_PLUGIN_RUNTIME_DIR, "browser-url")
            with open(grab, "w") as f:
                f.write(f'#!/bin/sh\nprintf %s "$1" > "{local}"\n')
            os.chmod(grab, 0o700)
            if os.path.exists(local):
                os.remove(local)
            env = child_env()
            env["BROWSER"] = grab
            proc = self.proc = await asyncio.create_subprocess_exec(
                claude_bin(), "auth", "login", env=env, start_new_session=True, stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
            output, url, deadline = "", None, time.time() + 30
            while not url and time.time() < deadline:
                chunk = await asyncio.wait_for(proc.stdout.read(4096), max(0.1, deadline - time.time()))
                if not chunk:
                    break
                output += chunk.decode(errors="replace")
                found = re.search(r"https://\S+", output)
                if found and "Paste code" in output:
                    url = found.group(0)
            if not url:
                return self.set("error", error="Claude Code didn't offer a sign-in page.")
            for _ in range(20):  # the browser is called a moment after the address is printed
                if os.path.exists(local):
                    break
                await asyncio.sleep(0.1)
            local_url = open(local).read().strip() if os.path.exists(local) else ""
            self.set("code", url=url, local_url=local_url)
            await asyncio.wait_for(proc.wait(), 900)  # ends by itself once either page is completed
            if proc.returncode == 0 and signed_in():
                self.set("idle")
                self.usage.force = True
                self.usage.wake.set()
            elif self.state["step"] == "checking":
                self.set("error", error="That code wasn't accepted. Start the sign-in again.")
            else:
                self.set("error", error="The sign-in didn't complete.")
        except asyncio.TimeoutError:
            self.kill()
            self.set("error", error="Timed out.")
        except asyncio.CancelledError:
            raise
        except Exception:
            decky.logger.exception("sign-in failed")
            self.kill()
            self.set("error", error="Couldn't start the sign-in.")

    async def submit(self, code):
        proc = self.proc
        if self.state["step"] != "code" or not proc or proc.returncode is not None or not code.strip():
            return
        self.set("checking")
        try:
            proc.stdin.write(code.strip().encode() + b"\n")
            await proc.stdin.drain()
        except OSError:
            pass  # run() reports how it ended

    def kill(self):
        if self.proc and self.proc.returncode is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        self.proc = None

    def cancel(self):
        if self.task:
            self.task.cancel()
        self.kill()
        self.set("idle")


class Usage:
    """Plan limits, collected by Omarchy's agent usage script (vendor/claude-usage)."""

    def __init__(self):
        self.data = {"limits": [], "updated": 0, "error": None, "plan": "", "signed_in": signed_in()}
        self.bells = dict(DEFAULT_BELLS)
        self.bells.update(saved().get("bells") or {})
        self.dirty = False
        self.pings = []       # labels of limits that just reset, for the panel to announce
        self.pinged = set()
        self.wake = asyncio.Event()
        self.force = False
        self.task = asyncio.create_task(self.run())

    def set_bell(self, label, on):
        self.bells[label] = bool(on)
        try:
            os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
            with open(STATE_FILE, "w") as f:
                json.dump({**saved(), "bells": self.bells}, f)
        except OSError:
            decky.logger.exception("could not save the bells")
        self.data = {**self.data, "limits": [{**l, "bell": bool(self.bells.get(l["label"]))}
                                             for l in self.data["limits"]]}
        self.dirty = True

    async def run(self):
        while True:
            try:
                force, self.force = self.force, False
                await self.fetch(force)
            except Exception:
                decky.logger.exception("usage check failed")
            now = time.time()
            waits = [USAGE_POLL_S] + [l["resets_at"] - now + 2 for l in self.data["limits"]
                                      if l["resets_at"] and l["resets_at"] > now]
            self.wake.clear()
            try:
                await asyncio.wait_for(self.wake.wait(), max(5, min(waits)))
            except asyncio.TimeoutError:
                pass
            self.check_resets()

    def check_resets(self):
        """The reset time is known in advance, so the ping doesn't depend on reaching the server."""
        now = time.time()
        for limit in self.data["limits"]:
            key = (limit["label"], int(limit["resets_at"] or 0) // 60)
            if limit["resets_at"] and limit["resets_at"] <= now and key not in self.pinged:
                self.pinged.add(key)
                # an untouched limit rolling over is not news
                if self.bells.get(limit["label"]) and limit["percent"] > 0:
                    self.pings.append(limit["label"])
                    self.dirty = True

    def fail(self, error):
        self.data = {**self.data, "error": error}
        self.dirty = True

    async def fetch(self, force=False):
        """Run Omarchy's collector (vendor/claude-usage) and keep the parts of its record the panel draws."""
        script = os.path.join(decky.DECKY_PLUGIN_DIR, "vendor/claude-usage/omarchy-agent-usage-claude")
        proc = await asyncio.create_subprocess_exec(
            "/usr/bin/python3", script, "--limits-only", *(["--force"] if force else []), env=child_env(),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), 60)
            record = json.loads(out)
        except (asyncio.TimeoutError, ValueError):
            return self.fail("Couldn't read usage.")
        limits = [self.limit(l.get("label") or "Limit", (l.get("percent") or 0) * 100, l.get("resetsAt"))
                  for l in record.get("limits") or []]
        self.data = {
            "limits": limits or self.data["limits"],  # a failed check keeps the last known windows
            "updated": time.time(),
            "error": record.get("usageStatusText") or record.get("authHelpText") or None,
            "stale": bool(record.get("limitsStale")) or not limits,
            "plan": record.get("tierLabel") or "",
            "signed_in": signed_in(),
        }
        self.dirty = True

    def limit(self, label, percent, resets_at):
        try:
            when = datetime.fromisoformat(resets_at).timestamp() if resets_at else None
        except ValueError:
            when = None
        return {"label": label, "percent": round(float(percent or 0)), "resets_at": when,
                "bell": bool(self.bells.get(label))}


class Plugin:
    async def _main(self):
        self.usage = Usage()
        self.login = Login(self.usage)
        decky.logger.info("Token Bell loaded")
        self.unloading = False
        while not self.unloading:
            await asyncio.sleep(FLUSH_S)
            try:
                if self.usage.dirty:
                    self.usage.dirty = False
                    pings, self.usage.pings = self.usage.pings, []
                    await decky.emit("claude_usage", self.usage.data, pings, self.login.state)
            except Exception:
                decky.logger.exception("could not send an update")

    async def _unload(self):
        self.unloading = True
        self.usage.task.cancel()
        self.login.cancel()

    async def get_state(self):
        return {"usage": self.usage.data, "login": self.login.state}

    async def login_start(self):
        self.login.start()

    async def login_code(self, code: str):
        await self.login.submit(code)

    async def login_cancel(self):
        self.login.cancel()

    async def refresh_usage(self, force: bool = False):
        self.usage.force = bool(force)
        self.usage.wake.set()

    async def set_bell(self, label: str, on: bool):
        self.usage.set_bell(label, on)
