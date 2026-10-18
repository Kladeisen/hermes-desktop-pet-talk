# Desktop-pet-talk

Native **full-duplex voice** for [Hermes](https://github.com/NousResearch/hermes-agent) — talk to your
bots from Hermes Desktop with real-time audio, live transcript, voice tool calls and task delegation.

**Engine:** [GPT-Live-1](https://openai.com/index/introducing-gpt-live-1-in-the-api/) (`gpt-live-1-codex`)
through the local **Codex app-server**, running on a **ChatGPT/Codex subscription** — no API key needed
for the voice lane.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.2.3-informational)](plugin.yaml)
[![Hermes](https://img.shields.io/badge/hermes-%E2%89%A50.22-informational)](plugin.yaml)
[![Status: preview](https://img.shields.io/badge/status-preview-orange)](#status--roadmap)

---

> **This repo is a personal extended build**, not the upstream project. It started from
> [Synero/hermes-live-voice](https://github.com/Synero/hermes-live-voice) (MIT) and adds
> desktop-pet controls, a plugin-owned native companion window, bot pets and a
> cross-platform backend. Snapshot of `master` @ `c7ece17` (follow-up lanes A–I merged),
> developed and tested against **Hermes Agent 0.22.0** on Linux/Wayland. Expect rough edges;
> read [Status & roadmap](#status--roadmap) before trusting it with a daily workflow.

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Install](#install)
- [First run](#first-run)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [How it works](#how-it-works)
- [Status & roadmap](#status--roadmap)
- [Changelog](#changelog)
- [Tests](#tests)
- [Credits](#credits)
- [License](#license)

---

## Features

- 🎧 **Full-duplex, interruptible voice** over WebRTC — audio goes device ↔ model directly (the server only brokers the session).
- 🤖 **Persona-aware** — the voice session adopts the active bot's `SOUL.md` identity. Built-in UI and voice instructions are English-only in this local installation; custom identity/directive content is preserved. See [model context language](docs/model-context-language.md).
- 📝 **Live transcript** — iMessage-style bubbles (you / bot), streaming deltas, tool activity chips.
- 🛠️ **Tools from voice** — the model can run tasks: by default they are delegated into the **exact chat captured when voice starts**, i.e. your own agent with **your** models and providers. A voice-side delegation policy keeps this clean (only real task requests are delegated, fillers stay conversational) and an internal queue prevents overlapping runs. An opt-in server-agent mode also exists.
- 🎚️ **Audio & call controls** — device pickers, built-in mic test, one-tap **mute** and hang-up right in the composer.
- 📊 **Usage panels** — measured voice minutes (rolling windows) and the Codex plan bucket.

## Requirements

- **Hermes Agent** (backend) and **Hermes Desktop** (app) — tested with **0.22.0**.
- **`codex` CLI ≥ 0.154**, logged in with a ChatGPT plan (`codex login` — device auth).
  This is the default `codex` voice engine and needs a ChatGPT/Codex subscription, not an API key.
- Python 3.11+ for the backend half.
- *Optional, Linux pop-out pet only:* system `python3` with PyGObject/Cairo, GTK3,
  WebKit2GTK 4.1 and gtk-layer-shell on a Wayland compositor. Everything else (voice, in-app
  pet, in-window bot pets) works without them, and on Windows/macOS too.

## Install

The plugin ships as a **unified package**: a backend half (`dashboard/plugin_api.py`, mounted by the
Hermes dashboard under `/api/plugins/talk-desktop/`) and a desktop half (`desktop/plugin.js`, loaded by
the Hermes Desktop app).

### From GitHub (recommended)

```bash
# The installer scans community sources and BLOCKS this one by default
# ("community source + caution verdict") - it launches subprocesses for the pet
# windows and binds loopback ports. Read the scan output, then:
hermes plugins install Kladeisen/hermes-desktop-pet-talk --force
hermes plugins enable talk-desktop
```

Verified verbatim on Hermes Agent 0.22.0: the install lands the whole tree in
`$HERMES_HOME/plugins/talk-desktop`, byte-identical to this repo, and `hermes plugins list` then
shows `talk-desktop 0.2.3 · git`.

<details><summary>Why the scan blocks, and how to make it not block</summary>

The scan reports ~50 findings for this package: `MEDIUM execution` on the `tools/*` harnesses that
launch GTK/Chromium/`hyprctl`, `LOW network` on the bundled `talk_vendor` loopback default, and the
private-core-import advisories from `hermes plugins validate`. None of them are a secret or a
credential; they are the price of shipping the desktop-pet machinery. Persistent alternatives:
set `plugins.scan_on_install: false` in `config.yaml` (removes the gate for *all* future installs),
or drop `tools/` and `tests/` from your copy before installing.
</details>

The app copies the desktop half into `$HERMES_HOME/desktop-plugins/talk-desktop/` on its next
start, so: install, enable, then **restart Hermes Desktop**.

Updates after the first install:

```bash
hermes plugins update hermes-desktop-pet-talk
# or pin/reinstall explicitly:
hermes plugins install Kladeisen/hermes-desktop-pet-talk --force -f
```

Pin a known-good revision with `hermes plugins install Kladeisen/hermes-desktop-pet-talk --ref <40-char-sha>`.

This repo is **not in the curated plugin catalog**. The catalog entry named `hermes-live-voice` is the
[upstream project](https://github.com/Synero/hermes-live-voice); installing that name gives you
upstream, not this build.

### Same-machine setup (manual)

```bash
# 1) Drop the repo into your Hermes plugins directory:
cp -r hermes-desktop-pet-talk "$HERMES_HOME/plugins/talk-desktop"     # default: ~/.hermes/plugins/talk-desktop

# 2) Enable the backend plugin (config.yaml → plugins.enabled) and restart the dashboard.
```

The desktop app discovers the desktop half from the plugin folder
(`$HERMES_HOME/plugins/talk-desktop/desktop/plugin.js`) automatically.

### Remote desktop (app on another machine, backend on a server)

1. Install the backend half on the server as above.
2. Copy **only** `desktop/plugin.js` to the desktop machine:
   `$HERMES_HOME/desktop-plugins/talk-desktop/plugin.js` — the folder name must equal the plugin id
   (`talk-desktop`), and `plugin.js` must sit at the folder root.
3. In the app: `Ctrl/Cmd+K` → **“Reload desktop plugins”**.

## First run

1. The mic button appears in the composer (next to the `+` row). Click to start a call.
2. Open the gear ⚙ for settings: **Bot → Voice engine → Voice → Audio**.
3. If this is a fresh machine: sign in to Codex first (`codex login`) or use the in-panel session flow.

## Discord (default profile)

The same GPT-Live-1 / Sol subscription backend now supports a Discord voice room.
In Discord, use the gateway's `/voice join` while you are in the intended voice channel,
then `/live-voice` with `args: join`. Controls: `pause`, `resume`, `leave`, `status`.
This is separate from `/talk` and never selects hermes-talk's provider.

See **[docs/discord-live-voice.md](docs/discord-live-voice.md)** for prerequisites,
authorization, managed dependency installation, testing and limitations.

## Configuration

`settings.json` is stored next to the installed backend plugin
(`$HERMES_HOME/plugins/talk-desktop/settings.json`). See `settings.example.json`:

| key | values | default | meaning |
|---|---|---|---|
| `codexAgentModel` | a ChatGPT-valid Codex model slug (e.g. `gpt-5.6-sol`) | *(unset)* | Model forced for the delegated **server agent** thread. Needed only when the machine's default Codex model is not ChatGPT-valid (e.g. a custom provider proxy). |
| `delegation` | `client` · `server` | `client` | Who runs voice-delegated tasks. **`client`** = the tasks run in your focused Hermes chat (your config/providers — recommended, nothing is sent to the ChatGPT lane). **`server`** = tasks run in a Codex agent thread on the backend (advanced/opt-in). |

## Troubleshooting

First-run gotchas:

- **No sign-in prompt?** The voice session needs a ChatGPT-plan Codex login. Open the mic
  config (gear while the plugin is visible) → the auth card shows your sign-in state and a
  **Sign in** button: it opens `auth.openai.com/codex/device` with a code to type.
  Nothing to copy by hand from a terminal.
- **`codex` not found in the dashboard logs?** The backend resolves `codex` from
  `~/.local/bin`, `$PATH` and `/usr/local/bin`. If your service runs with a minimal
  `PATH`, add the codex bin directory to the service environment.
- **Persona too generic?** The voice reads the focused bot's `SOUL.md`. No bot focused →
  it uses your Hermes default identity.

## How it works

The desktop renderer negotiates a WebRTC session against the ChatGPT backend; a local broker spawns
`codex app-server` and drives the realtime conversation (protocol `v3`, model `gpt-live-1-codex`).
Voice-delegated tasks surface as `delegation` items; the client (by default) routes them to your
focused Hermes chat and feeds the result back to the voice model to speak.

```text
┌─ Hermes Desktop ────────────────────────────────────────────────────────────┐
│  mic button in the composer  ·  Live Voice panel: transcript, controls, usage  │
└────────────────────────────────────────────────────────────────────────────┘
                │  WebRTC audio — the device talks to the model directly;
                │  the broker only sets the session up.
                v
┌─ ChatGPT realtime backend ──────────────────────────────────────────────────┐
│  GPT-Live-1 (gpt-live-1-codex)  ·  realtime protocol v3                      │
└────────────────────────────────────────────────────────────────────────────┘
                │  spawn + drive over stdio JSON-RPC
                v
┌─ dashboard half — /api/plugins/talk-desktop/ ───────────────────────────────┐
│  broker: codex app-server on your ChatGPT/Codex subscription                 │
└────────────────────────────────────────────────────────────────────────────┘
                │  delegation item (client mode, default)
                v
┌─ your focused Hermes chat ──────────────────────────────────────────────────┐
│  runs the task with YOUR models and providers, then the result               │
│  is fed back and spoken by the voice model                                   │
└────────────────────────────────────────────────────────────────────────────┘
```

Full engineering recipe, protocol tables and gotchas:
**[`docs/live-voice-recipe.md`](docs/live-voice-recipe.md)**.

## Status & roadmap

⚠️ **Preview (0.2.x).** The backend resolves its voice plumbing at import time in this order: the
full [`hermes-talk`](https://github.com/TheSmokeDev/hermes-talk) plugin when it is installed (richer
— native voice tools, run steering, cascade modes), otherwise the MIT-licensed fallback bundled in
`dashboard/talk_vendor/`, so a fresh install with no other plugin mounts correctly (covered by a
regression test that runs with an empty `HOME` and no `hermes-talk` present). Runtime dependencies
are the Hermes dashboard's own (`fastapi`, `httpx`); the desktop half has no build step. The complete
Live Voice implementation and the protocol documentation are included here for reference and
integration work.

### Other voice providers (not built yet)

Today the plugin has three voice engines, all running OpenAI models:

| Engine | What you need |
|---|---|
| **Codex Live** (default) | The `codex` CLI and a ChatGPT plan |
| **OpenAI Realtime** | An OpenAI API key, or your Codex sign-in |
| **Hermes Live** | An OpenAI API key, set in Hermes |

In every engine the voice model only talks with you. Real work is handed to your Hermes chat through tool calls, so the
chat does the work with your own models and providers.

**Possible addition: a "Custom Realtime server" engine.** You would enter a server address and an optional key in
the **Pets & voice** panel. The plugin would connect over WebSocket to any server that speaks the OpenAI Realtime
format. That would cover:

- **self-hosted servers**, for people who only use local AI. For example, [Speaches](https://speaches.ai/usage/realtime-api/)
  (Whisper speech-to-text with Kokoro or Piper speech, which runs on a modest GPU), or Kyutai
  [Unmute](https://github.com/kyutai-labs/unmute), which needs a 16 GB GPU;
- **cloud services with the same format**, such as Azure Voice Live and xAI Grok Voice.

None of these have been tried with this plugin. Handing work to your chat depends on the server supporting tool calls,
so this engine would start out as experimental.

Other routes, and why they aren't planned:

- **Google Gemini Live** uses a different protocol, so it would need its own engine.
- **Fully local voice-to-voice models** (Moshi, NVIDIA PersonaPlex, Qwen3-Omni) need a large GPU, and most can't
  call tools, so they couldn't hand work to Hermes.
- **A plain chain** (local speech-to-text, then Hermes, then local speech) works without a GPU. But it is
  turn-based, so it would need a different call design from the live engines here.

If you would use one of these, please open an issue and say which server or provider you run.

## Changelog

- **0.2.2** — identity and language polish, on top of community fixes by [@tillstriegel](https://github.com/tillstriegel) ([#4](https://github.com/Synero/hermes-live-voice/pull/4)): the voice identity prompt no longer hardcodes the owner's name, the model-facing voice context follows the session language (es/en), and — fixed here — the delegated-thread recovery path now keeps that language instead of silently recreating the thread in the fallback while the previous run was in the other language. Also: the transcript's user label is localized and owner-neutral rather than a hardcoded name, and the identity docstring no longer lists private bot names. **Why it matters:** the plugin runs on other people's machines, so no installer should ever see someone else's name in the prompt or in the UI.
- **0.2.1** — audit fixes: the backend now imports its **bundled** `talk_vendor` fallback on fresh installs (previously it needed `hermes-talk` installed); a concurrent `/session` pair no longer deadlocks the event loop; app-server RPC correlation survives reader-buffer pruning; `/codexlive/interrupt` runs off the event loop; `CODEX_HOME` is honored consistently across login/backup/logout; when an older app-server drops `clientManagedHandoffs` the response now carries `droppedFields`/`handoffDegraded`/`warning` and the desktop shows a notice instead of failing silently; the desktop interrupt call sends a plain object body (no double-encoding) and a muted mic can no longer be un-muted by barge-in.
- **0.2.0** — call controls (mute button, hover states) + delegation hardening: voice-side delegation policy, TTS-friendly reply note, filler filter, task queue, and neutralized background thread turns (the Codex plan no longer pays for invisible tool work).
- **0.1.0** — initial public preview.

## Tests

```bash
python -m pytest -q
```

Regression tests for the audit findings in issue #1 (no network, no `codex` binary, no OpenAI
calls — stdlib + pytest only). CI additionally verifies the bundled fallback imports on a
clean environment (empty `HOME`, no site-packages), compiles the backend, syntax-checks the
desktop half and runs the ESM load harness.

**Snapshot status: two tests are expected to fail here** (four parametrized cases), so CI is red
until they are fixed — both failures are inherited, not caused by publishing:

| Test | Why |
|---|---|
| `tests/test_model_context.py::test_desktop_model_messages` | still expects the old hardcoded `[voice] Reply briefly and naturally in English…` prefix, while the plugin now follows the session language (0.2.2 change). Stale test, intended behaviour. |
| `tests/test_discord_live.py::test_discord_media_dependency_is_declared_for_managed_installation` | asserts `plugin.yaml` declares `aiortc`; it deliberately does not (declaring it blocks admission — see the manifest comment). |

Installing therefore needs `--force`: the community-source scan and `hermes plugins validate` both
report the private-core imports and the deliberate app-DOM reach this plugin relies on.

## Credits

Voice auth, session minting and identity plumbing are derived from
[TheSmokeDev/hermes-talk](https://github.com/TheSmokeDev/hermes-talk) (MIT) —
bundled in `dashboard/talk_vendor/` with attribution in `NOTICE.md`. The
plugin prefers the full hermes-talk when it's installed (native voice tools,
run steering, cascade modes); the bundled fallback keeps fresh installs
self-contained.

Thanks to **[@whyyagswhy](https://github.com/whyyagswhy)** for the external audit
and the reproduction script behind the 0.2.1 fixes.

## License

MIT — see [LICENSE](LICENSE). Codex and GPT are OpenAI products; this project is **not affiliated
with or endorsed by OpenAI**. The Codex CLI it drives is open source and installed by the user.


## Desktop pet companion

The desktop display name is **Desktop-pet-talk**. Internal plugin ID, routes and
storage remain `talk-desktop`. Both surfaces use the pure, bounded descriptor
and layout functions in `desktop/plugin.js`; the packaged native helper reads
that same module. No custom Hermes build or `registerOverlayCompanion` is used.
Controls are 36px voice/mute and 24px chat/transcript, with mute above mic and a
clear gap to the artwork. The enlarged status rectangle has no tail or gear.

The main renderer owns one voice controller for the plugin lifetime. Composer
unmount and pet pop-out do not end calls. Plugin unload or an owner profile or
connection switch ends the voice owner; stale generations cannot control a
replacement. Chat opens the captured durable session with its exact profile and
connection route, in place. Transcript contents stay in the main renderer.

### Windows and macOS

The voice call, the in-app pet controls and quick reply work on every system. The
plugin's own desktop windows (pop-out pet and bot pets) need Linux with a Wayland
layer-shell compositor. The backend reports this through `POST /companion/capabilities`.
Where they can't run:

- The pop-out button is hidden. Shift-click the pet to use Hermes' own pop-out,
  which works on Windows, macOS and Linux.
- Bot pets appear **inside the Hermes window** instead: the same sprites, two-line
  bubble, chat button and dismiss button, and they can be dragged. Positions are
  remembered. Data comes from `POST /companion/bots` (no pop-out lease); images
  are fetched once per id from `POST /companion/image`.
- Optionally (off by default), each busy bot also gets a line in Hermes' own pet
  bubble ("Claude: Riddle game · Thinking (1m)"), which Hermes mirrors into its
  own pop-out. Hermes shows only the newest line, so with several busy bots they
  replace each other; that is why it is off.

Settings → Bot pets chooses **Automatic** (desktop windows where supported,
otherwise inside Hermes), **Desktop windows** or **Inside Hermes**, and turns the
bubble lines on (off by default).

The backend avoids POSIX-only calls outside the Linux window code
(`dashboard/portable.py`): no `fcntl` import, no `os.kill(pid, 0)` (on Windows
that would stop the process), no `dir_fd`/`O_NOFOLLOW` requirement, Codex found
through `%APPDATA%\npm` on Windows. The manual **Cross-platform backend**
workflow runs the backend tests on Windows, macOS and Linux. It cannot show how
the pets look on those systems.

### Native pop-out (Linux Wayland)

Click the round **pop-out arrow** beside the in-app pet's chat/transcript controls.
Its accessible title toggles between **Pop out pet** and **Close pop-out pet**
from the helper's reported state. It disables while launching/closing, and errors
appear beside the pet and in a toast. The same actions remain in the command palette:
**Talk Desktop: Pop out pet** / **Talk Desktop: Close pop-out pet**. The pop-out
shows the pet selected in Hermes (`display.pet.slug`, falling back to the first
installed pet, exactly like Hermes) for the owner's profile; the plugin ships no
character artwork of its own. The external
helper retains its own close control, not another pop-out button. Launch is explicit,
never starts a microphone, and requires the local backend plus the exact focused
owner profile. The native helper is presentation-only; microphone/provider access
stays in Desktop. A bounded lease, command IDs, desired mute state and acknowledgements
prevent stale/repeated actions. Lost owners shut the helper down rather than
pretending a live connection exists. Native transparent padding is click-through.

Runtime prerequisites are system `/usr/bin/python`, PyGObject/Cairo, GTK3,
WebKit2GTK 4.1 and gtk-layer-shell, on a layer-shell Wayland compositor. The plugin
checks these and reports missing runtime; it does not install system packages or
use Electron from a source checkout. Other platforms currently fail gracefully.

Renderer files can hot-reload, but Python plugin API routes are mounted when the
backend starts. This implementation **does not restart the running application**
or claim that an already-running backend has mounted newly added routes. If the
command reports unavailable routes, activate the backend through its normal
supported lifecycle at a separately approved time; renderer reload alone cannot
mount Python routes.

### Native animation and responsiveness regression

`/usr/bin/python tools/native-performance-test.py Working` runs the unchanged
production helper in real GTK/WebKit with an isolated HTTP owner (no audio).
Repeat with `Finished`, `Error`, an empty string for idle, and `Cycle` for
working → finished → idle. It records actual drawn cells, fixed control
rectangles, visible capabilities, click-to-helper-command latency and a native
WebKit snapshot under `~/.hermes/cache/scratch/pet-performance/`.

The native renderer uses Hermes' Petdex v2 named-row taxonomy: working selects
`running` (row 7), not `waiting` (row 6). Each clip trims blank padding and spans
an 1100ms loop. Artwork bounds are scanned once across the asset, not sampled
from each animation cell, so the control rail does not move with poses. Helpers
wake immediately for actions and skip unchanged state evaluations; this does
not remove the owner's separate command/acknowledgement polling latency.
Irrelevant native controls are hidden according to the published capabilities.

Helper Python/view changes activate on the next explicit close/reopen of the
external companion. Do not reload/unload the renderer to activate helper-only
changes during a voice call: plugin unload ends its controller. This test does
not prove Hyprland workspace reveal, transcript panel mounting, dragging, or
in-app capability visibility; those require separate acceptance tests.

### Native navigation, transcript and dragging regressions

On Hyprland, successful explicit chat/transcript actions reveal the existing
Hermes window owned by the helper's desktop-backend process ancestry. They never
launch another app or autofocus on state updates. Both legacy and Lua config
providers are supported; focus is read back after dispatch.

Dragging uses Hyprland's global logical cursor coordinates and the selected GDK
monitor's logical dimensions. WebKit Wayland `screenX` can be window-local, so it
must not be accumulated while moving that window. Buffer/output scale is not
applied again. Pointer cancellation and lost capture end the gesture.

The persistent transcript uses the SDK dialog portal; acknowledgement waits for
its committed DOM marker and fails if it cannot mount within 1.5 seconds. In-app
chat/mute/transcript relevance follows controller capabilities. Transcript remains
available after a call when content exists; mute disappears when the call ends.

Run `tools/native-view-test.mjs` with isolated jsdom dependencies for explicit
ack/reveal and drag lifecycle regressions; `tests/test_native_platform.py` covers
PID ownership, malformed addresses and 1x/1.25x/2x logical monitor mapping.
`tools/native-coordinate-probe.py` runs the real GTK/WebKit helper with real
compositor cursor displacement and an injected drag lifecycle (not a physical
mouse-button gesture). `tools/pet-badge-preview.mjs` verifies a visible, mounted
transcript in Chromium with an SDK fixture, not the user's packaged Electron.
`tools/verify-companion.py` now requires a mounted transcript DOM before claiming
its native transcript acknowledgement succeeded; its dialog SDK is a fixture.

Do not activate renderer changes while Live Voice is running or its state is
unknown. Updating the watched renderer mirror unloads the existing controller
and stops its call. Stage those changes until a confirmed voice-off window;
helper-only files are safe to install and activate by external close/reopen.

### Pet artwork

The plugin ships no pet or bot artwork. The main pet (in-app and pop-out) is
whatever pet is selected in Hermes; install and select one with `hermes pets`
or the desktop pet settings. Bot pets animate automatically when a bot's avatar
was picked from the Petdex gallery (matched by the avatar's pixels).

For bot sheets you made yourself or may not redistribute, put them in this
plugin's private, never-packaged `data/local-sprites/` folder (WebP or PNG on
the 192x208 Petdex grid). Any sheet there animates the bot whose avatar equals
its first frame; everything else stays a static avatar.

Companion regressions (from this plugin directory):

```sh
TALK_TEST_DEPS=/path/to/isolated/node_modules node tools/pet-badge-test.mjs
TALK_TEST_DEPS=/path/to/isolated/node_modules node tools/pet-legacy-test.mjs
```

The legacy suite preserves the original badge cases with plugin-lifetime
tracking expectations and explicit owner setup. Broker tests cover authentication,
bounded schema/queues, stale generations, native ready/visibility, environment
isolation and input rectangles. The pet setup invariants are in
`tests/test_pet_bundle.py`. Run full backend tests with an isolated dependency
environment (unset inherited `PYTHONPATH` before using uv).

`tools/verify-companion.py` exercises the real production plugin API, real
renderer controller and actual GTK/WebKit native view together, captures native
screenshots, clicks mute/chat/transcript/close through AT-SPI, verifies exact
navigation and acknowledgements, and waits for clean process exits. Only the
provider boundary is fake; no microphone is captured. Set `TALK_TEST_DEPS` to
isolated React/jsdom dependencies and run with Python dependencies aiortc,
FastAPI, httpx and uvicorn. This is an isolated fixture, not proof of routes
activated inside an already-running user backend or a real audio call.
