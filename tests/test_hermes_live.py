"""Group G: the "Hermes Live" engine's backend routes (Hermes' own GPT-Live, tools/voice_live.py).

A fake voice_live stands in for Hermes: no network, no OpenAI key, no provider call.
"""
from __future__ import annotations

import ast
import asyncio
import contextlib
import contextvars
import importlib.util
import io
import json
import logging
import os
import re
import sys
import threading
import types
import urllib.error
import urllib.request
from pathlib import Path

import pytest
from fastapi import HTTPException

from test_plugin_api import PLUGIN_API, load_unit

SECRET = "sk-proj-SECRETKEY1234567890"
# Not key-shaped on purpose: host redaction would not mask it, so only the plugin can keep it out.
MARKER = "FIXTURE_ONLY_KEY_MARKER_7f3a"


class Request:
    def __init__(self, body=None):
        self.body = body or {}

    async def json(self):
        return self.body


def route(name, **extra):
    """The real route plus every top-level `_hermeslive*` helper of plugin_api, in one namespace."""
    tree = ast.parse(PLUGIN_API.read_text(encoding="utf-8"))

    def named(node):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            return node.name
        if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name):
            return node.targets[0].id
        return ""

    helpers = [n for n in tree.body if named(n).lower().startswith("_hermeslive")]
    (handler,) = [n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef) and n.name == name]
    handler.decorator_list = []
    ns = {"asyncio": asyncio, "contextlib": contextlib, "contextvars": contextvars, "logging": logging,
          "re": re, "threading": threading, "HTTPException": HTTPException,
          "_profile_home": lambda p: object() if p == "coder" else None,
          "_bot_display_name": lambda p: p.capitalize()}
    exec(compile(ast.Module(body=[*helpers, handler], type_ignores=[]), str(PLUGIN_API), "exec"), ns)
    ns.update(extra)
    return ns


def fake_live(status=None, session=None, fail=None, calls=None):
    def create_webrtc_session(sdp_offer, history=None):
        calls.append({"offer": sdp_offer, "history": history, "scope": list(scopes)}) if calls is not None else None
        if fail:
            raise fail
        return session

    return types.SimpleNamespace(__name__="tools.voice_live", resolve_gpt_live_status=lambda: dict(status or {}),
                                 create_webrtc_session=create_webrtc_session)


scopes: list = []


@contextlib.contextmanager
def recording_scope(profile):
    scopes.append(profile)
    try:
        yield
    finally:
        scopes.pop()


@pytest.mark.parametrize("available", [False, True])
def test_status_reports_availability_and_reason_without_the_key(available):
    status = {"mode": "chained", "available": available, "model": "gpt-live-1", "voice": "marin",
              "reason": None if available else "no OpenAI API key (set OPENAI_API_KEY or voice.gpt_live.api_key)",
              # A future Hermes field must never be passed through.
              "api_key": SECRET}
    ns = route("hermeslive_status", _voice_live=lambda: fake_live(status=status))
    result = asyncio.run(ns["hermeslive_status"]())
    assert result["ok"] is True and result["available"] is available
    assert result["model"] == "gpt-live-1" and result["voice"] == "marin"
    assert (result["reason"] is None) is available
    assert SECRET not in repr(result) and "api_key" not in result


def test_status_on_a_hermes_without_gpt_live_is_unavailable_with_a_reason():
    def missing():
        raise ImportError("No module named 'tools.voice_live'")

    result = asyncio.run(route("hermeslive_status", _voice_live=missing)["hermeslive_status"]())
    assert result["ok"] is True and result["available"] is False
    assert "GPT-Live" in result["reason"]


def test_session_exchanges_the_exact_offer_under_the_owner_profile_and_returns_only_the_answer():
    calls = []
    live = fake_live(session={"session": {"id": "sess_1", "client_secret": SECRET},
                              "transport": {"type": "webrtc", "sdp": "v=0 answer\r\n"}}, calls=calls)
    ns = route("hermeslive_session", _voice_live=lambda: live, _owner_scope=recording_scope)
    offer = "v=0\r\no=- offer\r\n"  # byte-exact, trailing CRLF included
    result = asyncio.run(ns["hermeslive_session"](Request({"profile": "coder", "offer": offer})))
    assert calls == [{"offer": offer, "history": None, "scope": ["coder"]}], "created inside the owner's scope"
    assert result == {"ok": True, "engine": "hermes-live", "profile": "coder", "botName": "Coder",
                      "sessionId": "sess_1", "answer": "v=0 answer\r\n"}


def test_session_for_the_default_profile_runs_in_the_request_scope_and_forwards_history():
    calls = []
    history = [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]}]
    live = fake_live(session={"session": {"id": "s"}, "transport": {"sdp": "a"}}, calls=calls)
    ns = route("hermeslive_session", _voice_live=lambda: live, _owner_scope=recording_scope)
    result = asyncio.run(ns["hermeslive_session"](Request({"offer": "o", "history": history})))
    assert calls == [{"offer": "o", "history": history, "scope": [None]}]
    assert result["botName"] == "Hermes" and result["answer"] == "a"


