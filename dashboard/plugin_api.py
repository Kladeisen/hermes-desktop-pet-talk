"""talk-desktop — backend half: mint Realtime sessions for native Desktop.

Reuse hermes-talk's Codex-OAuth lane (talk_* modules), adding per-bot identity
(SOUL.md from the VPS profile) and Codex OAuth session management
(status, device-code login, logout).

Routes (mounted at /api/plugins/talk-desktop/):
  GET  /status              → Codex auth, profile list, configured model/voice
  POST /session             → {profile?, voice?} → ephemeral descriptor (to_wire)
  GET  /codex/status        → session state (no secrets) + pending login
  POST /codex/login/start   → start codex login --device-auth (URL + user code)
  POST /codex/login/cancel  → cancel a pending login
  POST /codex/logout        → sign out (auth.json backup; affects voice + VPS Codex CLI)
  GET  /codex/usage         → ChatGPT plan usage/quota (wham/usage rate_limit)
  GET  /voice/usage         → local Live Voice usage (last 7 days)
  POST /voice/usage/report  → {durationMs, audioMs} → record session usage on hangup
  POST /tool               → run a voice tool (talk_tools), returning spoken text
  POST /codexlive/session   → {profile?, voice?, offer(SDP)} → negotiate v3 via codex app-server
  POST /codexlive/stop      → {threadId} → stop the Codex Live realtime session
  GET  /hermeslive/status   → can Hermes' own GPT-Live start here (no key, a reason when not)
  POST /hermeslive/session  → {profile?, offer(SDP), history?} → answer SDP via tools.voice_live

Only the ephemeral secret goes to the Desktop renderer; OAuth never leaves the VPS.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

_PLUGIN_ROOT = Path(__file__).resolve().parent.parent


def _load_portable():
    """dashboard/portable.py, shared with the other backend files via one sys.modules entry."""
    import importlib.util
    name = "talk_desktop_portable"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, _PLUGIN_ROOT / "dashboard" / "portable.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules[name]


_portable = _load_portable()
_TALK_VENDOR_ROOT = _PLUGIN_ROOT / "dashboard" / "talk_vendor"
_HERMES_TALK_ROOT = _portable.hermes_root() / "plugins" / "hermes-talk"
# Import precedence (last inserted wins): the complete hermes-talk plugin
# when installed; otherwise the vendored bundle shipped in this repository.
for _p in (str(_PLUGIN_ROOT), str(_TALK_VENDOR_ROOT), str(_HERMES_TALK_ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import talk_auth  # noqa: E402
import talk_capabilities  # noqa: E402
import talk_config  # noqa: E402
import talk_host  # noqa: E402
import talk_identity  # noqa: E402
import talk_tools  # noqa: E402
import talk_wire  # noqa: E402

try:
    from fastapi import APIRouter, HTTPException, Request
except ImportError:  # pragma: no cover
    APIRouter = None
    HTTPException = None
    Request = None

router = APIRouter() if APIRouter else None
_log = logging.getLogger("hermes.plugins.talk-desktop")

# Plugin-owned native companion routes; no Hermes core/preload bridge required.
if router is not None:
    import importlib.util as _companion_import
    _companion_spec = _companion_import.spec_from_file_location(
        'talk_desktop_companion_broker', _PLUGIN_ROOT / 'dashboard' / 'companion_broker.py'
    )
    _companion_module = _companion_import.module_from_spec(_companion_spec)
    _companion_spec.loader.exec_module(_companion_module)
    companion_broker = _companion_module.Broker(_PLUGIN_ROOT)
    router.include_router(_companion_module.make_router(companion_broker))

    # The pet's "needs you" badge: same process-wide registry the plugin hooks fill.
    _attention_spec = _companion_import.spec_from_file_location(
        'talk_desktop_attention_loader', _PLUGIN_ROOT / 'attention.py'
    )
    _attention_loader = _companion_import.module_from_spec(_attention_spec)
    _attention_spec.loader.exec_module(_attention_loader)
    _attention = _attention_loader.shared()

    @router.get('/attention')
    async def attention_snapshot() -> dict:
        """Open approval / clarify / sudo waits: ids, kinds, session ids, timestamps only."""
        return _attention.registry.snapshot()

_PROFILES_ROOT = _portable.hermes_root() / "profiles"
_MINT_LOCK = threading.Lock()


def _list_bots() -> list[str]:
    if not _PROFILES_ROOT.is_dir():
        return []
    return sorted(
        e.name for e in _PROFILES_ROOT.iterdir()
        if e.is_dir() and (e / "SOUL.md").is_file()
    )


def _profile_home(profile: str) -> Path | None:
    # Simple profile name (no traversal). Profiles can be symlinks
    # (e.g. my-bot → ~/.hermes-my-bot), so the resolved path need not
    # be under profiles/ — only the name must be safe and the directory must exist.
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", profile or ""):
        return None
    p = _PROFILES_ROOT / profile
    if not p.is_dir():
        return None
    return p.resolve()


def _bot_display_name(profile: str) -> str:
    """Bot name from the SOUL.md heading, falling back to the slug.

    Examples: "# SOUL.md — ExampleBot", "# Assistant — Acme CEO", "# Ops",
    "# Project DevOps".
    """
    home = _profile_home(profile)
    if home is not None:
        try:
            first = ((home / "SOUL.md").read_text(encoding="utf-8", errors="replace").splitlines() or [""])[0].strip()
        except OSError:
            first = ""
        first = re.sub(r"[^\w\sÁÉÍÓÚÜÑáéíóúüñ—·-]", " ", first.lstrip("#").strip())
        parts = [p.strip() for p in first.split("—") if p.strip()]
        name = ""
        for part in parts:
            if part.lower().replace(" ", "").startswith("soul.md") or part.lower().startswith("soul"):
                continue
            name = part
            break
        if not name and parts:
            name = parts[-1]
        name = name.split("·")[0].strip()
        if name:
            return name[:40]
    return profile.capitalize()


def _bot_identity_sections(profile: str) -> dict[str, str]:
    """Bot identity: profile SOUL.md, with the same sanitization as hermes-talk."""
    home = _profile_home(profile)
    if home is None:
        return {}
    sections: dict[str, str] = {}
    soul = home / "SOUL.md"
    if soul.is_file():
        try:
            body = soul.read_text(encoding="utf-8", errors="replace").strip()
        except OSError:
            body = ""
        if body:
            try:
                body = talk_host._sanitize_identity_entries(body, "SOUL.md")
            except Exception:  # noqa: BLE001
                body = ""
            if body:
                sections["PERSONA"] = body[: talk_config.identity_char_limit("persona") or 8000]
    return sections


_DIRECTIVE_PATH = _PLUGIN_ROOT / "language_directive.txt"
_LANGUAGE_DIRECTIVE_DEFAULT = {
    "en": (
        '\n\nLANGUAGE AND VOICE: Reply in English. Speak naturally and clearly, like a native English speaker. '
        'Keep names, quotations, and user-supplied content intact.'
    ),
}

_LANGUAGE_DIRECTIVE_BUNDLE = "\n\n".join(value.strip() for value in _LANGUAGE_DIRECTIVE_DEFAULT.values())


def _language_directive(language: str = "en") -> str:
    """Use English for all locale inputs; preserve custom file content verbatim."""
    try:
        if _DIRECTIVE_PATH.is_file():
            text = _DIRECTIVE_PATH.read_text(encoding="utf-8")
            shipped = {value.strip() for value in _LANGUAGE_DIRECTIVE_DEFAULT.values()}
            shipped.add(_LANGUAGE_DIRECTIVE_BUNDLE)
            if text.strip() and text.strip() not in shipped:
                return "\n\n" + text
    except OSError:
        pass
    return _LANGUAGE_DIRECTIVE_DEFAULT["en"]


def _resolve_voice(requested: str | None) -> str:
    """Requested voice or the configured voice (TALK_VOICE / config)."""
    if requested:
        v = str(requested).strip().lower()
        if v in talk_config.OPENAI_REALTIME_VOICES:
            return v
        raise HTTPException(status_code=400, detail=f"voice '{v}' is not available")
    try:
        return talk_config.voice() or "marin"
    except Exception:  # noqa: BLE001
        return "marin"


_CHAT_CONFIRMATION_POLICY = (
    "\n\nCHAT HANDOFF CONFIRMATION: This rule overrides earlier guidance that reversible work or lookups "
    "need no confirmation when they are handed to the chat/backend. Answer small talk and quick questions "
    "directly when you can. For work that needs the chat agent, briefly name the task and ask "
    "'Should I send that to the chat?' Then wait; do not call send_to_chat or create a native delegation "
    "in that same turn. Delegate only when the user's immediately next turn clearly approves that "
    "specific task, such as 'yes', 'do it', or 'go ahead'. 'No', silence, an ambiguous reply, or a change "
    "of topic is not permission; do not send the task or reuse that pending approval later. An explicit "
    "request such as 'send this to the chat: ...' or 'do this in the chat' authorizes that specific "
    "handoff without another question. After approval, send the complete task exactly once, not just "
    "the words 'yes' or 'go ahead'. This permission covers the handoff only; the chat agent's own "
    "action-approval requirements still apply."
)


_SEND_TO_CHAT_DESC = (
    "Send a request to the user's currently open chat session so the REAL agent handles it "
    "with its full context, memory and tools. The request appears in that chat as a message "
    "from the user and the agent's reply streams there; you receive the reply text back and "
    "read or summarize it aloud. Use this whenever the user asks for actual work, actions, or "
    "information from their conversations, files or services \u2014 anything beyond a quick "
    "conversational answer. Do NOT use it for small talk or things you can answer instantly."
)


def _send_to_chat_tool() -> dict:
    return {
        "type": "function",
        "name": "send_to_chat",
        "description": _SEND_TO_CHAT_DESC,
        "parameters": {
            "type": "object",
            "properties": {
                "request": {
                    "type": "string",
                    "description": "The full request to hand to the agent, phrased naturally in the user's own language.",
                },
            },
            "required": ["request"],
        },
    }


def _mint_for(profile: str | None, voice: str, allow_chat: bool = True, language: str = "en", ask_before_chat: bool = False):
    """Mint with bot identity, or host identity when no profile is requested."""
    # Desktop routes default confirmation on; direct callers retain legacy behavior.
    tools = talk_tools.default_talk_tools()
    if allow_chat:
        tools = tools + [_send_to_chat_tool()]
        if ask_before_chat:
            tools[-1]["description"] = "Send the authorized full task to the user's chat agent." + _CHAT_CONFIRMATION_POLICY
    if profile:
        sections = _bot_identity_sections(profile)
    else:
        sections = talk_host.host().identity_sections()
    instructions = talk_identity.build_instructions(
        sections,
        tools=tools,
        lane="dashboard",
        capabilities=talk_capabilities.instruction_section(),
    )
    instructions = instructions + _language_directive(language)
    if allow_chat and ask_before_chat:
        instructions += "\n\nVOICE + CHAT: After authorization, call send_to_chat with the complete request phrased naturally in their language. If no chat is open, the tool will tell you."
    elif allow_chat:
        instructions += (
            "\n\nVOICE + CHAT: The user has a chat open in the app. Answer quick questions and "
                "small talk directly yourself. When they ask for REAL WORK (doing, creating, reviewing, "
                "searching their information, or taking action), call send_to_chat with the complete "
                "request phrased naturally in their language. The system sends it to their open chat, "
                "where the real agent replies. You will then receive the result; read or summarize it "
                "aloud naturally in no more than 2-3 sentences. If no chat is open, the tool will tell you."
        )
    instructions += _voice_policy(language)
    if allow_chat and ask_before_chat:
        instructions += _CHAT_CONFIRMATION_POLICY
    if profile:
        name = _bot_display_name(profile)
        if "You are Hermes, speaking live" in instructions:
            instructions = instructions.replace("You are Hermes, speaking live", f"You are {name}, speaking live", 1)
        instructions += (
            f"\n\nIDENTITY: You are {name}. If asked who you are, "
                f"answer as {name} in that role — never say you are Hermes, a model, or a generic assistant."
        )
    auth = talk_auth.resolve_auth()
    descriptor = talk_wire.mint_ephemeral_session(
        auth_token=auth.token,
        model=talk_config.talk_model(),
        voice=voice,
        instructions=instructions,
        tools=tools,
        text_output=False,
    )
    return descriptor, auth


# ── Codex OAuth: voice session (device-code login / logout / status) ────────

_LOGIN_URL = "https://auth.openai.com/codex/device"
_URL_RE = re.compile(r"https://auth\.openai\.com/codex/device")
# Device code is a hyphenated uppercase token (codex 0.145 prints e.g.
# "IK34-27GA1"). codex wraps it in ANSI SGR colour codes with no surrounding
# whitespace, so the escape's trailing "m" (a word char) sits right before the
# code and defeats a leading \b word boundary — the old pattern silently never
# matched, so the code was never exposed (the URL regex has no \b, which is
# exactly why copying the sign-in link worked). Strip ANSI first, then match.
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")
_CODE_RE = re.compile(r"\b([A-Z0-9]{4}-[A-Z0-9]{4,5})\b")
_LOGIN_TIMEOUT_S = 16 * 60

_LOGIN: dict = {
    "status": "idle",  # idle | pending | done | error
    "url": None,
    "code": None,
    "message": None,
    "started_at": None,
    "proc": None,
    "output": "",
}
_LOGIN_LOCK = threading.Lock()


def _codex_auth_path() -> Path:
    configured = os.environ.get("CODEX_HOME", "").strip()
    base = Path(configured) if configured else Path.home() / ".codex"
    return base / "auth.json"


def _codex_binary() -> str | None:
    """Resolve the codex CLI on Linux, macOS and Windows, even when the service PATH omits it."""
    try:
        found = shutil.which("codex")
    except Exception:  # noqa: BLE001
        found = None
    if found:
        return found
    home = Path.home()
    if os.name == "nt":
        appdata = os.environ.get("APPDATA", "").strip()
        npm = Path(appdata) / "npm" if appdata else home / "AppData" / "Roaming" / "npm"
        candidates = [npm / "codex.cmd", npm / "codex.exe", home / ".local" / "bin" / "codex.exe"]
    else:
        candidates = [home / ".npm-global" / "bin" / "codex", Path("/usr/local/bin/codex"),
                      home / ".local" / "bin" / "codex", Path("/usr/bin/codex"), Path("/opt/homebrew/bin/codex")]
    for cand in candidates:
        if cand.is_file() and os.access(cand, os.X_OK):
            return str(cand)
    if os.name != "nt" and shutil.which("bash"):
        try:
            out = subprocess.run(["bash", "-lc", "command -v codex"], capture_output=True, text=True, timeout=10)
            if out.returncode == 0 and out.stdout.strip():
                return out.stdout.strip().splitlines()[0]
        except Exception:  # noqa: BLE001
            pass
    return None


def _terminate(proc) -> None:
    try:
        proc.terminate()
        try:
            proc.wait(timeout=4)
        except Exception:  # noqa: BLE001
            proc.kill()
    except Exception:  # noqa: BLE001
        pass


def _login_reader(proc) -> None:
    try:
        for line in iter(proc.stdout.readline, ""):
            _LOGIN["output"] = (_LOGIN["output"] + line)[-4000:]
            clean = _ANSI_RE.sub("", line)
            if not _LOGIN["url"]:
                m = _URL_RE.search(clean)
                if m:
                    _LOGIN["url"] = m.group(0)
            if not _LOGIN["code"]:
                m = _CODE_RE.search(clean)
                if m:
                    _LOGIN["code"] = m.group(1)
    except Exception:  # noqa: BLE001
        pass


def _login_check() -> None:
    """Fold the device-login process state into _LOGIN (call before reporting)."""
    proc = _LOGIN.get("proc")
    if _LOGIN.get("status") != "pending":
        return
    if proc is not None and proc.poll() is None:
        started = _LOGIN.get("started_at") or 0
        if time.time() - started > _LOGIN_TIMEOUT_S:
            _terminate(proc)
            _LOGIN.update(status="error", message="timeout: the code expired without approval", proc=None)
        return
    # process finished (or vanished)
    try:
        diag = talk_auth.auth_diagnostic()
        state = diag.get("codex_oauth")
    except Exception:  # noqa: BLE001
        state = None
    if state in {"valid", "expired"}:
        _LOGIN.update(status="done", message="Signed in", proc=None, url=None, code=None,
                      output="")
    else:
        tail = " / ".join((_LOGIN.get("output") or "").strip().splitlines()[-3:])
        _LOGIN.update(status="error", message=("Could not sign in" + (f": {tail}" if tail else "")),
                      proc=None)


def _start_codex_login() -> dict:
    with _LOGIN_LOCK:
        _login_check()
        proc = _LOGIN.get("proc")
        if proc is not None and proc.poll() is None:
            _terminate(proc)
        binary = _codex_binary()
        if not binary:
            return {"ok": False, "message": "codex CLI was not found on the server"}
        # Back up the current session: starting a new login can replace/clear
        # ~/.codex/auth.json before completion (verified 2026-09-11).
        auth_path = _codex_auth_path()
        if auth_path.exists():
            try:
                ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
                shutil.copy2(auth_path, auth_path.with_name(f"auth.json.bak-pre-login-{ts}"))
            except OSError:
                pass
        env = os.environ.copy()
        # The resolved home (CODEX_HOME when set) is shared by backup/status/logout.
        # Keep it in the environment so every operation uses the same auth.json.
        proc = subprocess.Popen(
            [binary, "login", "--device-auth"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env=env,
            cwd=str(Path.home()),
        )
        _LOGIN.update(status="pending", url=None, code=None, message=None,
                      started_at=time.time(), proc=proc, output="")
        threading.Thread(target=_login_reader, args=(proc,), daemon=True).start()
    # Give the reader a moment to capture the URL/code.
    deadline = time.time() + 8
    while time.time() < deadline and not (_LOGIN.get("url") and _LOGIN.get("code")):
        time.sleep(0.2)
    return {"ok": True, "url": _LOGIN.get("url") or _LOGIN_URL, "code": _LOGIN.get("code"),
            "status": _LOGIN["status"]}


if router is not None:

    @router.get("/status")
    async def status() -> dict:
        try:
            auth = talk_auth.resolve_auth()
            auth_source = auth.source
        except Exception as exc:  # noqa: BLE001
            auth_source = f"unavailable: {exc}"
        return {
            "ok": True,
            "auth": auth_source,
            "model": talk_config.talk_model(),
            "voices": list(talk_config.OPENAI_REALTIME_VOICES),
            "bots": _list_bots(),
        }

    @router.post("/session")
    async def create_session(request: Request) -> dict:
        body = {}
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}
        profile = str(body.get("profile") or "").strip() or None
        allow_chat = bool(body.get("allowChat", True))
        ask_before_chat = body.get("askBeforeChat", True) is not False
        if profile and _profile_home(profile) is None:
            raise HTTPException(status_code=400, detail=f"profile '{profile}' does not exist")
        voice = _resolve_voice(body.get("voice"))

        def _do():
            # Serialize mints with identity overrides: the get_hermes_home patch is
            # process-global during _mint_for; allow one mint at a time. The lock
            # lives in this worker, not the coroutine: a threading.Lock held across
            # an await blocks the event loop, preventing the callback that would
            # release it from running (deadlock). This also restores the override
            # in the same worker that minted the session.
            with _MINT_LOCK:
                if profile:
                    orig = talk_config.get_hermes_home
                    talk_config.get_hermes_home = lambda: _profile_home(profile)
                    try:
                        return _mint_for(profile, voice, allow_chat, "en", ask_before_chat)
                    finally:
                        talk_config.get_hermes_home = orig
                return _mint_for(None, voice, allow_chat, "en", ask_before_chat)

        descriptor, auth = await asyncio.to_thread(_do)
        return {
            "ok": True,
            "profile": profile,
            "botName": _bot_display_name(profile) if profile else "Hermes",
            **descriptor.to_wire(),
            "authSource": auth.source,
            "voiceMode": "native",
        }

    @router.get("/codex/status")
    async def codex_status() -> dict:
        _login_check()
        try:
            st = talk_auth.auth_status()
            diag = talk_auth.auth_diagnostic()
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}",
                    "login": {k: _LOGIN.get(k) for k in ("status", "url", "code", "message")}}
        return {
            "ok": True,
            "configured": st.get("configured"),
            "lane": st.get("source"),
            "detail": st.get("detail"),
            "codexOauth": diag.get("codex_oauth"),
            "refreshRequired": diag.get("refresh_required"),
            "preference": diag.get("preference"),
            "login": {k: _LOGIN.get(k) for k in ("status", "url", "code", "message")},
        }

    @router.get("/codex/usage")
    async def codex_usage() -> dict:
        def _do() -> dict:
            try:
                auth = talk_auth.resolve_auth()
            except Exception as exc:  # noqa: BLE001
                return {"ok": False, "error": str(exc)[:160]}
            try:
                import httpx
                account_id = ""
                try:
                    data = json.loads(_codex_auth_path().read_text(encoding="utf-8"))
                    account_id = str((data.get("tokens") or {}).get("account_id") or "")
                except Exception:  # noqa: BLE001
                    pass
                headers = {
                    "Authorization": f"Bearer {auth.token}",
                    "Accept": "application/json",
                    "User-Agent": "codex-cli",
                }
                if account_id:
                    headers["ChatGPT-Account-Id"] = account_id
                payload = None
                last_status = None
                for url in (
                    "https://chatgpt.com/backend-api/wham/usage",
                    "https://api.openai.com/api/codex/usage",
                ):
                    with httpx.Client(timeout=12.0) as client:
                        resp = client.get(url, headers=headers)
                    last_status = resp.status_code
                    if resp.status_code == 200:
                        payload = resp.json() or {}
                        break
                if payload is None:
                    return {"ok": False, "error": f"usage http {last_status}"}
                rl = payload.get("rate_limit") or {}
                windows: dict = {}
                for key, fallback in (("primary_window", "5h"), ("secondary_window", "weekly")):
                    w = rl.get(key) or {}
                    if not (isinstance(w, dict) and w):
                        continue
                    mins = w.get("window_minutes")
                    secs = w.get("limit_window_seconds")
                    if not mins and secs:
                        try:
                            mins = int(secs) // 60
                        except Exception:  # noqa: BLE001
                            mins = None
                    if mins:
                        mins = int(mins)
                        if mins >= 6 * 1440:
                            label = "weekly"
                        else:
                            label = f"{max(1, round(mins / 60))}h"
                    else:
                        label = fallback
                    windows[label] = {
                        "usedPercent": w.get("used_percent"),
                        "windowMinutes": mins,
                        "resetsAt": w.get("reset_at") or w.get("resets_at"),
                    }
                return {
                    "ok": True,
                    "plan": payload.get("plan_type") or payload.get("plan") or None,
                    "windows": windows,
                }
            except Exception as exc:  # noqa: BLE001
                return {"ok": False, "error": f"{type(exc).__name__}: {exc}"[:160]}

        return await asyncio.to_thread(_do)

    # ── Live Voice usage (local per-session metering) ─────────────────────────
    _VU_FILE = _PLUGIN_ROOT / "data" / "voice-usage.json"
    _VU_LOCK = threading.Lock()

    def _vu_load() -> dict:
        try:
            data = json.loads(_VU_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("sessions"), list):
                return data
        except Exception:  # noqa: BLE001
            pass
        return {"sessions": []}

    def _vu_save(data: dict) -> None:
        try:
            _VU_FILE.parent.mkdir(parents=True, exist_ok=True)
            _VU_FILE.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        except Exception:  # noqa: BLE001
            pass

    @router.post("/voice/usage/report")
    async def voice_usage_report(request: Request) -> dict:
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}
        dur = max(0, int((body or {}).get("durationMs") or 0))
        aud = max(0, int((body or {}).get("audioMs") or 0))
        if dur <= 0:
            return {"ok": False, "error": "durationMs is required"}
        now_ms = int(time.time() * 1000)
        with _VU_LOCK:
            data = _vu_load()
            sess = data.setdefault("sessions", [])
            sess.append({"t": now_ms, "ms": dur, "audio_ms": aud})
            keep = [s for s in sess if isinstance(s, dict) and int(s.get("t") or 0) > now_ms - 8 * 24 * 3600 * 1000]
            data["sessions"] = keep[-2000:]
            _vu_save(data)
        return {"ok": True}

    @router.get("/voice/usage")
    async def voice_usage() -> dict:
        with _VU_LOCK:
            data = _vu_load()
        import datetime as _dt
        now_ms = int(time.time() * 1000)
        midnight = _dt.datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        today_ms = int(midnight.timestamp() * 1000)
        sess = [s for s in (data.get("sessions") or []) if isinstance(s, dict)]

        def agg(since_ms: int) -> dict:
            ms = aud = n = 0
            for s in sess:
                if int(s.get("t") or 0) >= since_ms:
                    ms += int(s.get("ms") or 0)
                    aud += int(s.get("audio_ms") or 0)
                    n += 1
            return {"minutes": ms / 60000.0, "audioMinutes": aud / 60000.0, "sessions": n}

        return {
            "ok": True,
            "rolling5h": agg(now_ms - 5 * 3600 * 1000),
            "rolling24h": agg(now_ms - 24 * 3600 * 1000),
            "week": agg(now_ms - 7 * 24 * 3600 * 1000),
            "today": agg(today_ms),
        }

    @router.post("/tool")
    async def run_tool(request: Request) -> dict:
        body = {}
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}
        language = "en"
        name = str(body.get("name") or "").strip()
        arguments = body.get("arguments")
        if not isinstance(arguments, dict):
            arguments = {}
        if not name:
            raise HTTPException(status_code=400, detail="name is required")
        try:
            output = await asyncio.wait_for(
                asyncio.to_thread(
                    talk_tools.execute_talk_tool, name, arguments,
                    **({"language": language} if getattr(talk_tools, "SUPPORTS_LANGUAGE", False) else {}),
                ),
                timeout=110,
            )
        except asyncio.TimeoutError:
            output = (
                f"The tool {name} is still running; I will stop waiting here. "
                    "Ask me to check the result in a moment."
            )
        except talk_tools.TalkToolError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"ok": True, "output": output}

    @router.post("/codex/login/start")
    async def codex_login_start() -> dict:
        return await asyncio.to_thread(_start_codex_login)

    @router.post("/codex/login/cancel")
    async def codex_login_cancel() -> dict:
        with _LOGIN_LOCK:
            proc = _LOGIN.get("proc")
            if proc is not None and proc.poll() is None:
                _terminate(proc)
            _LOGIN.update(status="idle", proc=None, url=None, code=None, message=None, output="")

        def _restore_if_needed() -> None:
            # A cancelled login can clear ~/.codex/auth.json; restore the latest
            # pre-login backup so the previous session is not lost.
            path = _codex_auth_path()
            if path.exists():
                return
            backups = sorted(path.parent.glob("auth.json.bak-pre-login-*"))
            if backups:
                try:
                    shutil.copy2(backups[-1], path)
                except OSError:
                    pass

        await asyncio.to_thread(_restore_if_needed)
        return {"ok": True}

    @router.post("/codex/logout")
    async def codex_logout() -> dict:
        def _do() -> dict:
            path = _codex_auth_path()
            if not path.exists():
                return {"ok": True, "message": "No session to sign out"}
            ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
            bak = path.with_name(f"auth.json.bak-voice-logout-{ts}")
            try:
                shutil.copy2(path, bak)
                path.unlink()
            except OSError as exc:
                return {"ok": False, "message": f"Could not sign out: {exc}"}
            return {"ok": True, "message": f"Signed out (backup: {bak.name})"}

        return await asyncio.to_thread(_do)


# ── Codex Live-1 (gpt-live-1-codex, v3/frameless) via codex app-server ──────
#
# Codex app-server (>=0.154) negotiates a WebRTC session with the ChatGPT
# backend using subscription auth (model_provider=openai). The client sends
# an SDP offer; return the answer here. Audio flows directly client<->OpenAI.

_CL: dict = {"proc": None, "notifs": [], "seq": 0, "thread_id": None}
_CL_LOCK = threading.Lock()


def _cl_send(obj: dict) -> None:
    proc = _CL["proc"]
    if proc is None or proc.poll() is not None:
        raise RuntimeError("codex app-server is not available")
    proc.stdin.write(json.dumps(obj) + "\n")
    proc.stdin.flush()


def _cl_reader(proc) -> None:
    try:
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                _CL["notifs"].append(json.loads(line))
            except Exception:  # noqa: BLE001
                continue
            if len(_CL["notifs"]) > 6000:
                del _CL["notifs"][:2000]
    except Exception:  # noqa: BLE001
        pass


def _cl_request(method: str, params: dict, timeout: float = 30.0):
    _CL["seq"] += 1
    rid = _CL["seq"]
    _cl_send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
    t0 = time.time()
    while time.time() - t0 < timeout:
        # Scan by id: _cl_reader prunes the front of the buffer, so a saved
        # start position can go stale and miss the response.
        for m in list(_CL["notifs"]):
            if m.get("id") == rid:
                if "error" in m:
                    raise RuntimeError(str(m["error"].get("message") or m["error"])[:400])
                return m.get("result")
        time.sleep(0.1)
    raise TimeoutError(f"codex app-server: no response to {method}")



def _cl_ensure() -> None:
    proc = _CL["proc"]
    if proc is not None and proc.poll() is None:
        return
    binary = _codex_binary()
    if not binary:
        raise RuntimeError("codex was not found (service PATH omits ~/.npm-global/bin)")
    env = os.environ.copy()
    env["PATH"] = os.pathsep.join(p for p in (str(Path(binary).parent), env.get("PATH", "")) if p)
    # The voice lane uses SUBSCRIPTION auth (auth.json), not an environment API key.
    env.pop("OPENAI_API_KEY", None)
    env.pop("CODEX_API_KEY", None)
    proc = subprocess.Popen(
        [binary, "app-server", "--listen", "stdio://",
         "--enable", "realtime_conversation",
         "-c", "model_provider=openai",
         "-c", "suppress_unstable_features_warning=true"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, bufsize=1, env=env,
    )
    _CL["proc"] = proc
    _CL["notifs"] = []
    _CL["thread_id"] = None
    threading.Thread(target=_cl_reader, args=(proc,), daemon=True).start()
    _cl_request("initialize", {"clientInfo": {"name": "hermes-talk-desktop", "version": "1.0"},
                               "capabilities": {"experimentalApi": True}}, timeout=25)


def _codexlive_persona(profile: str | None, language: str = "en") -> str:
    if profile:
        sections = _bot_identity_sections(profile)
        name = _bot_display_name(profile)
    else:
        sections = talk_host.host().identity_sections()
        name = "Hermes"
    base = talk_identity.build_instructions(sections, tools=[], lane="dashboard")
    if profile and "You are Hermes, speaking live" in base:
        base = base.replace("You are Hermes, speaking live", f"You are {name}, speaking live", 1)
    base += _language_directive(language)
    base += (
        f"\n\nVOICE: You are speaking with the user in a live voice session. Keep replies brief, natural, and to the point."
            f" IDENTITY: You are {name}; if asked who you are, answer as {name} in that role — never as a generic assistant."
    )
    base += _voice_policy(language)
    return base


_AGENT_INSTR = {
    "en": 'You are connected to a live voice session with the user. When the voice session delegates a request '
        'to you, carry it out with your tools and reply concisely: your text will be read aloud.',
}

# Client mode (default): the CLIENT runs voice tasks in the user’s Hermes chat.
# Core still routes every delegation to this thread as a phantom fallback.
# Running tools here would consume the ChatGPT plan and duplicate work.
# Neutralize it with this instruction: reply skip without using tools.
_AGENT_INSTR_SKIP = {
    "en": 'You are connected to a live voice session, but the CLIENT (the app) executes the requests from that '
        'session. If you receive a <realtime_delegation> message, do NOT execute anything, do NOT use tools, '
        'and do NOT read files: reply with only the word: skip',
}

# Delegation policy for the VOICE MODEL (which chooses what reaches the backend).
# Without this, greetings/fragments become long delegated turns that flood the chat.
_VOICE_POLICY = (
    "\n\nVOICE DELEGATION POLICY (live call):\n"
    "- Delegate to the chat/backend ONLY when the user asks you to DO something (check, review, find, run, make, fix, send, remember) or when answering needs real facts/actions from the backend.\n"
    "- Do NOT delegate greetings, small talk, acknowledgements, filler, thinking out loud, fragments, or repeats of something already answered (e.g. 'sure', 'ok', 'hello', 'can you hear me?'). Answer those yourself, briefly, or stay quiet.\n"
    "- If the request is unclear, ask ONE short clarifying question yourself instead of delegating.\n"
    "- While a task is running: say ONE brief line in English ('sure, I will check') and WAIT silently; do not guess results, do not delegate again in the meantime; if the user speaks, tell them you are still on it.\n"
    "- When the result arrives, read the key facts back in one or two short sentences."
)


def _voice_policy(language: str = "en") -> str:
    # All locale inputs, including legacy es, use the English policy.
    return _VOICE_POLICY


def _talk_settings() -> dict:
    try:
        p = _PLUGIN_ROOT / "settings.json"
        if p.is_file():
            data = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
    except Exception:  # noqa: BLE001
        pass
    return {}


def _agent_model() -> str | None:
    """Delegated agent model (the Codex thread that runs voice tasks).
    With a non-ChatGPT default model (e.g. a proxy), force an official model;
    otherwise the agent turn fails with HTTP 400."""
    v = os.environ.get("TALK_CODEX_AGENT_MODEL") or str(_talk_settings().get("codexAgentModel") or "")
    v = v.strip()
    return v or None


def _cl_thread_ensure(language: str = "en") -> str:
    language = "en"
    want = _agent_model()
    tid = _CL.get("thread_id")
    if tid and _CL.get("thread_model") == want and _CL.get("thread_language") == language:
        return tid
    body = {"cwd": str(Path.home()), "modelProvider": "openai"}
    if want:
        body["model"] = want
    th = _cl_request("thread/start", body, timeout=30)
    tid = ((th or {}).get("thread") or {}).get("id")
    if not tid:
        raise RuntimeError("codex: could not create the thread")
    _CL["thread_id"] = tid
    _CL["thread_model"] = want
    _CL["thread_language"] = language
    return tid


def _codexlive_start(profile: str | None, voice: str, offer: str, language: str = "en", ask_before_chat: bool = False) -> dict:
    language = "en"  # Backward-compatible locale inputs never select translated prompts.
    _cl_ensure()
    tid = _cl_thread_ensure(language)
    persona = _codexlive_persona(profile, language)
    if ask_before_chat:
        persona += _CHAT_CONFIRMATION_POLICY
    client_managed = str(_talk_settings().get("delegation") or "client").strip().lower() != "server"
    params = {
        "threadId": tid,
        "transport": {"type": "webrtc", "sdp": offer},
        "outputModality": "audio",
        "version": "v3",
        "voice": voice or "cove",
        "prompt": persona,
        "realtimeStartInstructions": (_AGENT_INSTR if not client_managed else _AGENT_INSTR_SKIP)["en"],
        # Voice tasks: by DEFAULT the CLIENT (Desktop) runs them in the user’s
        # Hermes chat using THEIR configuration, models, and providers.
        # Only settings.json {"delegation": "server"} lets core route tasks to the
        # Codex thread agent (ChatGPT lane). ackFiller supplies waiting phrases.
        "clientManagedHandoffs": client_managed,
        "delegationAckFiller": True,
    }
    drop_groups = (("delegationAckFiller",), ("clientManagedHandoffs",), ("realtimeStartInstructions", "prompt"))
    dropped: list[str] = []

    # Cursor = the newest notification so far, by identity. _cl_reader prunes the
    # front of the buffer, which moves list indexes but not this reference.
    def _mark():
        items = list(_CL["notifs"])
        return items[-1] if items else None

    def _since(mark):
        items = list(_CL["notifs"])
        for i in range(len(items) - 1, -1, -1):
            if items[i] is mark:
                return items[i + 1:]
        return items  # mark pruned (or buffer was empty): everything left is newer

    start = _mark()
    gi = 0
    while True:
        try:
            _cl_request("thread/realtime/start", params, timeout=25)
            break
        except RuntimeError as exc:
            low = str(exc).lower()
            if "unknown field" in low and gi < len(drop_groups):
                if ask_before_chat and "prompt" in drop_groups[gi]:
                    raise RuntimeError("Codex fallback would remove the confirmation prompt. Update Codex or turn off Ask before sending to chat.") from exc
                for f in drop_groups[gi]:
                    if f in params:
                        params.pop(f)
                        dropped.append(f)
                gi += 1
                start = _mark()
                continue
            if "thread" in low and ("not found" in low or "no such" in low or "not loaded" in low or "missing" in low):
                # Stale thread: recreate it and retry once.
                _CL["thread_id"] = None
                _CL["thread_model"] = None
                tid2 = _cl_thread_ensure(language)
                params["threadId"] = tid2
                start = _mark()
                _cl_request("thread/realtime/start", params, timeout=25)
                break
            if "usage limit" in low or "hit your usage" in low:
                raise RuntimeError(
                    "LIVE_QUOTA_REACHED: the ChatGPT plan reached its weekly limit (Live Voice shares that quota). "
                    "Switch Voice engine to gpt-realtime-2.1 in settings, or wait for the weekly reset."
                )
            if "already" in low:
                # Realtime session stuck in the thread: stop it and retry.
                try:
                    _cl_request("thread/realtime/stop", {"threadId": params.get("threadId")}, timeout=10)
                except Exception:  # noqa: BLE001
                    pass
                start = _mark()
                _cl_request("thread/realtime/start", params, timeout=25)
                break
            raise
    answer = None
    rsid = None
    t0 = time.time()
    while time.time() - t0 < 45:
        for m in _since(start):
            meth = m.get("method") or ""
            if meth == "thread/realtime/sdp":
                answer = (m.get("params") or {}).get("sdp") or answer
            elif meth == "thread/realtime/started":
                rsid = (m.get("params") or {}).get("realtimeSessionId") or rsid
            elif meth == "thread/realtime/error":
                raise RuntimeError("codex live: " + str((m.get("params") or {}).get("message"))[:300])
        if answer:
            break
        time.sleep(0.15)
    if not answer:
        raise TimeoutError("codex live: no answer SDP")
    result = {"answer": answer, "realtimeSessionId": rsid, "threadId": params.get("threadId") or tid, "version": "v3", "engine": "codex",
              "handoff": "client" if client_managed else "server"}
    if dropped:
        _log.warning("codex live: app-server does not support %s (omitted)", ", ".join(dropped))
        result["droppedFields"] = dropped
        if "clientManagedHandoffs" in dropped and client_managed:
            result["handoffDegraded"] = True
            result["warning"] = ("app-server does not support clientManagedHandoffs: voice tasks may run "
                                 "in the agent thread (ChatGPT lane) instead of the client chat")
    return result


def _codexlive_stop(thread_id: str | None) -> None:
    if not thread_id:
        return
    try:
        _cl_request("thread/realtime/stop", {"threadId": thread_id}, timeout=10)
    except Exception:  # noqa: BLE001
        pass


if router is not None:
    @router.post("/codexlive/session")
    async def codexlive_session(request: Request) -> dict:
        body = {}
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}
        profile = str(body.get("profile") or "").strip() or None
        if profile and _profile_home(profile) is None:
            raise HTTPException(status_code=400, detail=f"profile '{profile}' does not exist")
        voice = str(body.get("voice") or "cove")
        ask_before_chat = body.get("askBeforeChat", True) is not False
        offer = str(body.get("offer") or "")
        if not offer:
            raise HTTPException(status_code=400, detail="SDP offer is required")

        def _do():
            with _CL_LOCK:
                return _codexlive_start(profile, voice, offer, "en", ask_before_chat)

        try:
            result = await asyncio.to_thread(_do)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=str(exc)[:400]) from exc
        return {
            "ok": True,
            "engine": "codex",
            "profile": profile,
            "botName": _bot_display_name(profile) if profile else "Hermes",
            **result,
        }

    @router.post("/codexlive/interrupt")
    async def codexlive_interrupt(request: Request) -> dict:
        """Barge-in: interrupt the current voice turn (app-server turn/interrupt)."""
        body = {}
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}
        turn_id = str(body.get("turnId") or "").strip()
        thread_id = str(body.get("threadId") or "").strip() or _CL.get("thread_id")
        if not turn_id or not thread_id:
            return {"ok": False, "error": "turnId/threadId are required"}
        try:
            await asyncio.to_thread(
                _cl_request, "turn/interrupt", {"threadId": thread_id, "turnId": turn_id}, timeout=8
            )
            return {"ok": True}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc)[:200]}

    @router.post("/codexlive/stop")
    async def codexlive_stop_route(request: Request) -> dict:
        body = {}
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}
        tid = str(body.get("threadId") or _CL.get("thread_id") or "")
        await asyncio.to_thread(_codexlive_stop, tid)
        return {"ok": True}


# ── Hermes Live: Hermes' own GPT-Live voice mode (tools/voice_live.py), in-process ──

def _voice_live():
    import importlib
    return importlib.import_module("tools.voice_live")


@contextlib.contextmanager
def _owner_scope(profile: str | None):
    """The call owner's Hermes home and secrets, through Hermes' own context-local (await-safe)
    profile scope: nothing process-global is patched. No profile: the request's own scope."""
    if not profile:
        yield
        return
    from hermes_cli.web_server_profiles import _config_profile_scope
    with _config_profile_scope(profile):
        yield


