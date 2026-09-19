#!/usr/bin/env bash
# PostToolUse(Write|Edit): syntax-check and lint edited JS files. Exit 2 feeds errors back to Claude.
f=$(jq -r '.tool_input.file_path // .tool_response.filePath // empty')
case "$f" in *.js) ;; *) exit 0 ;; esac
[ -f "$f" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
if ! out=$(node --check "$f" 2>&1); then echo "$out" >&2; exit 2; fi
case "$f" in */src/*|src/*)
  if [ -x node_modules/.bin/biome ]; then
    if ! out=$(node_modules/.bin/biome lint --max-diagnostics=10 "$f" 2>&1); then echo "$out" >&2; exit 2; fi
  fi ;;
esac
exit 0
