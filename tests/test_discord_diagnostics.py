"""Offline lifecycle diagnostics: retain useful causes without logging payloads."""
import asyncio
import json
import logging
import sys
from pathlib import Path
from types import SimpleNamespace as NS

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.mark.parametrize('kind', ['session.closed', 'session.error', 'error'])
def test_provider_end_is_logged_without_payload(caplog, kind):
    from discord_live import CodexDiscordSession
    session = CodexDiscordSession(NS(), 7, lambda: True, None, None)
    with caplog.at_level(logging.INFO):
        session.on_event(json.dumps({'type': kind, 'error': {'message': 'PRIVATE_TOKEN'},
                                    'item': {'text': 'PRIVATE_TRANSCRIPT'}}))
    assert session.closed.is_set()
    assert session.failure == 'ProviderSessionEnded'
    assert 'provider event=' + kind in caplog.text
    assert 'PRIVATE' not in caplog.text
    assert any(r.name.startswith('gateway.') for r in caplog.records)


def test_output_track_failure_is_logged_without_exception_message(caplog):
    from discord_live import CodexDiscordSession

    class FailedTrack:
        async def recv(self):
            raise RuntimeError('PRIVATE_PROVIDER_MESSAGE')

    async def exercise():
        session = CodexDiscordSession(NS(), 7, lambda: True, None, None)
        await session._play(FailedTrack())
        assert session.closed.is_set()
        assert session.failure == 'RuntimeError'

    with caplog.at_level(logging.INFO):
        asyncio.run(exercise())
    assert 'output track ended (RuntimeError)' in caplog.text
    assert 'PRIVATE' not in caplog.text


def test_webrtc_failure_is_logged_without_signaling_payload(caplog, monkeypatch):
    import aiortc
    from discord_live import CodexDiscordSession

    class Peer:
        connectionState = 'new'
        localDescription = NS(sdp='PRIVATE_SDP')

        def __init__(self):
            self.handlers = {}

        def on(self, name):
            def register(fn):
                self.handlers[name] = fn
                return fn
            return register

        def createDataChannel(self, name):
            return NS(on=lambda *args: None)

        def addTrack(self, track):
            pass

        async def createOffer(self):
            return self.localDescription

        async def setLocalDescription(self, offer):
            pass

        async def setRemoteDescription(self, answer):
            pass

    peer = Peer()
    monkeypatch.setattr(aiortc, 'RTCPeerConnection', lambda: peer)

    async def broker(*args):
        return {'answer': 'PRIVATE_SDP', 'version': 'v3', 'handoff': 'client'}

    async def exercise():
        session = CodexDiscordSession(NS(start=lambda: None), 7, lambda: True, broker, None)
        await session.start()
        peer.connectionState = 'failed'
        await peer.handlers['connectionstatechange']()
        assert session.closed.is_set()

    with caplog.at_level(logging.INFO):
        asyncio.run(exercise())
    assert 'WebRTC state=failed' in caplog.text
    assert 'PRIVATE' not in caplog.text
