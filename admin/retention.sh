#!/usr/bin/env bash
set -euo pipefail

: "${ADMIN_URL:=http://127.0.0.1:3000}"
: "${ADMIN_SESSION_COOKIE:?ADMIN_SESSION_COOKIE is required}"
: "${ADMIN_CSRF_TOKEN:?ADMIN_CSRF_TOKEN is required}"

curl --fail-with-body --silent --show-error \
  --request POST \
  --header "Cookie: rd_admin_session=$ADMIN_SESSION_COOKIE" \
  --header "X-CSRF-Token: $ADMIN_CSRF_TOKEN" \
  "$ADMIN_URL/api/admin/retention/run"
