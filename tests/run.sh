#!/usr/bin/env bash
# Runs every regression test: tests/*.cjs with node, then tests/server-*.py with python3.
# Prints a FAIL line for each failing test and exits non-zero if any failed.
cd "$(dirname "$0")/.." || exit 1

failed=0
for t in tests/*.cjs; do
  node "$t" || { echo "FAIL $t"; failed=1; }
done
for t in tests/server-*.py; do
  python3 "$t" || { echo "FAIL $t"; failed=1; }
done
exit "$failed"
