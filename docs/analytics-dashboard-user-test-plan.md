# Analytics Dashboard — user test plan and findings log

Task: **Conduct User Testing** (`0f069ccf-5cdb-4526-8512-c5ab50e36872`), feature
*Basic Analytics Dashboard*.

**Status of this document.** The protocol below is ready to run. No session with
a human participant has been held yet — this repository cannot recruit one, and
saying otherwise would put invented quotes into a decision record. What HAS been
done is the developer walkthrough: every task in the protocol was performed
against the running screen, and the defects that surfaced are recorded in
[Findings](#findings), fixed, and locked down with tests so they cannot come
back. The questions that genuinely need a person — whether the funnel reads
correctly to someone who did not build it — are listed as
[open](#open-until-a-participant-runs-it) and are the point of the first
session.

---

## What is being tested

`/app/analytics` answers two questions the operational screens deliberately do
not: **how fast are we responding**, and **where are we losing leads**. The
Capture Inbox shows which clocks need somebody right now; this screen shows
whether the queue as a whole is working, aggregated over a window the viewer
chooses.

The dashboard is therefore a success only if a participant can reach a *decision*
from it — "we are slow on live chat", "Tuesdays breach" — not merely read the
numbers back.

## Who to test with

Three to five participants is enough to surface the majority of usability
defects, and the mix matters more than the count. Draw from the LeadFlow actors:

| Participant | Why them | What they are expected to want |
|---|---|---|
| Sales representative | Lives in the Capture Inbox, visits this screen weekly | Their own queue: "am I slow?" |
| Sales manager | The primary audience | Comparison across reps and channels |
| Marketing operations | Owns the capture channels | `By source` above everything else |
| Operations lead | Owns the SLA policy | Breach rate, and whether it is trending |

At least one participant must be someone who has **never seen the screen**. A
person who has watched it being built cannot tell you whether the labels teach
themselves.

## Setup

1. Seed a window with real shape: several days of leads, a mix of sources, some
   routed and unanswered, some answered fast, a few breached. A dashboard tested
   against an empty database tests nothing — every figure reads `—` and the
   participant has no judgement to make.
2. Sign in as the participant's own persona, not as an admin.
3. Start on `/app` (the Capture Inbox), NOT on the dashboard. How they get to
   the screen is part of what is being tested.
4. Record the screen and the audio. Do not take notes instead — writing while
   moderating is how the interesting half of a comment gets lost.

## Moderating

Ask the participant to think aloud. When they go quiet, prompt with "what are
you looking at?" rather than "do you see the breach rate?" — the second names
the thing you are testing and destroys the answer.

**Never explain the screen during a task.** If they are stuck, that is the
result. Wait, let it be uncomfortable, then move on and explain afterwards.

## Tasks

Each task states what the participant is asked to do, the reading it is probing,
and what counts as success. Success is a decision or an unprompted correct
statement, never "they eventually found it".

### T1 — Get to the numbers

> "You want to know how the team did this month."

Probes: is the dashboard discoverable from the shell at all.

**Success:** they click **Analytics** in the sidebar without being told the
screen exists. **Failure:** they look in the Capture Inbox for a report, or ask
where it is.

### T2 — Read the headline

> "Tell me how we are doing on response time."

Probes: whether *median* and *90th percentile* mean anything without a legend,
and whether the participant understands that both are shown because the average
hides the tail.

**Success:** they quote the median and then say something about the p90 being
worse — the point of showing both. **Partial:** they read the median only.
**Failure:** they read the average and call it typical.

### T3 — The distinction that matters

> "What is the breach rate telling you?"

Probes the single most consequential label on the screen. It is computed over
clocks that have **closed**, not over every lead — a queue with fifty open
clocks and one breach is not at a 2% breach rate yet.

**Success:** they say the denominator is not "all leads", prompted only by the
caption. **Failure:** they read it as a share of everything captured, and would
therefore under-report the problem to their own manager.

### T4 — An empty window

> "Show me last week." (Choose a week with no leads.)

Probes the null-versus-zero decision end to end. Every rate becomes `—` and the
empty state appears.

**Success:** they say there is no data for that period. **Failure:** they read
the screen as "we responded to nothing" — a false alarm the em dash exists to
prevent.

### T5 — Narrow to themselves

> "How is your own queue doing, on live chat only?"

Probes whether the four filters read as filters and whether the participant
notices the numbers change.

**Success:** they set Owner and Source and comment on the change. **Failure:**
they change a filter and do not notice the aggregate moved — which would mean
the reload needs a visible indication.

### T6 — Find the worst channel

> "Which channel is letting us down?"

Probes the by-source table and the newly added sorting.

**Success:** they sort by Breached or by Avg response, unprompted, and name the
channel. **Partial:** they scan the rows by eye and get the right answer.
**Failure:** they cannot tell the columns apart.

### T7 — Come back tomorrow

> "Close the tab and open the dashboard again."

Probes preference persistence: the filters and sort from T5/T6 should still be
there.

**Success:** they do not remark on it at all. Persistence is correct when it is
invisible; a participant who notices it has usually noticed it going *wrong*.

### T8 — Somebody else works the queue

While the participant is on the screen, route or answer a lead from another
session.

**Success:** the numbers move and the participant sees the `Live` marker without
having pressed anything. **Failure:** they reach for a refresh button.

## Debrief

Three questions, in this order, after the tasks and never during them:

1. What would you do differently tomorrow because of this screen?
   *(If the answer is "nothing", the dashboard is decoration.)*
2. What number were you looking for that is not here?
3. Which number here would you not trust in front of your own manager, and why?

## Recording the outcome

For each finding: the task it came from, what the participant did, what they
expected, and the severity — **blocker** (they reached a wrong conclusion),
**friction** (right conclusion, slow or uncertain), or **polish**.

Anything that changes what a number *means* is a blocker even if only one
participant hit it, because the same misreading will reach a manager's report.
Anything that only one participant found awkward and the rest breezed past is
polish. Fixes land as code plus a test, so the finding cannot silently return —
that is what the entries below did.

---

## Findings

### From the developer walkthrough (2026-07-31)

| # | Task | Finding | Severity | Resolution |
|---|---|---|---|---|
| 1 | T6 | The by-source table could not be ordered at all. Finding the worst channel meant reading fourteen rows by eye, and the answer depended on which column you happened to be scanning. | Friction | Sortable column headers, defaulting to biggest-first on every count. Real buttons with `aria-sort`, so the ordering is reachable by keyboard and announced — a click-handler on the cell would have locked screen-reader users out. `client/tests/unit/analyticsView.test.ts` |
| 2 | T6 | A channel with nothing answered has a null average response. Sorted naively it would land at whichever end the null coerced to — top of "fastest" or top of "slowest". Both readings are wrong: the channel has no response time, not an extreme one. | **Blocker** | Nulls sort last in *both* directions. Asserted explicitly in both directions, because a one-directional test would have passed on the broken behaviour. |
| 3 | T7 | Filters reset on every visit. An operator who works one channel re-picked four controls every morning — the kind of friction that ends with the dashboard going unused. | Friction | The view (filters, sort, daily order) persists in `localStorage`, versioned. `Clear filters` also forgets the stored copy, so clearing is not undone by the next visit. |
| 4 | T7 | A stored view is untrusted input: it survives deployments and is editable in devtools. A stale channel or a renamed sort key would have reached the query string or the comparator. | **Blocker** | Every field is validated independently on read and falls back on its own, so one stale value costs that one choice. An inverted window is rejected as a *pair*, so reopening the screen can never greet the viewer with a 400. |
| 5 | T2 | The daily series ran oldest-first, so "what happened today" was at the bottom of up to a year of rows. | Friction | Newest-first by default, with the trend-line order one click away. |
| 6 | — | `basic-analytics-dashboard.feature` asserted the text *"Response times and conversion across the funnel"*; the screen says *"across the capture funnel"*. The scenario could never have passed. | **Blocker** (in the harness) | Assertion corrected against the rendered text; the scenario now also exercises the sort and the daily-order toggle. |
| 7 | T4 | The null-versus-zero rendering had no test of its own. It is the reading most likely to be broken by a well-meant "tidy up the formatting" change, and the failure is silent — `0.0%` looks entirely plausible. | Friction | `asPercent` / `asDuration` extracted to `client/src/utils/analyticsFormat.ts` and asserted in both directions: a null renders as an em dash and *contains no zero*, while a genuine measured zero still renders as `0.0%`. |

Findings 1–7 are fixed. The numbers themselves were already covered:
`server/tests/integration/analytics.test.ts` (16 cases) pins the funnel, the
rates, the closed-clock breach denominator and the arrival-based response time
against a controlled window, and `tests/api_definitions/analytics/overview-get.json`
covers the endpoint contract.

### Open until a participant runs it

These cannot be answered by anyone who knows how the screen was built:

- **T3** — does the breach-rate caption ("Of clocks that have closed, not of all
  leads") actually teach the denominator, or is it read as boilerplate? This is
  the finding most likely to be a blocker, and the least likely to be caught
  internally.
- **T2** — is *90th percentile* understood, or does it need naming as "the slow
  tail" in the label rather than the caption?
- **T5** — is the reload after a filter change visible enough, or does the screen
  appear frozen for the moment the aggregate takes?
- **Debrief Q2** — which number is missing. Every answer to this so far has come
  from people who chose what to build, which makes it worthless as evidence.
