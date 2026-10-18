"""Automatic avatar -> gallery sheet resolution (thumb cache, installed sheet, background download)."""
import base64
import importlib.util
import io
import os
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('gallery_resolver_under_test', ROOT/'dashboard/gallery_sprites.py')
gallery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gallery)


def png(image):
    buf = io.BytesIO(); image.save(buf, format='PNG'); return buf.getvalue()


def avatar(color='red'):
    data = png(Image.new('RGBA', (96, 104), color))
    return data, 'data:image/png;base64,' + base64.b64encode(data).decode()


def sheet(color='red', columns=8, rows=9):
    image = Image.new('RGBA', (columns*192, rows*208))
    for row in range(9):
        for col in range(columns):
            image.paste(color if (row, col) == (0, 0) else 'blue', (col*192, row*208, (col+1)*192, (row+1)*208))
    buf = io.BytesIO(); image.save(buf, format='WEBP', lossless=True); return buf.getvalue()


class Jobs:
    """Deterministic stand-in for the background download thread."""
    def __init__(self): self.queued = []
    def __call__(self, job): self.queued.append(job)
    def run(self):
        jobs, self.queued = self.queued, []
        for job in jobs: job()


def setup(tmp_path, fetch=None, clock=None):
    home = tmp_path/'hermes'
    (home/'pets/.thumbs').mkdir(parents=True)
    (home/'profiles').mkdir()
    calls = []
    def fetcher(slug):
        calls.append(slug)
        return fetch(slug) if fetch else None
    jobs = Jobs()
    resolver = gallery.GalleryResolver(home, tmp_path/'cache', fetch=fetcher, spawn=jobs, clock=clock or (lambda: 0.0))
    return home, resolver, calls, jobs


def test_avatar_resolves_installed_sheet_through_thumb_cache(tmp_path):
    home, resolver, calls, jobs = setup(tmp_path)
    raw, uri = avatar()
    (home/'pets/.thumbs/s0uthpaw.png').write_bytes(raw)
    (home/'pets/s0uthpaw').mkdir(); (home/'pets/s0uthpaw/spritesheet.webp').write_bytes(sheet())
    resolver.pet_for(uri); jobs.run()
    pet = resolver.pet_for(uri)
    assert pet and pet['counts'] == [8]*9
    assert calls == []
    assert resolver.status_for(uri) == ('animated', 's0uthpaw')


def test_profile_scoped_thumb_cache_and_avatar_pixel_equality(tmp_path):
    home, resolver, _, jobs = setup(tmp_path)
    _, uri = avatar()
    thumbs = home/'profiles/bot/pets/.thumbs'; thumbs.mkdir(parents=True)
    # Different PNG bytes, same decoded pixels: matching is by pixels, not file bytes.
    Image.new('RGBA', (96, 104), 'red').save(thumbs/'teknium.png', format='PNG', compress_level=0)
    (home/'pets/teknium').mkdir(); (home/'pets/teknium/spritesheet.webp').write_bytes(sheet())
    resolver.pet_for(uri); jobs.run()
    assert resolver.pet_for(uri)['counts'] == [8]*9


def test_missing_sheet_downloads_once_in_background_and_reuses_verified_cache(tmp_path):
    home, resolver, calls, jobs = setup(tmp_path, fetch=lambda slug: sheet())
    raw, uri = avatar()
    (home/'pets/.thumbs/nukey.png').write_bytes(raw)
    assert resolver.pet_for(uri) is None
    assert resolver.status_for(uri) == ('downloading', 'nukey')
    assert resolver.pet_for(uri) is None and len(jobs.queued) == 1, 'one download per slug'
    jobs.run()
    assert calls == ['nukey']
    assert resolver.pet_for(uri)['counts'] == [8]*9
    cached = list((tmp_path/'cache').iterdir())
    assert [p.name for p in cached] == ['nukey.webp']
    later = Jobs()
    again = gallery.GalleryResolver(home, tmp_path/'cache', fetch=lambda s: calls.append(s), spawn=later, clock=lambda: 0.0)
    again.pet_for(uri); later.run()
    assert again.pet_for(uri)['counts'] == [8]*9 and calls == ['nukey'], 'restart reuses the cached sheet'


def test_unverified_download_is_not_cached_and_retries_only_after_backoff(tmp_path):
    now = [0.0]
    home, resolver, calls, jobs = setup(tmp_path, fetch=lambda slug: sheet('green'), clock=lambda: now[0])
    raw, uri = avatar()
    (home/'pets/.thumbs/impostor.png').write_bytes(raw)
    resolver.pet_for(uri); jobs.run()
    assert resolver.pet_for(uri) is None and not (tmp_path/'cache').exists() or not list((tmp_path/'cache').iterdir())
    assert resolver.status_for(uri)[0] == 'failed'
    resolver.pet_for(uri); assert jobs.queued == [], 'no immediate retry'
    now[0] = gallery.RETRY_SECONDS + 1
    resolver.pet_for(uri); assert len(jobs.queued) == 1


