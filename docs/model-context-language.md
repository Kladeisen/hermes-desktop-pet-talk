# English-only built-in text

Live Voice uses English UI labels, tooltips, status/error messages, previews,
model instructions, and spoken acknowledgements regardless of browser locale.
The renderer always sends `language: "en"` on `/session`, `/codexlive/session`,
and `/tool`. The backend accepts old locale inputs such as `"es"`, omitted/null
values, and unknown locales, but maps them to English. Thread reuse keeps an
English locale key, so switching browser locale does not create another thread.

`language_directive.txt` ships one English directive. Its exact shipped text,
or a missing/blank file, selects the built-in English default. Any different
file content is an explicit user override and is included verbatim. User
requests, dynamic tool output, SOUL/persona files, and memory are not translated
or censored. The input-only filler lexicon and Unicode name handling are kept
unchanged; they are not rendered text or language instructions.

Protocol identifiers, including `skip`, `<realtime_delegation>`,
`clientManagedHandoffs`, and the existing `LIVE_SIN_QUOTA` error marker, are
unchanged. Sol remains the new Codex voice fallback; saved voice/engine choices,
subscription auth, delegation behavior, and the Discord bridge are unchanged.

Tests load the real ESM under English and non-English browser locales and use
production backend functions with offline host/transport boundaries. They cover
legacy/default locale input, custom directive/identity/result preservation,
errors/timeouts, queued work, and stale work. They do not call providers or use
a microphone. The existing Codex dropped-field capability report remains intact.

The materialized Desktop file can hot-reload. Python HTTP routes and Discord
command callbacks retain their imported module until the corresponding host
process restarts; rescan alone does not reload that backend code. Restart only
with the user's approval, and start a new voice session for the updated prompt.
