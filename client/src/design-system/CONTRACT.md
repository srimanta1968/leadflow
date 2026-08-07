# The design-system contract

What a screen may assume, what it must not do, and where each rule is enforced.

Every rule below is a **test**, not a convention. The reason is in the history:
this codebase already shipped a hand-typed second copy of the palette that had
drifted four tokens, four screens with their own `<table>` and their own empty
state, two dialogs rendering `className="modal xl"` against a `.modal` rule
defined nowhere, and three of four dialogs with no focus trap, no Escape and no
scroll lock. Every one of those passed review and passed CI. Conventions did not
stop them; the gates below do.

## The four rules

| Rule | Enforced by |
|---|---|
| No raw colour outside the design system | `tests/unit/designSystemGuard.test.ts` |
| No hand-rolled table | `tests/unit/designSystemGuard.test.ts` |
| No hand-rolled overlay | `tests/unit/designSystemGuard.test.ts` |
| No class the stylesheet does not define | `tests/unit/designSystemGuard.test.ts` |
| A story per component, per state | `tests/unit/storybookGate.test.tsx` |
| Zero axe violations, every story | `tests/unit/storybookGate.test.tsx` |
| Geometry matches the approved mockup | `tests/unit/storybookGate.test.tsx` |
| Markup has not drifted from its baseline | `tests/unit/storybookGate.test.tsx` |
| Keyboard behaviour of every overlay | `tests/unit/overlayAccessibility.test.tsx` |
| Colour drift and WCAG 2.2 AA contrast | `tests/unit/designTokens.test.ts` |

**These are tests rather than ESLint rules deliberately.** `npm run lint` in this
package runs `eslint src --ext ts,tsx`, and eslint is not installed — the script
fails with `'eslint' is not recognized`. A rule added there would never execute,
which is the same green-gate-guarding-nothing shape listed above. Put in the
suite, they run on every commit and on every CI job. If eslint is adopted later
they move across unchanged.

## Colour

`design-system/tokens.json` is the only file in this repository permitted to
contain a colour literal. It is the source for three consumers at once:

- `tailwind.config.js` reads it to build the theme,
- `scripts/build-tokens.mjs` emits `src/styles/tokens.generated.css` from it,
- `design-system/tokens.ts` wraps it for typed use in components.

Its values are the `:root` block of the approved mockup, and
`designTokens.test.ts` re-parses that file on every run, so drift in either
direction fails.

Use a token class (`text-text`, `bg-panel`, `border-line`). Where Tailwind cannot
reach — an SVG `stroke`, a canvas `strokeStyle` — use `cssVar('--blue')`. There
is no third option, and the hex gate has no exception list.

## Semantics, not colour

Components take a **role**, never a colour: `role="blocked"` rather than
`className="text-red"`. Red means blocked, gold means warning, green means
success, blue means in-progress, and that mapping lives in `tokens.json` under
`semantic`. Passing a colour directly is how the same red comes to mean "overdue"
on one screen and "deleted" on the next.

`KpiTile` takes `higherIsBetter` for the same reason. Response time going up is
bad; captures going up is good. Without it the arrow is green on half the rails,
and a green arrow on a worsening metric is worse than no arrow at all.

## Data

`<DataTable>` is the only table. It is virtualized, so a hundred-thousand-row
queue costs the same DOM as a fifty-row one, and it owns four states you must not
re-implement:

- `loading` — a skeleton, `role="status"`, `motion-safe` so it stops moving under
  `prefers-reduced-motion`.
- `error` — a failed read. **Takes precedence over `empty`**, because a fetch that
  threw leaves `rows` at `[]` and the table would otherwise say "Nothing to show"
  about data nobody managed to ask for.
- `empty` — genuinely no rows.
- `density` — `dense` is the triage density. An operator working a queue wants
  rows per screen, not whitespace.

Nulls sort **last** in both directions. "No response recorded" is not the fastest
response time.

Saved views store a **filter definition, never a result set**. A stored result
says "5" forever while the queue moves on.

