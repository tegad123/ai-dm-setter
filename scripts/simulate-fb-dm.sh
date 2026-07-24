#!/bin/bash
# ---------------------------------------------------------------------------
# Simulate an inbound Facebook Messenger DM against the local webhook.
# Mimics exactly what Meta POSTs when a real user messages your Page, then
# signs the body with META_APP_SECRET so the dev server treats it as real.
#
# Usage:
#   ./scripts/simulate-fb-dm.sh "your message text"
#   SENDER_PSID=8765432109876543 ./scripts/simulate-fb-dm.sh "hey"
#
# Env vars (override defaults):
#   PAGE_ID         Page that received the DM (default: shazim local page)
#   SENDER_PSID     Real Facebook user PSID sending the DM
#   WEBHOOK_URL     Webhook endpoint (default: http://localhost:3000/...)
#   META_APP_SECRET Read from .env if exported; required to sign body
# ---------------------------------------------------------------------------

set -euo pipefail

# Load .env if present so META_APP_SECRET is picked up automatically
if [ -f ".env" ]; then
  set -a
  # shellcheck disable=SC1091
  . .env
  set +a
fi

MESSAGE_TEXT="${1:-hey, interested in your trading course}"

# Defaults target SK Trades (prod page cloned to local) + shazim's real
# page-scoped PSID, so the AI reply is delivered to the real Messenger inbox.
PAGE_ID="${PAGE_ID:-1100557749811046}"
SENDER_PSID="${SENDER_PSID:-27262754836683290}"
WEBHOOK_URL="${WEBHOOK_URL:-http://localhost:3000/api/webhooks/facebook}"

if [ -z "${META_APP_SECRET:-}" ]; then
  echo "ERROR: META_APP_SECRET is not set (not found in .env)." >&2
  exit 1
fi

TS_MS=$(($(date +%s) * 1000))
MID="m_local_$(date +%s)_$RANDOM"

# Build the payload exactly like Meta's real Messenger webhook
PAYLOAD=$(cat <<EOF
{"object":"page","entry":[{"id":"${PAGE_ID}","time":${TS_MS},"messaging":[{"sender":{"id":"${SENDER_PSID}"},"recipient":{"id":"${PAGE_ID}"},"timestamp":${TS_MS},"message":{"mid":"${MID}","text":"${MESSAGE_TEXT}"}}]}]}
EOF
)

# HMAC-SHA256 signature, hex-encoded, prefixed with "sha256="
SIGNATURE="sha256=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "$META_APP_SECRET" -hex | awk '{print $2}')"

echo "→ POST ${WEBHOOK_URL}"
echo "  pageId:    ${PAGE_ID}"
echo "  senderPSID:${SENDER_PSID}"
echo "  message:   ${MESSAGE_TEXT}"
echo "  signature: ${SIGNATURE:0:20}..."
echo

curl -sS -X POST "${WEBHOOK_URL}" \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: ${SIGNATURE}" \
  --data "${PAYLOAD}"

echo
