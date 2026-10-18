"""Discord media client for the existing Codex app-server v3 broker.

Dependencies are lazy: Desktop does not require aiortc or Discord to load.
The Discord adapter owns RTP/Opus/DAVE; only decoded PCM crosses this boundary.
"""
from __future__ import annotations

import asyncio
import fractions
import json
import logging
from contextlib import suppress

_log = logging.getLogger('gateway.plugins.talk-desktop.discord')
_SESSION = None
_LAST_FAILURE = None


def command_context():
    from gateway.session_context import _VAR_MAP
    from gateway.run import _gateway_runner_ref
    from gateway.config import Platform
    from gateway.session import SessionSource

    def bound(name):
        variable = _VAR_MAP.get('HERMES_SESSION_' + name)
        value = variable.get() if variable else None
        return value if isinstance(value, str) else ''

    if bound('PLATFORM') != 'discord' or bound('PROFILE') not in {'', 'default'}:
        raise PermissionError('Default-profile Discord invocation required')
    guild, operator = bound('SCOPE_ID'), bound('USER_ID')
    if not guild.isdecimal() or not operator.isdecimal() or int(guild) <= 0 or int(operator) <= 0:
        raise PermissionError('Host guild and operator identities required')
    runner = _gateway_runner_ref()
    if runner is None or not bound('CHAT_ID'):
        raise PermissionError('Host gateway command context unavailable')
    source = SessionSource(platform=Platform.DISCORD, chat_id=bound('CHAT_ID'), user_id=operator,
                           scope_id=guild, thread_id=bound('THREAD_ID') or None, profile=None,
                           chat_type='channel')
    return {'guild_id': int(guild), 'operator_id': int(operator), 'runner': runner, 'source': source}


def _load_broker_api():
    """An independent module means an independent app-server/thread, never Desktop's."""
    import importlib.util
    from pathlib import Path
    path = Path(__file__).resolve().parent / 'dashboard' / 'plugin_api.py'
    spec = importlib.util.spec_from_file_location('_discord_live_broker', path)
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
    return api


def make_broker():
    # Import the media dependency before taking ownership of the voice bridge.
    import aiortc  # noqa: F401
    api = _load_broker_api()
    settings = api._talk_settings
    api._talk_settings = lambda: {**settings(), 'delegation': 'client'}

    class Broker:
        async def start(self, offer, voice, language):
            worker = asyncio.create_task(asyncio.to_thread(api._codexlive_start, None, voice, offer, language))
            try:
                return await asyncio.shield(worker)
            except asyncio.CancelledError:
                # to_thread cannot be canceled: wait for signaling before teardown,
                # otherwise its late answer leaves a paid session running orphaned.
                with suppress(Exception):
                    await worker
                await self.stop(api._CL.get('thread_id'))
                raise
            except Exception:
                await self.stop(api._CL.get('thread_id'))
                raise

        async def stop(self, thread):
            await asyncio.to_thread(api._codexlive_stop, thread)
            proc = api._CL.get('proc')
            if proc is not None:
                def terminate():
                    if proc.poll() is None:
                        proc.terminate()
                        try:
                            proc.wait(timeout=5)
                        except Exception:
                            proc.kill()
                            proc.wait(timeout=5)
                await asyncio.to_thread(terminate)
                api._CL['proc'] = None
    return Broker()


