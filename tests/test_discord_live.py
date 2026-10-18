"""Offline Discord/Codex integration; generated PCM only, no live channel."""
import asyncio
import importlib
import math
import struct
from pathlib import Path
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def test_generated_discord_pcm_roundtrip():
    from discord_audio import DiscordAudio, InputAudioPacket, _new_source
    audio = DiscordAudio()
    pcm = struct.pack('<480h', *(int(12000 * math.sin(i * math.tau * 440 / 24000)) for i in range(480)))
    audio._source = _new_source(audio._outbound)
    audio.queue_playback(pcm)
    wire = audio._source.read()
    assert len(wire) == 3840
    from discord_audio import discord_to_session
    converted, tail = discord_to_session(wire)
    assert not tail
    audio._inbound.put(InputAudioPacket({'user_id': 7}, converted))
    packet = audio.read_input_packet()
    assert packet.speaker['user_id'] == 7
    samples = struct.unpack('<480h', packet.pcm)
    assert sum(s*s for s in samples) > 480 * 7000**2
    assert audio._source.read() == bytes(3840)
    audio.stop()


def test_webrtc_session_carries_generated_audio_and_cleans_up():
    from discord_live import CodexDiscordSession
    from discord_audio import DiscordAudio, InputAudioPacket
    from aiortc import RTCPeerConnection, RTCSessionDescription

    async def exercise():
        room = DiscordAudio()
        room.start = lambda: None
        room.stop = lambda: setattr(room, 'stopped', True)
        tone = struct.pack('<480h', *(int(10000 * math.sin(i * math.tau * 440 / 24000)) for i in range(480)))
        for _ in range(50):
            room._inbound.put(InputAudioPacket({'user_id': 7}, tone))
        room._audio_clock = 1
        peer = RTCPeerConnection()
        heard = asyncio.Event()
        async def broker(offer, voice, language):
            assert voice == 'sol' and language == 'en'
            await peer.setRemoteDescription(RTCSessionDescription(sdp=offer, type='offer'))
            # Echo the incoming real decoded media track.
            track = next(t.receiver.track for t in peer.getTransceivers() if t.kind == 'audio')
            peer.addTrack(track)
            answer = await peer.createAnswer()
            await peer.setLocalDescription(answer)
            return {'answer': peer.localDescription.sdp, 'threadId': 'test-thread', 'version': 'v3', 'handoff': 'client'}
        stopped = []
        async def stop(thread):
            stopped.append(thread)
        session = CodexDiscordSession(room, 7, lambda: True, broker, stop)
        try:
            await session.start()
            for _ in range(300):
                if not room._outbound.empty():
                    chunk = room._outbound.get()
                    if any(chunk):
                        heard.set()
                        break
                await asyncio.sleep(.02)
            assert heard.is_set(), 'generated inbound PCM did not return over real WebRTC'
        finally:
            await session.close()
            await peer.close()
        assert room.stopped
        assert stopped == ['test-thread']
        assert session.pc.connectionState == 'closed'
    asyncio.run(exercise())


def test_room_authority_denies_unknown_speakers_and_changed_audience():
    from discord_live import room_authority
    from types import SimpleNamespace as NS
    operator = NS(id=7, bot=False)
    guest = NS(id=9, bot=False)
    channel = NS(id=22, guild=NS(id=42), members=[operator])
    voice = NS(channel=channel, is_connected=lambda: True)
    receiver = object()
    adapter = NS(_voice_clients={42: voice}, _voice_receivers={42: receiver},
                 _is_allowed_user=lambda uid, **kw: uid == '7')
    bridge = dict(guild_id=42, voice_client=voice, receiver=receiver, adapter=adapter)
    guard = room_authority(bridge, 7)
    assert guard()
    channel.members.append(guest)
    assert not guard()
    import pytest
    with pytest.raises(PermissionError):
        room_authority(bridge, 7)
    channel.members = [operator]
    adapter._voice_receivers[42] = object()
    assert not guard()


