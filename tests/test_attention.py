"""Pet "needs you" badge: backend registry fed by Hermes human-input hooks."""
import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def load():
    sys.modules.pop('talk_desktop_attention', None)
    spec = importlib.util.spec_from_file_location('attention_test_loader', ROOT / 'attention.py')
    loader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loader)
    return loader.shared()


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def make():
    m = load()
    sent, clock = [], Clock()
    return m, m.Registry(broadcast=sent.append, clock=clock), sent, clock


def test_shared_instance_is_one_per_process_across_loaders():
    a = load()
    spec = importlib.util.spec_from_file_location('second_loader', ROOT / 'attention.py')
    other = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(other)
    assert other.shared() is a
    assert other.shared().registry is a.registry


def test_request_and_resolve_broadcast_open_set_without_prompt_or_session_key():
    m, reg, sent, clock = make()
    reg.opened(kind='approval', request_id='r1', session_id='20261014_x', session_key='agent:main:secret',
               platform='desktop', prompt='rm -rf / --token=sk-abc')
    assert len(sent) == 1
    first = sent[0]
    assert first['requests'] == [{'id': 'r1', 'kind': 'approval', 'session_id': '20261014_x', 'profile': 'default', 'since': 1000000}]
    assert 'sk-abc' not in repr(first) and 'agent:main' not in repr(first)
    clock.t += 5
    reg.opened(kind='clarify', request_id='r2', session_id='s2')
    assert [r['id'] for r in sent[-1]['requests']] == ['r1', 'r2']
    assert sent[-1]['seq'] > first['seq'] and sent[-1]['boot'] == first['boot']
    reg.resolved(kind='approval', request_id='r1', outcome='approved')
    assert [r['id'] for r in sent[-1]['requests']] == ['r2']
    reg.resolved(kind='clarify', request_id='r2', outcome='submitted')
    assert sent[-1]['requests'] == []
    assert reg.snapshot()['requests'] == []


def test_unknown_kinds_duplicates_and_unknown_resolves_are_ignored():
    m, reg, sent, clock = make()
    reg.opened(kind='secret', request_id='x')
    reg.opened(kind='approval', request_id='')
    reg.resolved(request_id='never-opened')
    assert sent == []
    reg.opened(kind='sudo', request_id='s')
    reg.resolved(request_id='s')
    reg.resolved(request_id='s')
    assert len(sent) == 2


def test_open_set_is_bounded_and_stale_entries_expire():
    m, reg, sent, clock = make()
    for i in range(m.MAX_OPEN + 4):
        clock.t += 1
        reg.opened(kind='approval', request_id=f'r{i}')
    ids = [r['id'] for r in reg.snapshot()['requests']]
    assert len(ids) == m.MAX_OPEN and ids[0] == 'r4'
    clock.t += m.MAX_AGE_S + 60
    assert reg.snapshot()['requests'] == []


def test_broadcast_failure_never_breaks_the_human_prompt():
    m = load()

    def boom(_):
        raise RuntimeError('no gateway')
    reg = m.Registry(broadcast=boom)
    reg.opened(kind='approval', request_id='r')
    reg.resolved(request_id='r')
    assert reg.snapshot()['requests'] == []


def test_plugin_registers_both_observer_hooks():
    sys.modules.pop('talk_desktop_attention', None)
    spec = importlib.util.spec_from_file_location('talk_desktop_init_test', ROOT / '__init__.py')
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    hooks = {}

    class Ctx:
        def register_command(self, *a, **k):
            pass

        def register_hook(self, name, fn):
            hooks[name] = fn
    plugin.register(Ctx())
    assert set(hooks) == {'on_human_input_request', 'on_human_input_resolved'}
    # the registered callbacks feed the process-wide registry the REST route also reads
    mod = sys.modules['talk_desktop_attention']
    mod.registry._broadcast = lambda _payload: None
    hooks['on_human_input_request'](kind='clarify', request_id='q', session_id='s')
    assert [r['id'] for r in mod.registry.snapshot()['requests']] == ['q']
    hooks['on_human_input_resolved'](kind='clarify', request_id='q', outcome='submitted')
    assert mod.registry.snapshot()['requests'] == []


def test_real_hermes_hook_contract_matches_when_available():
    """Name check against the installed Hermes, when it is importable."""
    hermes = Path.home() / '.hermes' / 'hermes-agent'
    hooks_file = hermes / 'hermes_cli' / 'plugins.py'
    if not hooks_file.is_file():
        pytest.skip('Hermes checkout not present')
    text = hooks_file.read_text()
    assert '"on_human_input_request"' in text and '"on_human_input_resolved"' in text
    events = (hermes / 'hermes_cli' / 'plugin_events.py').read_text()
    assert 'def broadcast_plugin_event(plugin_id: str, event: str' in events
    assert 'PLUGIN_EVENT_PREFIX = "plugin."' in events


def load_alerts():
    spec = importlib.util.spec_from_file_location('bot_alerts_test', ROOT / 'bot-alerts' / '__init__.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_bot_alerts_layout_uses_installation_profile(tmp_path):
    plugin = load_alerts()
    assert plugin._layout(tmp_path / 'profiles' / 'alpha' / 'plugins' / 'talk-desktop-alerts' / '__init__.py') == ('alpha', tmp_path)
    assert plugin._layout(tmp_path / 'plugins' / 'talk-desktop-alerts' / '__init__.py') == ('default', tmp_path)


def test_bot_alerts_forward_profile_and_resolve_without_breaking_prompts(monkeypatch):
    plugin = load_alerts()
    module = load()
    module.registry._broadcast = lambda _: None
    monkeypatch.setattr(plugin, '_layout', lambda: ('alpha', ROOT))
    hooks = {}
    class Context:
        def register_hook(self, name, callback):
            hooks[name] = callback
    plugin.register(Context())
    hooks['on_human_input_request'](kind='clarify', request_id='bot-question', profile='spoofed')
    assert module.registry.snapshot()['requests'][0]['profile'] == 'alpha'
    hooks['on_human_input_resolved'](request_id='bot-question')
    assert module.registry.snapshot()['requests'] == []
    def broken():
        raise RuntimeError('unavailable')
    monkeypatch.setattr(plugin, '_attention', broken)
    hooks['on_human_input_request'](kind='clarify', request_id='q')
    hooks['on_human_input_resolved'](request_id='q')
