"""Command hints must use the native Discord command actually registered."""
import asyncio
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def test_invalid_live_voice_operation_points_to_native_voice_join():
    from discord_live import command
    response = asyncio.run(command("unsupported-operation"))
    assert "/voice join" in response


def test_missing_voice_room_points_to_native_voice_join(monkeypatch):
    import discord_audio
    import discord_live as live
    monkeypatch.setattr(live, "_SESSION", None)
    monkeypatch.setattr(live, "command_context", lambda: {"guild_id": 42, "operator_id": 7})

    def no_room(guild):
        raise discord_audio.TalkDiscordError("not joined")

    monkeypatch.setattr(discord_audio, "resolve_voice_bridge", no_room)
    response = asyncio.run(live.command("join"))
    assert "/voice join" in response