def test_v3_delegations_are_serialized_deduplicated_and_return_real_result():
    from discord_live import CodexDiscordSession
    from types import SimpleNamespace as NS
    async def exercise():
        sent, requests = [], []
        async def delegate(text):
            requests.append(text)
            await asyncio.sleep(.01)
            return 'verified tool result'
        session = CodexDiscordSession(NS(drain_playback=lambda: None), 7, lambda: True, None, None, delegate=delegate)
        session.channel = NS(readyState='open', send=lambda text: sent.append(__import__('json').loads(text)))
        event = {'type': 'delegation.created', 'item': {'id': 'item-test', 'content': [{'type': 'input_text', 'text': 'check the file'}]}}
        session.on_event(__import__('json').dumps(event))
        session.on_event(__import__('json').dumps(event))
        await asyncio.gather(*list(session.tasks))
        assert requests == ['check the file']
        assert sent == [{'type': 'delegation.context.append', 'delegation_item_id': 'item-test',
                         'content': [{'type': 'input_text', 'text': 'verified tool result'}]}]
        session.authorized = lambda: False
        session.on_event(__import__('json').dumps({'type': 'delegation.created', 'item': {'id': 'item-denied', 'content': event['item']['content']}}))
        await asyncio.gather(*list(session.tasks))
        assert len(requests) == 1 and len(sent) == 1
    asyncio.run(exercise())


