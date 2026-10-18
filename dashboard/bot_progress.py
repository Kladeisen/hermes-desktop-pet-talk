"""What each bot pet should show: Kanban cards (feed A) plus live step files (feed B).

Feed A reads the Kanban board(s) read-only: a card's assignee is the bot's profile name,
so every bot is covered with no per-profile install, including Kanban workers that run
in their own processes. Feed B reads the small per-session step files written by the
``talk-desktop-alerts`` hooks plugin (thinking / which tool / done).

Output per bot: ``{row, title, detail, since, tone}``. ``row`` is the Petdex state row
(0 idle, 3 waving, 5 failed, 6 waiting, 7 running, 8 review), ``title`` the first bubble
line (card title, or empty), ``detail`` the second (current step / note / summary),
``since`` an epoch start for an elapsed timer (or None) and ``tone`` info / wait / error.
After a finished turn the bot reports an explicit idle (row 0, empty text) for
``IDLE_SHOW_S`` so the renderer's coarse "worked recently" guess cannot make it look
busy again. Only card titles,
progress notes, block reasons, summary first sentences and tool names leave this module,
sanitized and capped at 60 characters.
"""
import json
import os
import re
import sqlite3
import stat
import time
import unicodedata
from pathlib import Path


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

TEXT_MAX = 60
DONE_SHOW_S = 30          # completed card / finished turn stays visible this long
IDLE_SHOW_S = 180         # then an explicit idle outranks the renderer's 150 s 'worked recently' guess
STALL_S = 300             # model wait without a reply flagged after 5 minutes
ACTIVE_MAX_AGE = {'thinking': 3600, 'tool': 7200, 'working': 600}
STEP_MAX_BYTES = 1024
PRUNE_EVERY_S = 60
PRUNE_DEAD_AFTER_S = 600
PRUNE_ANY_AFTER_S = 86400
STATES = {'thinking', 'tool', 'working', 'done', 'error', 'interrupted'}
TOOL = re.compile(r'[a-z0-9_.-]{1,40}')


def clip(text, limit=TEXT_MAX):
    """Plain, printable, single-line text: markdown marks and control/format chars removed."""
    text = str(text or '')
    text = text.replace('**', '').replace('__', '').replace('`', '')
    text = ''.join(ch if unicodedata.category(ch)[0] not in 'CZ' or ch == ' ' else ' ' for ch in text)
    text = re.sub(r'\s+', ' ', text).strip()
    text = re.sub(r'^[#>\s]+', '', text)
    return text if len(text) <= limit else text[:limit - 1].rstrip() + '…'


def first_sentence(text):
    text = re.sub(r'\s+', ' ', str(text or '')).strip()
    return re.split(r'(?<=[.!?])\s', text, maxsplit=1)[0]


def pid_alive(pid):
    return portable.pid_alive(pid)


