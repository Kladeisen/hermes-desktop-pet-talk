"""Feed B: the hooks-only alerts plugin records each bot session's live step to a small file."""
import importlib.util
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load(tmp_path, profile='alpha', clock=None):
    spec = importlib.util.spec_from_file_location('bot_alerts_progress_test', ROOT/'bot-alerts'/'__init__.py')
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    plugin._layout = lambda here=None: (profile, tmp_path)
    if clock: plugin._now = clock
    hooks = {}
    class Context:
        def register_hook(self, name, callback): hooks[name] = callback
    plugin.register(Context())
    return plugin, hooks


def files(tmp_path):
    folder = tmp_path/'plugins/talk-desktop/data/progress'
    return [json.loads(p.read_text()) for p in sorted(folder.glob('*.json'))] if folder.exists() else []


def test_tool_and_model_steps_are_recorded_without_arguments_or_text(tmp_path):
    now = [1000.0]
    _, hooks = load(tmp_path, clock=lambda: now[0])
    hooks['pre_api_request'](session_id='s1', user_message='SECRET prompt', request_messages=[{'content': 'SECRET'}])
    [state] = files(tmp_path)
    assert state['profile'] == 'alpha' and state['state'] == 'thinking' and state['since'] == 1000.0
    assert state['pid'] == os.getpid()
    now[0] = 1003
    hooks['post_api_request'](session_id='s1')
    hooks['pre_tool_call'](session_id='s1', tool_name='terminal', args={'command': 'cat SECRET'})
    [state] = files(tmp_path)
    assert (state['state'], state['tool'], state['since']) == ('tool', 'terminal', 1003)
    raw = (tmp_path/'plugins/talk-desktop/data/progress').read_bytes() if False else ''.join(p.read_text() for p in (tmp_path/'plugins/talk-desktop/data/progress').glob('*'))
    assert 'SECRET' not in raw and 's1' not in raw, 'no prompt text, tool args or raw session ids on disk'
    now[0] = 1010
    hooks['post_tool_call'](session_id='s1', tool_name='terminal')
    assert files(tmp_path)[0]['state'] == 'working'
    hooks['on_session_end'](session_id='s1', completed=True, failed=False, interrupted=False)
    assert files(tmp_path)[0]['state'] == 'done'


def test_model_retries_keep_the_original_wait_start(tmp_path):
    now = [100.0]
    _, hooks = load(tmp_path, clock=lambda: now[0])
    hooks['pre_api_request'](session_id='s')
    for minute in range(1, 6):
        now[0] = 100 + minute * 240
        hooks['api_request_error'](session_id='s')
        hooks['pre_api_request'](session_id='s')
    [state] = files(tmp_path)
    assert state['state'] == 'thinking' and state['since'] == 100.0 and state['retries'] == 5


def test_sessions_are_separate_files_and_outcomes_map(tmp_path):
    _, hooks = load(tmp_path)
    hooks['pre_tool_call'](session_id='a', tool_name='read_file')
    hooks['on_session_end'](session_id='b', completed=False, failed=True, interrupted=False)
    hooks['on_session_end'](session_id='c', completed=False, failed=False, interrupted=True)
    assert sorted(s['state'] for s in files(tmp_path)) == ['error', 'interrupted', 'tool']


def test_unsafe_tool_names_and_failures_never_break_the_turn(tmp_path, monkeypatch):
    plugin, hooks = load(tmp_path)
    hooks['pre_tool_call'](session_id='s', tool_name='../../etc/passwd x' * 5)
    assert files(tmp_path)[0]['tool'] == 'tool'
    assert hooks['pre_tool_call'](session_id='s', tool_name='terminal') is None, 'never vetoes or rewrites a tool call'
    monkeypatch.setattr(plugin.os, 'replace', lambda *a: (_ for _ in ()).throw(OSError('disk full')))
    hooks['pre_api_request'](session_id='s')  # must not raise


def test_unchanged_steps_are_not_rewritten(tmp_path, monkeypatch):
    plugin, hooks = load(tmp_path)
    writes = []
    real = plugin.os.replace
    monkeypatch.setattr(plugin.os, 'replace', lambda a, b: (writes.append(b), real(a, b)))
    for _ in range(5): hooks['pre_api_request'](session_id='s')
    assert len(writes) == 1


def test_overlapping_writes_for_one_session_stay_valid_json(tmp_path, monkeypatch):
    """Two hooks of one session at once: each write gets its own temp file and they publish in turn."""
    import threading
    plugin, hooks = load(tmp_path)
    opened, release, second_writing = threading.Event(), threading.Event(), threading.Event()
    parts = []
    real_write = Path.write_text

    def scheduled_write(path, data, *args, **kwargs):
        parts.append(path.name)
        if threading.current_thread().name == 'first-hook':
            with path.open('w', encoding='utf-8') as stream:  # what write_text does, paused mid-write
                opened.set()
                release.wait(5)
                return stream.write(data)
        second_writing.set()
        return real_write(path, data, *args, **kwargs)

    monkeypatch.setattr(Path, 'write_text', scheduled_write)
    first = threading.Thread(name='first-hook', target=lambda: hooks['pre_tool_call'](session_id='same', tool_name='x'))
    second = threading.Thread(target=lambda: hooks['pre_tool_call'](session_id='same', tool_name='long_tool_name'))
    first.start()
    assert opened.wait(5)
    second.start()
    overlapped = second_writing.wait(0.5)
    release.set()
    first.join(5); second.join(5)
    assert not overlapped, 'a second write to the same session must wait for the first to publish'
    assert len(set(parts)) == 2, f'each write needs its own temp file, got {parts}'
    [state] = files(tmp_path)
    assert (state['state'], state['tool']) == ('tool', 'long_tool_name')
    assert not list((tmp_path/'plugins/talk-desktop/data/progress').glob('*.part'))


def test_failed_publication_is_retried_and_leaves_no_temp_file(tmp_path, monkeypatch):
    plugin, hooks = load(tmp_path)
    real = plugin.os.replace
    monkeypatch.setattr(plugin.os, 'replace', lambda *a: (_ for _ in ()).throw(OSError('disk full')))
    hooks['pre_api_request'](session_id='s')
    folder = tmp_path/'plugins/talk-desktop/data/progress'
    assert not list(folder.glob('*.part')), 'a failed write cleans up its temp file'
    monkeypatch.setattr(plugin.os, 'replace', real)
    hooks['pre_api_request'](session_id='s')
    assert [s['state'] for s in files(tmp_path)] == ['thinking'], 'the step is remembered only once it is on disk'


def test_manifest_declares_every_registered_hook(tmp_path):
    _, hooks = load(tmp_path)
    text = (ROOT/'bot-alerts/plugin.yaml').read_text()
    for name in hooks:
        assert f'  - {name}' in text, name
