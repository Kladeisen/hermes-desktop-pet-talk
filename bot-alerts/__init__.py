"""talk-desktop bot alerts: tell the talk-desktop pets when this bot profile is waiting on the user,
and what step each of its sessions is on (thinking, which tool, done).

Hermes loads plugins per profile home, so talk-desktop's own needs-you hooks only see
the default profile. Installed as ``<root>/profiles/<bot>/plugins/talk-desktop-alerts``,
this plugin forwards the bot's approval / clarify / sudo waits into the same in-process
registry talk-desktop serves (``talk_desktop_attention``), tagged with the bot's profile
name. Hooks only: no voice, UI, network or config access, and never the prompt text.

Progress: tool/model hooks write one tiny JSON file per session under
``<root>/plugins/talk-desktop/data/progress/`` (atomic replace). Files, not the in-process
registry, because Kanban workers and CLI bots run in their own processes. Each file holds
only the profile, a step (thinking / tool / working / done / error / interrupted), a
sanitized tool name, timestamps and the writer pid: never prompts, tool arguments,
outputs or raw session ids.
"""
from __future__ import annotations

import hashlib
import importlib.util
import itertools
import json
import logging
import os
import re
import sys
import threading
import time
from pathlib import Path

_MODULE = 'talk_desktop_attention'
_TOOL = re.compile(r'[a-z0-9_.-]{1,40}')
_now = time.time
_log = logging.getLogger('hermes.plugins.talk-desktop-alerts')


def _layout(here: Path | None = None) -> tuple[str, Path]:
    """(profile name, Hermes root) from ``<root>/profiles/<name>/plugins/<this>/__init__.py``."""
    here = (here or Path(__file__)).resolve()
    plugin_dir = here.parent
    home = plugin_dir.parent.parent
    if home.parent.name == 'profiles':
        return home.name, home.parent.parent
    return 'default', home


def _attention():
    module = sys.modules.get(_MODULE)
    if module is not None:
        return module
    _profile, root = _layout()
    path = root / 'plugins' / 'talk-desktop' / 'attention.py'
    spec = importlib.util.spec_from_file_location('talk_desktop_attention_loader', path)
    if spec is None or spec.loader is None:
        raise ImportError(f'talk-desktop attention module unavailable at {path}')
    loader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loader)
    return loader.shared()


class _Progress:
    """Latest step per session, written only when it changes."""

    def __init__(self, profile: str, root: Path) -> None:
        self.profile, self.folder = profile, root / 'plugins' / 'talk-desktop' / 'data' / 'progress'
        self.steps: dict[str, dict] = {}
        # Hooks can run concurrently: one lock per session serializes its publication.
        self._guard, self._locks = threading.Lock(), {}
        self._serial = itertools.count()

    def _file(self, session_id: str) -> Path:
        digest = hashlib.sha256(f'{self.profile}\0{session_id}'.encode()).hexdigest()[:24]
        return self.folder / f'{digest}.json'

    def set(self, session_id, state: str, tool: str = '', keep_since: bool = False, retry: bool = False) -> None:
        session_id = str(session_id or '')
        if not session_id:
            return
        with self._guard:
            lock = self._locks.setdefault(session_id, threading.Lock())
        with lock:
            previous = self.steps.get(session_id) or {}
            same = previous.get('state') == state and previous.get('tool', '') == tool
            step = {'v': 1, 'profile': self.profile, 'state': state, 'tool': tool,
                    'since': previous['since'] if same or keep_since and previous.get('state') == state else _now(),
                    'retries': previous.get('retries', 0) + 1 if retry else previous.get('retries', 0) if same else 0,
                    'pid': os.getpid()}
            if step == previous:
                return
            self.folder.mkdir(parents=True, exist_ok=True)
            target = self._file(session_id)
            part = target.with_name(f'{target.name}.{os.getpid()}.{next(self._serial)}.part')
            try:
                part.write_text(json.dumps(step))
                os.replace(part, target)
            except BaseException:
                part.unlink(missing_ok=True)
                raise
            self.steps[session_id] = step  # remembered only once it is on disk


def _tool_name(name) -> str:
    name = str(name or '').strip().lower()
    return name if _TOOL.fullmatch(name) else 'tool'


def register(ctx) -> None:
    profile, root = _layout()
    progress = _Progress(profile, root)

    def step(state: str, **options):
        def hook(**payload) -> None:
            try:
                tool = _tool_name(payload.get('tool_name')) if state == 'tool' else ''
                progress.set(payload.get('session_id'), state, tool, **options)
            except Exception:  # progress is cosmetic: never break the bot's turn
                _log.debug('bot progress write failed', exc_info=True)
        return hook

    def ended(**payload) -> None:
        state = 'error' if payload.get('failed') else 'interrupted' if payload.get('interrupted') else 'done'
        step(state)(**payload)

    ctx.register_hook('pre_api_request', step('thinking', keep_since=True))
    ctx.register_hook('api_request_error', step('thinking', keep_since=True, retry=True))
    ctx.register_hook('post_api_request', step('working'))
    ctx.register_hook('pre_tool_call', step('tool'))
    ctx.register_hook('post_tool_call', step('working'))
    ctx.register_hook('on_session_end', ended)

    def opened(**payload) -> None:
        try:
            _attention().registry.opened(**{**payload, 'profile': profile})
        except Exception:  # an alert must never break the human prompt
            _log.debug('bot alert dispatch failed', exc_info=True)

    def resolved(**payload) -> None:
        try:
            _attention().registry.resolved(**payload)
        except Exception:
            _log.debug('bot alert resolve failed', exc_info=True)

    ctx.register_hook('on_human_input_request', opened)
    ctx.register_hook('on_human_input_resolved', resolved)