def make_delegate(context, authorized):
    """Reuse the gateway's model/credential and toolset resolution, not Talk's provider.

    This host has no canonical Discord task-context API. A voice call owns a
    separate Hermes conversation; it never impersonates or rewrites a Desktop tab.
    """
    from run_agent import AIAgent
    from hermes_cli.config import load_config
    import threading
    import uuid
    runner, source = context['runner'], context['source']
    history = []
    task_id = 'discord-live-' + uuid.uuid4().hex

    async def delegate(text):
        if not authorized():
            raise PermissionError('Discord room authority changed')
        config = load_config()
        model, runtime = runner._resolve_session_agent_runtime(source=source, user_config=config)
        enabled, disabled = runner._resolve_turn_toolsets(config, source, 'discord')
        active = []
        canceled = threading.Event()

        def run():
            agent = AIAgent(model=model, **runtime, quiet_mode=True, verbose_logging=False,
                            max_iterations=(config.get('agent') or {}).get('max_turns', 90),
                            enabled_toolsets=enabled, disabled_toolsets=disabled, platform='discord',
                            session_id=task_id, session_db=getattr(runner._session_db, '_db', runner._session_db),
                            **{k: getattr(source, k, None) for k in
                               ('user_id', 'user_id_alt', 'user_name', 'chat_id', 'chat_name', 'chat_type', 'thread_id')})
            active.append(agent)
            try:
                if canceled.is_set():
                    return {'final_response': ''}
                return agent.run_conversation(user_message='Voice request: ' + text +
                    '\nReply briefly and plainly for speech. Use tools when facts/actions require them; never invent results.',
                    conversation_history=history or None, task_id=task_id)
            finally:
                runner._cleanup_agent_resources(agent)

        worker = asyncio.create_task(asyncio.to_thread(run))
        try:
            result = await asyncio.shield(worker)
        except asyncio.CancelledError:
            canceled.set()
            for agent in active:
                with suppress(Exception):
                    await asyncio.to_thread(agent.interrupt, hard_cancel=True)
            # Keep ownership until the cooperative worker exits; don't abandon tool work.
            with suppress(Exception):
                await worker
            raise
        if not authorized():
            raise PermissionError('Discord room authority changed')
        if result and isinstance(result.get('messages'), list):
            history[:] = result['messages']
        from agent.redact import redact_sensitive_text
        return redact_sensitive_text(str((result or {}).get('final_response') or 'The Hermes task produced no verified result.'))
    return delegate


async def command(raw_args=''):
    """Async gateway command: host session ContextVars identify guild and operator."""
    global _SESSION
    from discord_audio import DiscordAudio, resolve_voice_bridge
    operation = (raw_args or 'join').strip().lower()
    if operation not in {'join', 'leave', 'stop', 'status', 'pause', 'resume'}:
        return 'Use /live-voice join|pause|resume|leave|status (first use /voice join in your voice channel).'
    try:
        context = command_context()
    except Exception:
        return 'Live Voice requires an authorized Discord guild command on the default profile.'
    owner = (context['guild_id'], context['operator_id'])
    if _SESSION:
        if _SESSION['owner'] != owner:
            return 'Only the session operator in its Discord server can control Live Voice.'
        session = _SESSION['session']
        if operation == 'status':
            return 'Live Voice ' + _SESSION['state'] + ' (GPT-Live-1 / Sol / Codex subscription).'
        if operation == 'join':
            return 'Live Voice is already starting, active or stopping.'
        if operation in {'leave', 'stop'}:
            record = _SESSION
            cleanup = record.get('cleanup')
            if cleanup is None or cleanup.done():
                record['state'] = 'stopping'
                # Provider closure may already be waiting on owned agent cleanup.
                if not session.closed.is_set():
                    record['task'].cancel()
                record['cleanup'] = asyncio.create_task(_stop_session(record))
            # A repeated command or canceled caller must not interrupt teardown.
            return await asyncio.shield(record['cleanup'])
        if not session.authorized():
            return 'Live Voice room authority changed; leave and join again.'
        if operation == 'pause':
            session.audio.pause_input()
            return 'Live Voice microphone paused.'
        session.audio.resume_input()
        return 'Live Voice microphone resumed.'
    if operation == 'status':
        return 'Live Voice inactive.' + (' Last failure: ' + _LAST_FAILURE if _LAST_FAILURE else '')
    if operation != 'join':
        return 'Live Voice is not active.'
    try:
        bridge = resolve_voice_bridge(context['guild_id'])
        guard = room_authority(bridge, context['operator_id'])
        broker = make_broker()
        audio = DiscordAudio(context['guild_id'])
        session = CodexDiscordSession(audio, context['operator_id'], guard, broker.start, broker.stop,
                                     delegate=make_delegate(context, guard))
    except Exception as exc:
        return 'Live Voice startup refused (' + type(exc).__name__ + '). Check dependencies, /voice join and listener permissions.'
    record = {'owner': owner, 'session': session, 'state': 'starting'}
    _SESSION = record
    record['task'] = asyncio.create_task(_run_session(record))
    return 'Live Voice starting (GPT-Live-1 / Sol / Codex subscription); use /live-voice status.'


