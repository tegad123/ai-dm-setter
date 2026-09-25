#!/bin/bash
# Drive a whole lead flow against the LOCAL webhook, one turn after another,
# on a fresh synthetic sender. Dev-only.
#
# Usage:
#   ./scripts/drive-local-flow.sh <senderId> "msg 1" "msg 2" ... ["--image" "<url>"]
#   PLATFORM=ig ./scripts/drive-local-flow.sh 9100000000000021 "hey" "..."
set -euo pipefail
SENDER="$1"; shift
export WEBHOOK_BASE="${WEBHOOK_BASE:-http://localhost:3005}"
export WAIT_S="${WAIT_S:-150}"
export NODE_PATH="$PWD/node_modules"
if [ "${PLATFORM:-fb}" = "ig" ]; then export SENDER_IGSID="$SENDER"; else export SENDER_PSID="$SENDER"; fi
while [ $# -gt 0 ]; do
  if [ "$1" = "--image" ]; then
    npx tsx scripts/drive-local-turn.ts --image "$2" 2>&1 | sed '/baseline/d; /dotenv/d'; shift 2
  else
    npx tsx scripts/drive-local-turn.ts "$1" 2>&1 | sed '/baseline/d; /dotenv/d'; shift
  fi
done
