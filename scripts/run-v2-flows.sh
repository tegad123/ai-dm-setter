#!/bin/bash
# Tega's six go-live runs for DAETRADEZ v2, driven locally, one fresh synthetic
# lead per flow, sequential (the turn driver snapshots ALL new AI messages).
# Output: /private/tmp/v2-flows/<n>-<name>.txt
set -uo pipefail
OUT=/private/tmp/v2-flows; mkdir -p "$OUT"
export WEBHOOK_BASE="${WEBHOOK_BASE:-http://localhost:3005}" WAIT_S="${WAIT_S:-150}" SETTLE_S="${SETTLE_S:-25}"
IMG="https://upload.wikimedia.org/wikipedia/commons/thumb/3/3f/JPEG_example_flower.jpg/320px-JPEG_example_flower.jpg"

run() { local n="$1" name="$2" sender="$3"; shift 3; echo "=== FLOW $n $name (sender $sender)" | tee "$OUT/$n-$name.txt"; ./scripts/drive-local-flow.sh "$sender" "$@" 2>&1 | tee -a "$OUT/$n-$name.txt"; }

run 1 happy-path 9100000000000051 "brand new to trading" "Houston" "make an extra 2k a month so i can quit my warehouse job" "no system really, i just guess off the news and lose" "yes send it"
run 2 already-in-markets 9100000000000052 "I'm in the markets" "Houston"
run 3 solicitation 9100000000000053 "JOIN MY TRADING CHANNEL"
run 4 distress 9100000000000054 "bro I lost all my capital gambling, my mom is old and I really need this"
run 5 no-signal 9100000000000055 "🔥" --image "$IMG"
run 6 decline 9100000000000056 "brand new to trading" "Houston" "make an extra 2k a month so i can quit my warehouse job" "no system really, i just guess off the news and lose" "no" "no"
echo "ALL FLOWS DONE"
