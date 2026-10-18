"""English-only plugin behavior; no provider, microphone, or live chat calls."""
from __future__ import annotations

import json
import subprocess

import pytest

from test_plugin_api import REPO


def desktop_eval(language, checks):
    """Load the real ESM and render with inert SDK, React, and media boundaries."""
    script = r'''
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({console, navigator: {language: LOCALE},
  setTimeout: () => 1, clearTimeout: () => {},
  window: {dispatchEvent: () => {}}, CustomEvent: class {}});
const element = (type, props) => ({type, props});
const react = {useState: value => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {}, useRef: value => ({current: value})};
const sdk = {host: {state: {focusedSessionProfile: 'default'}}, useValue: value => value};
for (const name of ['Popover', 'PopoverContent', 'PopoverTrigger', 'Select', 'SelectContent',
  'SelectItem', 'SelectTrigger', 'SelectValue', 'Switch', 'Button']) sdk[name] = name;
const imports = {'react': react, 'react/jsx-runtime': {jsx: element, jsxs: element},
  '@hermes/plugin-sdk': sdk};
const source = fs.readFileSync(SOURCE, 'utf8') + '\nexport {ConfigForm, ComposerLiveButton, LivePanel, bus, delegateToChat, renderBubble, startLive, mintSession};';
const module = new vm.SourceTextModule(source, {context});
const ctx = {storage: {get: () => null, set: () => {}}, rest: () => {throw Error('network forbidden');}};
function nodes(tree) {
  if (tree == null || typeof tree === 'boolean') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (typeof tree !== 'object') return [tree];
  if (typeof tree.type === 'function') return nodes(tree.type(tree.props || {}));
  return [tree, ...nodes(tree.props?.children)];
}
(async () => {
  await module.link(name => {
    const values = imports[name];
    assert.ok(values, 'unexpected import: ' + name);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, {context});
  });
  await module.evaluate();
  const plugin = module.namespace;
  CHECKS
})().catch(error => {console.error(error); process.exitCode = 1;});
'''.replace('LOCALE', json.dumps(language)).replace('SOURCE', json.dumps(str(REPO / 'desktop/plugin.js'))).replace('CHECKS', checks)
    result = subprocess.run(['node', '--experimental-vm-modules', '-e', script],
                            capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize('language', ['de-DE', 'es-CL', 'fr-FR', '', None, 'en-US'])
def test_browser_locale_always_renders_english_settings(language):
    desktop_eval(language, r'''
const texts = nodes(plugin.ConfigForm({ctx})).filter(node => typeof node === 'string');
// The engine and voice moved to the status-bar panel; the gear keeps an English pointer to it.
for (const label of ['Voice engine and voice moved to the \u{1F43E} button in the status bar.', 'Microphone', 'Output', 'Work in the chat',
  'System default', 'Session', 'Sign in']) assert.ok(texts.includes(label), 'missing English label: ' + label);
assert.ok(!texts.includes('Motor de voz'));
''')


@pytest.mark.parametrize('live, muted', [(False, False), (True, False), (True, True)])
def test_composer_tooltips_are_english(live, muted):
    desktop_eval('de-DE', r'''
Object.assign(plugin.bus, {live: LIVE, muted: MUTED, stage: 'connected'});
const titles = nodes(plugin.ComposerLiveButton({ctx})).map(node => node.props?.title).filter(Boolean);
assert.ok(titles.includes(LIVE ? 'Hang up Live Voice' : 'Live Voice — click to talk'));
assert.ok(titles.includes('Live Voice: microphone, output, chat handoff'))
assert.ok(!titles.some(title => title.startsWith('Configure Live Voice')));
if (LIVE) {
  assert.ok(titles.includes(MUTED ? 'Unmute microphone' : 'Mute microphone'));
  assert.ok(titles.includes('Live transcript'));
}
'''.replace('LIVE', json.dumps(live)).replace('MUTED', json.dumps(muted)))


@pytest.mark.parametrize('route, body, expected', [
    ('create_session', {'profile': 'missing'}, "profile 'missing' does not exist"),
    ('codexlive_session', {'profile': 'missing'}, "profile 'missing' does not exist"),
    ('codexlive_session', {}, 'SDP offer is required'),
    ('voice_usage_report', {}, 'durationMs is required'),
    ('codexlive_interrupt', {}, 'turnId/threadId are required'),
    ('run_tool', {}, 'name is required'),
])
def test_backend_owned_validation_messages_are_english(route, body, expected):
    import asyncio
    from fastapi import HTTPException
    from test_plugin_api import PLUGIN_API, load_unit

    ns = load_unit(PLUGIN_API, route)
    ns.update(HTTPException=HTTPException, _profile_home=lambda _: None, _CL={})

    class Request:
        async def json(self):
            return {**body, 'language': 'es'}

    try:
        result = asyncio.run(ns[route](Request()))
    except HTTPException as exc:
        assert exc.detail == expected
    else:
        assert result['error'] == expected


@pytest.mark.parametrize('state, expected', [
    ('timeout', 'timeout: the code expired without approval'),
    ('valid', 'Signed in'),
    ('missing', 'Could not sign in: original diagnostic'),
])
def test_auth_login_status_messages_are_english(state, expected):
    from types import SimpleNamespace
    from test_plugin_api import PLUGIN_API, load_unit

    ns = load_unit(PLUGIN_API, '_login_check')
    ns.update(_LOGIN={'status': 'pending', 'proc': SimpleNamespace(poll=lambda: None if state == 'timeout' else 0),
                      'started_at': 1, 'output': 'original diagnostic'},
              time=SimpleNamespace(time=lambda: 1000), _LOGIN_TIMEOUT_S=60, _terminate=lambda _: None,
              talk_auth=SimpleNamespace(auth_diagnostic=lambda: {'codex_oauth': state}))
    ns['_login_check']()
    assert ns['_LOGIN']['message'] == expected


@pytest.mark.parametrize('mic_id', ['', 'selected-device'])
def test_microphone_failure_is_reported_in_english(mic_id):
    desktop_eval('es-CL', r'''
context.navigator.mediaDevices = {getUserMedia: async () => {throw {name: 'NotAllowedError'};}};
const logs = [];
await assert.rejects(plugin.startLive(ctx, {engine: 'codex', micId: MIC_ID, log: text => logs.push(text)}),
  /MIC: NotAllowedError — check permissions or try another microphone in the settings/);
assert.deepEqual(logs, ['requesting session…', 'opening microphone…']);
'''.replace('MIC_ID', json.dumps(mic_id)))


def test_shipped_text_has_no_spanish_copy():
    """Audit all shipped text, not just strings behind the old locale switch."""
    import re

    spanish = re.compile(
        r'[áéíóúüñÁÉÍÓÚÜÑ¿¡]|\\u00(?:[cdefCDEF][0-9a-fA-F])|'
        r'\b(?:mintea|Reusa|semanal|requerido|faltan|respaldo|cierra|carga|'
        r'Colgar|Copiar|Actualizar|Salida|pidiendo|abriendo|negociando|IDIOMA|IDENTIDAD|Eres|'
        r'suscripción|configuración|disponible|encontrado|respuesta|sesión|'
        r'transcripción|ventana|formulario|delegación|usuario|hablante)\b', re.I)
    excluded = {'.git', '__pycache__', '.pytest_cache', 'data', 'tests'}
    # Input recognition and Unicode name handling are not rendered or instructions.
    input_only = ('const fill = new Set(', 'const toks = s.toLowerCase().replace(', 'first = re.sub(')
    offenders = []
    for path in sorted(REPO.rglob('*')):
        if not path.is_file() or excluded.intersection(path.relative_to(REPO).parts):
            continue
        if 'LICENSE' in path.name:
            continue
        try:
            text = path.read_text(encoding='utf-8')
        except UnicodeDecodeError:
            continue
        for number, line in enumerate(text.splitlines(), 1):
            if spanish.search(line) and not any(fragment in line for fragment in input_only):
                offenders.append(f'{path.relative_to(REPO)}:{number}:{line}')
    assert not offenders, '\n'.join(offenders)
