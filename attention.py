"""Open human-input requests (approval / clarify / sudo) for the pet's "needs you" badge.

Hermes fires ``on_human_input_request`` / ``on_human_input_resolved`` around every
blocking approval, clarify question and sudo prompt (``tools/human_input_hooks.py``).
These run in the backend process that hosts the agent turn. This module keeps the
open set and pushes the whole set to the desktop half as the plugin event
``plugin.talk-desktop.attention`` through the sanctioned
``hermes_cli.plugin_events.broadcast_plugin_event`` door. No Hermes core change.

Only ids, kinds and timestamps leave this module: never the prompt text (an approval
prompt is a shell command and can carry secrets) and never the session key.

Shared state: ``__init__.register`` (hooks) and ``dashboard/plugin_api.py`` (the
``GET /attention`` snapshot route) are loaded by different loaders, so both obtain
this module through :func:`shared`, which pins one instance in ``sys.modules``.
"""
from __future__ import annotations

import importlib.util
import logging
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

PLUGIN_ID = "talk-desktop"
EVENT = "attention"
MODULE_NAME = "talk_desktop_attention"
KINDS = frozenset({"approval", "clarify", "sudo"})
MAX_OPEN = 16
# Safety net for a resolve that never arrives (e.g. a hook dispatch failure).
# Normal waits end far sooner: approvals.timeout defaults to 300 s.
MAX_AGE_S = 6 * 3600

_log = logging.getLogger("hermes.plugins.talk-desktop.attention")


def shared() -> Any:
    """The single process-wide instance of this module, whichever loader asks first."""
    mod = sys.modules.get(MODULE_NAME)
    if mod is None:
        spec = importlib.util.spec_from_file_location(MODULE_NAME, Path(__file__).resolve())
        if spec is None or spec.loader is None:
            raise ImportError("talk-desktop attention module unavailable")
        mod = importlib.util.module_from_spec(spec)
        sys.modules[MODULE_NAME] = mod
        spec.loader.exec_module(mod)
    return mod


def _default_broadcast(payload: dict) -> None:
    from hermes_cli.plugin_events import broadcast_plugin_event
    broadcast_plugin_event(PLUGIN_ID, EVENT, payload)


class Registry:
    def __init__(self, broadcast: Optional[Callable[[dict], None]] = None,
                 clock: Callable[[], float] = time.time) -> None:
        self._lock = threading.Lock()
        self._open: dict[str, dict] = {}
        self._seq = 0
        self._boot = uuid.uuid4().hex[:12]
        self._broadcast = broadcast or _default_broadcast
        self._clock = clock

    def _prune(self, now: float) -> None:
        for rid in [r for r, e in self._open.items() if now - e["since"] / 1000 > MAX_AGE_S]:
            self._open.pop(rid, None)

    def _payload(self) -> dict:
        self._seq += 1
        requests = sorted(self._open.values(), key=lambda e: e["since"])
        return {"boot": self._boot, "seq": self._seq, "requests": [dict(e) for e in requests]}

    def snapshot(self) -> dict:
        with self._lock:
            self._prune(self._clock())
            return {"boot": self._boot, "seq": self._seq,
                    "requests": [dict(e) for e in sorted(self._open.values(), key=lambda e: e["since"])]}

    def _publish(self, payload: dict) -> None:
        try:
            self._broadcast(payload)
        except Exception:  # observability must never break a human prompt
            _log.debug("attention broadcast failed", exc_info=True)

    def opened(self, **payload: Any) -> None:
        kind = str(payload.get("kind") or "")
        rid = str(payload.get("request_id") or "")
        if kind not in KINDS or not rid:
            return
        # ``profile`` is stamped by the registering plugin (bot-alerts sets the bot's
        # profile name); Hermes' own payload has no profile field.
        entry = {"id": rid[:64], "kind": kind,
                 "session_id": str(payload.get("session_id") or "")[:128],
                 "profile": str(payload.get("profile") or "default")[:64],
                 "since": int(self._clock() * 1000)}
        with self._lock:
            now = self._clock()
            self._prune(now)
            self._open[entry["id"]] = entry
            while len(self._open) > MAX_OPEN:
                oldest = min(self._open.values(), key=lambda e: e["since"])
                self._open.pop(oldest["id"], None)
            out = self._payload()
        self._publish(out)

    def resolved(self, **payload: Any) -> None:
        rid = str(payload.get("request_id") or "")[:64]
        with self._lock:
            if self._open.pop(rid, None) is None:
                return
            self._prune(self._clock())
            out = self._payload()
        self._publish(out)


registry = Registry()


def on_human_input_request(**payload: Any) -> None:
    registry.opened(**payload)


def on_human_input_resolved(**payload: Any) -> None:
    registry.resolved(**payload)