def test_unknown_avatar_never_fetches(tmp_path):
    home, resolver, calls, jobs = setup(tmp_path, fetch=lambda slug: sheet())
    (home/'pets/.thumbs/other.png').write_bytes(avatar('green')[0])
    _, uri = avatar('red')
    assert resolver.pet_for(uri) is None and jobs.queued == [] and calls == []
    assert resolver.status_for(uri) == ('no-match', '')
    assert resolver.pet_for('data:image/png;base64,AAAA') is None
    assert resolver.pet_for(None) is None


def test_new_thumb_and_changed_avatar_are_picked_up(tmp_path):
    home, resolver, _, jobs = setup(tmp_path)
    raw, uri = avatar('red')
    (home/'pets/a').mkdir(); (home/'pets/a/spritesheet.webp').write_bytes(sheet('red'))
    assert resolver.pet_for(uri) is None
    (home/'pets/.thumbs/a.png').write_bytes(raw)
    os.utime(home/'pets/.thumbs', ns=(1, 10**18))
    resolver.pet_for(uri); jobs.run()
    assert resolver.pet_for(uri) is not None, 'thumb cached later (user browsed the gallery) is found'
    raw2, uri2 = avatar('green')
    assert resolver.pet_for(uri2) is None


def test_unsafe_thumb_names_symlinks_and_installed_symlinks_are_ignored(tmp_path):
    home, resolver, calls, jobs = setup(tmp_path, fetch=lambda slug: sheet())
    raw, uri = avatar()
    target = tmp_path/'elsewhere.png'; target.write_bytes(raw)
    (home/'pets/.thumbs/linked.png').symlink_to(target)
    (home/'pets/.thumbs/Bad Name.png').write_bytes(raw)
    assert resolver.pet_for(uri) is None and jobs.queued == []
    (home/'pets/.thumbs/ok.png').write_bytes(raw)
    os.utime(home/'pets/.thumbs', ns=(1, 10**18))
    (home/'pets/ok').mkdir(); real = tmp_path/'real.webp'; real.write_bytes(sheet())
    (home/'pets/ok/spritesheet.webp').symlink_to(real)
    resolver.pet_for(uri)
    assert len(jobs.queued) == 1, 'symlinked installed sheet is not trusted; falls back to download'


def test_unchanged_polls_do_not_redecode(tmp_path, monkeypatch):
    home, resolver, _, jobs = setup(tmp_path)
    raw, uri = avatar()
    (home/'pets/.thumbs/s.png').write_bytes(raw)
    (home/'pets/s').mkdir(); (home/'pets/s/spritesheet.webp').write_bytes(sheet())
    resolver.pet_for(uri); jobs.run()
    first = resolver.pet_for(uri)
    assert first
    opened = []
    original = Image.open
    monkeypatch.setattr(Image, 'open', lambda *a, **k: (opened.append(1), original(*a, **k))[1])
    for _ in range(5):
        assert resolver.pet_for(uri) is first
    assert opened == []


def test_petdex_url_guard():
    assert gallery.petdex_url_ok('https://assets.petdex.dev/pets/x/sprite.webp')
    assert gallery.petdex_url_ok('https://petdex.dev/a.webp')
    for bad in ['http://assets.petdex.dev/x.webp', 'https://evil.dev/x.webp', 'https://petdex.dev.evil.com/x',
                'https://assets.petdex.dev@evil.com/x', '', None, 'file:///etc/passwd']:
        assert not gallery.petdex_url_ok(bad), bad


def test_hermes_home_behind_a_symlink_still_resolves(tmp_path):
    # e.g. Fedora Silverblue's /home -> /var/home; only paths *inside* Hermes home are no-follow.
    home, _, _, _ = setup(tmp_path)
    raw, uri = avatar()
    (home/'pets/.thumbs/s.png').write_bytes(raw)
    (home/'pets/s').mkdir(); (home/'pets/s/spritesheet.webp').write_bytes(sheet())
    link = tmp_path/'linked-home'; link.symlink_to(home, target_is_directory=True)
    jobs = Jobs()
    resolver = gallery.GalleryResolver(link, tmp_path/'cache', fetch=lambda s: None, spawn=jobs, clock=lambda: 0.0)
    resolver.pet_for(uri); jobs.run()
    assert resolver.pet_for(uri)['counts'] == [8]*9


def test_polls_never_decode_sheets_on_the_calling_thread(tmp_path, monkeypatch):
    home, resolver, _, jobs = setup(tmp_path)
    raw, uri = avatar()
    (home/'pets/.thumbs/s.png').write_bytes(raw)
    (home/'pets/s').mkdir(); (home/'pets/s/spritesheet.webp').write_bytes(sheet())
    decoded = []
    original = gallery.describe_sheet
    monkeypatch.setattr(gallery, 'describe_sheet', lambda *a: (decoded.append(1), original(*a))[1])
    assert resolver.pet_for(uri) is None
    assert resolver.status_for(uri) == ('loading', 's')
    assert decoded == [], 'sheet verification belongs to the background job'
    jobs.run()
    assert decoded and resolver.pet_for(uri)['counts'] == [8]*9
