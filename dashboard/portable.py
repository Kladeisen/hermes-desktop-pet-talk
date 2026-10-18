"""Small cross-platform helpers (Linux, macOS, Windows) for the backend half.

Every backend module loads this file through ``load()`` so they share one copy.
Nothing here imports a POSIX-only module at import time.
"""
import os
import stat
import sys
from pathlib import Path

NOFOLLOW = getattr(os, 'O_NOFOLLOW', 0)
NONBLOCK = getattr(os, 'O_NONBLOCK', 0)
DIRECTORY = getattr(os, 'O_DIRECTORY', 0)
BINARY = getattr(os, 'O_BINARY', 0)
# Race-free no-follow walking needs dir_fd plus O_NOFOLLOW/O_DIRECTORY (Linux, macOS).
DIR_FD = bool(NOFOLLOW and DIRECTORY) and os.open in os.supports_dir_fd
_REPARSE_POINT = getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400)


def _is_link(info):
    """Symlink, or on Windows any reparse point (symlink or junction)."""
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, 'st_file_attributes', 0) & _REPARSE_POINT)


def open_below(base, parts):
    """Read-only fd for ``base/parts...``, refusing symlinks below the trusted *base*.

    *base* may itself be reached through a symlink. Linux and macOS walk
    no-follow directory descriptors, which is race-free. Windows has neither
    ``dir_fd`` nor ``O_NOFOLLOW``: every component is checked with ``lstat``
    (symlinks and junctions are refused) and the opened file must be the one
    that was checked. Raises ``OSError``.
    """
    parts = tuple(parts)
    if not parts or any(not isinstance(p, str) or p in ('', '.', '..') or '/' in p or '\\' in p for p in parts):
        raise OSError('unsafe path component')
    if DIR_FD:
        descriptors = []
        try:
            current = os.open(os.path.realpath(base), os.O_RDONLY | DIRECTORY)
            descriptors.append(current)
            for part in parts[:-1]:
                current = os.open(part, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=current)
                descriptors.append(current)
            return os.open(parts[-1], os.O_RDONLY | NOFOLLOW | NONBLOCK, dir_fd=current)
        finally:
            for descriptor in reversed(descriptors):
                os.close(descriptor)
    path = Path(os.path.realpath(base))
    for part in parts:
        path = path / part
        if _is_link(os.lstat(path)):
            raise OSError('symlink refused')
    checked = os.lstat(path)
    fd = os.open(path, os.O_RDONLY | BINARY | NOFOLLOW)
    opened = os.fstat(fd)
    if checked.st_ino and opened.st_ino and (checked.st_ino, checked.st_dev) != (opened.st_ino, opened.st_dev):
        os.close(fd)
        raise OSError('file changed while opening')
    return fd


def open_leaf(path):
    """Read-only fd for one file inside a trusted directory, never through a symlink."""
    path = Path(path)
    return open_below(path.parent, (path.name,))


def pid_alive(pid):
    """Whether a process with this id exists. Never sends a signal on Windows."""
    if type(pid) is not int or pid <= 0:
        return False
    if os.name == 'nt':
        # os.kill(pid, 0) on Windows would *terminate* the process (signal 0 = CTRL_C_EVENT).
        import ctypes
        from ctypes import wintypes
        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
        kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return ctypes.get_last_error() == 5  # access denied: it exists
        try:
            code = wintypes.DWORD()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return True
            return code.value == 259  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def hermes_root():
    """Root Hermes home (the one holding ``profiles/``) on every platform."""
    try:
        from hermes_constants import get_default_hermes_root
        return Path(get_default_hermes_root())
    except Exception:  # running outside Hermes (tests, tools)
        pass
    if sys.platform == 'win32':
        base = os.environ.get('LOCALAPPDATA', '').strip()
        native = (Path(base) if base else Path.home() / 'AppData' / 'Local') / 'hermes'
    else:
        native = Path.home() / '.hermes'
    env = os.environ.get('HERMES_HOME', '').strip()
    if not env:
        return native
    home = Path(os.path.expandvars(env)).expanduser()
    try:
        home.resolve().relative_to(native.resolve())
        return native
    except ValueError:
        return home.parent.parent if home.parent.name == 'profiles' else home


def try_lock(stream):
    """Exclusive, non-blocking lock on an open file; raises BlockingIOError when held."""
    if os.name == 'nt':
        import msvcrt
        try:
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as error:
            raise BlockingIOError(str(error)) from error
        return
    import fcntl
    fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)


def load():
    """This module, shared through ``sys.modules`` by every plugin file that loads it."""
    return sys.modules[__name__]
