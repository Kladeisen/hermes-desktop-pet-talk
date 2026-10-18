"""Bot pet progress: Kanban cards (feed A) plus live step files (feed B), per bot profile."""
import importlib.util
import json
import os
import sqlite3
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('bot_progress_under_test', ROOT/'dashboard/bot_progress.py')
progress = importlib.util.module_from_spec(spec)
spec.loader.exec_module(progress)

NOW = 10_000.0


def board(root, rows=(), events=(), runs=()):
    db = sqlite3.connect(root/'kanban.db')
    db.executescript('''
      create table tasks (id text primary key, title text, assignee text, status text, started_at integer,
        completed_at integer, current_run_id integer, result text, block_kind text);
      create table task_runs (id integer primary key, task_id text, profile text, started_at integer,
        ended_at integer, outcome text, summary text);
      create table task_events (id integer primary key autoincrement, task_id text, run_id integer,
        kind text, payload text, created_at integer);''')
    db.executemany('insert into tasks values (?,?,?,?,?,?,?,?,?)', rows)
    db.executemany('insert into task_runs values (?,?,?,?,?,?,?)', runs)
    db.executemany('insert into task_events (task_id,run_id,kind,payload,created_at) values (?,?,?,?,?)', events)
    db.commit(); db.close()


def step(root, name, **fields):
    folder = root/'plugins/talk-desktop/data/progress'; folder.mkdir(parents=True, exist_ok=True)
    data = {'v': 1, 'profile': 'alpha', 'state': 'tool', 'tool': '', 'since': NOW - 10, 'retries': 0, 'pid': 1, **fields}
    (folder/f'{name}.json').write_text(json.dumps(data))
    return folder/f'{name}.json'


def reader(root, alive=lambda pid: True, now=NOW):
    return progress.BotProgress(root, root/'plugins/talk-desktop/data/progress', clock=lambda: now, alive=alive, ttl=0)


def test_no_signals_means_no_progress(tmp_path):
    assert reader(tmp_path).for_bots(['alpha']) == {}


def test_running_card_shows_title_latest_note_and_run_start(tmp_path):
    board(tmp_path, rows=[('t_1', 'Broad review of the talk-desktop plugin', 'alpha', 'running', 9000, None, 7, None, None)],
          runs=[(7, 't_1', 'alpha', 9400, None, None, None)],
          events=[('t_1', 7, 'heartbeat', None, 9500), ('t_1', 7, 'heartbeat', json.dumps({'note': 'Running **isolated** JS suites'}), 9600),
                  ('t_1', 7, 'heartbeat', None, 9700)])
    p = reader(tmp_path).for_bots(['alpha', 'beta'])
    assert set(p) == {'alpha'}
    assert p['alpha'] == {'row': 7, 'title': 'Broad review of the talk-desktop plugin', 'detail': 'Running isolated JS suites', 'since': 9400, 'tone': 'info'}


def test_blocked_card_waits_for_the_user_and_outranks_live_steps(tmp_path):
    board(tmp_path, rows=[('t_2', 'Ship it', 'alpha', 'blocked', 9000, None, None, None, 'needs_input')],
          events=[('t_2', 3, 'blocked', json.dumps({'reason': 'Approve the release?\nIt touches prod.'}), 9900)])
    step(tmp_path, 'a', state='tool', tool='terminal')
    p = reader(tmp_path).for_bots(['alpha'])['alpha']
    assert (p['row'], p['title'], p['detail'], p['tone']) == (6, 'Blocked: needs you', 'Approve the release? It touches prod.', 'wait')


def test_recently_completed_card_waves_with_its_summary_then_clears(tmp_path):
    board(tmp_path, rows=[('t_3', 'Weather', 'alpha', 'done', 9000, NOW - 20, None, None, None)],
          runs=[(9, 't_3', 'alpha', 9000, NOW - 20, 'completed', 'Arendal: cloudy, 8.9°C. Light wind from WSW.')])
    p = reader(tmp_path).for_bots(['alpha'])['alpha']
    assert (p['row'], p['title'], p['detail']) == (3, 'Done: Weather', 'Arendal: cloudy, 8.9°C.')
    assert reader(tmp_path, now=NOW + 15).for_bots(['alpha']) == {}, 'no step evidence: leave the renderer status alone'


