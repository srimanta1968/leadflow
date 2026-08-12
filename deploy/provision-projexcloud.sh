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
# Strip an inline comment and surrounding whitespace before comparing. The
# example file used to carry `KEY=CHANGE_ME   # REQUIRED ...`, so a raw cut
# yielded the comment too, never equalled "CHANGE_ME", and this guard fired on
# a FRESH env — blocking the very first run it exists to protect.
existing_tenant="$(grep -E '^PROJEXCLOUD_TENANT_ID=' "$ENV_FILE" | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//' | xargs || true)"
existing_app="$(grep -E '^PROJEXCLOUD_APP_ID=' "$ENV_FILE" | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//' | xargs || true)"
existing_key="$(grep -E '^PROJEXCLOUD_API_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//' | xargs || true)"

# A key already in hand means there is nothing left to do. Minting a second one
# is not destructive the way a duplicate tenant is, but it leaves a live
# credential nobody tracks, so it takes a deliberate clearing of the field.
if [ -n "$existing_key" ] && [ "$existing_key" != "CHANGE_ME" ]; then
  c_die "PROJEXCLOUD_API_KEY is already set. Clear it deliberately to mint a replacement,
       and revoke the old key upstream once the new one is deployed."
fi

# KEY-ONLY MODE. The tenant already exists, so signing up again would create a
# SECOND tenant and a second app — and the consent purposes and role templates
# LeadFlow seeds at boot would then exist in two places. Sign IN instead and
# carry on to the key. This is the path taken when a previous run registered the
# tenant but failed before the key was written.
RESUME=0
if [ -n "$existing_tenant" ] && [ "$existing_tenant" != "CHANGE_ME" ]; then
  RESUME=1
fi

curl -fsS -m 10 "$GATEWAY/health" >/dev/null || c_die "$GATEWAY is not answering"
c_ok "gateway reachable"

# --- 1. tenant + first person ------------------------------------------------
if [ "$RESUME" = "1" ]; then
  # tenant_id MUST be in the login body. Without it the issued token carries
  # tenant_id: null and the keys endpoint refuses it — the header X-Tenant-Id is
  # not consulted, only the claim.
  c_info "tenant $existing_tenant already registered — signing in rather than signing up"
  login="$(curl -sS -m 30 -X POST "$GATEWAY/api/auth/login"     -H 'Content-Type: application/json'     -d "$(node -e "process.stdout.write(JSON.stringify({
          email: process.env.PC_EMAIL, password: process.env.PC_PASSWORD,
          tenant_id: '$existing_tenant'
        }))")" )"
  TOKEN="$(printf '%s' "$login" | jget 'data.token')"
  TENANT_ID="$existing_tenant"
  APP_ID="$existing_app"
  [ -n "$TOKEN" ] || c_die "login failed for $PC_EMAIL. Response: $(printf '%s' "$login" | head -c 300)"
  c_ok "signed in to tenant $TENANT_ID"
else
  c_info "registering tenant '$COMPANY' for $PC_EMAIL"
  signup="$(curl -sS -m 30 -X POST "$GATEWAY/api/auth/signup-tenant"     -H 'Content-Type: application/json'     -d "$(node -e "process.stdout.write(JSON.stringify({
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

  # WRITE THE IDS BEFORE MINTING THE KEY. The tenant is the expensive, one-way
  # side effect; if the key step then fails, these two values are what let the
  # next run resume instead of registering a second tenant.
  set_env PROJEXCLOUD_TENANT_ID "$TENANT_ID"
  [ -n "$APP_ID" ] && set_env PROJEXCLOUD_APP_ID "$APP_ID"
fi

# --- 2. the application ------------------------------------------------------
# signup-tenant answers with an `app_id` that is a SLUG (projexlight-inc-304d62),
# not an application record. The keys endpoint takes the application UUID and
# the database rejects anything else with `invalid input syntax for type uuid`,
# surfaced to the caller only as InternalError. So the slug is never usable
# here: look up the real application, and create it when there is none.
is_uuid() { printf '%s' "$1" | grep -qiE '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; }

if ! is_uuid "${APP_ID:-}"; then
  c_info "resolving application '$APP_NAME' (signup returned a slug, not a UUID)"
  apps="$(curl -sS -m 30 "$GATEWAY/api/applications" -H "Authorization: Bearer $TOKEN")"
  APP_ID="$(printf '%s' "$apps" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const a=(JSON.parse(s).data||{}).applications||[];const m=a.find(x=>x.name==='$APP_NAME')||a[0];process.stdout.write(m&&(m.application_id||m.id)||'')}catch(e){process.stdout.write('')}})")"

  if [ -z "$APP_ID" ]; then
    c_info "creating application '$APP_NAME'"
    app="$(curl -sS -m 30 -X POST "$GATEWAY/api/applications"       -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN"       -d "{\"tenant_id\":\"$TENANT_ID\",\"name\":\"$APP_NAME\",\"environment\":\"live\",\"description\":\"Server-to-server calls from the LeadFlow backend\"}")"
    APP_ID="$(printf '%s' "$app" | jget 'data.application.application_id')"
    [ -n "$APP_ID" ] || APP_ID="$(printf '%s' "$app" | jget 'data.application_id')"
    [ -n "$APP_ID" ] || c_die "application create returned no id. Response: $(printf '%s' "$app" | head -c 300)"
    c_ok "application $APP_ID created"
  else
    c_ok "reusing existing application $APP_ID"
  fi

  is_uuid "$APP_ID" || c_die "application id '$APP_ID' is not a UUID; the keys endpoint would fail on it"
  # Persist before the key step: if minting fails, the next run must not go
  # looking for the application again.
  set_env PROJEXCLOUD_APP_ID "$APP_ID"
else
  c_ok "application $APP_ID"
fi

# --- 3. the API key ----------------------------------------------------------
# Written to the env IMMEDIATELY. The plaintext exists only in this response.
readonly KEY_NAME="${PC_KEY_NAME:-leadflow-production}"
c_info "minting API key '$KEY_NAME' (returned once — writing straight to the env file)"
key="$(curl -sS -m 30 -X POST "$GATEWAY/api/applications/$APP_ID/keys" \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d "$(node -e "process.stdout.write(JSON.stringify({
        tenant_id: '$TENANT_ID', name: '$KEY_NAME',
        scopes: ['*'], rate_limit_rpm: 600
      }))")" )"

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