@pytest.mark.parametrize("body, expected", [
    ({}, "SDP offer is required"),
    ({"offer": "   "}, "SDP offer is required"),
    ({"offer": "o", "profile": "missing"}, "profile 'missing' does not exist"),
])
def test_session_validates_its_input_before_any_provider_call(body, expected):
    calls = []
    ns = route("hermeslive_session", _voice_live=lambda: fake_live(calls=calls), _owner_scope=recording_scope)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(ns["hermeslive_session"](Request(body)))
    assert exc.value.status_code == 400 and exc.value.detail == expected
    assert calls == []


VENDOR_401 = ('GPT-Live session creation failed (401): {"error": {"message": "Incorrect API key provided: '
              + SECRET + '", "code": "invalid_api_key"}}')


@pytest.mark.parametrize("fail, status, code", [
    (ValueError("GPT-Live needs an OpenAI API key (OPENAI_API_KEY or voice.gpt_live.api_key)"), 503, "HERMES_LIVE_NO_KEY"),
    (RuntimeError(VENDOR_401), 502, "HERMES_LIVE_KEY_REJECTED"),
    (RuntimeError('GPT-Live session creation failed (429): {"error": {"code": "insufficient_quota"}}'), 502, "LIVE_QUOTA_REACHED"),
    (RuntimeError("GPT-Live session creation failed (500): upstream " + SECRET), 502, "Hermes Live session failed (500)"),
    (OSError("<urlopen error timed out>"), 502, "HERMES_LIVE_UNREACHABLE"),
    # A non-JSON vendor body is a ValueError too: not a missing key.
    (ValueError("Expecting value: line 1 column 1 (char 0)"), 502, "Hermes Live session failed"),
    (Exception("boom " + SECRET), 502, "Hermes Live session failed"),
    (ImportError("No module named 'tools.voice_live'"), 503, "HERMES_LIVE_UNSUPPORTED"),
])
def test_session_errors_map_to_clear_messages_and_never_echo_vendor_detail(fail, status, code):
    if isinstance(fail, ImportError):
        def live():
            raise fail
    else:
        live = lambda: fake_live(fail=fail)  # noqa: E731
    ns = route("hermeslive_session", _voice_live=live, _owner_scope=recording_scope)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(ns["hermeslive_session"](Request({"offer": "o"})))
    assert exc.value.status_code == status
    assert code in exc.value.detail
    assert code != "Hermes Live session failed" or "HERMES_LIVE_NO_KEY" not in exc.value.detail
    assert SECRET not in exc.value.detail and "Incorrect API key" not in exc.value.detail
    assert exc.value.__suppress_context__ is True, "the vendor exception is not chained into the error"


def test_owner_scope_uses_hermes_context_local_profile_scope(monkeypatch):
    entered = []

    @contextlib.contextmanager
    def config_profile_scope(profile):
        entered.append(profile)
        yield

    fake = types.ModuleType("hermes_cli.web_server_profiles")
    fake._config_profile_scope = config_profile_scope
    monkeypatch.setitem(sys.modules, "hermes_cli", types.ModuleType("hermes_cli"))
    monkeypatch.setitem(sys.modules, "hermes_cli.web_server_profiles", fake)
    owner_scope = contextlib.contextmanager(load_unit(PLUGIN_API, "_owner_scope")["_owner_scope"])
    with owner_scope("coder"):
        assert entered == ["coder"]
    with owner_scope(None):
        pass
    assert entered == ["coder"], "no profile: the request's own scope, nothing entered"


# ── Review round 1: the key must never reach a log, even before the route sanitizes the error ──

def real_helper_path() -> Path | None:
    """The installed Hermes helper, found via the account's real home: the verify script points
    HOME at a scratch dir. Read-only; loaded from its file, never imported as Hermes."""
    import pwd
    path = Path(pwd.getpwuid(os.getuid()).pw_dir) / ".hermes" / "hermes-agent" / "tools" / "voice_live.py"
    return path if path.is_file() else None


FIXTURE_HELPER = '''
import json, logging, urllib.error, urllib.request
logger = logging.getLogger(__name__)

def _live_section():
    return {}

def _resolve_credentials(live):
    return "", ""

def create_webrtc_session(sdp_offer, history=None):
    """The real helper's HTTP-error path (tools/voice_live.py create_webrtc_session), verbatim."""
    api_key, base_url = _resolve_credentials(_live_section())
    req = urllib.request.Request(f"{base_url}/live/sessions", data=b"{}", method="POST",
                                 headers={"Authorization": f"Bearer {api_key}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:600]
        logger.warning("GPT-Live session creation failed: %s %s", exc.code, detail)
        raise RuntimeError(f"GPT-Live session creation failed ({exc.code}): {detail}") from exc
'''


