"""Animated bot pets from Petdex gallery sheets.

Petdex sheets are regular grids of 192x208 cells using the nine-row state
taxonomy (idle, running-right, running-left, waving, jumping, failed, waiting,
running, review); only the column count and any extra trailing rows vary.
A sheet is accepted only when its first cell, downsampled nearest-neighbour to
96x104, equals the bot's avatar pixels exactly, so a pet can never show the
wrong character.
"""
import base64
import hashlib
import io
import os
import re
import stat
import threading
import time
from pathlib import Path
from urllib.parse import urlparse


def _load_portable():
    """dashboard/portable.py, shared by every backend file through one sys.modules entry."""
    import importlib.util, sys
    name = 'talk_desktop_portable'
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().with_name('portable.py'))
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules[name]


portable = _load_portable()

FRAME_W, FRAME_H = 192, 208
STATE_ROWS = 9
MAX_COLUMNS, MAX_ROWS = 16, 16
MAX_SHEET_BYTES = 8 * 1048576
MAX_THUMB_BYTES = 262144
FORMATS = {'WEBP': 'image/webp', 'PNG': 'image/png'}
EXTENSIONS = {'image/webp': 'webp', 'image/png': 'png'}
SLUG = re.compile(r'[a-z0-9][a-z0-9_-]{0,95}')
RETRY_SECONDS = 600
INDEX_BATCH = 64          # thumbs decoded per call, so a huge cache never stalls a poll
DOWNLOAD_TIMEOUT = 30
SHOWN_ROWS = (0, 3, 5, 6, 7, 8)   # Petdex rows the bot window can show


def describe_sheet(data, avatar_pixels):
    """Return the bot-view pet descriptor for a verified sheet, else None."""
    try:
        from PIL import Image
    except ImportError:
        return None
    if not isinstance(data, (bytes, bytearray)) or not 0 < len(data) <= MAX_SHEET_BYTES:
        return None
    try:
        with Image.open(io.BytesIO(data)) as image:
            mime = FORMATS.get(image.format)
            width, height = image.size
            columns, rows = width // FRAME_W, height // FRAME_H
            # Check geometry from the header before decoding any pixels.
            if (not mime or width % FRAME_W or height % FRAME_H
                    or not 1 <= columns <= MAX_COLUMNS or not STATE_ROWS <= rows <= MAX_ROWS):
                return None
            sheet = image.convert('RGBA')
        first = sheet.crop((0, 0, FRAME_W, FRAME_H)).resize((96, 104), Image.Resampling.NEAREST)
        if first.tobytes() != avatar_pixels:
            return None
        counts, top = [], FRAME_H
        for row in range(STATE_ROWS):
            count = 0
            for col in range(columns):
                box = (col*FRAME_W, row*FRAME_H, (col+1)*FRAME_W, (row+1)*FRAME_H)
                alpha = sheet.crop(box).getchannel('A')
                if not alpha.getbbox():
                    break
                # Highest clearly visible pixel in any pose the bot window shows (idle, waving,
                # failed, waiting, running, review): the bubble sits just above it.
                solid = alpha.point(lambda a: 255 if a > 24 else 0).getbbox() if row in SHOWN_ROWS else None
                if solid:
                    top = min(top, solid[1])
                count += 1
            if not count:
                return None
            counts.append(count)
    except (OSError, ValueError, Image.DecompressionBombError):
        return None
    return {'sprite': 'data:' + mime + ';base64,' + base64.b64encode(bytes(data)).decode('ascii'),
            'frameWidth': FRAME_W, 'frameHeight': FRAME_H, 'counts': counts, 'top': top if top < FRAME_H else 0}


def petdex_url_ok(url):
    """Only HTTPS petdex.dev hosts, no credentials or odd ports (anti-SSRF)."""
    try:
        parsed = urlparse(url) if isinstance(url, str) else None
        host = (parsed.hostname or '').lower() if parsed else ''
        return bool(parsed and parsed.scheme == 'https' and not parsed.username and not parsed.password
                    and parsed.port in (None, 443) and (host == 'petdex.dev' or host.endswith('.petdex.dev')))
    except ValueError:
        return False


def fetch_from_petdex(slug, timeout=DOWNLOAD_TIMEOUT):
    """Download *slug*'s sheet using Hermes' own manifest and SSRF-safe client; None on any failure."""
    try:
        from agent.pet.manifest import find_entry
        from tools.url_safety import create_ssrf_safe_client, is_safe_url
        entry = find_entry(slug, timeout=timeout)
        url = entry.spritesheet_url if entry else ''
        if not petdex_url_ok(url) or not is_safe_url(url):
            return None
        chunks, size = [], 0
        with create_ssrf_safe_client(timeout=timeout, follow_redirects=True) as client:
            with client.stream('GET', url, headers={'User-Agent': 'hermes-agent-petdex'}) as response:
                if response.status_code != 200 or not petdex_url_ok(str(response.url)):
                    return None
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    if size > MAX_SHEET_BYTES:
                        return None
                    chunks.append(chunk)
        return b''.join(chunks)
    except Exception:
        return None