async def _stop_session(record):
    global _SESSION, _LAST_FAILURE
    outcome, = await asyncio.gather(record['task'], return_exceptions=True)
    if isinstance(outcome, Exception):
        _log.warning('Discord Live Voice retrying incomplete cleanup (%s)', type(outcome).__name__)
    # closed fences media; only a successful close proves cleanup completed.
    # This also covers cancellation before the run task's first instruction.
    try:
        await record['session'].close()
    except Exception as exc:
        _LAST_FAILURE = type(exc).__name__
        record['state'] = 'cleanup-failed'
        _log.warning('Discord Live Voice cleanup incomplete (%s)', _LAST_FAILURE)
        return 'Live Voice cleanup incomplete (' + _LAST_FAILURE + '); session remains owned. Retry /live-voice leave.'
    if _SESSION is record:
        _SESSION = None
    return 'Live Voice ended; the gateway voice connection remains joined.'


async def _run_session(record):
    global _SESSION, _LAST_FAILURE
    session = record['session']
    try:
        await session.start()
        record['state'] = 'active'
        _LAST_FAILURE = None
        while not session.closed.is_set():
            if not session.authorized():
                raise PermissionError('Discord room authority changed')
            session.audio._fail_if_bridge_lost()
            await asyncio.sleep(.1)
        if session.failure:
            _LAST_FAILURE = session.failure
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        _LAST_FAILURE = type(exc).__name__
        _log.warning('Discord Live Voice stopped (%s)', _LAST_FAILURE)
    finally:
        await session.close()
        if _SESSION is record and not record.get('cleanup'):
            _SESSION = None


def room_authority(bridge, operator_id):
    """Freeze one host-verified room; changed listeners revoke ingress and egress."""
    from discord_audio import DiscordAudio
    voice, adapter = bridge['voice_client'], bridge['adapter']
    channel = voice.channel
    channel_id = channel.id
    audience = frozenset(m.id for m in channel.members if not m.bot)

    def authorized():
        try:
            if not DiscordAudio._published_bridge_is_exact(bridge) or not voice.is_connected():
                return False
            current = voice.channel
            if current.id != channel_id or current.guild.id != bridge['guild_id']:
                return False
            members = tuple(m for m in current.members if not m.bot)
            if frozenset(m.id for m in members) != audience or operator_id not in audience:
                return False
            return all(adapter._is_allowed_user(str(m.id), author=m, guild=current.guild, is_dm=False) is True
                       for m in members)
        except Exception:
            return False

    if not authorized():
        raise PermissionError('Operator and every human listener must be authorized and present')
    return authorized


