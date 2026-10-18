# Discord Live Voice (local adapter port)

## Scope

This port adds `/live-voice` to **talk-desktop**, the installed
`Synero/hermes-live-voice` plugin. It does not replace `/talk`, change the desktop
renderer, select a Talk provider, or alter identity, language, voice, engine,
credentials or other profiles.

Audio/lifecycle code is ported from the installed MIT-licensed hermes-talk
`talk_discord.py`; attribution and its complete license are retained. This keeps
its host listener handoff, Opus/DAVE receive handling, bounded queues, silence
pacing, speaker attribution, inactivity keepalive and cleanup behaviour.

The new media client converts Discord's 48 kHz stereo PCM through the adapter's
24 kHz mono format to an aiortc audio track. Model audio is decoded from the
WebRTC output track, resampled to 24 kHz mono, and queued back through the same
Discord adapter. PCM is not sent via JSON audio events.

Signaling calls the existing `dashboard/plugin_api.py` broker in an independent
module instance/app-server. It preserves OpenAI subscription authentication,
`gpt-live-1-codex`, protocol **v3**, `voice: sol`, and `oai-events`. Desktop and
Discord do not share a Codex thread/process. The Discord client forces supported
client-managed handoffs in memory only, leaves settings.json untouched, and
refuses degraded/older handoff negotiation instead of silently running tools in
Codex or selecting another provider.

## Prerequisites and activation

- Existing default-profile Hermes Discord bot configured and connected.
- Existing Codex CLI subscription login, as used by Desktop Live Voice.
- Hermes Discord voice dependencies and `aiortc>=1.15,<2` (declared in plugin.yaml).
- Bot voice permissions: View Channel, Connect and Speak; the host's existing
  Discord/DAVE/Opus setup must already work.
- The operator and every human listener must pass the host's Discord authorization
  policy and be in the same voice room. The bot must already have joined that room.

Managed dependency installation (not raw pip into a running interpreter):

```bash
hermes plugins validate "$HOME/.hermes/plugins/talk-desktop" --install-deps --json
# talk-desktop is already enabled here. On a fresh install only:
hermes plugins enable talk-desktop --no-allow-tool-override
# With approval, restart the gateway to load the command/new dependency generation:
hermes gateway restart
```

No Desktop restart is needed for this backend-only command. Discord's native
command reconciliation can take several minutes because of Discord rate limits.
The native command's argument field is named `args`.

1. Join the intended voice channel **as the operator**.
2. In that server, select `/voice` with `mode: join` (typed form: `/voice join`)
   to put the bot into your voice room. This port deliberately does not choose
   or join another room.
3. Run `/live-voice` with `args: join` (typed message form: `/live-voice join`).
4. Use `args: status` to check accepted startup/errors. Use `pause` / `resume`
   for input, and `leave` to stop Live Voice without disconnecting the bot's
   underlying gateway voice connection. `/voice` with `mode: leave` leaves the room.

Only the same operator/server may control the active call. Room changes revoke
input, queued playback and task-result delivery. Only the operator's immutable
per-packet speaker ID is forwarded to the provider; unknown speakers and other
members' speech are discarded. Native command identity is captured from host
ContextVars, never from raw arguments or environment fallback.

## Tasks and limitations

`delegation.created` is deduplicated and serialized. Results are returned with
v3 `delegation.context.append`; provider JSON/SDP/tokens are never published to a
Discord text channel. A failed startup publishes only an exception class
(never the raw provider error) through `/live-voice status`.

This installed Hermes has no canonical Discord task-context/invocation attachment
API used by newer hermes-talk versions. The port therefore reuses the gateway's
model/credential resolution, Discord toolsets, user identity and cleanup to run
a **separate Hermes voice conversation**. It does not attach to a focused Desktop
tab, adopt a different profile, or fall back to a Talk/Codex task provider.
Cooperative task cancellation interrupts the owned agent and waits for cleanup;
there is no detached fire-and-forget tool worker.

One Discord call per gateway process is supported. English is the Discord session
language; Sol is fixed for this adapter. The existing Desktop settings remain
independent. No room was selected automatically during installation: a live
Discord call requires the operator to identify the intended room via `/voice join`.

## Verification

All tests are offline except the explicitly separate provider probe:

```bash
cd "$HOME/.hermes/plugins/talk-desktop"
"$HOME/.hermes/cache/scratch/sol-voice-test-env-v2/bin/python" -m pytest -q
bash tools/plugin-load-test.sh
hermes plugins validate "$PWD" --json
```

The strict vertical TDD cycles covered generated PCM, real aiortc local WebRTC
echo, listener authorization and queued-output revocation, v3 task handling,
command registration/ownership, host identity, broker reuse, host task dispatch,
dependency declaration, pause-buffer leakage and cancellation-before-start.
The upstream audio-only regression suite was also ported (provider/session tests
are intentionally excluded). Full suite after lifecycle regressions: **156 passed**, no warnings.

The generated-silence provider probe uses the actual new `CodexDiscordSession`
and actual broker, asks for a non-delegating spoken transport-test sentence, and
writes a short 24 kHz mono WAV under scratch. This verifies real subscription
signaling, transcript and decoded audio, not a real Discord room or microphone.

Local baseline backup, isolated provider/registration probes, WAV and patch:
`$HOME/.hermes/cache/scratch/discord-live-voice/`. The patch is against the
pre-task installed files, not upstream HEAD, so pre-existing user changes are
excluded. Plugin updates may overwrite the local port; inspect before reapplying.
