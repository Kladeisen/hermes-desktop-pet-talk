"""The pop-out shows the pet the user selected in Hermes, never a bundled character."""
import importlib.util
import io
from pathlib import Path

import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('main_pet_broker', ROOT/'dashboard/companion_broker.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def sheet_bytes(columns=8, rows=9, fmt='WEBP'):
    image = Image.new('RGBA', (columns*192, rows*208), (200, 50, 50, 255))
    buf = io.BytesIO(); image.save(buf, format=fmt, lossless=True) if fmt == 'WEBP' else image.save(buf, format=fmt)
    return buf.getvalue()


def install(home, slug, data=None, name='spritesheet.webp', meta=None):
    directory = home/'pets'/slug
    directory.mkdir(parents=True)
    (directory/name).write_bytes(data or sheet_bytes())
    if meta is not None:
        (directory/'pet.json').write_text(meta)


def broker_for(tmp_path, profile='default', config='display:\n  pet:\n    enabled: true\n    slug: chosen\n'):
    home = tmp_path/'hermes'; (home/'profiles').mkdir(parents=True)
    (home/'config.yaml').write_text(config)
    broker = module.Broker(tmp_path/'plugin')
    broker.profiles_root = lambda: home/'profiles'
    broker.owner = {'generation': 'g', 'profile': profile}
    broker.state = {'bots': []}
    clock = [0.0]
    broker.clock = lambda: clock[0]
    return broker, home, clock


def test_selected_pet_is_published_by_id_and_fetched_once(tmp_path):
    broker, home, _ = broker_for(tmp_path)
    install(home, 'aaa-first')
    install(home, 'chosen')
    state = broker.helper_state()['state']
    assert state['pet']['slug'] == 'chosen'
    assert 'sprite' not in state['pet'], 'the multi-MB sheet must not ride every poll'
    sprite = broker.sprite_data({'id': state['pet']['spriteId']})['sprite']
    assert sprite.startswith('data:image/webp;base64,')


def test_falls_back_like_hermes_to_first_installed_pet(tmp_path):
    broker, home, _ = broker_for(tmp_path, config='display:\n  pet:\n    enabled: true\n    slug: missing\n')
    install(home, 'zeta'); install(home, 'alpha')
    assert broker.main_pet()['slug'] == 'alpha'


def test_pet_json_spritesheet_path_and_png_are_honoured(tmp_path):
    broker, home, _ = broker_for(tmp_path)
    install(home, 'chosen', data=sheet_bytes(fmt='PNG'), name='art.png', meta='{"spritesheetPath": "art.png"}')
    pet = broker.main_pet()
    assert pet['slug'] == 'chosen'
    assert pet['sprite'].startswith('data:image/png;base64,')


def test_bot_profile_owner_uses_that_profiles_pet(tmp_path):
    broker, home, _ = broker_for(tmp_path, profile='worker')
    install(home, 'chosen')
    profile = home/'profiles/worker'; profile.mkdir()
    (profile/'config.yaml').write_text('display:\n  pet:\n    enabled: true\n    slug: own\n')
    install(profile, 'own')
    assert broker.main_pet()['slug'] == 'own'


def test_selection_change_is_picked_up_after_the_short_cache(tmp_path):
    broker, home, clock = broker_for(tmp_path)
    install(home, 'chosen'); install(home, 'other')
    assert broker.main_pet()['slug'] == 'chosen'
    (home/'config.yaml').write_text('display:\n  pet:\n    enabled: true\n    slug: other\n')
    assert broker.main_pet()['slug'] == 'chosen', 'cached between polls'
    clock[0] = 3.0
    assert broker.main_pet()['slug'] == 'other'


def test_unchanged_sheet_is_not_reread(tmp_path, monkeypatch):
    broker, home, clock = broker_for(tmp_path)
    install(home, 'chosen')
    reads = []
    real = module.gallery._read_regular
    monkeypatch.setattr(module.gallery, '_read_regular', lambda *a: (reads.append(a[1]), real(*a))[1])
    for step in range(4):
        clock[0] = step * 3.0
        assert broker.main_pet()
    sheets = [parts for parts in reads if parts[-1] == 'spritesheet.webp']
    assert len(sheets) == 1, 'the multi-MB sheet is read once; only the tiny pet.json is re-checked'


@pytest.mark.parametrize('damage', ['no-pets', 'not-an-image', 'wrong-grid', 'symlinked-sheet', 'unsafe-path', 'oversize'])
def test_unusable_sheets_publish_no_pet(tmp_path, damage):
    broker, home, _ = broker_for(tmp_path)
    if damage == 'not-an-image': install(home, 'chosen', data=b'RIFF0000WEBPjunk')
    if damage == 'wrong-grid': install(home, 'chosen', data=sheet_bytes(columns=8, rows=4))
    if damage == 'symlinked-sheet':
        target = tmp_path/'elsewhere.webp'; target.write_bytes(sheet_bytes())
        (home/'pets/chosen').mkdir(parents=True); (home/'pets/chosen/spritesheet.webp').symlink_to(target)
    if damage == 'unsafe-path':
        install(home, 'chosen', name='real.webp', meta='{"spritesheetPath": "../../config.yaml"}')
        (home/'pets/chosen/real.webp').rename(home/'pets/chosen/elsewhere.bin')
    if damage == 'oversize':
        (home/'pets/chosen').mkdir(parents=True)
        with (home/'pets/chosen/spritesheet.webp').open('wb') as stream: stream.truncate(8388609)
    assert broker.main_pet() is None
    assert 'pet' not in broker.helper_state()['state']