def _avatar_pixels(uri):
    """Decoded RGBA pixels of a 96x104 data-URI avatar, or None."""
    try:
        from PIL import Image
        data = base64.b64decode(uri.split(',', 1)[1], validate=True)
        with Image.open(io.BytesIO(data)) as image:
            if image.size != (96, 104):
                return None
            return image.convert('RGBA').tobytes()
    except Exception:
        return None


def _open_regular(base, parts, limit):
    """(reader, stat-key, fd) for a bounded regular file at base/parts.

    The trusted base (Hermes home or the plugin cache) may itself be reached
    through a symlink; every component *below* it is opened no-follow.
    """
    try:
        fd = portable.open_below(base, parts)
    except OSError:
        return None
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= limit:
        os.close(fd)
        return None
    def read():
        with os.fdopen(fd, 'rb') as stream:
            data = stream.read(limit + 1)
        return data if len(data) <= limit else None
    return read, (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns), fd


LOCAL_NAME = re.compile(r'[A-Za-z0-9_-]{1,64}\.(webp|png)')
PET_FILE = re.compile(r'[A-Za-z0-9_.-]{1,64}\.(webp|png)')


def _read_regular(base, parts, limit):
    opened = _open_regular(base, parts, limit)
    if not opened:
        return None
    read, _, _ = opened
    try:
        return read()
    except OSError:
        return None


def local_sheet(folder, avatar_pixels):
    """Descriptor from a private local sprite folder whose first cell is this avatar.

    Lets a user keep hand-made or non-redistributable bot sheets outside the
    plugin source (for example in the plugin's private data folder): any sheet
    there animates the bot whose avatar equals its first frame.
    """
    folder = Path(folder)
    try:
        names = sorted(entry.name for entry in os.scandir(folder)
                       if LOCAL_NAME.fullmatch(entry.name) and entry.is_file(follow_symlinks=False))
    except OSError:
        return None
    for name in names[:32]:
        data = _read_regular(folder.parent, (folder.name, name), MAX_SHEET_BYTES)
        pet = describe_sheet(data, avatar_pixels) if data else None
        if pet:
            return pet
    return None


def _pet_config(home):
    """(enabled, slug) from ``display.pet`` in this profile's config.yaml."""
    try:
        with open(Path(home) / 'config.yaml', 'rb') as stream:
            data = stream.read(1048577)
    except OSError:
        return False, ''
    if not data or len(data) > 1048576:
        return False, ''
    try:
        import yaml
        config = yaml.safe_load(data.decode('utf-8-sig')) or {}
    except Exception:
        return False, ''
    pet = ((config.get('display') or {}).get('pet') or {}) if isinstance(config, dict) else {}
    if not isinstance(pet, dict):
        return False, ''
    enabled = pet.get('enabled')
    enabled = enabled is True or (isinstance(enabled, str) and enabled.strip().lower() in ('1', 'true', 'yes', 'on'))
    slug = pet.get('slug') if isinstance(pet.get('slug'), str) else ''
    return enabled, slug.strip()


def _pet_sheet_name(home, slug):
    """Spritesheet file name for an installed pet, following Hermes' pet store rules."""
    names = []
    raw = _read_regular(home, ('pets', slug, 'pet.json'), 65536)
    if raw:
        try:
            import json
            declared = json.loads(raw.decode('utf-8-sig')).get('spritesheetPath', '')
            if isinstance(declared, str) and PET_FILE.fullmatch(declared.strip()):
                names.append(declared.strip())
        except (ValueError, AttributeError):
            pass
    names += ['spritesheet.webp', 'spritesheet.png', 'sprite.webp', 'sprite.png']
    for name in names:
        try:
            if stat.S_ISREG(os.lstat(Path(home) / 'pets' / slug / name).st_mode):
                return name
        except OSError:
            continue
    return None


def active_pet_source(home):
    """(slug, (base, parts)) of the pet Hermes would show for this profile home, else (None, None).

    Mirrors Hermes' pet store: the configured ``display.pet.slug`` when it is
    installed, else the first installed pet alphabetically. The pop-out is an
    explicit request, so it still shows that pet while the in-app display is off.
    """
    _, slug = _pet_config(home)
    candidates = [slug] if slug and SLUG.fullmatch(slug) else []
    try:
        with os.scandir(Path(home) / 'pets') as entries:
            candidates += sorted(e.name for e in entries if SLUG.fullmatch(e.name) and e.is_dir(follow_symlinks=False))
    except OSError:
        pass
    for candidate in candidates:
        name = _pet_sheet_name(home, candidate)
        if name:
            return candidate, (Path(home), ('pets', candidate, name))
    return None, None


