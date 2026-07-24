#!/bin/bash
# ---------------------------------------------------------------------------
# Simulate an inbound Instagram DM against the local webhook.
# Mimics exactly what Meta POSTs (object=instagram) when a real user DMs your
# IG business account, signed with META_APP_SECRET so the dev server treats it
# as real.
#
# The sender IGSID was obtained from the IG conversations API (no webhook logs
# needed): GET /me/conversations?platform=instagram returns the participants.
#
# Usage:
#   ./scripts/simulate-ig-dm.sh "your message text"
#   SENDER_IGSID=1474847644133208 ./scripts/simulate-ig-dm.sh "hey"
#
# Env vars (override defaults):
#   IG_BUSINESS_ID  Your IG business account ID = webhook entry.id (recipient)
#   SENDER_IGSID    The lead's Instagram-scoped ID (from /me/conversations)
#   WEBHOOK_URL     Webhook endpoint (default: http://localhost:3000/...)
#   META_APP_SECRET Read from .env if exported; required to sign body
# ---------------------------------------------------------------------------

set -euo pipefail

if [ -f ".env" ]; then
  set -a
  # shellcheck disable=SC1091
  . .env
  set +a
fi

MESSAGE_TEXT="${1:-hey, interested in your trading course}"

# Defaults: SK Trades IG business account (page-linked ID) + shazim's real
# personal IG IGSID (@iamshazimkhan), so the AI reply is delivered to the real
# Instagram inbox.
IG_BUSINESS_ID="${IG_BUSINESS_ID:-17841445698923309}"
SENDER_IGSID="${SENDER_IGSID:-1474847644133208}"
WEBHOOK_URL="${WEBHOOK_URL:-http://localhost:3000/api/webhooks/instagram}"

if [ -z "${META_APP_SECRET:-}" ]; then
  echo "ERROR: META_APP_SECRET is not set (not found in .env)." >&2
  exit 1
fi

TS_MS=$(($(date +%s) * 1000))
MID="ig_local_$(date +%s)_$RANDOM"

# Build the payload exactly like Meta's real Instagram webhook
PAYLOAD=$(cat <<EOF
{"object":"instagram","entry":[{"id":"${IG_BUSINESS_ID}","time":${TS_MS},"messaging":[{"sender":{"id":"${SENDER_IGSID}"},"recipient":{"id":"${IG_BUSINESS_ID}"},"timestamp":${TS_MS},"message":{"mid":"${MID}","text":"${MESSAGE_TEXT}"}}]}]}
EOF
)

SIGNATURE="sha256=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "$META_APP_SECRET" -hex | awk '{print $2}')"

echo "→ POST ${WEBHOOK_URL}"
echo "  igBusinessId: ${IG_BUSINESS_ID}"
echo "  senderIGSID:  ${SENDER_IGSID}"
echo "  message:      ${MESSAGE_TEXT}"
echo "  signature:    ${SIGNATURE:0:20}..."
echo

curl -sS -X POST "${WEBHOOK_URL}" \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: ${SIGNATURE}" \
  --data "${PAYLOAD}"

echo
