# Notices

## This build

`hermes-desktop-pet-talk` (github.com/Kladeisen/hermes-desktop-pet-talk) is an extended
build maintained by Kladeisen, derived from
[`Synero/hermes-live-voice`](https://github.com/Synero/hermes-live-voice) (MIT, © 2026 Synero).
The upstream copyright and licence are retained in `LICENSE`; the additions here
(desktop pet companion, plugin-owned native window, bot pets, cross-platform backend)
are released under the same MIT terms.

## Discord adapter port

`discord_audio.py` and `tests/test_discord_audio_port.py` reuse the audio-only
portion of `talk_discord.py` and its regression tests from **hermes-talk**,
Copyright (c) 2026 SmokeDev, MIT License, installed revision
`981711b8f44df78e2ad958174e931c1b584b8bdd`.
The complete license is retained in `docs/hermes-talk-discord-LICENSE`.
Provider/session management and canonical task APIs were deliberately excluded;
`discord_live.py` connects this PCM adapter to this plugin's existing Codex
app-server WebRTC v3 broker instead. No Talk voice provider is substituted.

## Third-party code

This plugin bundles a fallback copy of parts of **hermes-talk**
(https://github.com/TheSmokeDev/hermes-talk), by TheSmokeDev and contributors,
under the MIT License. The bundled files live in `dashboard/talk_vendor/` and
keep their upstream copyright headers.

The bundled copy exists so the plugin is **self-contained**: a fresh install
does not need the hermes-talk plugin present. When hermes-talk IS installed,
it is preferred at runtime and the bundled copy stays unused.

Upstream hermes-talk is excellent — if you want its full voice experience
(native voice tools like memory search, background-agent delegation with
approvals, run steering, cascade voice modes), install the real plugin and
this one will use it automatically.