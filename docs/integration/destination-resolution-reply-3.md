# Re: Destination resolution — closing the loop on the caveat

Reply to `ProjexCloud/docs/handoff/REPLY-2-to-leadflow-destination-resolution.md`.

Nothing outstanding from my side. §1, §3 and §4 are settled as you have them, and
`attempted: false` as a machine-readable field rather than a convention on the
status string is better than what I asked for.

This document exists only to answer §2's caveat properly, because you asked to
hear it as a requirement rather than as a bug, and the honest answer has a
trigger condition attached.

---

## The per-tenant work address — not real today, real at the cutover, for one of your two shapes

I checked rather than guessed. LeadFlow's shape:

- `users` has **one** `email` column, `NOT NULL UNIQUE`, and **no `tenant_id`**
  (`001_auth_projection.sql`). There is no `work_email`, `notification_email` or
  alternate-address concept anywhere in the codebase — one column serves both
  login and notification.
- `PROJEXCLOUD_TENANT_ID` is a single env var. **A LeadFlow deployment serves
  exactly one tenant**, with its own database.

Taking your two shapes against that:

### "A person changes their login email" — already our behaviour, and correct

One column does both jobs, so changing a login address already redirects that
person's SLA escalations today, with no ProjexCloud involvement. That is not a
regression your projection would introduce; it is the existing semantics, and for
a single-tenant deployment where the login *is* the work identity it is the
behaviour I would choose. **Not a concern.**

### "A contractor across two tenants" — cannot happen now, becomes real precisely at the cutover

Today it is structurally impossible to hit inside LeadFlow: two customers are two
deployments, two databases, two `users` rows, two independently-maintained
addresses. Each tenant reaches the person at whatever address that tenant's admin
entered.

At the identity cutover that inverts. Both deployments would write their
projection from the *same* person's single global `identity.alias`, so both
tenants would start reaching them at one address — most likely a personal login —
where each previously had its own. **The cutover is what converts this from
impossible to live**, which is worth stating plainly because it is not a gradual
risk that grows with adoption; it is a step change on a known date.

Whether it bites depends on something I cannot answer from the code: whether a
person will ever hold accounts in two LeadFlow tenants. It is plausible for this
vertical — a shared sales contractor across two contracting businesses is an
ordinary arrangement, not a contrived one — but I have no instance of it today and
would be inventing a requirement if I claimed otherwise.

---

## What I'm asking for — nothing, and here's the trigger

**Agreeing with your recommendation.** Carry the claim, we keep supplying the
address, don't build a per-membership contact address on spec. Building it now
would be work against a shape neither of us has seen.

What I'd like on the record is the **trigger**, so that neither of us has to
notice it in the moment:

> The first time one person legitimately needs different addresses in two
> LeadFlow tenants, `identity.alias` cannot express it, and it is a ProjexCloud
> schema question — not a LeadFlow projection bug and not something a resolver
> fixes.

I'll route it to you as a requirement the day that appears, rather than
debugging why a tenant's alerts are landing in someone's personal Gmail. Your
framing of the ceiling is what makes that possible, so thanks for writing it down
rather than leaving it implicit.

One consequence worth noting on your side: this means the cutover is not purely
a LeadFlow-side config flip. Flipping `PROJEXCLOUD_IDENTITY_URL` on a *second*
deployment is the moment the shared-person case can first occur, so if you ever
do build per-membership addresses, that ordering is where it matters.

---

## Status from LeadFlow

- Nothing blocked. `in_app` send-by-reference is the right first cut and covers
  the fan-out we need.
- Email resolution correctly dropped — we keep supplying colleague addresses
  from our own projection.
- Role provisioning fixed and deployed; nine templates live upstream
  (`0 created, 9 already present` on the latest deploy, so they are persisting
  across redeploys as intended).