## Overlays

`<Modal>` and `<Drawer>` are the only overlays. Both own, and you get for free:

- focus moved into the panel on open and **restored to the opener on close** —
  the half everyone omits, without which a keyboard user lands at the top of the
  document and has to find their place again;
- `Tab` and `Shift+Tab` cycling inside the panel, never reaching the page behind;
- `Escape` to close — **unless `dismissable={false}`**, because a governed
  confirmation that Escape dismisses is not a confirmation;
- body scroll lock that **restores the previous value** rather than blanking it.

`role="dialog"` anywhere outside `design-system/` fails the guard.

## Permission-denied is a first-class state

Not a disabled button. Every primitive's `PermissionDenied` story shows the same
shape: the action is **absent**, and the reason names the missing capability.

A disabled primary with no explanation is the most common way a permission
failure gets read as a broken screen. A control that 403s on click is worse
still — it teaches operators to click and wait, and it writes a denied attempt
into the audit log for somebody who was never going to be allowed one.

While a permission verdict is **in flight**, treat it as allowed. Rendering
denied-then-allowed swaps a `<span>` for an `<a>` under the cursor mid-click; that
is a real defect this codebase had, and it cost a browser suite half its passes.

## Evidence

An assertion row says where a value came from, how confident the system is, and,
when it lost, **why**. The `Assertion` type makes a superseded row without a
reason uncompilable, and the reason is quoted from the survivorship engine rather
than composed in the UI — a reason the UI invented would read as authoritative
while agreeing with nothing.

`confidence: null` means unscored and renders as `—`. It must never render as
`0%`, which says "we checked and it is worthless" rather than "nobody scored it".

Consent sits **alongside** the P0–P4 ladder, not inside it. A record can be fully
verified and still carry no permission to contact, and collapsing the two lets a
confident-looking rail imply a permission nobody granted.

## Motion

Anything decorative that moves is `motion-safe:`. Skeletons are the common case:
they carry no information, so they are the first thing that should stop moving
for somebody who asked their OS for less movement.

## Storybook

```
npm run storybook          # dev server on :6006
npm run build-storybook    # static build, tokens rebuilt first
```

Stories live beside their component as `<Component>.stories.tsx`. Six states are
required of every component story file: `Default`, `Loading`, `Empty`,
`ErrorState`, `PermissionDenied`, `Dense`. The first three get written anyway;
the last three are the ones that ship unexamined, which is exactly why the gate
names them.

The same files are the input to `storybookGate.test.tsx`. That is the point of
writing them in CSF rather than as test fixtures: a story exists to be looked at,
so it stays current, and pointing the gate at it means a state somebody adds for
review gets audited automatically.

### Baselines

`tests/baselines/design-system-stories.json` holds each story's rendered markup.
To re-record after an intended change:

```
UPDATE_BASELINES=1 npx vitest run tests/unit/storybookGate.test.tsx
```

**These are structural, not pixels.** jsdom does no layout, so nothing here can
claim a screenshot comparison. They catch an element, class, role or label
changing — the part a screenshot diff makes you eyeball anyway. The tie back to
the approved design is the geometry pin, which re-parses the mockup's own
stylesheet, plus the colour contract in `designTokens.test.ts`.

### Where we knowingly differ from the mockup

Three deviations, each asserted in `storybookGate.test.tsx` so that "correcting"
one back fails and makes you read the reason first:

- **Backdrop padding** 8px, not the mockup's 24px. The mockup pairs 24px with a
  96vw panel, which overflows horizontally below about 1200px — it is a
  fixed-width artboard and never rendered that case.
- **KPI rail gap** 16px, not 12px. The rail wraps to two and three columns below
  `xl`, where 12px reads as a rendering fault rather than a gutter.
- **Modal sizes `sm` / `xl` / `full`.** The mockup declares exactly one modal box,
  which is our `lg`. The other three are extensions for content it never showed,
  and are not claimed as its.