_HERMESLIVE_CALL = contextvars.ContextVar("hermeslive_call", default=False)
_HERMESLIVE_LOGS = {}  # helper logger name -> plugin calls in flight
_HERMESLIVE_LOG_LOCK = threading.Lock()


def _hermeslive_withhold(record: logging.LogRecord) -> bool:
    """In the plugin's own GPT-Live call only (context-local), a helper record keeps its level and
    status code but not its text: the helper logs vendor error bodies, which can quote the key."""
    if _HERMESLIVE_CALL.get():
        code = next((a for a in record.args if isinstance(a, int)), "") if isinstance(record.args, tuple) else ""
        record.msg, record.args = "GPT-Live %s: detail withheld by talk-desktop (it can quote the key)", (code,)
        record.exc_info = record.exc_text = record.stack_info = None
    return True


@contextlib.contextmanager
def _hermeslive_quiet(log: logging.Logger):
    """The filter is on the helper's logger only while plugin calls run; other contexts log as before."""
    with _HERMESLIVE_LOG_LOCK:
        _HERMESLIVE_LOGS[log.name] = _HERMESLIVE_LOGS.get(log.name, 0) + 1
        log.addFilter(_hermeslive_withhold)
    token = _HERMESLIVE_CALL.set(True)
    try:
        yield
    finally:
        _HERMESLIVE_CALL.reset(token)
        with _HERMESLIVE_LOG_LOCK:
            _HERMESLIVE_LOGS[log.name] -= 1
            if not _HERMESLIVE_LOGS[log.name]:
                del _HERMESLIVE_LOGS[log.name]
                log.removeFilter(_hermeslive_withhold)


