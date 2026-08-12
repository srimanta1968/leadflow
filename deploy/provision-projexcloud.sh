#!/usr/bin/env bash
#
# Register LeadFlow with ProjexCloud and write the three credentials into
# leadflow.env.
#
# THE API KEY IS RETURNED EXACTLY ONCE. `POST /api/applications/:id/keys`
# answers with `data.plaintext` at creation and never again — the server keeps
# only a hash. Everything below is arranged around that single fact: the value
# is written to the env file in the same step that creates it, it is never
# echoed to the terminal or a log, and if the write fails the script says so
# loudly, because the alternative is a key that exists upstream and is
# unrecoverable here.
#
# RE-RUNNING MUST NOT CREATE A SECOND TENANT. That is the expensive mistake this
# script can make: signup-tenant is not idempotent, so a careless second run
# produces a duplicate tenant, a duplicate app and a live key nobody is using —
# and the seeded consent purposes and role templates then exist in two places.
# The guard below refuses to proceed if the env already holds real credentials.
#
# Usage:
#   export PC_EMAIL='srimanta.jana@projexlight.com'
#   export PC_PASSWORD='...'          # the ProjexCloud account password
#   ./provision-projexcloud.sh
#
set -euo pipefail

readonly GATEWAY="${PROJEXCLOUD_GATEWAY_URL:-https://cloud.projexlight.com}"
readonly ENV_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/leadflow.env"

readonly COMPANY="${PC_COMPANY:-Projexlight Inc}"
readonly REGION="${PC_REGION:-us-east-1}"
readonly GIVEN="${PC_GIVEN_NAME:-Srimanta}"
readonly FAMILY="${PC_FAMILY_NAME:-Jana}"
readonly APP_NAME="${PC_APP_NAME:-LeadFlow}"

c_info() { printf '\033[0;34m[provision]\033[0m %s\n' "$*"; }
c_ok()   { printf '\033[0;32m[ ok ]\033[0m %s\n' "$*"; }
c_die()  { printf '\033[0;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

# Read a JSON path without jq, which is not installed on the target host.
jget() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const v='$1'.split('.').reduce((o,k)=>o&&o[k],j);process.stdout.write(v==null?'':String(v))}catch(e){process.stdout.write('')}})"; }

# Rewrite KEY=value in place, appending when absent. Never prints the value.
set_env() {
  local key="$1" val="$2"
  [ -f "$ENV_FILE" ] || c_die "missing $ENV_FILE — copy leadflow.env.example first"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    # A temp file next to the target, then mv: an interrupted in-place edit
    # would leave the env half-written, and the key would be unrecoverable.
    local tmp="${ENV_FILE}.tmp.$$"
    awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k{print k "=" v; next} {print}' "$ENV_FILE" > "$tmp"
    mv "$tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

[ -n "${PC_EMAIL:-}" ]    || c_die "set PC_EMAIL"
[ -n "${PC_PASSWORD:-}" ] || c_die "set PC_PASSWORD"
[ -f "$ENV_FILE" ]        || c_die "missing $ENV_FILE — copy leadflow.env.example first"

# --- the duplicate-tenant guard ---------------------------------------------
existing_tenant="$(grep -E '^PROJEXCLOUD_TENANT_ID=' "$ENV_FILE" | cut -d= -f2- || true)"
if [ -n "$existing_tenant" ] && [ "$existing_tenant" != "CHANGE_ME" ]; then
  c_die "PROJEXCLOUD_TENANT_ID is already set to '$existing_tenant'.
       Re-running would create a SECOND tenant and a second app, and the consent
       purposes and role templates LeadFlow seeds at boot would then exist in
       two places. Clear it deliberately if you really want a new tenant."
fi

curl -fsS -m 10 "$GATEWAY/health" >/dev/null || c_die "$GATEWAY is not answering"
c_ok "gateway reachable"

# --- 1. tenant + first person ------------------------------------------------
c_info "registering tenant '$COMPANY' for $PC_EMAIL"
signup="$(curl -sS -m 30 -X POST "$GATEWAY/api/auth/signup-tenant" \
  -H 'Content-Type: application/json' \
  -d "$(node -e "process.stdout.write(JSON.stringify({
        email: process.env.PC_EMAIL, password: process.env.PC_PASSWORD,
        company_name: '$COMPANY', region: '$REGION',
        given_name: '$GIVEN', family_name: '$FAMILY',
        display_name: '$GIVEN $FAMILY'
      }))")" )"

TOKEN="$(printf '%s' "$signup" | jget 'data.token')"
TENANT_ID="$(printf '%s' "$signup" | jget 'data.tenant_id')"
APP_ID="$(printf '%s' "$signup" | jget 'data.app_id')"

[ -n "$TOKEN" ] || c_die "signup-tenant returned no token. Response: $(printf '%s' "$signup" | head -c 300)"
[ -n "$TENANT_ID" ] || c_die "signup-tenant returned no tenant_id. Response: $(printf '%s' "$signup" | head -c 300)"
c_ok "tenant $TENANT_ID"

# --- 2. the application ------------------------------------------------------
# signup-tenant may already create a default app. Reuse it rather than making a
# second one — two apps under one tenant means two sets of role templates and a
# coin-flip about which the gateway scopes by.
if [ -z "$APP_ID" ]; then
  c_info "creating application '$APP_NAME'"
  app="$(curl -sS -m 30 -X POST "$GATEWAY/api/applications" \
    -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
    -d "{\"name\":\"$APP_NAME\",\"environment\":\"live\",\"description\":\"Server-to-server calls from the LeadFlow backend\"}")"
  APP_ID="$(printf '%s' "$app" | jget 'data.application.application_id')"
  [ -n "$APP_ID" ] || c_die "application create returned no id. Response: $(printf '%s' "$app" | head -c 300)"
  c_ok "application $APP_ID"
else
  c_ok "reusing application $APP_ID from signup"
fi

# --- 3. the API key ----------------------------------------------------------
# Written to the env IMMEDIATELY. The plaintext exists only in this response.
c_info "minting API key (returned once — writing straight to the env file)"
key="$(curl -sS -m 30 -X POST "$GATEWAY/api/applications/$APP_ID/keys" \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"leadflow-staging","rate_limit_rpm":600}')"

API_KEY="$(printf '%s' "$key" | jget 'data.plaintext')"
KEY_ID="$(printf '%s' "$key" | jget 'data.key.key_id')"
if [ -z "$API_KEY" ]; then
  c_die "key create returned no plaintext. Response: $(printf '%s' "$key" | head -c 300)
       If a key WAS created upstream, revoke it before retrying — its plaintext
       cannot be recovered and it would sit live and unused."
fi

set_env PROJEXCLOUD_TENANT_ID "$TENANT_ID"
set_env PROJEXCLOUD_APP_ID    "$APP_ID"
set_env PROJEXCLOUD_API_KEY   "$API_KEY"
set_env PROJEXCLOUD_GATEWAY_URL "$GATEWAY"
# The key id, not the key — so a future rotation has something to revoke.
set_env PROJEXCLOUD_API_KEY_ID "$KEY_ID"

c_ok "credentials written to $ENV_FILE (key id $KEY_ID; the key itself is not printed)"

chmod 600 "$ENV_FILE" 2>/dev/null || true

cat <<EOF

  Registered
    tenant       $TENANT_ID
    application  $APP_ID
    key id       $KEY_ID
    owner        $GIVEN $FAMILY <$PC_EMAIL>

  Next:  ./deploy.sh deploy        (preflight will now find no CHANGE_ME)
         ./deploy.sh restart       if it was already running

EOF
