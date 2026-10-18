"""Plugin-owned local companion broker. Desktop remains the only voice owner.

Owner API inherits Hermes authentication; helper has a separate private capability
received over stdin. No provider credentials, SDP, audio or transcript are accepted.
"""
import atexit
import base64
import collections
import hashlib
import ipaddress
import json
import math
import os
import re
from pathlib import Path
import secrets
import stat
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from fastapi import APIRouter, HTTPException, Request

import importlib.util as _gallery_import
_gallery_spec = _gallery_import.spec_from_file_location('talk_desktop_gallery_sprites', Path(__file__).with_name('gallery_sprites.py'))
gallery = _gallery_import.module_from_spec(_gallery_spec)
_gallery_spec.loader.exec_module(gallery)
_progress_spec = _gallery_import.spec_from_file_location('talk_desktop_bot_progress', Path(__file__).with_name('bot_progress.py'))
bot_progress = _gallery_import.module_from_spec(_progress_spec)
_progress_spec.loader.exec_module(bot_progress)
portable = gallery.portable  # shared cross-platform helpers (dashboard/portable.py)

ACTIONS = {'start', 'stop', 'setMuted', 'chat', 'transcript', 'reply', 'bots', 'hidePet', 'botChat', 'botDismiss'}
MAX_REPLY = 500
MAX_BODY = 16384
LEASE_SECONDS = 8

def clean_label(value):
    """Same rule as petBotLabel in desktop/plugin.js: odd spaces become one space, other invisible
    or control characters go except the ZWJ and VS16 that join emoji; 40 code points at most."""
    import unicodedata
    if not isinstance(value, str):
        return ''
    text = ''.join(' ' if unicodedata.category(ch) == 'Zs' else ch for ch in value)
    text = ''.join(ch for ch in text if ch in '\u200d\ufe0f' or unicodedata.category(ch)[0] != 'C' and unicodedata.category(ch) not in ('Zl', 'Zp'))
    return re.sub(' +', ' ', text).strip(' ')[:40].strip(' ')

def main_sheet(data):
    """{'sprite': data URI} for a plausible pet sheet, from its header only; else None."""
    if not isinstance(data, (bytes, bytearray)) or not 0 < len(data) <= gallery.MAX_SHEET_BYTES:
        return None
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        mime = 'image/png'
    elif data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        mime = 'image/webp'
    else:
        return None
    try:
        import io
        from PIL import Image
    except ImportError:  # the view measures the grid itself; Pillow only adds an early check
        Image = None
    if Image is None:
        return {'sprite': 'data:' + mime + ';base64,' + base64.b64encode(bytes(data)).decode('ascii')}
    try:
        with Image.open(io.BytesIO(data)) as image:  # lazy: reads the header, not the pixels
            width, height = image.size
    except Exception:
        return None
    if width % gallery.FRAME_W or height % gallery.FRAME_H or not 1 <= width // gallery.FRAME_W <= gallery.MAX_COLUMNS \
            or not gallery.STATE_ROWS <= height // gallery.FRAME_H <= gallery.MAX_ROWS:
        return None
    return {'sprite': 'data:' + mime + ';base64,' + base64.b64encode(bytes(data)).decode('ascii')}