def _hermeslive_error(exc: Exception) -> tuple[int, str]:
    """(status, detail) for a failed Hermes Live start: a code the desktop words plainly. Vendor
    bodies are never passed on; they can quote the key."""
    if isinstance(exc, ImportError):
        return 503, "HERMES_LIVE_UNSUPPORTED: this Hermes has no GPT-Live voice mode"
    text = str(exc)
    if isinstance(exc, ValueError) and "API key" in text:
        return 503, "HERMES_LIVE_NO_KEY: no OpenAI API key"
    status = (re.search(r"failed \((\d{3})\)", text) or [None, ""])[1]
    if status in ("401", "403") or "invalid_api_key" in text:
        return 502, "HERMES_LIVE_KEY_REJECTED: OpenAI rejected the API key"
    if status == "429" or "insufficient_quota" in text:
        return 502, "LIVE_QUOTA_REACHED: OpenAI quota or rate limit (Hermes Live)"
    if isinstance(exc, OSError):
        return 502, "HERMES_LIVE_UNREACHABLE: could not reach OpenAI"
    return 502, "Hermes Live session failed" + (f" ({status})" if status else "")


if router is not None:
    @router.get("/hermeslive/status")
    async def hermeslive_status() -> dict:
        """Whether Hermes Live can start on this profile, and why not. Never the key."""
        try:
            st = await asyncio.to_thread(lambda: _voice_live().resolve_gpt_live_status())
        except Exception as exc:  # noqa: BLE001
            return {"ok": True, "available": False, "reason": _hermeslive_error(exc)[1].split(": ", 1)[-1]}
        return {"ok": True, "available": bool(st.get("available")), "reason": st.get("reason"),
                "model": str(st.get("model") or ""), "voice": str(st.get("voice") or "")}

    @router.post("/hermeslive/session")
    async def hermeslive_session(request: Request) -> dict:
        """{profile?, offer, history?} → Hermes' GPT-Live answer SDP. The key stays in Hermes."""
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}
        profile = str(body.get("profile") or "").strip() or None
        offer = body.get("offer") if isinstance(body.get("offer"), str) else ""
        if not offer.strip():
            raise HTTPException(status_code=400, detail="SDP offer is required")
        if profile and _profile_home(profile) is None:
            raise HTTPException(status_code=400, detail=f"profile '{profile}' does not exist")
        history = body.get("history") if isinstance(body.get("history"), list) else None

        def _do():
            live = _voice_live()
            with _owner_scope(profile), _hermeslive_quiet(logging.getLogger(live.__name__)):
                return live.create_webrtc_session(offer, history)

        try:
            result = await asyncio.to_thread(_do)
        except Exception as exc:  # noqa: BLE001
            status, detail = _hermeslive_error(exc)
            raise HTTPException(status_code=status, detail=detail) from None
        return {"ok": True, "engine": "hermes-live", "profile": profile,
                "botName": _bot_display_name(profile) if profile else "Hermes",
                "sessionId": str((result.get("session") or {}).get("id") or ""),
                "answer": str((result.get("transport") or {}).get("sdp") or "")}

