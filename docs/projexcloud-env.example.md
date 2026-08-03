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
# A token the gateway ACCEPTS as a bearer credential. A bare pk_live_ API key
# is refused with 403 — it is the client_secret for POST /api/auth/token, not a
# bearer credential in its own right.
PROJEXCLOUD_API_KEY=
PROJEXCLOUD_TENANT_ID=
PROJEXCLOUD_APP_ID=
PROJEXCLOUD_AUDIENCE=
PROJEXCLOUD_TEST_EMAIL=
PROJEXCLOUD_TEST_PASSWORD=
