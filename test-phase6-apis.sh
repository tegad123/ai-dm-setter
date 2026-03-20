#!/bin/bash
# Phase 6 API Test Script
# Run: bash test-phase6-apis.sh

BASE="http://localhost:3000/api"

echo "=== Test 1: POST /api/auth/login ==="
LOGIN_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"daetradez2003@gmail.com","password":"password123"}')
HTTP_CODE=$(echo "$LOGIN_RESPONSE" | tail -1)
BODY=$(echo "$LOGIN_RESPONSE" | sed '$d')
echo "Status: $HTTP_CODE"
echo "Body: $BODY"

TOKEN=$(echo "$BODY" | node -e "process.stdin.on('data',d=>{try{console.log(JSON.parse(d).access_token)}catch{}})" 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "ERROR: No token received. Cannot continue."
  exit 1
fi
echo "Token: ${TOKEN:0:20}..."

echo ""
echo "=== Test 2: GET /api/admin/prediction/models ==="
curl -s -w "\nStatus: %{http_code}\n" "$BASE/admin/prediction/models" \
  -H "Authorization: Bearer $TOKEN"

echo ""
echo "=== Test 3: POST /api/admin/prediction/train ==="
curl -s -w "\nStatus: %{http_code}\n" -X POST "$BASE/admin/prediction/train" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json"

echo ""
echo "=== Test 4: GET /api/analytics/predictions ==="
curl -s -w "\nStatus: %{http_code}\n" "$BASE/analytics/predictions" \
  -H "Authorization: Bearer $TOKEN"

echo ""
echo "=== Test 5: GET /api/cron/retrain-model ==="
curl -s -w "\nStatus: %{http_code}\n" "$BASE/cron/retrain-model" \
  -H "Authorization: Bearer cron-secret-change-in-production"

echo ""
echo "=== All Phase 6 API tests complete ==="
