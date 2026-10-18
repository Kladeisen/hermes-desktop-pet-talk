"""Live Voice desktop/dashboard surface plus optional Discord media client."""
from __future__ import annotations

from pathlib import Path
import sys


async def _live_voice_command(raw_args: str = '') -> str:
    # Hermes file-path loads plugins under synthetic package names. Keep the
    # gateway module lazy so Desktop stays dependency-free.
    root = str(Path(__file__).resolve().parent)
    if root not in sys.path:
        sys.path.insert(0, root)
    from discord_live import command
    return await command(raw_args)


def _attention():
    import importlib.util
    path = Path(__file__).resolve().parent / 'attention.py'
    spec = importlib.util.spec_from_file_location('talk_desktop_attention_loader', path)
    if spec is None or spec.loader is None:
        raise ImportError('attention.py missing')
    loader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loader)
    return loader.shared()


def register(ctx) -> None:
    ctx.register_command('live-voice', handler=_live_voice_command,
                         description='Discord GPT-Live-1 voice with Sol on your Codex subscription',
                         args_hint='[join|pause|resume|leave|status]')
    # The pet's "needs you" badge: observe approval / clarify / sudo waits (observers only).
    try:
        attention = _attention()
        ctx.register_hook('on_human_input_request', attention.on_human_input_request)
        ctx.register_hook('on_human_input_resolved', attention.on_human_input_resolved)
    except Exception:  # the badge is optional; never block plugin admission
        import logging
        logging.getLogger('hermes.plugins.talk-desktop').warning('attention hooks unavailable', exc_info=True)
