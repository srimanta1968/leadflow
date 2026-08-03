# ProjexCloud defects found from LeadFlow integration

Found 3 Aug 2026 against the local gateway (`http://localhost:4000`, `projex-api-gateway`)
while wiring LeadFlow's boot-time provisioners. Reproductions are all HTTP, so
they run against any instance.

Two of these are ProjexCloud's; the third was LeadFlow's and is already fixed
here. They are listed together because the third is what made the first two
visible.

---

## 1. Every API key is permanently unauthorised — its persona is never created

**Severity: critical.** Machine-to-machine authentication cannot work at all.
This is not specific to LeadFlow's key: **629 of 629 keys** in the local database
are in this state.

`packages/sdk-api-keys/src/services/apiKeyService.ts:139`

```ts
const synthetic_persona_id = crypto.randomUUID();
```

The id is generated and written into `api_keys.key.synthetic_persona_id`, but no
corresponding row is ever inserted into `persona.persona`.

There is no foreign key on `api_keys.key.synthetic_persona_id`, so issuing the
key succeeds and looks entirely healthy. `persona.role_assignment.persona_id`
*does* have one — so the moment you try to grant the key a role, which
`AGENTS.md` correctly says is REQUIRED, it fails:

```
insert or update on table "role_assignment"
violates foreign key constraint "role_assignment_persona_id_fkey"   (23503)
```

And an ungranted persona 403s on every call, forever. The failure presents as
"my valid key returns 403", which `AGENTS.md:22` already anticipates — but the
remedy it prescribes is the thing that cannot execute.

### Reproduction

```bash
# 1. Mint a key (scopes is required and undocumented — see defect 3)
curl -X POST $GW/api/applications/$APPLICATION_ID/keys \
  -H "Authorization: Bearer $HUMAN_JWT" -H 'Content-Type: application/json' \
  -d '{"name":"probe","scopes":["crm"]}'
#    -> 201, returns synthetic_persona_id

# 2. That persona does not exist
curl -H "Authorization: Bearer $HUMAN_JWT" $GW/api/personas/$SYNTHETIC_PERSONA_ID
#    -> 404 NotFound

# 3. So it can never be granted anything
curl -X POST $GW/api/role-assignments \
  -H "Authorization: Bearer $HUMAN_JWT" -H 'Content-Type: application/json' \
  -d "{\"persona_id\":\"$SYNTHETIC_PERSONA_ID\",\"role_template_id\":\"$RT\"}"
#    -> 500  role_assignment_persona_id_fkey (23503)

# 4. And the key 403s whether sent directly or exchanged
curl -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $PK_KEY" $GW/api/role-templates
#    -> 403
curl -X POST $GW/api/auth/token -H 'Content-Type: application/json' \
  -d "{\"grant_type\":\"client_credentials\",\"client_id\":\"$APPLICATION_ID\",\"client_secret\":\"$PK_KEY\"}"
#    -> 200 access_token
curl -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $ACCESS_TOKEN" $GW/api/role-templates
#    -> 403   (exchange succeeds; authority still absent)
```

```sql
SELECT count(*) AS keys,
       count(p.persona_id) AS persona_exists,
       count(*) - count(p.persona_id) AS dangling
FROM api_keys.key k
LEFT JOIN persona.persona p ON p.persona_id = k.synthetic_persona_id;
-- 629 | 0 | 629
```

### Suggested fix

Create the persona row in the SAME transaction as the key, so the two cannot
diverge, and add the missing foreign key on
`api_keys.key.synthetic_persona_id` so this can never regress silently. A
backfill is needed for the 629 existing keys, or they stay unusable.

Worth deciding deliberately: a synthetic persona needs a tenant and probably a
membership to be meaningful, so "create the row" may be a slightly larger design
question than one INSERT. That is the argument for fixing it properly rather
than patching the symptom.

---

## 2. `POST /api/personas/{persona_id}/roles` does not exist

**Severity: high — the documentation prescribes an endpoint that 404s.**

`AGENTS.md` says, twice and in bold terms:

> `POST /api/personas/{persona_id}/roles`  <- REQUIRED. The key's synthetic
> persona has no grants until you add them, so every call 403s no matter how
> valid the key is.

`packages/sdk-persona/src/server/routes.ts:160` registers that path as **GET
only** — it lists a persona's roles. There is no POST.

```
POST /api/personas/{id}/roles
-> 404 {"message":"Route POST:/api/personas/.../roles not found"}
```

The actual grant is `POST /api/role-assignments` with
`{persona_id, role_template_id}` (`routes.ts:133`).

Anyone following the guide hits a 404, concludes the gateway is broken or their
id is wrong, and has no way to discover the real route short of reading the
source. Combined with defect 1 they then hit a 500 — two dead ends before
learning the mechanism does not work at all.

### Suggested fix

Correct `AGENTS.md` to name `POST /api/role-assignments`, or add the documented
alias. Prefer the alias if anything already depends on the documented shape.

---

## 3. `scopes` is required on key creation but absent from the guide

**Severity: low, but it is the first wall you hit.**

