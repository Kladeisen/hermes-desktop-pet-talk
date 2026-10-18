"""Bot sheets from the plugin's private data/local-sprites folder; never renderer paths."""
import base64
import importlib.util
import io
from pathlib import Path
import pytest
from PIL import Image

spec = importlib.util.spec_from_file_location('animation_broker', Path(__file__).parents[1]/'dashboard/companion_broker.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

COUNTS = [7,8,8,4,5,8,6,6,6]


def write_sheet(path, first='red'):
    sheet = Image.new('RGBA',(1536,2288))
    for row, count in enumerate(COUNTS):
        for col in range(count):
            sheet.paste((first if col == 0 and row == 0 else 'blue'), (col*192,row*208,(col+1)*192,(row+1)*208))
    sheet.save(path, lossless=True)


def fixture(tmp_path):
    root = tmp_path/'plugin'
    folder = root/'data/local-sprites'
    folder.mkdir(parents=True)
    avatar = Image.new('RGBA', (96,104), 'red')
    buf = io.BytesIO(); avatar.save(buf, format='PNG')
    uri = 'data:image/png;base64,'+base64.b64encode(buf.getvalue()).decode()
    write_sheet(folder/'test.webp')
    broker = module.Broker(root)
    broker.bot_avatar = lambda name: uri
    broker.owner = {'generation':'test'}
    broker.main_pet = lambda: None
    broker.state = {'bots':[dict(id='any-profile',label='Test',status='Working',chat=True)]}
    return broker, folder, uri


def test_plugin_source_ships_no_sprite_assets():
    root = Path(__file__).parents[1]
    assert not (root/'companion/pets').exists() and not (root/'pets').exists()


def test_local_sheet_cache_reuses_decode_and_invalidates_on_change(tmp_path, monkeypatch):
    broker, folder, uri = fixture(tmp_path)
    original = Image.open
    calls = []
    def opened(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)
    monkeypatch.setattr(Image, 'open', opened)
    first = broker.helper_state()['state']['bots'][0]['pet']
    count = len(calls)
    assert broker.helper_state()['state']['bots'][0]['pet'] == first
    assert len(calls) == count, 'unchanged folder must not re-decode on every poll'
    write_sheet(folder/'test.webp', first='green')
    assert 'pet' not in broker.helper_state()['state']['bots'][0]
    write_sheet(folder/'test.webp')
    assert 'pet' in broker.helper_state()['state']['bots'][0]
    broker.bot_avatar = lambda _: 'data:image/png;base64,AAAA'
    assert 'pet' not in broker.helper_state()['state']['bots'][0]
    broker.bot_avatar = lambda _: uri
    (folder/'test.webp').write_bytes(b'broken')
    assert 'pet' not in broker.helper_state()['state']['bots'][0]


def test_helper_associates_verified_sheet_and_measures_nonblank_frames(tmp_path):
    broker, _, _ = fixture(tmp_path)
    pet = broker.helper_state()['state']['bots'][0]['pet']
    assert pet['frameWidth'] == 192 and pet['frameHeight'] == 208
    assert pet['counts'] == COUNTS
    assert 'sprite' not in pet, 'sheet is fetched once by id, not on every poll'
    assert broker.sprite_data({'id': pet['spriteId']})['sprite'].startswith('data:image/webp;base64,')
    assert broker.pet_source(broker.bot_avatar('any-profile'))[0] == 'animated (local sprite)'


@pytest.mark.parametrize('damage', ['wrong-first-cell','bad-name','symlink','directory-symlink','oversize','folder-is-file'])
def test_unverified_assets_keep_static_avatar(tmp_path, damage):
    broker, folder, _ = fixture(tmp_path)
    if damage == 'wrong-first-cell':
        write_sheet(folder/'test.webp', first='green')
    if damage == 'bad-name':
        (folder/'test.webp').rename(folder/'te st.webp')
    if damage == 'symlink':
        (folder/'test.webp').rename(tmp_path/'real.webp')
        (folder/'test.webp').symlink_to(tmp_path/'real.webp')
    if damage == 'directory-symlink':
        folder.rename(tmp_path/'other'); folder.symlink_to(tmp_path/'other', target_is_directory=True)
    if damage == 'oversize':
        with (folder/'test.webp').open('wb') as stream: stream.truncate(8388609)
    if damage == 'folder-is-file':
        for child in folder.iterdir(): child.unlink()
        folder.rmdir(); folder.write_bytes(b'x')
    bot = broker.helper_state()['state']['bots'][0]
    assert 'pet' not in bot
    assert bot['avatar'].startswith('data:image/png;')