@pytest.mark.parametrize('state,tool,row,detail', [
    ('thinking', '', 8, 'Thinking'),
    ('tool', 'terminal', 7, 'terminal'),
    ('working', '', 7, 'Working'),
])
def test_live_steps_map_to_main_pet_poses(tmp_path, state, tool, row, detail):
    step(tmp_path, 'a', state=state, tool=tool)
    p = reader(tmp_path).for_bots(['alpha'])['alpha']
    assert (p['row'], p['detail'], p['since'], p['title']) == (row, detail, NOW - 10, '')


def test_live_step_inside_a_kanban_run_keeps_the_card_title(tmp_path):
    board(tmp_path, rows=[('t_1', 'Review', 'alpha', 'running', 9000, None, 7, None, None)], runs=[(7, 't_1', 'alpha', 9000, None, None, None)])
    step(tmp_path, 'a', state='tool', tool='read_file')
    p = reader(tmp_path).for_bots(['alpha'])['alpha']
    assert (p['title'], p['detail'], p['row']) == ('Review', 'read_file', 7)


def test_model_stall_is_flagged_after_five_minutes(tmp_path):
    step(tmp_path, 'a', state='thinking', since=NOW - 360, retries=2)
    p = reader(tmp_path).for_bots(['alpha'])['alpha']
    assert (p['row'], p['detail'], p['since'], p['tone']) == (6, 'No reply from model (2 retries)', NOW - 360, 'wait')


def test_finished_live_steps_show_briefly(tmp_path):
    for state, row, detail in (('done', 3, 'Done'), ('error', 5, 'Error'), ('interrupted', 0, 'Stopped')):
        step(tmp_path, 'a', state=state, since=NOW - 5)
        p = reader(tmp_path).for_bots(['alpha'])['alpha']
        assert (p['row'], p['detail'], p['since']) == (row, detail, None)
    step(tmp_path, 'a', state='done', since=NOW - 60)
    assert reader(tmp_path).for_bots(['alpha'])['alpha'] == {'row': 0, 'title': '', 'detail': '', 'since': None, 'tone': 'info'}
    step(tmp_path, 'a', state='done', since=NOW - 400)
    assert reader(tmp_path).for_bots(['alpha']) == {}


def test_most_recent_active_session_wins_and_dead_writers_are_ignored(tmp_path):
    step(tmp_path, 'old', state='tool', tool='terminal', since=NOW - 100, pid=11)
    step(tmp_path, 'new', state='thinking', since=NOW - 3, pid=12)
    step(tmp_path, 'dead', state='tool', tool='browser', since=NOW - 1, pid=13)
    p = reader(tmp_path, alive=lambda pid: pid != 13).for_bots(['alpha'])['alpha']
    assert p['detail'] == 'Thinking'


def test_files_for_other_profiles_and_malformed_files_are_ignored(tmp_path):
    step(tmp_path, 'x', profile='beta', state='tool', tool='terminal')
    folder = tmp_path/'plugins/talk-desktop/data/progress'
    (folder/'junk.json').write_text('{')
    (folder/'big.json').write_text(json.dumps({'profile': 'alpha', 'state': 'tool', 'pad': 'x' * 5000}))
    (folder/'bad.json').write_text(json.dumps({'profile': 'alpha', 'state': 'rm -rf', 'since': NOW, 'pid': 1}))
    target = tmp_path/'elsewhere.json'; target.write_text(json.dumps({'profile': 'alpha', 'state': 'tool', 'tool': 'x', 'since': NOW, 'pid': 1}))
    (folder/'link.json').symlink_to(target)
    assert reader(tmp_path).for_bots(['alpha']) == {}
    assert set(reader(tmp_path).for_bots(['beta'])) == {'beta'}


