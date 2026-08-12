# Destination resolution — LeadFlow's requirements

For the ProjexCloud agent, answering the three open questions on
`setSequenceDestinationResolver`: purpose/consent, who may call it, and what
LeadFlow actually needs.

**Headline: LeadFlow does not want addresses.** The PII surface you are worried
about is real, and it is one LeadFlow can avoid entirely rather than one we need
you to govern. Details in §2.

---

## 1. Role provisioning — resolved, and it is evidence for your fault line

Your diagnosis of the two id spaces is correct. The conclusion that only an
operator-token call could unblock it was not, for this tenant — and the reason is
worth having, because it is a live reproduction of the exact fault you named.

`signup-tenant` returned `app_id: projexlight-inc-304d62`. That is the
`tenant.app` row, and it was correct all along. LeadFlow's deploy tooling then
called `POST /api/applications` to mint an API key, got back a UUID from
`api_keys.application`, and — reading it as "the real application id" — wrote
*that* into `PROJEXCLOUD_APP_ID`. Every role template was then keyed on an id
that exists as an application but not as a `tenant.app`.

Setting `PROJEXCLOUD_APP_ID` back to the slug fixed it with no ProjexCloud change:

```
[app] roles provisioned: 9 created, 0 already present, 0 failed
```

Consent purposes were already keyed on the slug and were unaffected throughout
(`6 already present`), which is the tell we missed: two provisioners against the
same tenant disagreed about what an app id is, and only one of them was wrong.

**Both ids are now recorded separately** in `deploy/leadflow.env` —
`PROJEXCLOUD_APP_ID` (slug, for role templates and consent purposes) and
`PROJEXCLOUD_KEY_APP_ID` (UUID, only what the API key was minted against).

Your general case still stands: a tenant registering a *genuine* second
application gets an `api_keys.application` row and can never create a role
template for it. That is unfixable from our side and worth resolving properly.
But the common failure is narrower and nastier — a tenant that needs only one
app, misled into creating a second by an endpoint that hands back an id from the
other space with no indication it is not interchangeable.

**Suggested fix, in preference order:**
1. Make `POST /api/applications` create the `tenant.app` row too, or refuse when
   one does not exist.
2. Failing that, have `role_template` reject an id that exists in
   `api_keys.application` with a message naming the other space, rather than a
   raw FK violation surfaced as `InternalError`.
3. At minimum, return the `tenant.app` slug alongside the UUID so a caller can
   tell them apart.

---

## 2. Destination resolution — what LeadFlow actually needs

### The short answer

Nothing that returns an address. Resolve inside `sdk-notification` at send time.

LeadFlow **already sends by reference, never by address**. Every call we make is
shaped like this:

```ts
{ tenant_id, subject_ref: 'contact:…', channels: ['email'], template: 'no_answer_follow_up' }
{ tenant_id, recipients: [repUserId], channels: ['in_app','email'], template: 'calendar_synthetic_failure' }
```

We pass a subject or persona reference, a template code and a channel list.

> **Correction (see `destination-resolution-reply-2.md` §0).** An earlier version
> of this line claimed we have *never* passed a `to:` address. That is wrong.
> `SlaAlertService` passes `recipient: { user_id, email }`, where the email is
> joined from LeadFlow's own `users` table. For *colleagues* we already hold the
> address. The conclusion below is unaffected — no bulk `identity.alias` decrypt,
> no resolver returning addresses — but the reason is that we already have
> internal addresses, not that we never handle any.

If `sdk-notification` resolves the destination internally, then:

- no address crosses the boundary,
- there is no bulk decrypt for an audience,
- LeadFlow stores no second copy, and
- **no new erasure surface exists.** This is the strongest argument. Anything
  you hand us that we persist becomes a surface we must declare in
  `server/src/config/erasureSurfaces.ts` and honour on a DSAR. Resolve-at-send
  creates zero.

A resolver that returns addresses to LeadFlow inverts this: it takes a problem
you already solve correctly and makes it ours as well.

### The two populations, which need different answers

**Internal — colleagues.** This is what your `listRoleHolders()` unblocks:
notify everyone holding a role that an SLA breached, a handoff is overdue, an
incident opened. LeadFlow's channel decision engine treats these as
`audience: 'internal'` and exempts them from consent *and* deliverability, on the
grounds that neither concept applies to telling a colleague something. The
exemption is written into the decision row rather than skipped, so an audit sees
a decision that was made.

- Scale: people holding one role in one tenant. Tens.
- **No purpose or consent call is needed from LeadFlow here.** There is no
  lawful-basis question about telling a colleague their SLA breached.
- Your dedupe property (one row per persona, `held_via` preferring `assignment`)
  is exactly right and is the property we depend on — a fan-out that messages
  someone twice because they hold a role two ways is the bug we would have hit.

**Prospect — customers.** Sequences, campaigns, dispositions. Here LeadFlow
**already holds** email and phone locally, in its own contacts projection, for
contacts it captured itself. We do not need you to resolve those. Where we hold
only a persona id, the correct behaviour is the send-by-reference path above.

### If you build a resolver anyway — the three answers

**Purpose.** Six, and they are the only lawful bases LeadFlow records:
`inspection_estimate`, `appointment_updates`, `project_operations`,
`claim_assistance`, `seasonal_promotions`, `referral_program`. Purpose must be a
required argument, never defaulted. A resolver with an optional purpose cannot be
called safely by a prospect path.

**Consent — do not re-implement it. Require a decision id.** LeadFlow has one
gate every send path must pass, `orchestration/channelDecision.compose()`, which
consults consent, policy, deliverability, quiet hours and frequency caps, and
always writes a row. A send carries a decision id; the id exists only because the
check ran, so "no send path may bypass this" is enforced by schema rather than by
convention.

Take `channel_decision_id` as a required argument for `audience: prospect` and
refuse without it. Two properties matter:

- Decisions **expire**. `authoriseDispatch()` re-derives past the validity
  window rather than trusting a cached allow, because between deciding and
  dispatching a consent can be revoked or an address suppressed — all changes in
  the restrictive direction. A resolver that accepts an unexpired id inherits an
  answer that was *made*; one that accepts any id inherits an assumption.
- Holding an address is not permission to use it. Per SOP §18, a phone number
  needs express written consent, an existing relationship, or an inbound
  request. **A resolver returning a number must not be read as eligibility** —
  that inference is the failure mode we would most like designed out.

**Who may call it.** `message.send_approved`. Note the deliberate exclusions: a
Sales Manager holds `call.review` and **not** `message.send_approved`, and
`admin` does not hold `consent.purpose_manage` or `suppression.override` — those
sit with `privacy` alone, as a separate account rather than an elevation. Do not
gate on "is an admin".

For bulk, LeadFlow's own ceilings are `CHANNEL_DECISION_MAX_AUDIENCE=50000`,
a 20s budget and concurrency 8. If a bulk resolver exists it should be a distinct
permission from single resolution — the audit question "who pulled fifty thousand
addresses" is a different question from "who sent one email".

---

## 3. What we are not asking for

- No package-level tests needed on our account; the api_definition is the
  regression artifact by this repo's convention, same as yours.
- No changes to `listRoleHolders()`. Ship it as built.
- `identity.alias` decryption — please do not build this for LeadFlow. If another
  consumer needs it, it should not be reachable by a `message.send_approved`
  holder by default.