class BotProgress:
    def __init__(self, root, folder, clock=time.time, alive=pid_alive, ttl=1.0, kanban_root=None):
        self.root = Path(root)
        self.kanban_root = Path(kanban_root or os.environ.get('HERMES_KANBAN_HOME') or root)
        self.folder = Path(folder)
        self.clock, self.alive, self.ttl = clock, alive, ttl
        self._cache = None
        self._pruned = None

    # ── feed A: Kanban ─────────────────────────────────────────────────
    def _boards(self):
        paths = [self.kanban_root / 'kanban.db']
        boards = self.kanban_root / 'kanban' / 'boards'
        try:
            paths += sorted(p / 'kanban.db' for p in boards.iterdir() if p.is_dir() and not p.is_symlink())
        except OSError:
            pass
        for path in paths:
            try:
                if stat.S_ISREG(os.lstat(path).st_mode):
                    yield path
            except OSError:
                continue

    def _cards(self, names, now):
        """{bot: {'blocked'|'running'|'done': card}} across every board."""
        found = {}
        marks = ','.join('?' * len(names))
        for path in self._boards():
            try:
                db = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=0.2)
            except sqlite3.Error:
                continue
            try:
                rows = db.execute(
                    f"select id, title, assignee, status, started_at, completed_at, current_run_id from tasks "
                    f"where assignee in ({marks}) and (status in ('running','blocked') or (status='done' and completed_at between ? and ?))",
                    (*names, int(now - IDLE_SHOW_S), int(now) + 1)).fetchall()
                for task, title, bot, status, started, completed, run in rows:
                    slot = found.setdefault(bot, {})
                    if status == 'running':
                        since = started
                        if run is not None:
                            row = db.execute('select started_at from task_runs where id=?', (run,)).fetchone()
                            since = row[0] if row and row[0] else started
                        query = "select payload from task_events where task_id=? and kind='heartbeat' and payload like '%\"note\"%'"
                        args = [task]
                        if run is not None:
                            query += ' and run_id=?'; args.append(run)
                        note = db.execute(query + ' order by id desc limit 1', args).fetchone()
                        card = {'title': title, 'since': since, 'note': self._field(note, 'note')}
                        if 'running' not in slot or (since or 0) > (slot['running']['since'] or 0):
                            slot['running'] = card
                    elif status == 'blocked':
                        event = db.execute("select payload, created_at from task_events where task_id=? and kind='blocked' "
                                           "order by id desc limit 1", (task,)).fetchone()
                        card = {'title': title, 'reason': self._field(event, 'reason'), 'since': event[1] if event else None}
                        if 'blocked' not in slot or (card['since'] or 0) > (slot['blocked']['since'] or 0):
                            slot['blocked'] = card
                    else:
                        summary = db.execute('select summary from task_runs where task_id=? order by id desc limit 1', (task,)).fetchone()
                        spawned = db.execute("select payload from task_events where task_id=? and kind='spawned' "
                                             "order by id desc limit 1", (task,)).fetchone()
                        try:
                            pid = json.loads(spawned[0]).get('pid') if spawned and spawned[0] else None
                        except (ValueError, TypeError, AttributeError):
                            pid = None
                        card = {'title': title, 'summary': summary[0] if summary and summary[0] else '', 'completed': completed,
                                'pid': pid if type(pid) is int else None, 'recent': now - (completed or 0) <= DONE_SHOW_S}
                        if 'done' not in slot or (completed or 0) > (slot['done']['completed'] or 0):
                            slot['done'] = card
            except sqlite3.Error:
                pass
            finally:
                db.close()
        return found

    @staticmethod
    def _field(row, key):
        try:
            value = json.loads(row[0]).get(key) if row and row[0] else ''
        except (ValueError, TypeError, AttributeError):
            value = ''
        return value if isinstance(value, str) else ''

    # ── feed B: live step files ────────────────────────────────────────
    def _steps(self, names, now):
        """{bot: [step, ...]} from valid step files; prunes dead/ancient files now and then."""
        wanted, found = set(names), {}
        prune = self._pruned is None or now - self._pruned >= PRUNE_EVERY_S
        try:
            entries = list(os.scandir(self.folder))
        except OSError:
            return found
        for entry in entries:
            if not entry.name.endswith('.json'):
                continue
            try:
                info = entry.stat(follow_symlinks=False)
                if not stat.S_ISREG(info.st_mode) or info.st_size > STEP_MAX_BYTES:
                    continue
                fd = portable.open_leaf(entry.path)
                with os.fdopen(fd, 'rb') as stream:
                    step = json.loads(stream.read(STEP_MAX_BYTES + 1))
            except (OSError, ValueError):
                continue
            if not isinstance(step, dict):
                continue
            pid, alive = step.get('pid'), None
            if prune and (now - info.st_mtime > PRUNE_ANY_AFTER_S or
                          (now - info.st_mtime > PRUNE_DEAD_AFTER_S and not (alive := self.alive(pid)))):
                try:
                    os.unlink(entry.path)
                except OSError:
                    pass
                continue
            since, tool, retries = step.get('since'), step.get('tool', ''), step.get('retries', 0)
            if (step.get('profile') not in wanted or step.get('state') not in STATES
                    or type(since) not in (int, float) or since != since or abs(since) > 1e11
                    or not isinstance(tool, str) or (tool and not TOOL.fullmatch(tool))
                    or type(retries) is not int or not 0 <= retries <= 1000):
                continue
            step['alive'] = alive
            found.setdefault(step['profile'], []).append(step)
        if prune:
            self._pruned = now
        return found

    def _live(self, steps, now):
        """The bot's current step: newest active session from a live writer, else a recent finish
        (``finished``), else an explicit idle shortly after one (``idle``)."""
        active = [s for s in steps if s['state'] in ACTIVE_MAX_AGE and now - s['since'] <= ACTIVE_MAX_AGE[s['state']]
                  and (s['alive'] if s['alive'] is not None else self.alive(s.get('pid')))]
        if active:
            step = max(active, key=lambda s: s['since'])
            if step['state'] == 'thinking' and now - step['since'] >= STALL_S:
                retries = step['retries']
                detail = 'No reply from model' + (f' ({retries} retr{"y" if retries == 1 else "ies"})' if retries else '')
                return {'row': 6, 'detail': detail, 'since': step['since'], 'tone': 'wait', 'pid': step.get('pid')}
            row, detail = {'thinking': (8, 'Thinking'), 'tool': (7, step['tool'] or 'tool'), 'working': (7, 'Working')}[step['state']]
            return {'row': row, 'detail': detail, 'since': step['since'], 'tone': 'info', 'pid': step.get('pid')}
        finished = [s for s in steps if s['state'] not in ACTIVE_MAX_AGE and now - s['since'] <= DONE_SHOW_S]
        if finished:
            step = max(finished, key=lambda s: s['since'])
            row, detail, tone = {'done': (3, 'Done', 'info'), 'error': (5, 'Error', 'error'),
                                 'interrupted': (0, 'Stopped', 'info')}[step['state']]
            return {'row': row, 'detail': detail, 'since': None, 'tone': tone, 'finished': True}
        if any(s['state'] not in ACTIVE_MAX_AGE and now - s['since'] <= IDLE_SHOW_S for s in steps):
            return {'row': 0, 'detail': '', 'since': None, 'tone': 'info', 'idle': True}
        return None

    # ── combined ───────────────────────────────────────────────────────
    def for_bots(self, names):
        names = tuple(sorted({n for n in names if isinstance(n, str) and n}))
        now = self.clock()
        if self._cache and self._cache[0] == names and now - self._cache[1] < self.ttl:
            return self._cache[2]
        result = {}
        if names:
            cards, steps = self._cards(names, now), self._steps(names, now)
            for name in names:
                bot_cards, bot_steps = cards.get(name, {}), steps.get(name, [])
                done = bot_cards.get('done')
                if done and done['pid'] is not None and 'running' not in bot_cards:
                    # The worker that just completed a card makes one more model call; that is not new work.
                    # Its finished step is kept: it is what turns the pet idle after the Done wave.
                    bot_steps = [s for s in bot_steps if s.get('pid') != done['pid'] or s['state'] not in ACTIVE_MAX_AGE]
                shown = self._combine(bot_cards, self._live(bot_steps, now))
                if shown:
                    result[name] = shown
        self._cache = (names, now, result)
        return result

    @staticmethod
    def _combine(cards, live):
        working = live if live and not live.get('finished') and not live.get('idle') else None
        if 'blocked' in cards:
            card = cards['blocked']
            return {'row': 6, 'title': 'Blocked: needs you', 'detail': clip(card['reason']),
                    'since': card['since'], 'tone': 'wait'}
        if 'running' in cards:
            card = cards['running']
            shown = {'row': 7, 'title': clip(card['title']), 'detail': clip(card['note']) or 'Working',
                     'since': card['since'], 'tone': 'info'}
            if working:
                shown['row'], shown['tone'] = working['row'], working['tone']
                if working['tone'] == 'wait' or not card['note']:
                    shown['detail'] = working['detail']
                if working['tone'] == 'wait':
                    shown['since'] = working['since']  # time the stall, not the whole card
            return shown
        done = cards.get('done')
        if working:
            return {'row': working['row'], 'title': '', 'detail': working['detail'], 'since': working['since'], 'tone': working['tone']}
        if done and done['recent']:
            return {'row': 3, 'title': clip('Done: ' + clip(done['title'], 200)), 'detail': clip(first_sentence(done['summary'])),
                    'since': None, 'tone': 'info'}
        if live and live.get('finished'):
            return {'row': live['row'], 'title': '', 'detail': live['detail'], 'since': None, 'tone': live['tone']}
        if live and live.get('idle'):
            # Only step evidence ends the renderer's busy guess: a done card alone cannot see
            # a new chat turn on the same bot.
            return {'row': 0, 'title': '', 'detail': '', 'since': None, 'tone': 'info'}
        return None
