#!/usr/bin/env bash
# Runs each test file in its own bun process.
#
# `bun test` normally runs every file in one process, and mock.module() writes
# into a process-global module registry that neither mock.restore() nor a
# cache-busting import specifier can undo. So a mock registered by one file
# leaks into every file discovered after it: routes/obs.test.ts stubs
# services/command-key, which meant services/command-key.test.ts was silently
# asserting against that stub instead of the real module.
#
# Per-file isolation costs a few seconds and makes the mocks mean what they say.
set -euo pipefail

failed=0

while IFS= read -r file; do
  echo "── $file"
  if ! bun test "$file"; then
    failed=1
  fi
done < <(find src -name '*.test.ts' | sort)

exit "$failed"
