"""Broker wiring for automatic gallery sprites: any grid, sent to the helper once by id."""
import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path

import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('broker_gallery_under_test', ROOT/'dashboard/companion_broker.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def sheet(columns, rows, color='red'):
    image = Image.new('RGBA', (columns*192, rows*208))
    for row in range(9):
        for col in range(columns):
            image.paste(color if (row, col) == (0, 0) else 'blue', (col*192, row*208, (col+1)*192, (row+1)*208))
    buf = io.BytesIO(); image.save(buf, format='WEBP', lossless=True); return buf.getvalue()


def avatar_uri(color='red'):
    buf = io.BytesIO(); Image.new('RGBA', (96, 104), color).save(buf, format='PNG')
    return buf.getvalue(), 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()


def broker_with(tmp_path, avatars):
    root = tmp_path/'plugin'; root.mkdir(parents=True)
    home = tmp_path/'hermes'; (home/'pets/.thumbs').mkdir(parents=True); (home/'profiles').mkdir()
    for name in avatars: (home/'profiles'/name).mkdir()
    broker = module.Broker(root)
    broker.gallery_spawn = lambda job: job()  # run background verification/download inline
    broker.profiles_root = lambda: home/'profiles'
    broker.bot_avatar = lambda name: avatars.get(name)
    broker.owner = {'generation': 'g'}
    broker.main_pet = lambda: None  # the pop-out pet has its own tests (test_main_pet.py)
    broker.state = {'bots': [dict(id=name, label=name, status='Working', chat=True) for name in avatars]}
    return broker, root, home


def test_local_sheet_with_new_grid_size_is_accepted(tmp_path):
    raw, uri = avatar_uri()
    broker, root, _ = broker_with(tmp_path, {'bot': uri})
    data = sheet(8, 9)  # 1536x1872: the s0uthpaw layout the fixed-size check rejected
    (root/'data/local-sprites').mkdir(parents=True)
    (root/'data/local-sprites/test.webp').write_bytes(data)
    pet = broker.helper_state()['state']['bots'][0]['pet']
    assert pet['counts'] == [8]*9


def test_gallery_sheet_resolves_from_thumb_cache_without_local_sheet(tmp_path):
    raw, uri = avatar_uri()
    broker, _, home = broker_with(tmp_path, {'sovtpaw': uri})
    (home/'pets/.thumbs/s0uthpaw.png').write_bytes(raw)
    (home/'pets/s0uthpaw').mkdir(); (home/'pets/s0uthpaw/spritesheet.webp').write_bytes(sheet(8, 9))
    pet = broker.helper_state()['state']['bots'][0]['pet']
    assert pet['counts'] == [8]*9


def test_helper_state_carries_sprite_id_and_sheet_is_fetched_once(tmp_path):
    raw, uri = avatar_uri()
    broker, _, home = broker_with(tmp_path, {'a': uri, 'b': uri})
    (home/'pets/.thumbs/s.png').write_bytes(raw)
    (home/'pets/s').mkdir(); (home/'pets/s/spritesheet.webp').write_bytes(sheet(8, 9))
    state = broker.helper_state()
    pets = [bot['pet'] for bot in state['state']['bots']]
    assert all('sprite' not in pet for pet in pets), 'multi-MB sheet must not ride every 200 ms poll'
    assert len(json.dumps(state)) < 20000
    ident = pets[0]['spriteId']
    assert pets[1]['spriteId'] == ident and len(ident) == 64
    sprite = broker.sprite_data({'id': ident})['sprite']
    assert sprite.startswith('data:image/webp;base64,')
    assert hashlib.sha256(sprite.encode()).hexdigest() == ident
    for bad in ({'id': '0'*64}, {'id': 7}, {}, {'id': ident, 'extra': 1}):
        with pytest.raises(module.HTTPException):
            broker.sprite_data(bad)


def test_sprite_report_explains_static_pets(tmp_path):
    raw, uri = avatar_uri()
    _, other = avatar_uri('green')
    broker, _, home = broker_with(tmp_path, {'anim': uri, 'plain': other, 'none': None})
    (home/'pets/.thumbs/s.png').write_bytes(raw)
    (home/'pets/s').mkdir(); (home/'pets/s/spritesheet.webp').write_bytes(sheet(6, 9))
    report = broker.sprite_report()
    assert report == {'anim': 'animated (s)', 'none': 'no avatar', 'plain': 'no gallery match'}


def test_sprite_report_route_needs_no_lease_but_validates_bots(tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    raw, uri = avatar_uri()
    broker, _, home = broker_with(tmp_path, {'anim': uri})
    broker.owner = None  # palette check works with bot pets off and no pop-out
    app = FastAPI(); app.include_router(module.make_router(broker))
    with TestClient(app, client=('127.0.0.1', 1234)) as client:
        assert client.post('/companion/sprites', json={'bots': ['anim']}).json() == {'bots': {'anim': 'no gallery match'}}
        assert client.post('/companion/sprites', json={'bots': ['../x']}).status_code == 400
        assert client.post('/companion/sprites', json={'bots': 'anim'}).status_code == 400
        assert client.post('/companion/sprites', json={'bots': ['anim']}, headers={'Origin': 'https://evil'}).status_code == 403


def test_repeated_polls_reuse_the_found_sheet_location(tmp_path, monkeypatch):
    raw, uri = avatar_uri()
    broker, _, home = broker_with(tmp_path, {'anim': uri})
    for n in range(6): (home/'profiles'/f'p{n}').mkdir()
    (home/'pets/.thumbs/s.png').write_bytes(raw)
    # Downloaded sheets live in the plugin cache: the last of ~14 candidate locations.
    cache = broker.root/'data/gallery-sprites'; cache.mkdir(parents=True)
    (cache/'s.webp').write_bytes(sheet(8, 9))
    assert broker.helper_state()['state']['bots'][0]['pet']
    opens = []
    real = module.gallery._open_regular
    monkeypatch.setattr(module.gallery, '_open_regular', lambda *a: (opens.append(a[1]), real(*a))[1])
    for _ in range(5): assert broker.helper_state()['state']['bots'][0]['pet']
    assert len(opens) == 5, 'one sheet probe per poll, not one per candidate location'


def test_helper_state_carries_backend_progress_per_bot(tmp_path):
    import sqlite3, time
    raw, uri = avatar_uri()
    broker, root, home = broker_with(tmp_path, {'alpha': uri, 'beta': uri})
    db = sqlite3.connect(home/'kanban.db')
    db.executescript("create table tasks (id text, title text, assignee text, status text, started_at integer, completed_at integer, current_run_id integer);"
                     "create table task_runs (id integer, task_id text, started_at integer, summary text);"
                     "create table task_events (id integer primary key, task_id text, run_id integer, kind text, payload text, created_at integer);")
    db.execute("insert into tasks values ('t_1','Review the plugin','alpha','running',?,null,null)", (int(time.time()) - 90,))
    db.commit(); db.close()
    bots = {bot['id']: bot for bot in broker.helper_state()['state']['bots']}
    assert bots['alpha']['progress']['title'] == 'Review the plugin'
    assert bots['alpha']['progress']['row'] == 7
    assert 'progress' not in bots['beta']
    broker._progress = None
    (home/'kanban.db').unlink()
    assert 'progress' not in broker.helper_state()['state']['bots'][0], 'board gone: no stale progress'


def test_progress_failure_never_breaks_the_pet_state(tmp_path, monkeypatch):
    raw, uri = avatar_uri()
    broker, root, home = broker_with(tmp_path, {'alpha': uri})
    class Broken:
        def for_bots(self, names): raise RuntimeError('boom')
    broker._progress = Broken()
    assert broker.helper_state()['state']['bots'][0]['id'] == 'alpha'


def test_inapp_bots_route_serves_bot_pets_inside_hermes_without_a_lease(tmp_path):
    """Windows/macOS: no desktop windows, so the renderer draws bot pets from this feed."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    raw, uri = avatar_uri()
    broker, _, home = broker_with(tmp_path, {'anim': uri, 'plain': avatar_uri('green')[1]})
    (home/'pets/.thumbs/s.png').write_bytes(raw)
    (home/'pets/s').mkdir(); (home/'pets/s/spritesheet.webp').write_bytes(sheet(8, 9))
    broker.owner = None  # no pop-out lease: the in-app layer needs none
    app = FastAPI(); app.include_router(module.make_router(broker))
    with TestClient(app, client=('127.0.0.1', 1234)) as client:
        reply = client.post('/companion/bots', json={'bots': ['anim', 'plain']})
        assert reply.status_code == 200
        bots = reply.json()['bots']
        assert len(reply.content) < 20000, 'images travel by id, never inline'
        assert bots['anim']['pet']['counts'] == [8]*9 and 'sprite' not in bots['anim']['pet']
        assert 'pet' not in bots['plain'] and len(bots['plain']['avatarId']) == 64
        sheet_uri = client.post('/companion/image', json={'id': bots['anim']['pet']['spriteId']}).json()['data']
        assert sheet_uri.startswith('data:image/webp;base64,')
        assert client.post('/companion/image', json={'id': bots['plain']['avatarId']}).json()['data'].startswith('data:image/png;base64,')
        assert client.post('/companion/image', json={'id': '0'*64}).status_code == 404
        for bad in ({'bots': ['../x']}, {'bots': 'anim'}, {'bots': ['anim', 'anim']}, {'bots': ['default']}, {'bots': ['b%d' % n for n in range(13)]}):
            assert client.post('/companion/bots', json=bad).status_code == 400, bad
        assert client.post('/companion/bots', json={'bots': ['anim']}, headers={'Origin': 'https://evil'}).status_code == 403
    with TestClient(app, client=('192.0.2.9', 1234)) as client:
        assert client.post('/companion/bots', json={'bots': ['anim']}).status_code == 403


def test_capabilities_report_desktop_windows_only_on_linux_layer_shell(monkeypatch):
    monkeypatch.setattr(module.sys, 'platform', 'win32')
    assert module.Broker.capabilities()['desktopWindows'] is False
    monkeypatch.setattr(module.sys, 'platform', 'darwin')
    assert module.Broker.capabilities()['desktopWindows'] is False
    monkeypatch.setattr(module.sys, 'platform', 'linux')
    monkeypatch.delenv('WAYLAND_DISPLAY', raising=False)
    assert module.Broker.capabilities()['desktopWindows'] is False
    monkeypatch.setenv('WAYLAND_DISPLAY', 'wayland-1')
    monkeypatch.setattr(module.os.path, 'exists', lambda path: path == '/usr/bin/python')
    assert module.Broker.capabilities() == {'desktopWindows': True, 'platform': 'linux', 'reason': ''}


def test_runtime_refuses_cleanly_off_linux(tmp_path, monkeypatch):
    broker = module.Broker(tmp_path)
    monkeypatch.setattr(module.sys, 'platform', 'win32')
    with pytest.raises(module.HTTPException) as error:
        broker.runtime()
    assert error.value.status_code == 503 and 'shift-click' in error.value.detail
