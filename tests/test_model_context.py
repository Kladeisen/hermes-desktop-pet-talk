"""Exercise model context without providers, a microphone, or an installed plugin."""
import ast
import asyncio
import importlib.util
import json
import subprocess
from types import SimpleNamespace

import pytest

from test_plugin_api import PLUGIN_API, REPO, VENDOR, load_unit


@pytest.mark.parametrize('localized', [False, True])
@pytest.mark.parametrize('language', ['en', 'es'])
def test_tool_adapter_signature_compatibility(localized, language):
    ns = load_unit(PLUGIN_API, 'run_tool')
    calls = []

    def legacy(name, arguments):
        calls.append((name, arguments))
        return 'Original tool output'

    def localized_tool(name, arguments, language='en'):
        calls.append((name, arguments, language))
        return 'Original tool output'

    ns['talk_tools'] = SimpleNamespace(
        execute_talk_tool=localized_tool if localized else legacy,
        TalkToolError=ValueError,
        **({'SUPPORTS_LANGUAGE': True} if localized else {}),
    )

    class Request:
        async def json(self):
            return {'name': 'example', 'arguments': {}, 'language': language}

    assert asyncio.run(ns['run_tool'](Request()))['output'] == 'Original tool output'
    assert calls == [('example', {}, 'en') if localized else ('example', {})]


def constants():
    tree = ast.parse(PLUGIN_API.read_text())
    names = {'_LANGUAGE_DIRECTIVE_DEFAULT', '_AGENT_INSTR', '_AGENT_INSTR_SKIP', '_VOICE_POLICY',
             '_SEND_TO_CHAT_DESC', '_CHAT_CONFIRMATION_POLICY'}
    result = {n.targets[0].id: ast.literal_eval(n.value) for n in tree.body
            if isinstance(n, ast.Assign) and isinstance(n.targets[0], ast.Name)
            and n.targets[0].id in names}
    result['_LANGUAGE_DIRECTIVE_BUNDLE'] = '\n\n'.join(v.strip() for v in result['_LANGUAGE_DIRECTIVE_DEFAULT'].values())
    policy = load_unit(PLUGIN_API, '_voice_policy')
    policy.update(result)
    result['_voice_policy'] = policy['_voice_policy']
    return result


