"""Cross-platform helpers: the Windows code paths are exercised here by forcing them on Linux."""
import importlib.util
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def load(name='portable_under_test'):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'dashboard/portable.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


portable = load()


def link(path, target, directory=False):
    """Create a symlink, or skip where the OS refuses (Windows without developer mode)."""
    try:
        path.symlink_to(target, target_is_directory=directory)
    except (OSError, NotImplementedError) as error:
        pytest.skip('symlinks unavailable here: ' + str(error))


@pytest.fixture(params=['dir_fd', 'lstat'])
def walker(request, monkeypatch):
    """Both strategies: race-free dir_fd walk (Linux/macOS) and the lstat walk used on Windows."""
    module = load('portable_' + request.param)
    if request.param == 'lstat':
        monkeypatch.setattr(module, 'DIR_FD', False)
        monkeypatch.setattr(module, 'NOFOLLOW', 0)
    return module


def test_open_below_reads_regular_files(tmp_path, walker):
    (tmp_path / 'a' / 'b').mkdir(parents=True)
    (tmp_path / 'a' / 'b' / 'file.webp').write_bytes(b'data')
    fd = walker.open_below(tmp_path, ('a', 'b', 'file.webp'))
    with os.fdopen(fd, 'rb') as stream:
        assert stream.read() == b'data'


def test_open_below_refuses_symlinked_dirs_and_files(tmp_path, walker):
    outside = tmp_path / 'outside'; outside.mkdir(); (outside / 'secret').write_bytes(b'x')
    base = tmp_path / 'base'; base.mkdir()
    link(base / 'link', outside, directory=True)
    link(base / 'file', outside / 'secret')
    for parts in (('link', 'secret'), ('file',)):
        with pytest.raises(OSError):
            os.close(walker.open_below(base, parts))


def test_open_below_allows_a_symlinked_trusted_base(tmp_path, walker):
    real = tmp_path / 'real'; real.mkdir(); (real / 'f').write_bytes(b'ok')
    link(tmp_path / 'dotfiles', real, directory=True)
    fd = walker.open_below(tmp_path / 'dotfiles', ('f',))
    os.close(fd)


@pytest.mark.parametrize('parts', [(), ('..', 'x'), ('a/b',), ('a\\b',), ('',), ('.',), (3,)])
def test_open_below_rejects_unsafe_components(tmp_path, parts):
    with pytest.raises(OSError):
        portable.open_below(tmp_path, parts)


def test_open_leaf_matches_open_below(tmp_path, walker):
    (tmp_path / 'leaf').write_bytes(b'z')
    os.close(walker.open_leaf(tmp_path / 'leaf'))
    link(tmp_path / 'ln', tmp_path / 'leaf')
    with pytest.raises(OSError):
        walker.open_leaf(tmp_path / 'ln')


def test_pid_alive_never_signals_a_live_process():
    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
    try:
        assert portable.pid_alive(child.pid) is True
        assert child.poll() is None, 'checking must not stop the process'
    finally:
        child.kill(); child.wait()
    assert portable.pid_alive(child.pid) is False


@pytest.mark.parametrize('pid', [0, -1, None, '12', True, 1.5])
def test_pid_alive_rejects_non_pids(pid):
    assert portable.pid_alive(pid) is False


def test_pid_alive_windows_path_uses_no_signal(monkeypatch):
    """On Windows os.kill(pid, 0) would kill the process; the Windows path must not call it."""
    import ctypes
    import ctypes.wintypes  # load before pretending to be Windows (ctypes branches on os.name)
    calls = []

    monkeypatch.setattr(ctypes, 'WinDLL', lambda *a, **k: Kernel(), raising=False)
    monkeypatch.setattr(ctypes, 'get_last_error', lambda: 87, raising=False)
    monkeypatch.setattr(portable.os, 'kill', lambda *a: calls.append(a))
    monkeypatch.setattr(portable.os, 'name', 'nt')
    assert portable.pid_alive(4242) is True
    assert portable.pid_alive(4243) is False
    assert calls == []


class Kernel:
    """Fake kernel32: plain function attributes, so argtypes/restype can be set like on ctypes functions."""
    def __init__(self):
        def open_process(access, inherit, pid):
            return 7 if pid == 4242 else 0
        def exit_code(handle, out):
            out._obj.value = 259  # STILL_ACTIVE
            return True
        def close(handle):
            return True
        self.OpenProcess, self.GetExitCodeProcess, self.CloseHandle = open_process, exit_code, close


def test_hermes_root_follows_hermes_constants_or_platform(monkeypatch, tmp_path):
    monkeypatch.setitem(sys.modules, 'hermes_constants', None)  # outside Hermes
    monkeypatch.setenv('HOME', str(tmp_path / 'home'))  # tmp_path itself may sit under the real ~/.hermes
    monkeypatch.setenv('HERMES_HOME', str(tmp_path / 'root' / 'profiles' / 'bot'))
    monkeypatch.setattr(portable.sys, 'platform', 'linux')
    assert portable.hermes_root() == tmp_path / 'root'
    monkeypatch.delenv('HERMES_HOME')
    monkeypatch.setattr(portable.sys, 'platform', 'win32')
    monkeypatch.setenv('LOCALAPPDATA', str(tmp_path / 'Local'))
    assert portable.hermes_root() == tmp_path / 'Local' / 'hermes'


def test_try_lock_is_exclusive(tmp_path):
    path = tmp_path / 'lock'
    with open(path, 'a+') as first, open(path, 'a+') as second:
        portable.try_lock(first)
        with pytest.raises(BlockingIOError):
            portable.try_lock(second)


def test_backend_modules_import_without_posix_only_modules(monkeypatch):
    """Windows has no fcntl; every backend module must still import (voice keeps working)."""
    import builtins
    real = builtins.__import__
    def guarded(name, *args, **kwargs):
        if name in ('fcntl', 'termios', 'pwd', 'grp', 'resource'):
            raise ImportError('no ' + name + ' on this platform')
        return real(name, *args, **kwargs)
    monkeypatch.setattr(builtins, '__import__', guarded)
    for name in ('portable', 'gallery_sprites', 'bot_progress', 'companion_broker'):
        spec = importlib.util.spec_from_file_location('nofcntl_' + name, ROOT / 'dashboard' / (name + '.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
