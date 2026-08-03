# EVENT_TYPE_REGISTRY is closed to consuming apps — every tenant app's audit chain is empty

**For the ProjexCloud coding agent. Raised from LeadFlow integration, 3 Aug 2026.**
Companion to defect 6 in `docs/projexcloud-defects.md`. Same class as TK-4138: a
platform-level gap that blocks every vertical, not one app's mistake.

**Severity: high.** Not a crash, and that is what makes it expensive — nothing
fails, so nobody finds out. `appendAuditEntry` in a consuming app is required to
be non-throwing (a governed write must not fail because the ledger was briefly
unreachable), so a permanent rejection is indistinguishable from a transient one.
The app reports every governed action as recorded. The chain has nothing in it.

---

## Reproduction

```bash
curl -X POST $GW/api/audit/append \
  -H "Authorization: Bearer $TENANT_JWT" -H 'Content-Type: application/json' \
  -d '{"pool_index":"'"$TENANT"'","tenant_id":"'"$TENANT"'",
       "event_type":"capture.created","actor_kind":"human",
       "payload":{"actor_id":"persona-1"}}'

-> 400 {"error":"UnregisteredEventType",
        "details":["Unregistered event_type: capture.created.
                    Add it to EVENT_TYPE_REGISTRY first."]}
```

Raised from `packages/contracts/src/events.ts:606`, enforced at
`packages/sdk-audit/src/server/handlers/auditController.ts:47`.

**Measured, not sampled:**

| | count |
|---|---|
| `EVENT_TYPE_REGISTRY` entries | 294 |
| …ending in `.v<N>` | **294 / 294** |
| LeadFlow audit event names | 32 |
| …present in the registry | **0 / 32** |
| …ending in `.v<N>` | **0 / 32** |

---

## Root cause

`EVENT_TYPE_REGISTRY` (`packages/contracts/src/events.ts:53`) is a
**compile-time constant** in the contracts package:

```ts
export const EVENT_TYPE_REGISTRY: Record<string, EventTypeMetadata> = { ... }
```

`services/api-gateway/src/routes/events.ts` exposes exactly two routes over it,
both **read-only**:

- `GET /api/events/types` — list
- `GET /api/events/types/:type` — fetch one

There is **no write path**. A tenant app cannot add its own event types by any
supported means; the only way in is to edit the contracts package and redeploy
the platform.

**The constraint itself is right and should be kept.** OC-2 — producers reject
anything absent from the registry — is what stops an audit vocabulary becoming
unqueryable within a release, where `lead.routed`, `lead.route` and
`routing.applied` all appear and nobody can answer "how often was a lead
routed". LeadFlow enforces the same rule on itself for the same reason. **The
defect is not the closed vocabulary. It is that the vocabulary is closed to the
people who need to extend it, with no path in.**

---

## Why this is worse than it looks

1. **It fails silently by design.** The non-throwing append is correct — refusing
   a write after it committed would leave the caller told it did not happen. But
   it means a permanent contract rejection presents exactly like a blip.
2. **It falsifies a headline claim.** "Every governed action is audited" is
   currently false for any app on the platform. `docs/insignia/` scores
   "identity-bound access, default-deny, per-request authz" as PRESENT; for
   audit on tenant apps it is not.
3. **The nightly chain verification has nothing to verify.** An empty chain
   verifies clean. A green result therefore carries no information.
4. **It is not LeadFlow-specific.** Any vertical hits this on its first
   `append`. LeadFlow found it only because it had already built a closed
   vocabulary of its own and went looking for why the ledger was empty.

---

## Options considered

**A. Consumers reuse existing registry entries.** Rejected — the 294 entries are
platform-domain events (`vault.*`, `tenant.*`, `audit.*`). Mapping
`capture.promoted` onto one of them files a vertical's business event under a
platform name, which is worse than no entry: the row exists, is queryable, and
means something else. It would corrupt the ledger rather than leave a gap in it.

**B. Relax the check for unknown types.** Rejected — this is OC-2, and dropping
it re-creates the unqueryable-vocabulary problem the registry exists to prevent.
Do not weaken the constraint to fit the gap.

**C. Consumers PR their event types into `packages/contracts`.** Workable today
and worth documenting either way, but it couples every vertical's release to a
platform release. A vertical adding one audit event should not need a platform
deploy.

**D (recommended). A tenant-scoped registration endpoint,** with the same
metadata contract and the same validation, writing to a table the registry is
read through. The constant stays as the platform's own baseline; tenant types
extend it without touching it.

---

## Recommended shape

```
POST /api/events/types        (human JWT, tenant-scoped)
  { event_type, retention_class, conflict_policy,
    schema_state, compaction_policy, schema_version }
```

Design points that matter:

- **Tenant-scoped, not global.** One tenant registering `capture.created` must
  not define it for everyone. Resolution reads platform baseline first, then the
  tenant's own — so a tenant can never shadow a platform type.
- **Additive only.** Mirror the existing comment in `events.ts`
  ("Additive-only — never remove or mutate existing rows"). Registration creates;
  it does not redefine.
- **Validate the name against the convention** — `<domain>.<entity>.<verb>.v<N>`,
  which all 294 current entries follow. Reject anything else at registration,
  where the author can fix it, rather than at append time in production.
- **Same metadata, same enum validation.** `retention_class` on a tenant type has
  the same regulatory meaning as on a platform one.

---

## Also needed regardless of which option is chosen

**Document the naming convention.** `AGENTS.md` says nothing about event names,
and the version suffix is a schema-evolution decision an app should not discover
from a 400. All 294 registry entries end `.v<N>`; none of LeadFlow's 32 do,
because there was nothing to tell us. If consumers are expected to match the
convention, say so — ideally with the reason, since `.v1` is the hook that lets a
payload shape change without breaking historical queries.

**Improve the error.** `Add it to EVENT_TYPE_REGISTRY first` is actionable only
for someone with commit access to the contracts package. For a tenant-app author
it names a file they cannot reach and gives no alternative.

---

## Verification

1. A tenant app registers `capture.created.v1` and `POST /api/audit/append`
   accepts it.
2. `POST /api/audit/verify` over that pool returns a chain with entries in it —
   today it verifies an empty chain and reports success.
3. A tenant cannot register a name that collides with a platform baseline type.
4. A malformed name (`capture.created`, no version) is rejected at REGISTRATION
   with a message naming the convention.

## LeadFlow's side, once this lands

Rename the 32 names in `server/src/platform/audit/vocabulary.ts` to `.v1` and
register them at boot alongside the existing consent-purpose and role
provisioners, which are already idempotent and non-fatal for exactly this shape
of work. LeadFlow is not blocked on anything else: the append body was corrected
to `pool_index` / `event_type` / `payload` with `actor_kind: 'human'`, and it is
verified against the running gateway. Registration is the only thing missing.