def vendor_module(name):
    spec = importlib.util.spec_from_file_location(name, VENDOR / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize('language', [None, 'es', 'en', 'de'])
def test_language_directive_default_file_and_user_override(tmp_path, language):
    ns = load_unit(PLUGIN_API, '_language_directive')
    ns.update(constants(), _DIRECTIVE_PATH=REPO / 'language_directive.txt')
    expected = ns['_language_directive'](language)
    assert expected == ns['_LANGUAGE_DIRECTIVE_DEFAULT']['en']
    assert 'Reply in English' in expected
    assert 'Chilean' not in expected and 'IDIOMA' not in expected
    assert ns['_language_directive']() == expected
    ns['_DIRECTIVE_PATH'] = tmp_path / 'directive.txt'
    assert ns['_language_directive'](language) == expected
    ns['_DIRECTIVE_PATH'].write_text('')
    assert ns['_language_directive'](language) == expected
    # An explicitly supplied directive is user content, not a shipped translation.
    custom = '  Mi preferencia personal: español.\n'
    ns['_DIRECTIVE_PATH'].write_text(custom)
    assert ns['_language_directive'](language) == '\n\n' + custom
    for shipped_default in ns['_LANGUAGE_DIRECTIVE_DEFAULT'].values():
        ns['_DIRECTIVE_PATH'].write_text(shipped_default.strip() + '\n')
        assert ns['_language_directive'](language) == expected


@pytest.mark.parametrize('profile', [None, 'example-bot'])
@pytest.mark.parametrize('allow_chat', [False, True])
@pytest.mark.parametrize('language', [None, 'es', 'en'])
@pytest.mark.parametrize('ask_before_chat', [True, False])
def test_constructed_voice_prompts(profile, allow_chat, language, ask_before_chat):
    sections = {'PERSONA': 'Soy un bot de prueba.', 'MEMORY': 'El usuario vive en Chile.'}
    ns = load_unit(PLUGIN_API, '_mint_for')
    ns.update(constants())
    captured = {}
    ns.update(
        talk_tools=vendor_module('talk_tools'),
        _send_to_chat_tool=load_unit(PLUGIN_API, '_send_to_chat_tool')['_send_to_chat_tool'],
        _bot_identity_sections=lambda _: sections,
        talk_host=SimpleNamespace(host=lambda: SimpleNamespace(identity_sections=lambda: sections)),
        talk_identity=vendor_module('talk_identity'),
        talk_capabilities=SimpleNamespace(instruction_section=lambda: None),
        _DIRECTIVE_PATH=REPO / 'language_directive.txt',
        _bot_display_name=lambda _: 'Example Bot',
        talk_auth=SimpleNamespace(resolve_auth=lambda: SimpleNamespace(token='stub')),
        talk_config=SimpleNamespace(talk_model=lambda: 'stub'),
        talk_wire=SimpleNamespace(mint_ephemeral_session=lambda **kw: captured.update(kw)),
    )
    directive = load_unit(PLUGIN_API, '_language_directive')
    directive.update(ns)
    ns['_language_directive'] = directive['_language_directive']
    ns['_send_to_chat_tool'].__globals__['_SEND_TO_CHAT_DESC'] = ns['_SEND_TO_CHAT_DESC']
    ns['_mint_for'](profile, 'marin', allow_chat, language, ask_before_chat)
    prompt = captured['instructions']
    assert ('Should I send that to the chat?' in prompt) == (ask_before_chat and allow_chat)
    if allow_chat:
        desc = next(t['description'] for t in captured['tools'] if t['name'] == 'send_to_chat')
        assert ('Should I send that to the chat?' in desc) == ask_before_chat
        if ask_before_chat:
            assert 'When they ask for REAL WORK' not in prompt
            for rule in ('overrides earlier guidance', 'immediately next turn', 'change of topic',
                         'ambiguous reply', 'send this to the chat', 'exactly once', 'handoff only'):
                assert rule in prompt and rule in desc
            assert prompt.index('CHAT HANDOFF CONFIRMATION:') > prompt.index('no confirmation.')
        else:
            assert desc == ns['_SEND_TO_CHAT_DESC']
            assert 'When they ask for REAL WORK' in prompt
    else:
        assert not any(t['name'] == 'send_to_chat' for t in captured['tools'])
    assert ('VOICE + CHAT:' in prompt) == allow_chat
    if allow_chat:
        assert 'complete request phrased naturally in their language' in prompt
    assert 'LANGUAGE AND VOICE: Reply in English' in prompt
    assert 'Do NOT delegate greetings' in prompt
    assert all(text in prompt for text in sections.values())
    persona = load_unit(PLUGIN_API, '_codexlive_persona')
    persona.update(ns)
    prompt = persona['_codexlive_persona'](profile, language)
    assert 'VOICE: You are speaking' in prompt
    assert 'IDENTITY: You are ' + ('Example Bot' if profile else 'Hermes') in prompt
    assert 'sure, I will check' in prompt and 'dale, lo reviso' not in prompt
    assert 'VOZ:' not in prompt and 'IDENTIDAD:' not in prompt
    assert all(text in prompt for text in sections.values())


@pytest.mark.parametrize('mode', ['client', 'server'])
@pytest.mark.parametrize('language', [None, 'es', 'en'])
@pytest.mark.parametrize('ask_before_chat', [True, False])
def test_codex_start_sends_english_delegation_instructions(mode, language, ask_before_chat):
    ns = load_unit(PLUGIN_API, '_codexlive_start')
    ns.update(constants())
    ns.update(_CL={'notifs': []}, _cl_ensure=lambda: None,
              _cl_thread_ensure=lambda lang: 'thread', _codexlive_persona=lambda _, lang: 'persona',
              _talk_settings=lambda: {'delegation': mode})
    captured = {}

    def request(method, params, **kwargs):
        if method == 'thread/realtime/start':
            captured.update(params)
            ns['_CL']['notifs'].append({'method': 'thread/realtime/sdp', 'params': {'sdp': 'stub'}})
        return {}

    ns['_cl_request'] = request
    ns['_codexlive_start'](None, 'cove', 'stub', language, ask_before_chat)
    assert ('Should I send that to the chat?' in captured['prompt']) == ask_before_chat
    if not ask_before_chat:
        assert captured['prompt'] == 'persona'
    instruction = captured['realtimeStartInstructions']
    assert instruction.startswith('You are connected to a live voice session')
    if mode == 'client':
        assert '<realtime_delegation>' in instruction
        assert 'do NOT read files: reply with only the word: skip' in instruction
    else:
        assert 'carry it out with your tools' in instruction


@pytest.mark.parametrize('ask_before_chat', [True, False])
def test_codex_confirmation_prompt_cannot_be_silently_dropped(ask_before_chat):
    ns = load_unit(PLUGIN_API, '_codexlive_start')
    ns.update(constants(), _CL={'notifs': []}, _cl_ensure=lambda: None,
              _cl_thread_ensure=lambda _: 'thread', _codexlive_persona=lambda *args: 'persona',
              _talk_settings=lambda: {}, _log=SimpleNamespace(warning=lambda *args: None))
    calls = []
    def request(method, params, **kwargs):
        calls.append(dict(params))
        for field in ('delegationAckFiller', 'clientManagedHandoffs', 'prompt'):
            if field in params:
                raise RuntimeError('unknown field ' + field)
        ns['_CL']['notifs'].append({'method': 'thread/realtime/sdp', 'params': {'sdp': 'stub'}})
    ns['_cl_request'] = request
    if ask_before_chat:
        with pytest.raises(RuntimeError, match='confirmation prompt'):
            ns['_codexlive_start'](None, 'cove', 'stub', 'en', True)
        assert len(calls) == 3
        assert all('Should I send that to the chat?' in p['prompt'] for p in calls)
    else:
        result = ns['_codexlive_start'](None, 'cove', 'stub', 'en', False)
        assert len(calls) == 4 and 'prompt' not in calls[-1]
        assert 'prompt' in result['droppedFields'] and result['answer'] == 'stub'


@pytest.mark.parametrize('language', [None, 'es', 'en'])
def test_tool_timeout_and_dynamic_output(language):
    ns = load_unit(PLUGIN_API, 'run_tool')
    output = 'Resultado original en español.'

    async def wait_for(*args, **kwargs):
        if output is None:
            raise asyncio.TimeoutError
        return output

    ns['asyncio'] = SimpleNamespace(wait_for=wait_for, to_thread=lambda *args: None,
                                    TimeoutError=asyncio.TimeoutError)
    ns['talk_tools'] = SimpleNamespace(execute_talk_tool=lambda *args: None, TalkToolError=ValueError)

    class Request:
        async def json(self):
            return {'name': 'example', 'arguments': {}, 'language': language}

    assert asyncio.run(ns['run_tool'](Request()))['output'] == output
    output = None
    assert asyncio.run(ns['run_tool'](Request()))['output'].startswith('The tool example is still running;')
    tools = vendor_module('talk_tools')
    with pytest.raises(tools.TalkToolError, match="the voice tool 'example' is not available"):
        tools.execute_talk_tool('example', {}, language)


@pytest.mark.parametrize('browser_locale', ['en-US', 'de-DE', 'es-CL'])
def test_desktop_model_messages(browser_locale):
    source = (REPO / 'desktop/plugin.js').read_text()
    # Evaluate the real delegation functions with only host/time/transport boundaries stubbed.
    delegation = source[source.index('const _voiceNote ='):source.index('// ── Barge-in')]
    delegation += source[source.index('const petAtomGet ='):source.index('// In-app pet companion only:')]
    preview = source[source.index('  const phrase ='):source.index('  const url = await new Promise', source.index('  const phrase ='))]
    locale_setup = source[source.index('const SENTINEL_DEFAULT ='):source.index('// Allowance')]
    script = r'''
const assert = require('node:assert/strict');
const navigator = {language: LOCALE_VALUE};
LOCALE_SETUP
let _delegating = null, _delegBusy = false, _delegQueue = null;
let handoffMode = 'client';
const liveController = {owner: () => host.state.focusedSessionId ? {runtimeId: 'session',storedId:'stored-session',profile:'owner'} : null};
const transcript = [], progress = [], pushTranscript = (role, text) => progress.push(text), KEY_CHAT = 'chat';
let now = 1000000;
Date.now = () => now;
const sleep = async () => { now += 300000; };
const handlers = {};
let completion = 'Resultado en español.', submitted;
const host = {state: {focusedSessionId: 'session',focusedSessionProfile:'owner'}, onEvent: (name, cb) => {
  handlers[name] = cb; return () => { delete handlers[name]; };
}, request: async (method, body) => {
  submitted = body.text;
  if (completion instanceof Error) throw completion;
  if (completion === 'agent-error') handlers.error({session_id: 'session', message: 'fallo original'});
  else if (completion !== null) handlers['message.complete']({session_id: 'session', text: completion});
}};
const window = {dispatchEvent: () => {}};
class CustomEvent { constructor(type, options) { this.type = type; this.detail = options?.detail; } }
const messages = [];
const dc = {send: data => messages.push(JSON.parse(data))};
const ctx = {storage: {get: () => '1'}};
const lastText = () => messages.at(-1).content[0].text;
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
DELEGATION
(async () => {
  assert.equal(await delegateToChat(''), ('Empty request.'));
  _delegating = {text: 'revisa', at: now};
  assert.match(await delegateToChat('revisa'), /^That request is already/);
  _delegating = null;
  host.state.focusedSessionId = '';
  assert.match(await delegateToChat('revisa'), /^No conversation is open/);
  host.state.focusedSessionId = 'session';
  assert.equal(await delegateToChat('revisa mi archivo'), completion);
  assert.ok(progress.includes('working in the chat…'));
  assert.match(submitted, /^\[voice\] Reply briefly and naturally in English/);
  assert.ok(submitted.endsWith('\n\nrevisa mi archivo'));
  completion = new Error('fallo original');
  assert.equal(await delegateToChat('revisa'), ('Could not send to the chat: fallo original'));
  completion = 'agent-error';
  assert.equal(await delegateToChat('revisa'), ('Agent error: fallo original'));
  completion = '';
  assert.equal(await delegateToChat('revisa'), ('The agent finished without visible text.'));
  completion = null;
  assert.match(await delegateToChat('revisa'), /^The agent is still working/);
  completion = 'Resultado en español.';
  await runVoiceTool(ctx, 'call', 'send_to_chat', {request: 'revisa'}, dc);
  assert.match(messages[0].item.content[0].text, /^\[The real agent is ALREADY/);
  assert.equal(messages[2].item.output, completion);
  await runVoiceTool({rest: async () => { throw new Error('fallo original'); }}, 'call', 'probe', {}, dc);
  assert.equal(messages.at(-2).item.output, ('The tool probe failed: fallo original'));
  await runVoiceTool({rest: async (path, options) => { assert.equal(options.body.language, 'en'); return {output: completion}; }}, 'call', 'probe', {}, dc);
  assert.equal(messages.at(-2).item.output, completion);
  const msg = text => ({item: {id: 'item', content: [{text}]}});
  handleDelegation(ctx, msg('hola, ¿me escuchas?'), dc);
  assert.match(lastText(), /^The user was just chatting/);
  handleDelegation({storage: {get: () => '0'}}, msg('revisa mi archivo'), dc);
  assert.match(lastText(), /^I cannot run that/);
  _delegBusy = true;
  handleDelegation(ctx, msg('revisa mi archivo'), dc);
  assert.match(lastText(), /^A task is already in progress/);
  _delegQueue.at = now - 600001;
  _delegBusy = false;
  _runDelegation(ctx, dc, 'current', 'revisa');
  await flush();
  assert.match(lastText(), /^The queued task went stale/);
  assert.ok(messages.some(m => m.content?.[0]?.text === ('Task result (answer the user with this, briefly and naturally): ') + completion));
  assert.equal(_plainForVoice('Texto español. ```codigo```'), ('Texto español.  (code block omitted)'));
  const realDelegate = delegateToChat;
  delegateToChat = async () => '';
  _runDelegation(ctx, dc, 'empty', 'revisa');
  await flush();
  assert.equal(lastText(), ('Task result (answer the user with this, briefly and naturally): The task could not be completed in the chat.'));
  delegateToChat = realDelegate;
  // Preview prompt construction and both outbound formats; no media APIs run.
  for (const eng of ['codex', 'realtime']) {
    const voice = 'cove';
    PREVIEW
    const message = messages.at(eng === 'codex' ? -1 : -2);
    const text = (message.content || message.item.content)[0].text;
    assert.match(text, /^Say out loud exactly this sentence, adding nothing else:/);
    assert.ok(text.includes('Hi, this is voice cove'));
    assert.ok(!text.includes('Nacho'));
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
'''.replace('LOCALE_VALUE', repr(browser_locale)).replace('LOCALE_SETUP', locale_setup).replace('DELEGATION', delegation).replace('PREVIEW', preview)
    result = subprocess.run(['node', '-e', script], capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize('route', ['create_session', 'codexlive_session'])
@pytest.mark.parametrize('ask_before_chat', [None, True, False])
def test_session_routes_normalize_locale_to_english(route, ask_before_chat):
    import threading
    ns = load_unit(PLUGIN_API, route)
    calls = []
    def mint(profile, voice, allow_chat, language, ask_before_chat=None):
        calls.append((language, ask_before_chat))
        return SimpleNamespace(to_wire=lambda: {'language': language}), SimpleNamespace(source='stub')
    def start(profile, voice, offer, language, ask_before_chat=None):
        calls.append((language, ask_before_chat))
        return {'language': language}
    ns.update(_MINT_LOCK=threading.Lock(), _CL_LOCK=threading.Lock(),
              _resolve_voice=lambda value: 'marin', _mint_for=mint, _codexlive_start=start)
    class Request:
        def __init__(self, language):
            self.language = language
        async def json(self):
            return {'offer': 'stub', **({'language': self.language} if self.language else {}),
                    **({'askBeforeChat': ask_before_chat} if ask_before_chat is not None else {})}
    async def run():
        return await asyncio.gather(*(ns[route](Request(lang)) for lang in ['en', 'es', None]))
    results = asyncio.run(run())
    assert [r['language'] for r in results] == ['en', 'en', 'en']
    assert calls == [('en', ask_before_chat is not False)] * 3


def test_codex_thread_reuses_english_for_default_and_legacy_locale():
    from pathlib import Path
    ns = load_unit(PLUGIN_API, '_cl_thread_ensure')
    calls = []
    def request(method, body, **kwargs):
        calls.append(body)
        return {'thread': {'id': str(len(calls))}}
    ns.update(_CL={}, _agent_model=lambda: None, Path=Path, _cl_request=request)
    ensure = ns['_cl_thread_ensure']
    assert ensure() == ensure('es') == '1'
    assert ensure('en') == ensure('en') == '1'
    assert ensure('es') == ensure(None) == ensure('de') == '1'
    assert ns['_CL']['thread_language'] == 'en'
    assert len(calls) == 1


@pytest.mark.parametrize('browser_locale', ['en-US', 'de-DE', 'es-CL'])
@pytest.mark.parametrize('chat_work', [None, '1', '0'])
@pytest.mark.parametrize('ask_chat', [None, '1', '0'])
def test_desktop_session_request_bodies(browser_locale, chat_work, ask_chat):
    import re
    source = (REPO / 'desktop/plugin.js').read_text()
    # Evaluate every production session request body, including preview's Codex path.
    bodies = re.findall(r"ctx.rest\('/(?:codexlive/)?session',\s*\{\s*method: 'POST',\s*body: (\{[^\n]+?\}),", source)
    assert len(bodies) == 3
    locale_setup = source[source.index('const SENTINEL_DEFAULT ='):source.index('// Allowance')]
    keys = source[source.index('const KEY_VOICE ='):source.index('const VOICES =')]
    script = 'const assert = require("node:assert/strict"); const navigator = {language: ' + repr(browser_locale) + '};' + locale_setup + keys
    script += 'const profile = null, voice = "cove", offer = {sdp: "stub"}, allowChat = true;'
    script += f'const [chat, ask] = {json.dumps([chat_work, ask_chat])}; const ctx = {{storage: {{get: k => k === KEY_CHAT ? chat : ask}}}};'
    for body in bodies:
        script += f'assert.equal(({body}).language, "en");'
        script += f'assert.equal(({body}).askBeforeChat, {json.dumps(chat_work != "0" and ask_chat != "0")});'
    result = subprocess.run(['node', '-e', script], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize('language', [None, 'es', 'en'])
def test_tool_route_uses_english_unavailable_error(language):
    ns = load_unit(PLUGIN_API, 'run_tool')
    class HTTPException(Exception):
        def __init__(self, status_code, detail):
            self.detail = detail
    ns.update(talk_tools=vendor_module('talk_tools'), HTTPException=HTTPException)
    class Request:
        async def json(self):
            return {'name': 'probe', 'language': language}
    with pytest.raises(HTTPException) as exc:
        asyncio.run(ns['run_tool'](Request()))
    assert 'the voice tool' in exc.value.detail