class Broker:
    def __init__(self, root, clock=time.monotonic):
        self.root = Path(root)
        self.clock = clock
        self.lock = threading.RLock()
        self.owner = None
        self.state = None
        self.pending = collections.OrderedDict()
        self.done = collections.OrderedDict()
        self.child = None
        self.server = None
        self.file_lock = None
        self.view_token = None
        self.ready = threading.Event()
        self.closed = threading.Event()
        atexit.register(self.close)

    def fail(self, code, message):
        raise HTTPException(code, message)

    def profiles_root(self):
        return portable.hermes_root() / 'profiles'

    def profile_dir(self, name):
        if not isinstance(name, str) or name == 'default' or not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', name):
            self.fail(400, 'Invalid bot identity')
        profiles = self.profiles_root()
        path = profiles / name
        if profiles.is_symlink() or path.is_symlink() or not path.is_dir() or path.resolve().parent != profiles.resolve():
            self.fail(400, 'Unknown bot profile')
        return path

    def sanitize_bots(self, bots):
        if not isinstance(bots, list) or len(bots) > 12:
            self.fail(400, 'Invalid bot roster')
        result, seen = [], set()
        for bot in bots:
            if not isinstance(bot, dict) or set(bot) - {'id','label','status','chat','attention'}:
                self.fail(400, 'Invalid bot fields')
            name = bot.get('id')
            self.profile_dir(name)
            if name in seen:
                self.fail(400, 'Duplicate bot identity')
            seen.add(name)
            if bot.get('status') not in ('','Working','Finished','Error') or type(bot.get('chat')) is not bool:
                self.fail(400, 'Invalid bot presentation')
            # One odd name must not reject the whole presentation (the lease would expire).
            clean = {'id':name, 'label':clean_label(bot.get('label')) or name, 'status':bot['status'], 'chat':bot['chat']}
            if 'attention' in bot:
                attention = bot['attention']
                if not isinstance(attention, dict) or set(attention) != {'kind','count'} or attention.get('kind') not in ('approval','clarify','sudo') or type(attention.get('count')) is not int or not 1 <= attention['count'] <= 16:
                    self.fail(400, 'Invalid bot attention')
                clean['attention'] = attention.copy()
            result.append(clean)
        return result

    def bot_avatar(self, name):
        """Bounded regular avatar image below the profile, never through a symlink."""
        try:
            self.profile_dir(name)
        except HTTPException:
            return None
        for extension in ('png','webp','jpg'):
            try:
                fd = portable.open_below(self.profiles_root(), (name, 'assets', 'avatar.' + extension))
            except OSError:
                continue
            try:
                with os.fdopen(fd, 'rb') as stream:
                    info = os.fstat(stream.fileno())
                    if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= 1048576:
                        continue
                    data = stream.read(1048577)
            except OSError:
                continue
            if len(data) > 1048576:
                continue
            mime = ('image/png' if extension == 'png' and data.startswith(b'\x89PNG\r\n\x1a\n') else
                    'image/webp' if extension == 'webp' and data[:4] == b'RIFF' and data[8:12] == b'WEBP' else
                    'image/jpeg' if extension == 'jpg' and data.startswith(b'\xff\xd8\xff') else None)
            if mime:
                return 'data:' + mime + ';base64,' + base64.b64encode(data).decode('ascii')
        return None

    def expire(self):
        if self.owner and self.clock() - self.owner['pulse'] > LEASE_SECONDS:
            self.close()

    def claim(self, data):
        with self.lock:
            self.expire()
            if self.owner:
                self.fail(409, 'Companion already has an owner')
            if data.get('connection') != 'local' or not isinstance(data.get('profile'), str) or not data['profile'] or len(data['profile']) > 64:
                self.fail(403, 'Companion requires a verified local owner route')
            self.closed.clear()
            self.owner = {'token': secrets.token_urlsafe(32), 'generation': secrets.token_urlsafe(18), 'profile': data['profile'], 'connection': 'local', 'pulse': self.clock()}
            return {key:self.owner[key] for key in ('token','generation')}

    def authenticate(self, data):
        self.expire()
        if not self.owner or not secrets.compare_digest(str(data.get('token','')), self.owner['token']):
            self.fail(401, 'Owner unavailable')
        if data.get('generation') != self.owner['generation']:
            self.fail(409, 'Stale owner generation')

    def sanitize(self, state):
        if not isinstance(state, dict) or set(state) - {'descriptor','lifecycle','status','muted','bands','capabilities','theme','owner','narration','attention','bots','botsEnabled','petVisible','petSize','botSize','botReset'}:
            self.fail(400, 'Unsupported presentation field')
        life = state.get('lifecycle')
        if life not in {'idle','connecting','connected','error'}:
            self.fail(400, 'Invalid lifecycle')
        status = state.get('status','')
        if status not in {'','Sending','Working','Finished','Error'}:
            self.fail(400, 'Unrecognized status')
        bands = state.get('bands', [])
        caps = state.get('capabilities', [])
        if not isinstance(bands,list) or len(bands)>6 or any(type(n) not in (int,float) or not math.isfinite(n) or not 0 <= n <= 1 for n in bands):
            self.fail(400, 'Invalid waveform')
        if not isinstance(caps,list) or any(c not in ACTIONS for c in caps) or type(state.get('muted')) is not bool:
            self.fail(400, 'Invalid controls')
        result = {'lifecycle':life,'status':status,'bands':bands,'capabilities':caps,'muted':state['muted']}
        for key in ('botsEnabled', 'petVisible'):
            if key in state:
                if type(state[key]) is not bool:
                    self.fail(400, 'Invalid visibility toggle')
                result[key] = state[key]
        # Pets panel sizes in percent (100 = the default look) and the bot-position reset counter.
        for key, low, high in (('petSize', 50, 200), ('botSize', 50, 200), ('botReset', 0, 2**31 - 1)):
            if key in state:
                if type(state[key]) is not int or not low <= state[key] <= high:
                    self.fail(400, 'Invalid pet size')
                result[key] = state[key]
        if 'bots' in state:
            result['bots'] = self.sanitize_bots(state['bots'])
        narration = state.get('narration')
        if narration is not None:
            if not isinstance(narration,dict) or set(narration)-{'text','tone','until'} or not isinstance(narration.get('text'),str) or len(narration['text'])>120 or narration.get('tone') not in {'info','wait','error'} or type(narration.get('until')) not in (int,float) or not math.isfinite(narration['until']):
                self.fail(400, 'Invalid narration')
            result['narration'] = {'text':''.join(ch for ch in narration['text'] if ch.isprintable()),'tone':narration['tone'],'until':narration['until']}
        # Hermes is blocked on the user (approval / clarify / sudo): kind and count only, never prompt text.
        attention = state.get('attention')
        if attention is not None:
            if not isinstance(attention,dict) or set(attention)-{'kind','count'} or attention.get('kind') not in {'approval','clarify','sudo'} or type(attention.get('count')) is not int or not 1 <= attention['count'] <= 16:
                self.fail(400, 'Invalid attention')
            result['attention'] = {'kind':attention['kind'],'count':attention['count']}
        # Descriptor originates from plugin source, not arbitrary transported markup.
        descriptor = state.get('descriptor')
        if descriptor is not None:
            if not isinstance(descriptor,dict) or len(json.dumps(descriptor)) > 4096:
                self.fail(400, 'Invalid descriptor')
            if set(descriptor)-{'version','anchor','gap','controlGap','surface','ink','controls','statusBox'} or descriptor.get('version')!=1 or descriptor.get('anchor')!='visible-art' or descriptor.get('surface')!='popover' or descriptor.get('ink')!='foreground':
                self.fail(400, 'Unsafe descriptor schema')
            def number(value, low, high):
                return type(value) in (int,float) and math.isfinite(value) and low <= value <= high
            if not number(descriptor.get('gap'),0,40) or not number(descriptor.get('controlGap'),0,40):
                self.fail(400, 'Invalid descriptor spacing')
            controls=descriptor.get('controls')
            if not isinstance(controls,list) or len(controls)!=4:
                self.fail(400, 'Invalid descriptor controls')
            for control in controls:
                if not isinstance(control,dict) or set(control)-{'action','icon','label','size','column','row','feedback'} or control.get('action') not in ACTIONS or control.get('icon') not in {'stop','microphone','microphone-off','chat','transcript','bots'} or control.get('label') not in {'start','stop','mute','unmute','chat','transcript','bots'} or not number(control.get('size'),20,48) or control.get('column') not in (0,1) or control.get('row') not in (0,1) or control.get('feedback','') not in {'','voice','mute'}:
                    self.fail(400, 'Unsafe control schema')
            box=descriptor.get('statusBox')
            keys={'width','fontSize','lineHeight','radius','paddingX','paddingY','border'}
            if not isinstance(box,dict) or set(box)!=keys or any(not number(v,.1,400) for v in box.values()):
                self.fail(400, 'Invalid status box')
            result['descriptor'] = descriptor
        theme = state.get('theme',{})
        if not isinstance(theme,dict) or set(theme)-{'surface','ink','border','accent'}:
            self.fail(400, 'Invalid theme')
        import re
        if any(not isinstance(v,str) or len(v)>80 or not re.fullmatch(r'#[a-fA-F0-9]{3,8}|rgba?\([0-9.,% ]+\)',v) for v in theme.values()):
            self.fail(400, 'Invalid theme color')
        result['theme'] = theme
        target = state.get('owner')
        if target:
            if not isinstance(target,dict) or set(target)-{'runtimeId','storedId','profile','connection'} or any(not isinstance(v,str) or len(v)>200 for v in target.values()):
                self.fail(400, 'Invalid chat owner')
            if target.get('connection') != 'local' or target.get('profile') != self.owner['profile']:
                self.fail(409, 'Owner route changed')
            result['owner'] = target
        return result

    def pulse(self, data):
        with self.lock:
            self.authenticate(data)
            self.state = self.sanitize(data.get('state'))
            self.owner['pulse'] = self.clock()
            # Delivery repeats until acknowledged. Desktop additionally deduplicates
            # pending IDs before dispatch, so transport retry never toggles twice.
            for rid, entry in list(self.pending.items()):
                if self.clock()-entry['time'] > 15:
                    self.complete(rid, {'ok':False,'error':'Command timed out'})
            for ack in data.get('acks',[])[:32]:
                if not isinstance(ack,dict) or set(ack)-{'id','ok','error'} or type(ack.get('ok')) is not bool:
                    self.fail(400, 'Invalid acknowledgement')
                if ack.get('id') in self.pending:
                    self.complete(ack['id'], {'ok':ack['ok'],'error':str(ack.get('error',''))[:100]})
            return {'generation':self.owner['generation'], 'commands':[e['command'] for e in self.pending.values()], 'helper':bool(self.child and self.child.poll() is None)}

    def complete(self, rid, ack):
        self.pending.pop(rid,None)
        self.done[rid] = ack
        while len(self.done)>256:
            self.done.popitem(last=False)

    def command(self, data):
        with self.lock:
            self.expire()
            if not self.owner or not self.state:
                self.fail(410,'Voice owner disconnected')
            if set(data)-{'id','generation','action','muted','text','bot'}:
                self.fail(400,'Unknown command field')
            bot_action = data.get('action') in {'botChat','botDismiss'}
            if bot_action:
                bot = next((b for b in self.state.get('bots',[]) if b['id'] == data.get('bot')), None)
                if not bot or (data['action'] == 'botChat' and not bot['chat']):
                    self.fail(409, 'Bot action unavailable')
                self.profile_dir(bot['id'])
            elif 'bot' in data:
                self.fail(400, 'Unexpected bot identity')
            if data.get('action') == 'reply':
                if not isinstance(data.get('text'),str) or not 1<=len(data['text'].strip())<=MAX_REPLY:
                    self.fail(400,'Reply text required')
            elif 'text' in data:
                self.fail(400,'Unknown command field')
            rid = data.get('id')
            if not isinstance(rid,str) or not 8<=len(rid)<=80:
                self.fail(400,'Invalid request ID')
            if data.get('generation') != self.owner['generation']:
                self.fail(409,'Stale owner generation')
            if data.get('action') not in ACTIONS:
                self.fail(400,'Unknown action')
            if data.get('action') == 'setMuted' and type(data.get('muted')) is not bool:
                self.fail(400,'Desired mute state required')
            if rid in self.done:
                self.done.move_to_end(rid)
                return {'duplicate':True, **self.done[rid]}
            if rid in self.pending:
                return {'pending':True}
            if not bot_action and data['action'] not in self.state['capabilities']:
                self.fail(409,'Action unavailable')
            if len(self.pending)>=32:
                self.fail(429,'Too many pending commands')
            self.pending[rid] = {'time':self.clock(),'command':data.copy()}
            return {'pending':True}

    def gallery(self):
        """Automatic avatar -> Petdex sheet resolver (thumb cache + one background download)."""
        home = self.profiles_root().parent
        if getattr(self, '_gallery', None) is None or self._gallery.home != home:
            self._gallery = gallery.GalleryResolver(home, self.root / 'data' / 'gallery-sprites',
                                                    spawn=getattr(self, 'gallery_spawn', None))
        return self._gallery

    def pet_source(self, avatar):
        """(report text, pet) for one avatar: private local sheet, gallery sheet, or static."""
        if not avatar:
            return 'no avatar', None
        pet = self.local_pet(avatar)
        if pet:
            return 'animated (local sprite)', pet
        status, slug, pet = self.gallery().resolve(avatar)
        return {'animated': 'animated (' + slug + ')', 'loading': 'checking sheet (' + slug + ')',
                'downloading': 'downloading sheet (' + slug + ')',
                'failed': 'sheet download failed (' + slug + ')', 'indexing': 'indexing gallery thumbnails',
                'no-avatar': 'avatar unreadable', 'no-match': 'no gallery match'}.get(status, status), pet

    def bot_pet(self, avatar):
        return self.pet_source(avatar)[1]

    def local_pet(self, avatar):
        """Sheet from the plugin's private ``data/local-sprites`` folder (never shipped).

        Any sheet there animates the bot whose avatar equals its first frame. The
        folder listing is stat-cached so the 200 ms helper poll never re-decodes.
        """
        folder = self.root / 'data' / 'local-sprites'
        try:
            info = os.lstat(folder)
            if not stat.S_ISDIR(info.st_mode):
                return None
            entries = sorted((e.name, e.stat(follow_symlinks=False)) for e in os.scandir(folder))
            stamp = (info.st_ino, info.st_mtime_ns, tuple((n, i.st_ino, i.st_size, i.st_mtime_ns) for n, i in entries))
        except OSError:
            return None
        if getattr(self, '_local_stamp', None) != stamp:
            self._local_stamp, self._local_cache = stamp, {}
        if avatar not in self._local_cache:
            if len(self._local_cache) >= 32:
                self._local_cache.clear()
            pixels = gallery._avatar_pixels(avatar)
            self._local_cache[avatar] = gallery.local_sheet(folder, pixels) if pixels else None
        return self._local_cache[avatar]

    def owner_home(self):
        """Hermes home of the owner's profile: the root for default, else profiles/<name>."""
        profile = (self.owner or {}).get('profile') or 'default'
        root = self.profiles_root().parent
        if profile == 'default':
            return root
        try:
            return self.profile_dir(profile)
        except HTTPException:
            return None

    def main_pet(self):
        """The pet the user selected in Hermes, for the pop-out (re-checked every ~2 s).

        Only the file is validated here (bounded regular WebP/PNG on the 192x208
        grid, header-only); the view measures frames itself, so the poll thread
        never decodes the multi-MB sheet.
        """
        now = self.clock()
        cached = getattr(self, '_main_pet', None)
        if cached and now - cached[0] < 2.0:
            return cached[1]
        pet, home = None, self.owner_home()
        slug, where = gallery.active_pet_source(home) if home else (None, None)
        if where:
            try:
                info = os.lstat(where[0].joinpath(*where[1]))
                key = (str(where[0]), where[1], info.st_ino, info.st_size, info.st_mtime_ns)
            except OSError:
                key = None
            previous = getattr(self, '_main_sheet', None)
            if key and previous and previous[0] == key:
                pet = previous[1]
            elif key:
                pet = main_sheet(gallery._read_regular(where[0], where[1], gallery.MAX_SHEET_BYTES))
                self._main_sheet = (key, pet)
            if pet:
                pet = {**pet, 'slug': slug}
        self._main_pet = (now, pet)
        return pet

    def progress(self, names):
        """Backend-observed progress per bot: Kanban cards plus live step files (cached ~2 s)."""
        home = self.profiles_root().parent
        if getattr(self, '_progress', None) is None or getattr(self._progress, 'root', None) != home:
            self._progress = bot_progress.BotProgress(home, self.root / 'data' / 'progress', ttl=2.0)
        try:
            return self._progress.for_bots(names)
        except Exception:
            return {}  # progress is cosmetic; never lose the pet state over it

    def helper_state(self):
        state = dict(self.state or {})
        bots = []
        progress = self.progress([bot['id'] for bot in state.get('bots', [])]) if state.get('bots') else {}
        def by_id(pet):
            # The multi-MB sheet is fetched once per id via /sprite, not every 200 ms poll.
            return {**{key: value for key, value in pet.items() if key != 'sprite'}, 'spriteId': self.remember_image(pet['sprite'])}
        main = self.main_pet()
        if main:
            state['pet'] = by_id(main)
        for bot in state.get('bots', []):
            avatar = self.bot_avatar(bot['id'])
            pet = self.bot_pet(avatar)
            if pet:
                pet = by_id(pet)
            shown = progress.get(bot['id'])
            bots.append({**bot, 'avatar':avatar, **({'pet':pet} if pet else {}), **({'progress':shown} if shown else {})})
        state['bots'] = bots
        return {'generation': self.owner['generation'], 'state': state, 'acks': dict(self.done)}

    def remember_image(self, data):
        """Cache a data-URI image (sheet or avatar) and return its id; fetched once per id."""
        images = getattr(self, '_sprites', None)
        if images is None:
            images = self._sprites = collections.OrderedDict()
        ident = hashlib.sha256(data.encode('ascii')).hexdigest()
        images[ident] = data
        images.move_to_end(ident)
        while len(images) > 48:
            images.popitem(last=False)
        return ident

    def inapp_bots(self, names):
        """Per-bot feed for bot pets drawn inside the Hermes window (no pop-out lease).

        Images travel by id ({'avatarId', 'pet': {'spriteId', ...}}); the renderer
        fetches each new id once from /companion/image.
        """
        if not isinstance(names, list) or len(names) > 12 or len(set(map(str, names))) != len(names):
            self.fail(400, 'Invalid bot roster')
        with self.lock:
            for name in names:
                self.profile_dir(name)
            progress = self.progress(names) if names else {}
            result = {}
            for name in names:
                avatar = self.bot_avatar(name)
                pet = self.bot_pet(avatar)
                entry = {}
                if avatar:
                    entry['avatarId'] = self.remember_image(avatar)
                if pet:
                    entry['pet'] = {**{k: v for k, v in pet.items() if k != 'sprite'}, 'spriteId': self.remember_image(pet['sprite'])}
                if progress.get(name):
                    entry['progress'] = progress[name]
                result[name] = entry
            return result

    @staticmethod
    def capabilities():
        """Whether this backend can open the plugin's own desktop pet windows."""
        if not sys.platform.startswith('linux'):
            return {'desktopWindows': False, 'platform': sys.platform, 'reason': 'Desktop pet windows are Linux-only for now'}
        if not os.environ.get('WAYLAND_DISPLAY'):
            return {'desktopWindows': False, 'platform': sys.platform, 'reason': 'Desktop pet windows need a Wayland layer-shell compositor'}
        if not os.path.exists('/usr/bin/python'):
            return {'desktopWindows': False, 'platform': sys.platform, 'reason': 'Desktop pet windows need the system Python with GTK'}
        return {'desktopWindows': True, 'platform': sys.platform, 'reason': ''}

    def sprite_data(self, data):
        if not isinstance(data, dict) or set(data) != {'id'} or not isinstance(data['id'], str) or not re.fullmatch(r'[0-9a-f]{64}', data['id']):
            self.fail(400, 'Invalid sprite request')
        sprite = (getattr(self, '_sprites', None) or {}).get(data['id'])
        if not sprite:
            self.fail(404, 'Unknown sprite')
        return {'sprite': sprite}

    def sprite_report(self, names=None):
        """Why each bot pet is animated or static; profile names only, no image data."""
        if names is None:
            names = [bot['id'] for bot in (self.state or {}).get('bots', [])]
        if not isinstance(names, list) or len(names) > 12:
            self.fail(400, 'Invalid bot roster')
        report = {}
        with self.lock:  # shares the pet caches with the helper's poll thread
            for name in names:
                self.profile_dir(name)
                report[name] = self.pet_source(self.bot_avatar(name))[0]
        return report

    def runtime(self):
        if not sys.platform.startswith('linux'):
            self.fail(503,'Desktop pop-out windows are Linux-only for now; shift-click the pet for Hermes\' own pop-out')
        if not os.environ.get('WAYLAND_DISPLAY'):
            self.fail(503,'The pop-out pet currently requires Linux Wayland layer-shell')
        allowed={'HOME','USER','LOGNAME','LANG','LC_ALL','DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','XDG_SESSION_TYPE','XAUTHORITY','GDK_SCALE','GDK_DPI_SCALE','GTK_THEME','XDG_DATA_DIRS','XDG_CONFIG_HOME','XDG_CACHE_HOME','HYPRLAND_INSTANCE_SIGNATURE'}
        env={k:v for k,v in os.environ.items() if k in allowed}
        env.update({'PATH':'/usr/bin:/bin','GDK_BACKEND':'wayland'})
        try:
            check = subprocess.run(['/usr/bin/python',str(self.root/'companion'/'native_helper.py'),'--check'],env=env,capture_output=True,text=True,timeout=10)
        except (OSError,subprocess.TimeoutExpired):
            self.fail(503,'The pop-out pet requires system Python and the GTK runtime')
        if check.returncode:
            self.fail(503,'Missing native runtime: python-gobject, gtk3, webkit2gtk-4.1, gtk-layer-shell')
        return env

    def launch(self, data):
        with self.lock:
            self.authenticate(data)
            if self.child and self.child.poll() is None:
                return {'running':True,'singleton':True}
            if not self.state:
                self.fail(409,'Owner has not published presentation')
            env = self.runtime()
            path = self.root/'data'/'companion.lock'
            path.parent.mkdir(exist_ok=True)
            fd = path.open('a')
            try:
                portable.try_lock(fd)
            except BlockingIOError:
                fd.close(); self.fail(409,'Another local plugin process owns the pop-out pet')
            self.file_lock = fd
            self.view_token = secrets.token_urlsafe(32)
            broker = self
            class Handler(BaseHTTPRequestHandler):
                def log_message(self,*args): pass
                def do_POST(self):
                    try:
                        if self.headers.get('Origin') is not None:
                            broker.fail(403,'Browser origins are not permitted')
                        if self.headers.get('Host') != f'127.0.0.1:{self.server.server_port}':
                            broker.fail(403,'Invalid host')
                        if not secrets.compare_digest(self.headers.get('Authorization',''), 'Bearer '+str(broker.view_token)):
                            broker.fail(401,'Helper authentication required')
                        size = int(self.headers.get('Content-Length','0'))
                        if not 0<size<=MAX_BODY:
                            broker.fail(413,'Invalid body length')
                        payload=json.loads(self.rfile.read(size))
                        if self.path=='/ready':
                            broker.ready.set();output={'ready':True}
                        elif self.path=='/state':
                            with broker.lock:
                                broker.expire()
                                if not broker.owner: broker.fail(410,'Owner disconnected')
                                output=broker.helper_state()
                        elif self.path=='/sprite':
                            with broker.lock: output=broker.sprite_data(payload)
                        elif self.path=='/command': output=broker.command(payload)
                        else: broker.fail(404,'Unknown helper endpoint')
                        body=json.dumps(output).encode();self.send_response(200)
                    except HTTPException as e:
                        body=json.dumps({'error':str(e.detail)}).encode();self.send_response(e.status_code)
                    except (ValueError,TypeError):
                        body=b'{"error":"Invalid request"}';self.send_response(400)
                    try:
                        self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(body)
                    except (BrokenPipeError,ConnectionResetError):
                        pass  # helper may close while a poll is in flight
            try:
                self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
                self.server.daemon_threads=True
                threading.Thread(target=self.server.serve_forever,daemon=True).start()
                self.ready.clear()
                self.child=subprocess.Popen(['/usr/bin/python',str(self.root/'companion'/'native_helper.py')],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env=env,start_new_session=True)
                bootstrap={'url':f'http://127.0.0.1:{self.server.server_port}','token':self.view_token,'root':str(self.root)}
                self.child.stdin.write((json.dumps(bootstrap)+'\n').encode());self.child.stdin.close()
                if not self.ready.wait(5) or self.child.poll() is not None:
                    self.fail(503,'The pop-out pet failed to initialize its view')
                self.owner['pulse']=self.clock()
                threading.Thread(target=self.watch,args=(self.owner['generation'],),daemon=True).start()
                return {'running':True,'ready':True,'runtime':'GTK3/WebKit2/native Wayland'}
            except Exception:
                self.close();raise

    def watch(self, generation):
        while not self.closed.wait(1):
            with self.lock:
                if not self.owner or self.owner['generation']!=generation:
                    return
                self.expire()
                if self.child and self.child.poll() is not None:
                    self.close();return

    def close(self):
        with self.lock:
            self.closed.set()
            self.owner=None;self.state=None;self.pending.clear();self.done.clear();self.view_token=None
            child,self.child=self.child,None
            if child and child.poll() is None:
                child.terminate()
                try: child.wait(timeout=2)
                except subprocess.TimeoutExpired: child.kill();child.wait(timeout=2)
            server,self.server=self.server,None
            if server:
                # shutdown may wait on a handler acquiring this lock.
                threading.Thread(target=lambda:(server.shutdown(),server.server_close()),daemon=True).start()
            if self.file_lock:
                self.file_lock.close();self.file_lock=None