```
POST /api/applications/{id}/keys  {"name":"leadflow-server"}
-> 400 {"error":"ValidationError","details":["scopes must be a non-empty string array"]}
```

`AGENTS.md`'s walkthrough shows `POST /api/applications/{application_id}/keys`
with no body contract, so the first attempt always fails. Document the required
field and the valid values — the accepted set is not discoverable from the error.

---

## 4. `app_id` and `application_id` are different things (documentation gap)

Not a bug, but it cost real time and the failure mode is confusing.

- **`app_id`** — the tenant's app row (`tenant.app`), e.g. `leadflow-dev-af4bd2`.
  Goes in request bodies and the `x-app-id` header.
- **`application_id`** — the API-key client registration from
  `POST /api/applications`, a UUID. Used **only** as `client_id` in the
  client-credentials exchange.

Putting the application_id where app_id belongs fails at the database rather than
at validation:

```
POST /api/role-templates  {"app_id":"<application_id>", ...}
-> 400 insert or update on table "role_template"
       violates foreign key constraint "role_template_app_id_fkey"
```

A raw FK name is a poor error for what is a straightforward mix-up of two
similarly-named identifiers. Worth both a line in `AGENTS.md` and a friendlier
validation message.

---

## 5. (LeadFlow's own — FIXED) consent purpose payload was the wrong schema

Recorded here only because it is what made the above visible.

`server/src/platform/consent/purposeProvisioner.ts` was sending
`{key, label, description, service_necessary}` and getting:

```
400 ValidationError
    purpose_id is required
    app_id is required
    legal_basis must be one of consent, contract, legitimate-interest,
                               vital, public-task, legal-obligation
```

on every boot, for all six purposes. Nothing surfaced it because provisioning is
non-fatal by design — six errors scrolled past at every start and the app served
happily with no purposes registered upstream, which means a consent receipt
could not have been issued against any of them.

Fixed to send `purpose_id`, `app_id`, `description`, `legal_basis` and
`default_jurisdictions`. Note `serviceNecessary` maps to `legal_basis:
'contract'` rather than `'consent'` — a purpose needed to deliver what the
person asked for is Art.6 performance-of-contract, and calling it consent would
misstate the lawful basis for exactly the purposes a person cannot meaningfully
refuse.

---

## 6. LeadFlow's audit events cannot be appended — none are in EVENT_TYPE_REGISTRY

> **Written up as a task for the ProjexCloud agent:**
> `docs/projexcloud-task-event-registry.md` — with the measured counts
> (294/294 registry entries versioned, 0/32 LeadFlow events registered),
> the four options considered, and the recommended tenant-scoped
> registration endpoint. Same class as TK-4138: platform-level, blocks
> every vertical.

**Severity: high.** Every governed action LeadFlow records is rejected by
`POST /api/audit/append`, so the tamper-evident chain is empty while the app
reports the actions as recorded.

```
POST /api/audit/append {... "event_type":"capture.created" ...}
-> 400 {"error":"UnregisteredEventType",
        "details":["Unregistered event_type: capture.created. Add it to EVENT_TYPE_REGISTRY first."]}
```

`EVENT_TYPE_REGISTRY` (`packages/contracts/src/events.ts:53`) is a closed code
constant, and Opinionated Constraint OC-2 requires producers to reject anything
absent from it. That is a defensible design — an audit vocabulary anyone can
extend at the call site is unqueryable within a release, which is exactly why
LeadFlow keeps its own closed vocabulary too. The problem is that a consuming
app has **no way to register its own event types**: the registry ships in the
contracts package, so LeadFlow cannot add to it, and there is no registration
endpoint.

LeadFlow currently has 32 canonical event names
(`server/src/platform/audit/vocabulary.ts`) — `capture.created`, `lead.routed`,
`sla.policy.updated` and so on. None are registered, so none can be appended.

Two things are needed, and they are separable:

1. **A way for a tenant app to register its event types.** Either an endpoint
   (`POST /api/audit/event-types`) scoped to the tenant, or a documented
   contribution path into the contracts package. Without one, every vertical
   built on ProjexCloud hits this wall the first time it appends.
2. **Naming.** The registry convention is `<domain>.<entity>.<verb>.v<N>` —
   versioned, e.g. `tenant.bu.created.v1`. LeadFlow's names carry no version.
   If apps are expected to match the convention, say so in `AGENTS.md`; the
   version suffix is a schema-evolution decision an app should not discover from
   a 400.

Until then LeadFlow's `appendAuditEntry` degrades exactly as designed — it never
throws, logs loudly, and reports `delivered: false` — so no governed action
fails because of it. But the ledger stays empty, and the nightly chain
verification has nothing to verify.

### Also fixed on the LeadFlow side while finding this

The append body was the wrong shape entirely — flat, with the stamps at the top
level. sdk-audit wants `pool_index`, `event_type`, `payload`, and an
`actor_kind` from `human | service | agent` ('person' is rejected). Corrected in
`server/src/platform/audit/auditLog.ts`. That was ours, and it was hidden by the
same never-throws design: three separate 400s, none of which failed anything.

