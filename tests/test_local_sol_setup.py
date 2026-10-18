"""Local acceptance tests for Ole's GPT-Live/Sol setup."""
from pathlib import Path
import re
import subprocess
from types import SimpleNamespace

from test_plugin_api import PLUGIN_API, load_unit


def test_default_live_persona_does_not_replace_hermes_with_luna():
    ns = load_unit(PLUGIN_API, "_codexlive_persona")
    ns.update(
        talk_host=SimpleNamespace(host=lambda: SimpleNamespace(identity_sections=lambda: {"PERSONA": "You are Hermes."})),
        talk_identity=SimpleNamespace(build_instructions=lambda *args, **kwargs: "You are Hermes, speaking live."),
        _language_directive=lambda language: "",
        _voice_policy=lambda language: "",
    )
    prompt = ns["_codexlive_persona"](None, "en")
    assert "IDENTITY: You are Hermes" in prompt
    assert "Luna" not in prompt


def test_new_live_plugin_uses_sol_without_overriding_saved_voice():
    source = (PLUGIN_API.parents[1] / "desktop/plugin.js").read_text()
    match = re.search(r"const effVoiceFor = \(engine, stored\) => \{.*?\n\}", source, re.S)
    assert match is not None
    constants = "\n".join(line for line in source.splitlines() if line.startswith(("const VOICES =", "const V3_VOICES =")))
    script = constants + "\n" + match.group(0) + "\n" + """
      const assert = require('node:assert/strict');
      assert.equal(effVoiceFor('codex', ''), 'sol');
      assert.equal(effVoiceFor('codex', 'cedar'), 'sol');
      assert.equal(effVoiceFor('codex', 'sol'), 'sol');
      assert.equal(effVoiceFor('codex', 'maple'), 'maple');
      assert.equal(effVoiceFor('openai', ''), 'marin');
    """
    completed = subprocess.run(['node', '-e', script], capture_output=True, text=True)
    assert completed.returncode == 0, completed.stderr


def test_live_session_metadata_uses_hermes_for_default_profile():
    import asyncio
    import threading
    ns = load_unit(PLUGIN_API, "codexlive_session")
    ns.update(
        _CL_LOCK=threading.Lock(),
        _codexlive_start=lambda *args: {"answer": "test-answer", "threadId": "test-thread"},
    )
    class Request:
        async def json(self):
            return {"voice": "sol", "offer": "test-offer", "language": "en"}
    result = asyncio.run(ns["codexlive_session"](Request()))
    assert result["botName"] == "Hermes"
