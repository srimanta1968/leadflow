# ProjexCloud gateway — template. Copy to .env.local (local gateway) or
# .env.cloud (hosted), then fill in. Both are gitignored; this file is not and
# must never contain a real value.
#
# Obtain a tenant-scoped credential:
#   curl -X POST $PROJEXCLOUD_GATEWAY_URL/api/auth/signup-tenant \
#     -H 'Content-Type: application/json' \
#     -d '{"email":"...","password":"...","company_name":"...","first_name":"...","last_name":"..."}'
#
# The signup response carries tenant_id, app_id and a TENANT-SCOPED token.
# Use that token. The token from POST /api/auth/login carries tenant_id: null
# and every tenant-scoped route refuses it.

PROJEXCLOUD_GATEWAY_URL=http://localhost:4000
PROJEXCLOUD_IDENTITY_URL=http://localhost:4000
# Either a token the gateway accepts as a bearer credential, or a pk_live_/
# pk_test_ API key. A bare key is refused with 403 if sent directly, so the
# client exchanges one for a short-lived token via POST /api/auth/token before
# calling — but note that the exchanged token's synthetic persona starts with NO
# role grants, so calls keep 403ing until POST /api/personas/{id}/roles is run.
# A valid key plus a successful exchange plus 403 is an ungranted persona, not a
# broken key.
PROJEXCLOUD_API_KEY=
# The tenant records are written under. App-scoped: a ProjexCloud tenant row has
# a NOT NULL app_id, so it belongs to exactly ONE app.
PROJEXCLOUD_TENANT_ID=
# The CUSTOMER, set only once they own more than one app — then it is the root
# tenant and PROJEXCLOUD_TENANT_ID is the child tenant for this app. Leave empty
# for a single-app customer, where the two are the same row. Billing and the org
# chart scope here; leads, routing, SLA, consent and audit scope to the child.
PROJEXCLOUD_ROOT_TENANT_ID=
PROJEXCLOUD_APP_ID=
PROJEXCLOUD_AUDIENCE=
PROJEXCLOUD_TEST_EMAIL=
PROJEXCLOUD_TEST_PASSWORD=
