#!/usr/bin/env bash
# Builds mods/file-editor/vendor/beautiful-mermaid.js and beautiful-mermaid.LICENSES.txt:
# beautiful-mermaid (MIT) with its layout engine elkjs (EPL-2.0) and entities (BSD-2-Clause),
# bundled into one ES module that Herdr's QuickJS loads. The Markdown preview draws ```mermaid
# blocks with it (mermaid.js). Only needed to rebuild (node, npm and the network).
#
#   vendor/beautiful-mermaid/build.sh
#
# The npm packages are used as published, except for what Herdr's QuickJS needs:
# - `window` is Herdr's, not a browser's: elkjs would take it as its global object (it has no
#   Math, Date, ...). `window` is undefined in the bundle and `global` is shim.js's object,
#   which inherits globalThis.
# - setTimeout throws (mods use cx.timer): elkjs's in-process worker only defers with
#   setTimeout(fn, 0), so shim.js runs those jobs at once and layout stays synchronous.
# - Object.prototype is frozen, and elkjs's java.lang.Object does `_.toString = ...`, which then
#   throws in strict code: the property is made writable on `_` first.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(cd "$HERE/../.." && pwd)/mods/file-editor/vendor"
BEAUTIFUL_MERMAID=1.1.3
ELKJS=0.11.1
ENTITIES=7.0.1
ESBUILD=0.24.2
for c in node npm; do command -v "$c" >/dev/null || { echo "build: $c is needed" >&2; exit 1; }; done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"
npm init -y >/dev/null
npm install --silent --no-audit --no-fund --save-exact \
  "beautiful-mermaid@$BEAUTIFUL_MERMAID" "elkjs@$ELKJS" "entities@$ENTITIES" "esbuild@$ESBUILD"
cp "$HERE/entry.js" "$HERE/shim.js" .

./node_modules/.bin/esbuild entry.js --bundle --format=esm --platform=neutral \
  --main-fields=module,main --target=es2020 --log-level=error \
  --define:window=undefined --define:global=__bm_global --inject:shim.js --outfile=bundle.js

node - bundle.js <<'JS'
const fs = require("fs");
const file = process.argv[2];
const text = fs.readFileSync(file, "utf8");
const re = /^(\s*)_\.toString = function\(\) \{/gm;
const hits = text.match(re) || [];
if (hits.length !== 1) throw new Error(`expected one "_.toString = function() {" in elkjs, found ${hits.length}`);
fs.writeFileSync(file, text.replace(re, (_m, indent) =>
  `${indent}Object.defineProperty(_, "toString", { writable: true, configurable: true, enumerable: false, value: void 0 });\n` +
  `${indent}_.toString = function() {`));
JS

BANNER="/* beautiful-mermaid $BEAUTIFUL_MERMAID (MIT, Craft Docs, github.com/lukilabs/beautiful-mermaid) with elkjs $ELKJS (EPL-2.0, github.com/kieler/elkjs, source at that tag) and entities $ENTITIES (BSD-2-Clause, Felix Böhm). Bundled for Herdr's QuickJS by vendor/beautiful-mermaid/build.sh, which says what it changes. Licenses: beautiful-mermaid.LICENSES.txt. */"
./node_modules/.bin/esbuild bundle.js --minify --format=esm --target=es2020 --log-level=error \
  --banner:js="$BANNER" --outfile=beautiful-mermaid.js

# It must draw (in Node; Herdr's QuickJS is checked by herdr-app check and in the app).
cp beautiful-mermaid.js smoke.mjs
node --input-type=module -e '
import { renderMermaidSVG } from "./smoke.mjs";
const svg = renderMermaidSVG("graph TD\n  A[Start] --> B{Ok?}\n  B -->|yes| C[Done]", { bg: "#000000", fg: "#ffffff" });
if (!svg.startsWith("<svg") || !svg.includes("Done")) throw new Error("the bundle does not draw");
'

{
  echo "Licenses of beautiful-mermaid.js, bundled for Herdr's QuickJS by vendor/beautiful-mermaid/build.sh."
  echo "elkjs is under the Eclipse Public License 2.0: its source is at https://github.com/kieler/elkjs"
  echo "(tag $ELKJS) and on npm (elkjs@$ELKJS); build.sh lists the changes made to it here."
  for pkg in "beautiful-mermaid@$BEAUTIFUL_MERMAID:beautiful-mermaid/LICENSE" "elkjs@$ELKJS:elkjs/LICENSE.md" "entities@$ENTITIES:entities/LICENSE"; do
    echo
    echo "================================================================================"
    echo "${pkg%%:*}"
    echo "================================================================================"
    echo
    cat "node_modules/${pkg#*:}"
  done
} > LICENSES.txt

mkdir -p "$OUT"
cp beautiful-mermaid.js "$OUT/beautiful-mermaid.js"
cp LICENSES.txt "$OUT/beautiful-mermaid.LICENSES.txt"
echo "built $OUT/beautiful-mermaid.js ($(wc -c < "$OUT/beautiful-mermaid.js" | tr -d ' ') bytes) and beautiful-mermaid.LICENSES.txt"