def make_router(broker):
    router=APIRouter()
    async def body(request):
        try:
            if not request.client or not ipaddress.ip_address(request.client.host).is_loopback:
                broker.fail(403,'The pop-out pet can only launch on the local backend')
        except ValueError: broker.fail(403,'Local peer required')
        if request.headers.get('origin'):
            broker.fail(403,'Owner API requires the native Hermes REST transport')
        raw=await request.body()
        if len(raw)>MAX_BODY: broker.fail(413,'Presentation too large')
        try:
            data=json.loads(raw)
            if not isinstance(data,dict): raise ValueError()
            return data
        except ValueError: broker.fail(400,'Invalid JSON object')
    @router.post('/companion/claim')
    async def claim(request:Request): return broker.claim(await body(request))
    @router.post('/companion/pulse')
    async def pulse(request:Request): return broker.pulse(await body(request))
    @router.post('/companion/launch')
    async def launch(request:Request):
        import asyncio
        return await asyncio.to_thread(broker.launch, await body(request))
    @router.post('/companion/sprites')
    async def sprites(request:Request):
        # Diagnostic text only (profile names and gallery slugs); works without a pop-out lease
        # so the palette check runs while bot pets are off.
        import asyncio
        data=await body(request)
        return {'bots': await asyncio.to_thread(broker.sprite_report, data.get('bots'))}
    @router.post('/companion/capabilities')
    async def capabilities(request:Request):
        await body(request)
        return broker.capabilities()
    @router.post('/companion/bots')
    async def inapp_bots(request:Request):
        # Bot pets inside the Hermes window: same data the desktop helper gets, no lease needed.
        import asyncio
        data=await body(request)
        return {'bots': await asyncio.to_thread(broker.inapp_bots, data.get('bots'))}
    @router.post('/companion/image')
    async def image(request:Request):
        data=await body(request)
        with broker.lock:
            return {'data': broker.sprite_data(data)['sprite']}
    @router.post('/companion/release')
    async def release(request:Request):
        data=await body(request)
        with broker.lock:
            broker.authenticate(data);broker.close()
        return {'released':True}
    return router