class CodexDiscordSession:
    def __init__(self, audio, operator_id, authorized, broker, stop_broker, *, delegate=None):
        self.audio = audio
        self.operator_id = operator_id
        self.authorized = authorized
        self.broker = broker
        self.stop_broker = stop_broker
        self.delegate = delegate
        self.pc = None
        self.channel = None
        self.thread_id = None
        self.tasks = set()
        self.closed = asyncio.Event()
        self._cleanup_complete = False
        self.failure = None
        self.delegations = set()
        self.delegation_lock = asyncio.Lock()
        self.transcript = ''

    def bind_audio_authority(self):
        # The player is a different thread. Fence it too, not just ingress and
        # the async playback pump: queued audio must not outlive the audience.
        self.audio._native_guard = self.authorized
        source = getattr(self.audio, '_source', None)
        if source is not None:
            source.authorize_playback = self.authorized

    def on_event(self, raw):
        try:
            event = json.loads(raw)
            kind = event.get('type')
            item = event.get('item') or {}
            if kind == 'input_transcript.added':
                self.transcript = (self.transcript + str(item.get('text') or ''))[-8000:]
            elif kind == 'input_audio.speech_started':
                self.audio.drain_playback()
            elif kind == 'delegation.created':
                identity = item.get('id')
                if not isinstance(identity, str) or identity in self.delegations or len(self.delegations) >= 1000:
                    return
                self.delegations.add(identity)
                text = ' '.join(str(part.get('text') or '') for part in item.get('content', [])
                                if isinstance(part, dict) and part.get('type') == 'input_text').strip()
                text = text or self.transcript.strip()
                self.transcript = ''
                if text and self.delegate and len(self.tasks) < 16:
                    self._spawn(self._delegate(identity, text[:8000]))
            elif kind in {'session.closed', 'session.error', 'error'}:
                # Only allowlisted event names; never provider payloads or transcripts.
                _log.warning('Discord Live Voice provider event=%s', kind)
                self.failure = 'ProviderSessionEnded'
                self.closed.set()
        except (ValueError, TypeError, AttributeError):
            return

    async def _delegate(self, identity, text):
        async with self.delegation_lock:
            if self.closed.is_set() or not self.authorized():
                return
            try:
                result = await self.delegate(text)
            except asyncio.CancelledError:
                raise
            except Exception:
                result = 'The Hermes task failed; no result was verified.'
            if not self.closed.is_set() and self.authorized() and self.channel.readyState == 'open':
                self.channel.send(json.dumps({'type': 'delegation.context.append', 'delegation_item_id': identity,
                                             'content': [{'type': 'input_text', 'text': str(result)[:16000]}]}))

    def _spawn(self, coro):
        task = asyncio.create_task(coro)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task

    async def start(self):
        from aiortc import AudioStreamTrack, RTCPeerConnection, RTCSessionDescription
        from av import AudioFrame
        session = self

        class InputTrack(AudioStreamTrack):
            def __init__(self):
                super().__init__()
                self.pts = 0
                self.pending = bytearray()
                self.deadline = asyncio.get_running_loop().time()

            async def recv(self):
                await asyncio.sleep(max(0, self.deadline - asyncio.get_running_loop().time()))
                self.deadline = max(self.deadline, asyncio.get_running_loop().time()) + .02
                if not session.authorized():
                    raise PermissionError('Discord room authority changed')
                if getattr(session.audio, 'input_paused', False):
                    self.pending.clear()
                if len(self.pending) < 960:
                    packet = session.audio.read_input_packet()
                    if packet and (packet.speaker is None or packet.speaker.get('user_id') == session.operator_id):
                        self.pending.extend(packet.pcm)
                data = bytes(self.pending[:960])
                del self.pending[:960]
                data += bytes(960 - len(data))
                frame = AudioFrame(format='s16', layout='mono', samples=480)
                frame.planes[0].update(data)
                frame.sample_rate = 24000
                frame.pts = self.pts
                frame.time_base = fractions.Fraction(1, 24000)
                self.pts += 480
                return frame

        self.pc = RTCPeerConnection()
        self.channel = self.pc.createDataChannel('oai-events')
        self.channel.on('message', self.on_event)

        @self.pc.on('track')
        def track_received(track):
            if track.kind == 'audio':
                self._spawn(self._play(track))

        @self.pc.on('connectionstatechange')
        async def state_changed():
            state = self.pc.connectionState
            if state in {'new', 'connecting', 'connected', 'disconnected', 'failed', 'closed'}:
                _log.info('Discord Live Voice WebRTC state=%s', state)
            if state in {'failed', 'closed'}:
                self.closed.set()

        self.audio.start()
        self.bind_audio_authority()
        self.pc.addTrack(InputTrack())
        offer = await self.pc.createOffer()
        await self.pc.setLocalDescription(offer)
        result = await self.broker(self.pc.localDescription.sdp, 'sol', 'en')
        self.thread_id = result.get('threadId')
        if result.get('version') != 'v3' or result.get('handoff') != 'client' or result.get('droppedFields'):
            raise RuntimeError('Codex app-server must support v3 client-managed handoffs')
        await self.pc.setRemoteDescription(RTCSessionDescription(sdp=result['answer'], type='answer'))

    async def _play(self, track):
        from av import AudioResampler
        resampler = AudioResampler(format='s16', layout='mono', rate=24000)
        try:
            while not self.closed.is_set():
                frame = await track.recv()
                if not self.authorized():
                    raise PermissionError('Discord room authority changed')
                for converted in resampler.resample(frame):
                    self.audio.queue_playback(bytes(converted.planes[0])[:converted.samples * 2])
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.failure = type(exc).__name__
            _log.warning('Discord Live Voice output track ended (%s)', self.failure)
            self.closed.set()

    async def close(self):
        if self._cleanup_complete:
            return
        self.closed.set()
        for task in list(self.tasks):
            task.cancel()
        await asyncio.gather(*list(self.tasks), return_exceptions=True)
        if self.pc:
            await self.pc.close()
        self.audio.drain_playback()
        self.audio.stop()
        if self.thread_id:
            await self.stop_broker(self.thread_id)
            self.thread_id = None
        self._cleanup_complete = True
