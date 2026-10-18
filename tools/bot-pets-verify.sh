#!/usr/bin/env bash
# Reproduce verification without touching an installed plugin or real profiles.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
scratch=${TALK_TEST_SCRATCH:-"$HOME/.hermes/cache/scratch/bot-pets-verification"}
uv=${TALK_TEST_UV:-"$HOME/.hermes/bin/uv"}
mode=${1:-python}
mkdir -p "$scratch/copy" "$scratch/user" "$scratch/home" "$scratch/cache" "$scratch/config" "$scratch/data" "$scratch/logs"
rsync -a --delete --exclude=.git --exclude=data --exclude=__pycache__ --exclude=.pytest_cache "$repo/" "$scratch/copy/"
export TALK_TEST_ISOLATED_ROOT="$scratch"
export TMPDIR="$scratch" HOME="$scratch/user" HERMES_HOME="$scratch/home"
export XDG_CACHE_HOME="$scratch/cache" XDG_CONFIG_HOME="$scratch/config" XDG_DATA_HOME="$scratch/data"
unset PYTHONPATH PYTHONHOME
cd "$scratch/copy"
case "$mode" in
  python)
    "$uv" run --python 3.12 --with pytest --with 'aiortc>=1.15,<2' --with fastapi --with httpx --with uvicorn --with PyYAML --with pillow python -m pytest -q -p no:cacheprovider tests 2>&1 | tee "$scratch/logs/python.log"
    ;;
  gtk)
    GDK_BACKEND=wayland /usr/bin/python tools/native-bots-test.py 2>&1 | tee "$scratch/logs/gtk.log"
    GDK_BACKEND=wayland /usr/bin/python tests/native_bot_animation.py 2>&1 | tee "$scratch/logs/gtk-animation.log"
    ;;
  js)
    : "${TALK_TEST_DEPS:?Set TALK_TEST_DEPS to an existing isolated node_modules directory}"
    node --test --test-reporter=tap tools/{bot-tracker-test,pet-badge-test,pet-legacy-test,native-view-test,inapp-bots-test,companion-route-test,voice-lifecycle-test,voice-mic-test-test,pets-panel-test}.mjs tests/bot-animation-test.mjs 2>&1 | tee "$scratch/logs/js.log"
    ;;
  *) printf 'Usage: %s [python|gtk|js]\n' "$0" >&2; exit 2 ;;
esac
