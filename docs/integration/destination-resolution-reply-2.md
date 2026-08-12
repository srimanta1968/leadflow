# Re: Destination resolution — accepted, generalised

Answering §4, and correcting one thing I got wrong in my §2.

---

## 0 · A correction I owe you first

I wrote "we have never passed a `to:` address". **That is not true**, and you
would have found it the moment you looked at our send calls.

`SlaAlertService` passes an address today:

```ts
recipient: { user_id: row.recipient_user_id, email: row.recipient_email ?? null }
```

`recipient_email` is `u.email` joined from **LeadFlow's own `users` table** — the
local credential store. So for *colleagues*, LeadFlow already holds the address
and hands it over.

The conclusion survives — no bulk `identity.alias` decrypt, no resolver returning
addresses, no new erasure surface — but the reason is different from the one I
gave, and it changes the answer to your first question. Sorry for sending you
off with a cleaner story than the code supports.

---

## 1 · Which channels must resolve at send — `in_app` only, and not for the reason you'd expect

**Ship `in_app` first. `email` resolution is not load-bearing on day one.**

Not because email doesn't matter — SLA breach escalation to a manager goes out
over email and it is the most important internal notification we send. It isn't
load-bearing because **we already have the address**, per §0. Internal recipients
are rows in our `users` table; we join the email and pass it.

So on day one:

| Channel | Internal recipients | Needs your resolution? |
|---|---|---|
| `in_app` | `persona_id` is the address | No — nothing to resolve |
| `email` | we join `users.email` and pass it | No — we supply it |

**Where it becomes load-bearing: the identity cutover.** When
`PROJEXCLOUD_IDENTITY_URL` is set, our `users` table stops being a credential
store and becomes a projection written only from verified platform claims. If
that projection carries `email`, we keep supplying it and never need resolution.
If it doesn't, every internal email send loses its address on the same day
authentication moves — and that is a bad day to discover it.

**So the real question is not "when do you build email resolution" but "does the
identity projection carry an email claim".** If yes, you may not need email
resolution for us at all. If no, it needs to land *before* the cutover, not
after. Worth deciding that explicitly rather than letting the sequencing pick it.

`{ kind: "address", channel, destination }` in your §3.2 already covers what we
do today, unchanged — so our current path keeps working through all of this.

---

## 2 · `no_destination` — observable, and it must not be an attempt

**Observable. We will not re-drive, and we do not want a fallback.**

We already have one, structurally. `SlaAlertService` writes the alert row **first**
and attempts the outbound notification **second**, so a delivery failure degrades
the channel rather than silencing the escalation — the alert is durable and
visible in-app before any gateway is called. In-app is not a fallback we would
select; it has already happened by the time you answer.

**One hard requirement, and it is the only thing I need from this semantics:**

> `no_destination` must not count as a delivery attempt.

Our ledger has an `attempts` counter and marks an alert `failed` after a fixed
number. We already distinguish "no gateway to fail against" from a real failure,
precisely so an unconfigured gateway doesn't burn the retry budget.
`no_destination` is a third thing — not a failure, not an absent gateway, but
*nobody reachable* — and retrying it can only produce the same answer. If it
consumes attempts, the alert lands in `failed`, and `failed` in our ledger reads
as "the escalation was not delivered" when in fact the in-app record was written
and is on the manager's screen. That turns an honest ledger into a misleading one,
which is the specific failure your `status: "no_destination"` design is trying to
prevent.

Return it per-channel in one call as you have it. We will record it distinctly
rather than act on it — it is exactly the material our ledger needs to answer
"was anyone actually told, and how?" honestly.

---

## 3 · On the generalisation — agreed, with one simplification for us

Your three-mode `authorization` envelope is right, and better than making
`channel_decision_id` mandatory. Two notes:

**We only need `delegated`. We will never send `exempt`.** Our internal exemption
is already recorded *as a decision* — `compose({ audience: 'internal' })` runs the
composer, records `INTERNAL_RECIPIENT` as a stated reason, and returns a decision
id, because an exemption that appears in the ledger is the point. So even our
colleague notifications arrive with a `decision_ref` and an `expires_at`. Your
`exempt` mode is for apps without a composer; we are not one. That means the
`delegated` re-check path is the *only* one we exercise, and it is worth knowing
it will carry our whole volume rather than being an edge case.

**"Inherited, not trusted" — yes, and please keep the asymmetry explicit.** Your
wording is that the platform may only ever narrow: turn our `send` into
`suppressed`, never a `deny` into a send. That asymmetry is the property, not an
implementation detail. If it is ever expressed as "re-evaluate and take the newer
answer", it will eventually widen one, and no test will catch it because widening
looks like working.

**Bulk:** agreed that with no addresses returned the risk is fan-out, not
disclosure. A 400 naming the ceiling rather than a truncated send is the right
call — a silently truncated audience and a silent drop are the same bug wearing
different clothes. Our own ceiling is 50,000 with a 20s budget, for reference.

**Permissions:** agreed, and I was wrong to hand you `message.send_approved` as
though it were portable. It is our vocabulary. Platform gates on its own scope,
carries `on_behalf_of` for the audit, app enforces its own finer permission before
calling — that is the correct seam.

---

## 4 · On §1 — declining (1) is right

Your reason for not auto-creating `tenant.app` per credential holder is better
than my suggestion. One product app with several credential holders (live/test,
one key per consumer) is a legitimate and normal shape, and manufacturing product
apps as a side effect of key management would widen the fault line rather than
close it. (2) and (3) address what actually bit us: not a missing row, but an
endpoint handing back an id from the other space with nothing marking it as
non-interchangeable.

Our side is fixed and committed — both ids kept under separate names,
`PROJEXCLOUD_APP_ID` (slug) never overwritten by `PROJEXCLOUD_KEY_APP_ID` (UUID).

---

## Summary of what I need

1. **`in_app` first is fine.** Email resolution is not day-one blocking.
2. **Tell me whether the identity projection will carry an email claim** — that,
   not a build order, decides whether you need email resolution for us at all.
3. **`no_destination` must not consume a delivery attempt.**

Nothing else blocks us. `listRoleHolders()` as built covers the fan-out.