def test_stale_files_from_dead_processes_are_pruned(tmp_path):
    keep = step(tmp_path, 'keep', state='tool', since=NOW - 5, pid=1)
    gone = step(tmp_path, 'gone', state='done', since=NOW - 900, pid=2)
    os.utime(gone, (NOW - 900, NOW - 900))
    ancient = step(tmp_path, 'ancient', state='tool', since=NOW - 90000, pid=1)
    os.utime(ancient, (NOW - 90000, NOW - 90000))
    os.utime(keep, (NOW - 5, NOW - 5))
    reader(tmp_path, alive=lambda pid: pid == 1).for_bots(['alpha'])
    assert keep.exists() and not gone.exists() and not ancient.exists()


def test_text_is_sanitized_and_bounded(tmp_path):
    board(tmp_path, rows=[('t_1', '# ' + 'Very long title ' * 10 + '\x07', 'alpha', 'running', 9000, None, 7, None, None)],
          runs=[(7, 't_1', 'alpha', 9000, None, None, None)],
          events=[('t_1', 7, 'heartbeat', json.dumps({'note': '`code`\u200b ' * 30}), 9600)])
    p = reader(tmp_path).for_bots(['alpha'])['alpha']
    assert len(p['title']) <= 60 and len(p['detail']) <= 60
    assert p['title'].startswith('Very long title') and p['title'].endswith('…')
    assert all(ch.isprintable() for ch in p['title'] + p['detail']) and '`' not in p['detail'] and '#' not in p['title']


def test_named_boards_and_a_missing_or_locked_db_never_raise(tmp_path):
    named = tmp_path/'kanban/boards/work'; named.mkdir(parents=True)
    board(named, rows=[('t_9', 'Other board', 'alpha', 'running', 9000, None, None, None, None)])
    assert reader(tmp_path).for_bots(['alpha'])['alpha']['title'] == 'Other board'
    (tmp_path/'kanban.db').write_bytes(b'not sqlite')
    assert reader(tmp_path).for_bots(['alpha'])['alpha']['title'] == 'Other board'


def test_results_are_cached_between_polls(tmp_path, monkeypatch):
    board(tmp_path, rows=[('t_1', 'Review', 'alpha', 'running', 9000, None, None, None, None)])
    r = progress.BotProgress(tmp_path, tmp_path/'p', clock=lambda: NOW, alive=lambda pid: True, ttl=1.0)
    opened = []
    real = progress.sqlite3.connect
    monkeypatch.setattr(progress.sqlite3, 'connect', lambda *a, **k: (opened.append(1), real(*a, **k))[1])
    for _ in range(5): r.for_bots(['alpha'])
    assert len(opened) == 1


def test_completion_time_must_be_in_the_recent_past(tmp_path):
    board(tmp_path, rows=[('t_3', 'Weather', 'alpha', 'done', 9000, NOW + 600, None, None, None)])
    assert reader(tmp_path).for_bots(['alpha']) == {}


def test_stall_inside_a_kanban_run_times_the_stall_not_the_card(tmp_path):
    board(tmp_path, rows=[('t_1', 'Review', 'alpha', 'running', 1000, None, 7, None, None)], runs=[(7, 't_1', 'alpha', 1000, None, None, None)])
    step(tmp_path, 'a', state='thinking', since=NOW - 400, retries=3)
    p = reader(tmp_path).for_bots(['alpha'])['alpha']
    assert (p['title'], p['detail'], p['since'], p['tone']) == ('Review', 'No reply from model (3 retries)', NOW - 400, 'wait')