def test_plugin_registers_distinct_async_gateway_command_without_media_imports():
    import importlib.util
    from types import SimpleNamespace as NS
    spec = importlib.util.spec_from_file_location('live_plugin_entry', ROOT / '__init__.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    registrations = []
    module.register(NS(register_command=lambda *args, **kwargs: registrations.append((args, kwargs))))
    assert registrations and registrations[0][0] == ('live-voice',)
    import inspect
    assert inspect.iscoroutinefunction(registrations[0][1]['handler'])
    assert 'join' in registrations[0][1]['args_hint']


def test_gateway_command_lifecycle_is_owned_by_invoking_discord_user(monkeypatch):
    import discord_live as live
    from types import SimpleNamespace as NS
    context = {'guild_id': 42, 'operator_id': 7, 'source': None, 'runner': None}
    monkeypatch.setattr(live, 'command_context', lambda: context, raising=False)
    bridge = {'guild_id': 42, 'voice_client': object(), 'receiver': object(), 'adapter': object()}
    import discord_audio
    monkeypatch.setattr(discord_audio, 'resolve_voice_bridge', lambda guild: bridge)
    monkeypatch.setattr(live, 'room_authority', lambda b, o: lambda: True)
    monkeypatch.setattr(live, 'make_broker', lambda: NS(start=None, stop=None), raising=False)
    monkeypatch.setattr(live, 'make_delegate', lambda *args: None, raising=False)
    sessions = []
    class FakeSession:
        def __init__(self, audio, operator, guard, broker, stop, **kw):
            self.audio, self.operator_id, self.authorized = audio, operator, guard
            self.closed = asyncio.Event()
            self.failure = None
            sessions.append(self)
        async def start(self):
            self.started = True
        async def close(self):
            self.closed.set()
    monkeypatch.setattr(live, 'CodexDiscordSession', FakeSession)
    async def exercise():
        assert 'starting' in (await live.command('join')).lower()
        await asyncio.sleep(.01)
        assert sessions[0].started
        assert 'active' in (await live.command('status')).lower()
        context['operator_id'] = 9
        assert 'operator' in (await live.command('leave')).lower()
        assert not sessions[0].closed.is_set()
        context['operator_id'] = 7
        assert 'paused' in (await live.command('pause')).lower()
        assert sessions[0].audio.input_paused
        assert 'resumed' in (await live.command('resume')).lower()
        assert 'ended' in (await live.command('leave')).lower()
        assert 'starting' in (await live.command('join')).lower()
        assert 'ended' in (await live.command('leave')).lower()
        assert live._SESSION is None, 'canceled-before-start session retained ownership'
        assert sessions[-1].closed.is_set()
    asyncio.run(exercise())


def test_leave_retries_one_shot_broker_stop_failure(monkeypatch):
    import discord_live as live
    import discord_audio
    from types import SimpleNamespace as NS

    started = asyncio.Event()
    stopped = []
    audio_stopped = []

    async def stop(thread):
        stopped.append(thread)
        if len(stopped) == 1:
            raise OSError('intentional offline broker stop failure')

    monkeypatch.setattr(live, 'command_context', lambda: {'guild_id': 42, 'operator_id': 7})
    monkeypatch.setattr(discord_audio, 'resolve_voice_bridge', lambda guild: object())
    monkeypatch.setattr(discord_audio, 'DiscordAudio', lambda guild: NS(
        _fail_if_bridge_lost=lambda: None, drain_playback=lambda: None,
        stop=lambda: audio_stopped.append(True)))
    monkeypatch.setattr(live, 'room_authority', lambda *args: lambda: True)
    monkeypatch.setattr(live, 'make_broker', lambda: NS(start=None, stop=stop))
    monkeypatch.setattr(live, 'make_delegate', lambda *args: None)
    monkeypatch.setattr(live, '_SESSION', None)
    monkeypatch.setattr(live, '_LAST_FAILURE', None)

    async def start(session):
        session.thread_id = 'owned-thread'
        started.set()

    monkeypatch.setattr(live.CodexDiscordSession, 'start', start)

    async def exercise():
        assert 'starting' in await live.command('join')
        record = live._SESSION
        assert record is not None
        await asyncio.wait_for(started.wait(), 1)
        reply = await asyncio.wait_for(live.command('leave'), 1)
        assert record['session'].thread_id is None, 'leave orphaned the broker after a cleanup exception'
        assert stopped == ['owned-thread', 'owned-thread'], 'incomplete teardown was not retried'
        assert 'ended' in reply
        await record['session'].close()
        await record['session'].close()
        assert stopped == ['owned-thread', 'owned-thread']
        assert audio_stopped == [True, True], 'successful cleanup was repeated'
        assert live._SESSION is None

    asyncio.run(exercise())


@pytest.mark.parametrize('shutdown', ['leave', 'provider-close'])
def test_failed_cleanup_retains_ownership_until_operator_retry(monkeypatch, shutdown):
    import discord_live as live
    import discord_audio
    from types import SimpleNamespace as NS

    started, retry_started, release_retry = asyncio.Event(), asyncio.Event(), asyncio.Event()
    failing = [True]
    stopped = []

    async def stop(thread):
        stopped.append(thread)
        if failing[0]:
            raise OSError('synthetic-private-stop-details')
        retry_started.set()
        await release_retry.wait()

    monkeypatch.setattr(live, 'command_context', lambda: {'guild_id': 42, 'operator_id': 7})
    monkeypatch.setattr(discord_audio, 'resolve_voice_bridge', lambda guild: object())
    monkeypatch.setattr(discord_audio, 'DiscordAudio', lambda guild: NS(
        _fail_if_bridge_lost=lambda: None, drain_playback=lambda: None, stop=lambda: None))
    monkeypatch.setattr(live, 'room_authority', lambda *args: lambda: True)
    monkeypatch.setattr(live, 'make_broker', lambda: NS(start=None, stop=stop))
    monkeypatch.setattr(live, 'make_delegate', lambda *args: None)
    monkeypatch.setattr(live, '_SESSION', None)
    monkeypatch.setattr(live, '_LAST_FAILURE', None)

    async def start(session):
        session.thread_id = 'owned-thread'
        started.set()

    monkeypatch.setattr(live.CodexDiscordSession, 'start', start)

    async def exercise():
        assert 'starting' in await live.command('join')
        record = live._SESSION
        assert record is not None
        await asyncio.wait_for(started.wait(), 1)
        if shutdown == 'provider-close':
            record['session'].on_event('{"type": "session.closed"}')
            await asyncio.wait_for(asyncio.gather(record['task'], return_exceptions=True), 1)
            assert live._SESSION is record, 'provider cleanup failure orphaned the session'
        replies = await asyncio.wait_for(asyncio.gather(live.command('leave'), return_exceptions=True), 1)
        reply = replies[0]
        assert isinstance(reply, str), 'cleanup failure escaped without operator retry instructions'
        assert 'ended' not in reply.lower()
        assert 'incomplete' in reply.lower() and 'retry' in reply.lower()
        assert 'OSError' in reply and 'synthetic-private-stop-details' not in reply
        assert live._SESSION is record, 'failed teardown released ownership'
        assert record['session'].closed.is_set()
        assert not record['session']._cleanup_complete
        assert record['session'].thread_id == 'owned-thread'
        assert stopped == ['owned-thread', 'owned-thread']
        assert 'cleanup-failed' in await live.command('status')
        assert live._LAST_FAILURE == 'OSError'
        assert 'already' in await live.command('join')
        assert live._SESSION is record

        failing[0] = False
        commands = [asyncio.create_task(live.command('leave'))]
        try:
            await asyncio.wait_for(retry_started.wait(), 1)
            commands.append(asyncio.create_task(live.command('stop')))
            done, _ = await asyncio.wait(commands, timeout=.02)
            assert not done, 'repeated retry did not share pending teardown'
            assert stopped == ['owned-thread'] * 3
            commands[0].cancel()
            canceled = await asyncio.gather(commands[0], return_exceptions=True)
            assert isinstance(canceled[0], asyncio.CancelledError)
            assert live._SESSION is record
            assert not record['cleanup'].done(), 'canceled retry caller interrupted shared teardown'
        finally:
            release_retry.set()
            replies = await asyncio.wait_for(asyncio.gather(*commands, return_exceptions=True), 1)
            await asyncio.wait_for(asyncio.shield(record['cleanup']), 1)
        assert isinstance(replies[1], str) and 'ended' in replies[1]
        assert record['session'].thread_id is None
        assert record['session']._cleanup_complete
        assert stopped == ['owned-thread'] * 3
        assert live._SESSION is None

    asyncio.run(exercise())


def test_repeated_leave_during_signaling_keeps_ownership_until_broker_stops(monkeypatch):
    import discord_live as live
    import discord_audio
    import threading
    from types import SimpleNamespace as NS

    started, release, finished = threading.Event(), threading.Event(), threading.Event()
    stopped, terminated, audio_stopped = [], [], []
    proc = NS(poll=lambda: 0 if terminated else None,
              terminate=lambda: terminated.append(True), wait=lambda timeout: 0)
    state = {'proc': proc, 'thread_id': None}

    def signal(*args):
        started.set()
        try:
            assert release.wait(3), 'test did not release broker signaling'
            state['thread_id'] = 'late-thread'
            return {'threadId': 'late-thread'}
        finally:
            finished.set()

    def stop(thread):
        stopped.append(thread)
        state['thread_id'] = None

    api = NS(_CL=state, _talk_settings=lambda: {}, _codexlive_start=signal, _codexlive_stop=stop)
    monkeypatch.setattr(live, '_load_broker_api', lambda: api)
    monkeypatch.setattr(live, 'command_context', lambda: {'guild_id': 42, 'operator_id': 7})
    monkeypatch.setattr(discord_audio, 'resolve_voice_bridge', lambda guild: object())
    monkeypatch.setattr(discord_audio, 'DiscordAudio', lambda guild: NS(
        drain_playback=lambda: None, stop=lambda: audio_stopped.append(True)))
    monkeypatch.setattr(live, 'room_authority', lambda *args: lambda: True)
    monkeypatch.setattr(live, 'make_delegate', lambda *args: None)
    monkeypatch.setattr(live, '_SESSION', None)

    async def start(session):
        result = await session.broker('test-offer', 'sol', 'en')
        session.thread_id = result['threadId']

    monkeypatch.setattr(live.CodexDiscordSession, 'start', start)

    async def exercise():
        commands = []
        assert 'starting' in await live.command('join')
        record = live._SESSION
        assert record is not None
        try:
            assert await asyncio.to_thread(started.wait, 2), 'broker signaling never started'
            first = asyncio.create_task(live.command('leave'))
            commands.append(first)
            done, _ = await asyncio.wait(commands, timeout=.02)
            assert not done, 'first leave did not wait for blocked signaling'
            second = asyncio.create_task(live.command('leave'))
            commands.append(second)
            done, _ = await asyncio.wait(commands, timeout=.02)
            assert not done, 'duplicate leave abandoned the blocked broker worker'
            assert live._SESSION is record, 'cleanup released ownership before broker signaling ended'
            assert 'already' in await live.command('join'), 'join replaced a session during cleanup'
        finally:
            release.set()
            assert await asyncio.to_thread(finished.wait, 2), 'broker worker did not finish'
            replies = await asyncio.wait_for(asyncio.gather(*commands), 2)
        assert all('ended' in reply for reply in replies)
        assert stopped == ['late-thread'], 'late broker thread was left running'
        assert terminated == [True]
        assert state == {'proc': None, 'thread_id': None}
        assert audio_stopped == [True]
        assert record['session'].closed.is_set()
        assert live._SESSION is None

    asyncio.run(exercise())


@pytest.mark.parametrize('shutdown', ['leave', 'provider-close'])
def test_repeated_leave_during_delegated_cleanup_keeps_the_agent_owned(monkeypatch, shutdown):
    _exercise_delegated_cleanup(monkeypatch, shutdown)


def test_canceled_leave_caller_does_not_abandon_shared_cleanup(monkeypatch):
    _exercise_delegated_cleanup(monkeypatch, 'leave', cancel_caller=True)


def _exercise_delegated_cleanup(monkeypatch, shutdown, *, cancel_caller=False):
    import discord_live as live
    import discord_audio
    import threading
    from types import SimpleNamespace as NS

    started, interrupted = threading.Event(), threading.Event()
    cleanup_started, release_cleanup, cleanup_finished = threading.Event(), threading.Event(), threading.Event()
    interrupts, cleaned, stopped, audio_stopped, sent = [], [], [], [], []

    class Agent:
        def __init__(self, **kw):
            pass

        def run_conversation(self, **kw):
            started.set()
            assert interrupted.wait(3), 'owned agent was not interrupted'
            return {'final_response': 'stopped'}

        def interrupt(self, **kw):
            interrupts.append(kw)
            interrupted.set()

    def cleanup(agent):
        cleanup_started.set()
        try:
            assert release_cleanup.wait(3), 'test did not release delegated-agent cleanup'
            cleaned.append(agent)
        finally:
            cleanup_finished.set()

    runner = NS(_resolve_session_agent_runtime=lambda **kw: ('model', {}),
                _resolve_turn_toolsets=lambda *args: ([], []), _session_db=None,
                _cleanup_agent_resources=cleanup)
    monkeypatch.setitem(sys.modules, 'run_agent', NS(AIAgent=Agent))
    monkeypatch.setitem(sys.modules, 'hermes_cli.config', NS(load_config=lambda: {}))
    monkeypatch.setattr(live, 'command_context', lambda: {
        'guild_id': 42, 'operator_id': 7, 'runner': runner, 'source': NS()})
    monkeypatch.setattr(discord_audio, 'resolve_voice_bridge', lambda guild: object())
    monkeypatch.setattr(discord_audio, 'DiscordAudio', lambda guild: NS(
        _fail_if_bridge_lost=lambda: None, drain_playback=lambda: None,
        stop=lambda: audio_stopped.append(True)))
    monkeypatch.setattr(live, 'room_authority', lambda *args: lambda: True)
    monkeypatch.setattr(live, '_SESSION', None)
    monkeypatch.setattr(live, '_LAST_FAILURE', None)

    async def stop(thread):
        stopped.append(thread)

    monkeypatch.setattr(live, 'make_broker', lambda: NS(start=None, stop=stop))

    async def start(session):
        session.thread_id = 'delegated-thread'
        session.channel = NS(readyState='open', send=sent.append)
        session._spawn(session._delegate('test-delegation', 'test cleanup'))

    monkeypatch.setattr(live.CodexDiscordSession, 'start', start)

    async def exercise():
        commands = []
        assert 'starting' in await live.command('join')
        record = live._SESSION
        assert record is not None
        try:
            assert await asyncio.to_thread(started.wait, 2), 'delegated agent did not start'
            if shutdown == 'provider-close':
                record['session'].on_event('{"type": "session.closed"}')
                assert await asyncio.to_thread(cleanup_started.wait, 2), 'provider closure did not start cleanup'
            first = asyncio.create_task(live.command('leave'))
            commands.append(first)
            assert await asyncio.to_thread(cleanup_started.wait, 2), 'leave did not start agent cleanup'
            if not cancel_caller:
                commands.append(asyncio.create_task(live.command('stop')))
            done, _ = await asyncio.wait(commands, timeout=.02)
            assert not done, 'repeated leave abandoned delegated-agent cleanup'
            if cancel_caller:
                first.cancel()
                replies = await asyncio.gather(first, return_exceptions=True)
                assert isinstance(replies[0], asyncio.CancelledError)
                assert not record['task'].done(), 'canceling the command caller abandoned owned agent cleanup'
            assert live._SESSION is record, 'cleanup released ownership while the agent still owned resources'
            assert 'stopping' in await live.command('status')
            assert 'already' in await live.command('join')
            assert not stopped and not cleaned
        finally:
            release_cleanup.set()
            assert await asyncio.to_thread(cleanup_finished.wait, 2), 'agent cleanup did not finish'
            replies = await asyncio.wait_for(asyncio.gather(*commands, return_exceptions=cancel_caller), 2)
            if record.get('cleanup'):
                await asyncio.wait_for(asyncio.shield(record['cleanup']), 2)
        if not cancel_caller:
            assert all(isinstance(reply, str) and 'ended' in reply for reply in replies)
        assert interrupts == [{'hard_cancel': True}]
        assert len(cleaned) == 1
        assert stopped == ['delegated-thread']
        assert audio_stopped == [True]
        assert not sent, 'canceled delegation delivered a result after leave'
        assert record['session'].thread_id is None
        assert not record['session'].tasks
        assert live._SESSION is None

    asyncio.run(exercise())


def test_command_context_reads_host_bound_ids_not_environment(monkeypatch):
    from types import SimpleNamespace as NS
    import contextvars
    import discord_live as live
    host = NS(_VAR_MAP={name: contextvars.ContextVar(name, default='') for name in
                      ['HERMES_SESSION_PLATFORM', 'HERMES_SESSION_SCOPE_ID', 'HERMES_SESSION_USER_ID',
                       'HERMES_SESSION_PROFILE', 'HERMES_SESSION_CHAT_ID', 'HERMES_SESSION_THREAD_ID']})
    monkeypatch.setitem(sys.modules, 'gateway.session_context', host)
    runner = object()
    monkeypatch.setitem(sys.modules, 'gateway.run', NS(_gateway_runner_ref=lambda: runner))
    monkeypatch.setitem(sys.modules, 'gateway.config', NS(Platform=NS(DISCORD='discord')))
    monkeypatch.setitem(sys.modules, 'gateway.session', NS(SessionSource=lambda **kw: NS(**kw)))
    import pytest
    monkeypatch.setenv('HERMES_SESSION_PLATFORM', 'discord')
    with pytest.raises(PermissionError):
        live.command_context()
    for name, value in [('PLATFORM','discord'), ('SCOPE_ID','42'), ('USER_ID','7'), ('CHAT_ID','22')]:
        host._VAR_MAP['HERMES_SESSION_' + name].set(value)
    context = live.command_context()
    assert context['guild_id'] == 42 and context['operator_id'] == 7
    assert context['runner'] is runner and context['source'].chat_id == '22'
    host._VAR_MAP['HERMES_SESSION_PROFILE'].set('other')
    with pytest.raises(PermissionError):
        live.command_context()


def test_discord_broker_preserves_v3_sol_subscription_and_isolates_desktop(monkeypatch):
    import discord_live as live
    from types import SimpleNamespace as NS
    calls = []
    state = {'proc': None, 'thread_id': None}
    api = NS(_CL=state, _talk_settings=lambda: {'delegation': 'server', 'codexAgentModel': 'existing-model'},
             _codexlive_start=lambda profile, voice, offer, language: calls.append((profile, voice, offer, language)) or
             {'answer': 'test-answer', 'version': 'v3', 'handoff': 'client', 'threadId': 'test-thread'},
             _codexlive_stop=lambda thread: calls.append(('stop', thread)))
    monkeypatch.setattr(live, '_load_broker_api', lambda: api, raising=False)
    broker = live.make_broker()
    async def exercise():
        result = await broker.start('test-offer', 'sol', 'en')
        assert result['version'] == 'v3'
        assert api._talk_settings() == {'delegation': 'client', 'codexAgentModel': 'existing-model'}
        await broker.stop('test-thread')
    asyncio.run(exercise())
    assert calls == [(None, 'sol', 'test-offer', 'en'), ('stop', 'test-thread')]


def test_delegation_uses_host_model_tools_and_discord_identity(monkeypatch):
    import discord_live as live
    from types import SimpleNamespace as NS
    kwargs_seen, prompts, cleaned = [], [], []
    class Agent:
        def __init__(self, **kw):
            kwargs_seen.append(kw)
        def run_conversation(self, **kw):
            prompts.append(kw)
            return {'final_response': 'actual fake-agent result unit-test-secret'}
    monkeypatch.setitem(sys.modules, 'run_agent', NS(AIAgent=Agent))
    monkeypatch.setitem(sys.modules, 'agent.redact', NS(redact_sensitive_text=lambda text: text.replace('unit-test-secret', '[REDACTED]')))
    monkeypatch.setitem(sys.modules, 'hermes_cli.config', NS(load_config=lambda: {'agent': {'max_turns': 3}}))
    source = NS(chat_id='22', user_id='7', scope_id='42', user_id_alt=None, user_name=None,
                chat_name=None, chat_type='channel', thread_id=None)
    runner = NS(_resolve_session_agent_runtime=lambda **kw: ('host-model', {'provider':'host-provider'}),
                _resolve_turn_toolsets=lambda *args: (['terminal'], ['browser']),
                _cleanup_agent_resources=lambda agent: cleaned.append(agent),
                _session_db=None)
    delegate = live.make_delegate({'runner': runner, 'source': source}, lambda: True)
    result = asyncio.run(delegate('check the file'))
    assert result == 'actual fake-agent result [REDACTED]'
    assert kwargs_seen[0]['model'] == 'host-model'
    assert kwargs_seen[0]['provider'] == 'host-provider'
    assert kwargs_seen[0]['enabled_toolsets'] == ['terminal']
    assert kwargs_seen[0]['disabled_toolsets'] == ['browser']
    assert kwargs_seen[0]['platform'] == 'discord' and kwargs_seen[0]['user_id'] == '7'
    assert 'check the file' in prompts[0]['user_message']
    assert cleaned


def test_player_thread_revokes_already_queued_audio_when_room_changes():
    from discord_live import CodexDiscordSession
    from discord_audio import DiscordAudio, _new_source
    audio = DiscordAudio()
    audio._source = _new_source(audio._outbound)
    allowed = [True]
    session = CodexDiscordSession(audio, 7, lambda: allowed[0], None, None)
    session.bind_audio_authority()
    audio.queue_playback(struct.pack('<480h', *([8000] * 480)))
    allowed[0] = False
    assert audio._source.read() == bytes(3840)
    assert not audio.playback_pending


def test_discord_media_dependency_is_declared_for_managed_installation():
    manifest = (ROOT / 'plugin.yaml').read_text()
    assert 'python_dependencies:' in manifest
    assert 'aiortc>=1.15,<2' in manifest


def test_pausing_discards_track_buffered_speech_and_unknown_speakers():
    from discord_live import CodexDiscordSession
    from discord_audio import DiscordAudio, InputAudioPacket
    import pytest
    async def exercise():
        audio = DiscordAudio()
        audio.start = lambda: None
        audio._inbound.put(InputAudioPacket({'user_id': 9}, struct.pack('<480h', *([9000] * 480))))
        audio._inbound.put(InputAudioPacket({'user_id': 7}, struct.pack('<960h', *([8000] * 960))))
        async def broker(*args):
            raise RuntimeError('intentional offline signaling refusal')
        session = CodexDiscordSession(audio, 7, lambda: True, broker, None)
        try:
            with pytest.raises(RuntimeError):
                await session.start()
            track = session.pc.getSenders()[0].track
            assert not any(bytes((await track.recv()).planes[0]))
            assert any(bytes((await track.recv()).planes[0]))
            audio.pause_input()
            assert not any(bytes((await track.recv()).planes[0])), 'pause leaked prebuffered speech'
        finally:
            await session.close()
    asyncio.run(exercise())


def test_leaving_interrupts_the_owned_hermes_task_and_waits_for_cleanup(monkeypatch):
    import discord_live as live
    import threading
    from types import SimpleNamespace as NS
    started, release = threading.Event(), threading.Event()
    interrupts, cleaned = [], []
    class Agent:
        def __init__(self, **kw): pass
        def run_conversation(self, **kw):
            started.set()
            assert release.wait(3), 'worker was abandoned without interruption'
            return {'final_response': 'stopped'}
        def interrupt(self, **kw):
            interrupts.append(kw)
            release.set()
    monkeypatch.setitem(sys.modules, 'run_agent', NS(AIAgent=Agent))
    monkeypatch.setitem(sys.modules, 'hermes_cli.config', NS(load_config=lambda: {}))
    source = NS()
    runner = NS(_resolve_session_agent_runtime=lambda **kw: ('model', {}),
                _resolve_turn_toolsets=lambda *args: ([], []), _session_db=None,
                _cleanup_agent_resources=lambda agent: cleaned.append(agent))
    async def exercise():
        task = asyncio.create_task(live.make_delegate({'runner':runner, 'source':source}, lambda: True)('read test'))
        await asyncio.to_thread(started.wait, 2)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        assert cleaned, 'leave returned before the owned worker was cleaned up'
        assert interrupts == [{'hard_cancel': True}]
    asyncio.run(exercise())