class GalleryResolver:
    """Find each bot avatar's full gallery sheet automatically.

    The Hermes avatar picker stores only frame 0 as ``avatar.png`` but caches the
    identical thumbnail as ``pets/.thumbs/<slug>.png`` (root and profile-scoped
    pet dirs). Matching decoded avatar pixels against that cache yields the
    slug; the sheet comes from an installed pet, this plugin's own verified
    cache, or one background download from petdex. Every sheet is re-verified
    against the avatar before use, so an unknown avatar stays static.
    """

    def __init__(self, hermes_home, cache_dir, fetch=None, spawn=None, clock=time.monotonic):
        self.home = Path(hermes_home)
        self.cache_dir = Path(cache_dir)
        self.fetch = fetch or fetch_from_petdex
        self.spawn = spawn or (lambda job: threading.Thread(target=job, daemon=True).start())
        self.clock = clock
        self.lock = threading.RLock()
        self._avatars = {}      # data URI -> pixels | None
        self._thumbs = {}       # file path -> (stat key, digest | None)
        self._stamp = None
        self._pending = False
        self._by_digest = {}    # pixel digest -> sorted slugs
        self._sheets = {}       # (base, parts, stat key, digest) -> descriptor | None
        self._verifying = set() # sheet cache keys with a queued background verification
        self._where = {}        # slug -> (base, parts) of its last verified sheet
        self._downloads = {}    # slug -> ('downloading' | 'failed', time)

    # ── thumbnail index ────────────────────────────────────────────────
    def _pet_dirs(self):
        dirs = [self.home / 'pets']
        try:
            with os.scandir(self.home / 'profiles') as entries:
                for entry in sorted(entries, key=lambda e: e.name):
                    if SLUG.fullmatch(entry.name) and entry.is_dir(follow_symlinks=False):
                        dirs.append(Path(entry.path) / 'pets')
        except OSError:
            pass
        return dirs

    def _thumb_dirs(self):
        found = []
        for pets in self._pet_dirs():
            thumbs = pets / '.thumbs'
            try:
                info = os.lstat(thumbs)
            except OSError:
                continue
            if stat.S_ISDIR(info.st_mode):
                found.append((thumbs, info.st_ino, info.st_mtime_ns))
        return found

    def _refresh_index(self):
        from PIL import Image
        dirs = self._thumb_dirs()
        stamp = tuple((str(d), ino, mtime) for d, ino, mtime in dirs)
        if stamp == self._stamp and not self._pending:
            return
        seen, budget, pending = set(), INDEX_BATCH, False
        for directory, _, _ in dirs:
            try:
                entries = list(os.scandir(directory))
            except OSError:
                continue
            for entry in entries:
                name = entry.name
                if not name.endswith('.png') or not SLUG.fullmatch(name[:-4]):
                    continue
                try:
                    info = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_THUMB_BYTES:
                    continue
                key = (info.st_ino, info.st_size, info.st_mtime_ns)
                seen.add(entry.path)
                if self._thumbs.get(entry.path, (None,))[0] == key:
                    continue
                if budget <= 0:
                    pending = True
                    continue
                budget -= 1
                digest = None
                try:
                    fd = portable.open_leaf(entry.path)
                    with os.fdopen(fd, 'rb') as stream:
                        data = stream.read(MAX_THUMB_BYTES + 1)
                    if len(data) <= MAX_THUMB_BYTES:
                        with Image.open(io.BytesIO(data)) as image:
                            if image.size == (96, 104):
                                digest = hashlib.sha256(image.convert('RGBA').tobytes()).hexdigest()
                except Exception:
                    pass
                self._thumbs[entry.path] = (key, digest)
        for path in set(self._thumbs) - seen:
            del self._thumbs[path]
        index = {}
        for path, (_, digest) in self._thumbs.items():
            if digest:
                index.setdefault(digest, set()).add(Path(path).name[:-4])
        self._by_digest = {digest: sorted(slugs) for digest, slugs in index.items()}
        self._stamp, self._pending = stamp, pending

    # ── sheets ─────────────────────────────────────────────────────────
    def _candidates(self, slug):
        for pets in self._pet_dirs():
            relative = pets.relative_to(self.home).parts
            for extension in ('webp', 'png'):
                yield self.home, (*relative, slug, 'spritesheet.' + extension)
        for extension in ('webp', 'png'):
            yield self.cache_dir, (slug + '.' + extension,)

    def _remember(self, cache_key, pet):
        if len(self._sheets) >= 32:
            self._sheets.clear()
        self._sheets[cache_key] = pet

    def _verify(self, cache_key, read, pixels):
        """Decode and check a sheet off the poll thread (about 60 ms for a 1.8 MB sheet)."""
        def job():
            try:
                pet = describe_sheet(read(), pixels)
            except Exception:
                pet = None
            with self.lock:
                self._remember(cache_key, pet)
                self._verifying.discard(cache_key)
        return job

    def _local(self, slug, pixels, digest):
        """('animated', pet) | ('loading', None) | (None, None) when no usable local sheet."""
        known = self._where.get(slug)
        if known:
            state, pet = self._probe(slug, *known, pixels, digest)
            if state == 'animated':
                return state, pet
        for base, parts in self._candidates(slug):
            if (base, parts) == known:
                continue
            state, pet = self._probe(slug, base, parts, pixels, digest)
            if state:
                return state, pet
        return None, None

    def _probe(self, slug, base, parts, pixels, digest):
        """State of one candidate sheet; queues background verification on first sight."""
        opened = _open_regular(base, parts, MAX_SHEET_BYTES)
        if not opened:
            return None, None
        read, key, fd = opened
        cache_key = (str(base), parts, key, digest)
        if cache_key in self._sheets or cache_key in self._verifying:
            os.close(fd)
        else:
            self._verifying.add(cache_key)
            try:
                self.spawn(self._verify(cache_key, read, pixels))
            except Exception:
                self._verifying.discard(cache_key)
                os.close(fd)
                return None, None
        if self._sheets.get(cache_key):
            self._where[slug] = (base, parts)
            return 'animated', self._sheets[cache_key]
        if cache_key in self._verifying:
            return 'loading', None
        return None, None

    def _download(self, slug, pixels, digest):
        def job():
            try:
                data = self.fetch(slug)
            except Exception:
                data = None
            pet = describe_sheet(data, pixels) if data else None
            saved = None
            if pet:
                try:
                    self.cache_dir.mkdir(parents=True, exist_ok=True)
                    name = slug + '.' + EXTENSIONS[pet['sprite'][5:pet['sprite'].index(';')]]
                    target = self.cache_dir / name
                    part = target.with_name(name + '.part')
                    part.write_bytes(data)
                    os.replace(part, target)
                    opened = _open_regular(self.cache_dir, (name,), MAX_SHEET_BYTES)
                    if opened:
                        os.close(opened[2])
                        saved = (str(self.cache_dir), (name,), opened[1], digest)
                except OSError:
                    pass
            with self.lock:
                if saved:
                    self._remember(saved, pet)
                    self._downloads.pop(slug, None)
                else:
                    self._downloads[slug] = ('failed', self.clock())
        self._downloads[slug] = ('downloading', self.clock())
        try:
            self.spawn(job)
        except Exception:
            self._downloads[slug] = ('failed', self.clock())

    # ── public ─────────────────────────────────────────────────────────
    def resolve(self, uri):
        """(status, slug, pet) for an avatar data URI; status is one of
        animated / loading / downloading / failed / indexing / no-match / no-avatar."""
        if not isinstance(uri, str) or not uri.startswith('data:image/'):
            return 'no-avatar', '', None
        with self.lock:
            if uri not in self._avatars:
                if len(self._avatars) >= 64:
                    self._avatars.clear()
                self._avatars[uri] = _avatar_pixels(uri)
            pixels = self._avatars[uri]
            if pixels is None:
                return 'no-avatar', '', None
            try:
                self._refresh_index()
            except ImportError:
                return 'no-match', '', None
            digest = hashlib.sha256(pixels).hexdigest()
            slugs = self._by_digest.get(digest, [])
            for slug in slugs:
                state, pet = self._local(slug, pixels, digest)
                if state:
                    return state, slug, pet
            if not slugs:
                return ('indexing' if self._pending else 'no-match'), '', None
            slug = slugs[0]
            state, since = self._downloads.get(slug, (None, 0))
            if state == 'downloading':
                return 'downloading', slug, None
            if state == 'failed' and self.clock() - since < RETRY_SECONDS:
                return 'failed', slug, None
            self._download(slug, pixels, digest)
            if slug not in self._downloads:  # synchronous spawn already finished
                return self.resolve(uri)
            return self._downloads[slug][0], slug, None

    def pet_for(self, uri):
        return self.resolve(uri)[2]

    def status_for(self, uri):
        return self.resolve(uri)[:2]