def test_done_card_outranks_the_bots_final_model_call(tmp_path):
    """After kanban_complete the worker makes one more model call; show Done, not Thinking."""
    board(tmp_path, rows=[('t_3', 'Riddle', 'alpha', 'done', 9000, NOW - 2, None, None, None)],
          runs=[(9, 't_3', 'alpha', 9000, NOW - 2, 'completed', 'Asked Codex a riddle. It is about pointers.')],
          events=[('t_3', 9, 'spawned', json.dumps({'pid': 1}), 9000)])
    step(tmp_path, 'a', state='thinking', since=NOW - 1, pid=1)
    p = reader(tmp_path).for_bots(['alpha'])['alpha']
    assert (p['row'], p['title'], p['detail'], p['since']) == (3, 'Done: Riddle', 'Asked Codex a riddle.', None)


def test_a_running_card_still_outranks_a_recent_done_card(tmp_path):
    board(tmp_path, rows=[('t_3', 'First', 'alpha', 'done', 9000, NOW - 5, None, None, None),
                          ('t_4', 'Second', 'alpha', 'running', NOW - 3, None, None, None, None)])
    assert reader(tmp_path).for_bots(['alpha'])['alpha']['title'] == 'Second'


def test_idle_after_a_finished_turn_lets_the_pet_stop_looking_busy(tmp_path):
    """The renderer's coarse 150 s 'Working' guess must not outlive an observed finish."""
    step(tmp_path, 'a', state='done', since=NOW - 90, pid=99)
    p = reader(tmp_path, alive=lambda pid: False).for_bots(['alpha'])['alpha']
    assert p == {'row': 0, 'title': '', 'detail': '', 'since': None, 'tone': 'info'}


def test_an_active_session_beats_another_sessions_idle(tmp_path):
    step(tmp_path, 'old', state='done', since=NOW - 90)
    step(tmp_path, 'new', state='tool', tool='terminal', since=NOW - 4)
    assert reader(tmp_path).for_bots(['alpha'])['alpha']['detail'] == 'terminal'


def test_a_new_session_from_another_process_beats_a_just_done_card(tmp_path):
    board(tmp_path, rows=[('t_3', 'Riddle', 'alpha', 'done', 9000, NOW - 2, None, None, None)],
          runs=[(9, 't_3', 'alpha', 9000, NOW - 2, 'completed', 'Asked a riddle.')],
          events=[('t_3', 9, 'spawned', json.dumps({'pid': 4242}), 9000)])
    step(tmp_path, 'worker', state='thinking', since=NOW - 1, pid=4242)
    assert reader(tmp_path).for_bots(['alpha'])['alpha']['row'] == 3, 'the worker that finished the card'
    step(tmp_path, 'chat', state='tool', tool='terminal', since=NOW - 1, pid=777)
    p = reader(tmp_path).for_bots(['alpha'])['alpha']
    assert (p['row'], p['detail']) == (7, 'terminal'), 'a different process is new work'


def test_without_step_files_an_old_done_card_leaves_the_renderer_status_alone(tmp_path):
    """No step plugin: the backend cannot see new chat turns, so it must not force idle over them."""
    board(tmp_path, rows=[('t_3', 'Riddle', 'alpha', 'done', 9000, NOW - 90, None, None, None)])
    assert reader(tmp_path).for_bots(['alpha']) == {}


def test_after_the_done_wave_the_workers_finished_turn_gives_idle(tmp_path):
    board(tmp_path, rows=[('t_3', 'Riddle', 'alpha', 'done', 9000, NOW - 2, None, None, None)],
          runs=[(9, 't_3', 'alpha', 9000, NOW - 2, 'completed', 'Asked a riddle.')],
          events=[('t_3', 9, 'spawned', json.dumps({'pid': 4242}), 9000)])
    step(tmp_path, 'worker', state='done', since=NOW + 3, pid=4242)
    later = reader(tmp_path, now=NOW + 35, alive=lambda pid: False).for_bots(['alpha'])['alpha']
    assert later == {'row': 0, 'title': '', 'detail': '', 'since': None, 'tone': 'info'}, 'idle, not a second plain Done'
