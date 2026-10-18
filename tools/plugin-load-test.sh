#!/usr/bin/env bash
# Verify a Hermes Desktop plugin loads BEFORE packaging it.
#
# LESSON: node --check file.js can falsely pass ESM (different parse mode).
# A broken parenthesis once passed the check but prevented Desktop loading.
# Check module syntax (.mjs) AND import with React / jsx-runtime / SDK stubs
# to simulate the actual module load.
#
# Usage: bash plugin-load-test.sh [/path/to/plugin.js]
set -euo pipefail

PLUGIN="${1:-$(cd "$(dirname "$0")/.." && pwd)/desktop/plugin.js}"
TMP="${TMPDIR:-$HOME/.hermes/cache/scratch}/plugin-load-test"
rm -rf "$TMP" && mkdir -p "$TMP/node_modules/@hermes/plugin-sdk" "$TMP/node_modules/react"

cp "$PLUGIN" "$TMP/check.mjs"
if node --check "$TMP/check.mjs"; then
  echo "✓ ESM syntax (module mode) OK"
else
  echo "✗ ESM SYNTAX ERROR — do not package"; exit 1
fi

printf '{"type":"module"}\n' > "$TMP/package.json"
cat > "$TMP/node_modules/react/package.json" <<'EOF'
{"name":"react","type":"module","exports":{".":"./index.js","./jsx-runtime":"./jsx-runtime.js"}}
EOF
cat > "$TMP/node_modules/react/index.js" <<'EOF'
export const useState = (v) => [typeof v === 'function' ? v() : v, () => {}]
export const useEffect = () => {}
export const useRef = (v) => ({ current: v === undefined ? null : v })
EOF
cat > "$TMP/node_modules/react/jsx-runtime.js" <<'EOF'
export const jsx = () => null
export const jsxs = () => null
EOF
cat > "$TMP/node_modules/@hermes/plugin-sdk/package.json" <<'EOF'
{"name":"@hermes/plugin-sdk","type":"module","main":"index.js"}
EOF
cat > "$TMP/node_modules/@hermes/plugin-sdk/index.js" <<'EOF'
export const host = { state: {}, request: async () => {}, onEvent: () => () => {} }
export const useValue = (x) => x
export const Popover = () => null
export const PopoverContent = () => null
export const PopoverTrigger = () => null
export const Select = () => null
export const SelectContent = () => null
export const SelectItem = () => null
export const SelectTrigger = () => null
export const SelectValue = () => null
export const Switch = () => null
export const Button = () => null
EOF

cp "$PLUGIN" "$TMP/plugin-test.js"
node -e "
import('$TMP/plugin-test.js').then(m => {
  const id = m.default && m.default.id
  const reg = typeof (m.default && m.default.register)
  if (!id || reg !== 'function') { console.error('✗ module does not export {id, register()}'); process.exit(1) }
  console.log('✓ module imports OK — id:', id, '| register:', reg)
}).catch(e => { console.error('✗ LOAD ERROR:', String(e && e.stack || e).slice(0, 900)); process.exit(1) })
"
echo "✓ READY to package"