def load_helper(kind: str):
    """A voice_live module whose credentials are a fixture marker and whose urlopen answers 401 with
    a body that quotes the key, as OpenAI's invalid_api_key error does. No config, no network."""
    name = f"tools.voice_live_review_{kind}"
    if kind == "real":
        path = real_helper_path()
        if path is None:
            pytest.skip("Hermes checkout not present")
        spec = importlib.util.spec_from_file_location(name, path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    else:
        mod = types.ModuleType(name)
        exec(compile(FIXTURE_HELPER, "<fixture voice_live>", "exec"), mod.__dict__)
    mod._live_section = lambda *a: {}
    mod._resolve_credentials = lambda live: (MARKER, "https://fixture.invalid/v1")

    def rejected(request, **kwargs):
        assert request.full_url.startswith("https://fixture.invalid/"), "never a real provider"
        body = json.dumps({"error": {"message": f"Incorrect API key provided: {MARKER} {SECRET}",
                                     "code": "invalid_api_key"}}).encode()
        raise urllib.error.HTTPError(request.full_url, 401, "fixture rejected", {}, io.BytesIO(body))

    mod.urllib = types.SimpleNamespace(request=types.SimpleNamespace(Request=urllib.request.Request,
                                                                     urlopen=rejected), error=urllib.error)
    return mod





@pytest.mark.parametrize("kind", ["fixture", "real"])
def test_a_rejected_key_never_reaches_any_log_record_with_host_redaction_off(kind, caplog):
    """caplog formats with a plain Formatter, so Hermes' optional RedactingFormatter is not in the
    path; MARKER is not key-shaped either, so only the plugin can keep it out."""
    helper = load_helper(kind)
    log = logging.getLogger(helper.__name__)
    filters_before = list(log.filters)
    ns = route("hermeslive_session", _voice_live=lambda: helper, _owner_scope=recording_scope)
    caplog.set_level(logging.DEBUG)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(ns["hermeslive_session"](Request({"offer": "v=0\r\n"})))
    assert exc.value.status_code == 502 and "HERMES_LIVE_KEY_REJECTED" in exc.value.detail
    records = [r for r in caplog.records if r.name == helper.__name__]
    assert records, "the failure is still logged, only without the vendor text"
    for r in records:
        text = caplog.handler.format(r)
        assert MARKER not in text and SECRET not in text and "Incorrect API key" not in text
        assert "401" in text and r.levelno == logging.WARNING
    assert MARKER not in caplog.text and SECRET not in caplog.text
    assert log.filters == filters_before, "the logger is left exactly as it was"


def test_hermes_own_logging_outside_the_plugin_call_is_untouched_even_while_a_call_runs(caplog):
    """The protection is scoped to the plugin's own call (context-local), so a concurrent Hermes
    request on another thread keeps its full log text, and overlapping calls keep it until the last."""
    helper = load_helper("fixture")
    log = logging.getLogger(helper.__name__)
    inside = {"a": threading.Event(), "b": threading.Event()}
    release = {"a": threading.Event(), "b": threading.Event()}
    results = {}

    def slow(sdp_offer, history=None):
        log.warning("inside the plugin call %s: %s", sdp_offer, MARKER)
        inside[sdp_offer].set()
        assert release[sdp_offer].wait(5)
        return {"session": {"id": sdp_offer}, "transport": {"sdp": "answer-" + sdp_offer}}

    live = types.SimpleNamespace(__name__=helper.__name__, create_webrtc_session=slow)
    ns = route("hermeslive_session", _voice_live=lambda: live, _owner_scope=recording_scope)

    def call(offer):
        results[offer] = asyncio.run(ns["hermeslive_session"](Request({"offer": offer})))

    caplog.set_level(logging.DEBUG)
    workers = {k: threading.Thread(target=call, args=(k,)) for k in "ab"}
    for k in "ab":
        workers[k].start()
        assert inside[k].wait(5)
    log.warning("hermes' own route: %s", "visible-detail-1")  # another request, outside the plugin calls
    release["a"].set()
    workers["a"].join(5)
    assert log.filters, "still active while the overlapping call b runs"
    log.warning("hermes' own route: %s", "visible-detail-2")
    release["b"].set()
    workers["b"].join(5)
    assert results["a"]["answer"] == "answer-a" and results["b"]["answer"] == "answer-b"
    texts = [r.getMessage() for r in caplog.records if r.name == helper.__name__]
    assert any("visible-detail-1" in t for t in texts) and any("visible-detail-2" in t for t in texts), \
        "unrelated Hermes logging is not weakened"
    assert not any(MARKER in t for t in texts)
    assert log.filters == [], "filter removed after the last call"
    log.warning("after: %s", "visible-detail-3")
    assert "visible-detail-3" in caplog.records[-1].getMessage()
