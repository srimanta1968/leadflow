// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { composeStories } from '@storybook/react';
import axe from 'axe-core';
import fs from 'fs';
import path from 'path';

/**
 * The Storybook gate: coverage, accessibility and drift, over the SAME story
 * files Storybook itself renders.
 *
 * Writing the states in CSF rather than as test fixtures is the whole point. A
 * story exists to be looked at, so it gets written and kept current; a fixture
 * exists to be asserted on, so it rots. Pointing the gate at the stories means a
 * state somebody adds for review is audited automatically, and a state nobody
 * wrote is a failure rather than a silence.
 *
 * WHAT EACH SECTION IS FOR, against the task's four criteria:
 *
 *   1. "Storybook covers every component and state" — a design-system file that
 *      exports a component must have a sibling .stories.tsx, and every component
 *      story file must carry all six states. Exceptions are typed out.
 *   2. "axe passes with zero violations across all stories" — every composed
 *      story is rendered and audited here, in CI, rather than in a browser panel
 *      somebody has to remember to open.
 *   3. "Visual regression baselines pinned to the approved mockup" — two halves.
 *      The mockup's own geometry declarations are parsed out of its stylesheet
 *      and compared with the classes the components actually carry; and every
 *      story's rendered markup is diffed against a committed baseline.
 *   4. Lint rules — tests/unit/designSystemGuard.test.ts.
 *
 * WHAT THE BASELINES ARE NOT: pixels. jsdom does no layout, so nothing here can
 * claim a screenshot comparison. They catch STRUCTURAL drift — an element, a
 * class, a role or a label changing — which is the part a screenshot diff makes
 * you eyeball anyway. The geometry pins below are what tie the structure back to
 * the approved design, and the colour half of that contract is already asserted
 * against the same file in designTokens.test.ts.
 */

const SRC = path.resolve(__dirname, '../../src');
const DESIGN_SYSTEM = path.join(SRC, 'design-system');
const MOCKUP = path.resolve(__dirname, '../../../docs/Prd/lynkeduppro_contact_workflow_studio (1).html');
const BASELINE = path.resolve(__dirname, '../baselines/design-system-stories.json');

afterEach(cleanup);

/* --------------------------------------------------------------- discovery */

const modules = import.meta.glob('../../src/design-system/**/*.stories.tsx', { eager: true }) as Record<
  string,
  Record<string, unknown>
>;

/** Every story in every file, as [id, Component]. */
const ALL_STORIES: [string, React.ComponentType][] = Object.entries(modules)
  .flatMap(([file, mod]) => {
    const composed = composeStories(mod as never);
    const component = path.basename(file, '.stories.tsx');
    return Object.entries(composed).map(
      ([name, Story]) => [`${component}/${name}`, Story as React.ComponentType] as [string, React.ComponentType],
    );
  })
  // Sorted so the baseline file has a stable order and its diffs stay readable.
  .sort(([a], [b]) => a.localeCompare(b));

/* -------------------------------------------------- 1. coverage (criterion 1) */

describe('Storybook covers every component and state', () => {
  /**
   * Components with no story, and why. Typing the reason out is the mechanism:
   * adding to this list is visible in a diff, whereas forgetting to write a
   * story is not.
   */
  const NO_STORY = new Map([
    [
      'shell/AppShell.tsx',
      'Composes the router, the session context, the toast provider and two live '
      + 'fetches. A story of it would be a story of four mocks — it is covered end '
      + 'to end by the browser .feature suite instead, which exercises the real ones.',
    ],
  ]);

  /** Design-system .tsx files that export at least one React component. */
  function componentFiles(): string[] {
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return walk(full);
        return e.name.endsWith('.tsx') && !e.name.endsWith('.stories.tsx') ? [full] : [];
      });
    return walk(DESIGN_SYSTEM).filter((f) =>
      // An exported function whose name starts with a capital — a component.
      /export function [A-Z]/.test(fs.readFileSync(f, 'utf8')),
    );
  }

  const rel = (f: string) => path.relative(DESIGN_SYSTEM, f).replace(/\\/g, '/');

  it('gives every component a story file', () => {
    const missing = componentFiles()
      .filter((f) => !fs.existsSync(f.replace(/\.tsx$/, '.stories.tsx')))
      .map(rel)
      .filter((r) => !NO_STORY.has(r));
    expect(missing, `no Storybook story:\n${missing.join('\n')}`).toEqual([]);
  });

  it('keeps the no-story exception list honest', () => {
    // A stale exception is how a list like this quietly stops meaning anything.
    const stale = [...NO_STORY.keys()].filter((r) => {
      const full = path.join(DESIGN_SYSTEM, r);
      return !fs.existsSync(full) || fs.existsSync(full.replace(/\.tsx$/, '.stories.tsx'));
    });
    expect(stale, `now has a story, or is gone — remove from the list:\n${stale.join('\n')}`).toEqual([]);
  });

  it('covers all six states in every component story file', () => {
    // The six the task names. The awkward three are the reason this is checked:
    // default/loading/empty get written anyway, and error, permission-denied and
    // dense are the ones that ship unexamined and then break in production.
    const REQUIRED = ['Default', 'Loading', 'Empty', 'ErrorState', 'PermissionDenied', 'Dense'];
    const byComponent = new Map<string, Set<string>>();
    for (const [id] of ALL_STORIES) {
      const [component, name] = id.split('/');
      if (!byComponent.has(component)) byComponent.set(component, new Set());
      byComponent.get(component)!.add(name);
    }

    const gaps = [...byComponent.entries()].flatMap(([component, names]) =>
      REQUIRED.filter((s) => !names.has(s)).map((s) => `${component}: no ${s} story`),
    );
    expect(gaps, gaps.join('\n')).toEqual([]);
    // Guards against the whole glob silently resolving to nothing, which would
    // make every assertion in this file vacuously true.
    expect(byComponent.size).toBeGreaterThanOrEqual(11);
  });
});

/* ------------------------------------------------ 2. accessibility (criterion 2) */

describe('axe finds no violation in any story', () => {
  it.each(ALL_STORIES)('%s', async (_id, Story) => {
    const { container } = render(<Story />);
    const results = await axe.run(container, {
      // Contrast is audited precisely in designTokens.test.ts, against the token
      // pairs rather than jsdom's guesses — jsdom does no layout, so axe cannot
      // resolve a computed colour here and would report noise either way.
      rules: { 'color-contrast': { enabled: false } },
    });
    const found = results.violations.map((v) => `${v.id} (${v.impact}): ${v.help}`);
    expect(found, found.join('\n')).toEqual([]);
  });
});

/* ------------------------------------------- 3a. mockup geometry (criterion 3) */

describe('geometry is pinned to the approved mockup', () => {
  const mockupCss = fs.readFileSync(MOCKUP, 'utf8');

  /** The declaration block for a selector in the mockup's own stylesheet. */
  function rule(selector: string): string {
    const found = new RegExp(`(?:^|[},])\\s*${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'm').exec(mockupCss);
    if (!found) throw new Error(`the mockup no longer declares ${selector} — the contract moved`);
    return found[1].replace(/\s+/g, '');
  }

  const source = (f: string) => fs.readFileSync(path.join(DESIGN_SYSTEM, f), 'utf8');

  it('reproduces the mockup backdrop exactly', () => {
    const overlay = rule('.overlay');
    expect(overlay).toContain('rgba(0,0,0,.72)');
    expect(overlay).toContain('blur(4px)');
    expect(overlay).toContain('z-index:150');

    const modal = source('overlays/Modal.tsx');
    // Arbitrary-value Tailwind rather than the nearest preset, because "close
    // enough" on a backdrop is how a design system drifts one step per quarter.
    expect(modal).toContain('bg-black/[0.72]');
    expect(modal).toContain('backdrop-blur-[4px]');
    expect(modal).toContain('z-[150]');
  });

  it('reproduces the mockup modal box', () => {
    const modal = rule('.modal');
    expect(modal).toContain('width:min(1000px,96vw)');
    expect(modal).toContain('max-height:92vh');
    expect(modal).toContain('border-radius:18px');

    const src = source('overlays/Modal.tsx');
    // `lg` IS the mockup's modal. sm/xl/full are extensions — see the deviation
    // list below, which is where anything the mockup does not declare has to be
    // justified in writing.
    expect(src).toContain("lg: 'w-[min(1000px,96vw)] max-h-[92vh]'");
    expect(src).toContain('rounded-[18px]');
  });

  it('reproduces the mockup drawer box', () => {
    const drawer = rule('.drawer');
    expect(drawer).toContain('width:min(680px,96vw)');
    expect(drawer).toContain('z-index:140');

    const src = source('overlays/Drawer.tsx');
    expect(src).toContain('w-[min(680px,96vw)]');
    expect(src).toContain('z-[140]');
  });

  it('reproduces the mockup KPI rail at full width', () => {
    expect(rule('.kpis')).toContain('grid-template-columns:repeat(6,minmax(0,1fr))');
    // Six across on a wide screen, and fewer as it narrows. The mockup is a
    // fixed-width artboard and so never had to answer the narrow case; six
    // 27px numerals on a phone is unreadable, which is a worse kind of
    // unfaithfulness than a different column count.
    expect(source('data/KpiRail.tsx')).toContain('xl:grid-cols-6');
  });

  /**
   * Where we KNOWINGLY differ from the mockup, and why. Every entry is a place
   * the mockup is internally inconsistent or simply never met the case, so
   * copying it would ship the defect. Without this list the pins above would
   * either be wrong or would have to be silently loosened.
   */
  const DEVIATIONS = [
    {
      what: '.overlay padding: mockup 24px, ours 8px (p-2)',
      why: 'The mockup pairs 24px of backdrop padding with a 96vw panel, which '
        + 'overflows horizontally on any viewport under about 1200px. It is a '
        + 'fixed-width artboard, so it never rendered that case.',
      pin: () => expect(source('overlays/Modal.tsx')).toContain('p-2 backdrop-blur-[4px]'),
    },
    {
      what: '.kpis gap: mockup 12px, ours 16px (gap-4)',
      why: 'The rail wraps to two and three columns below xl, where 12px reads as '
        + 'a rendering fault rather than a gutter.',
      pin: () => expect(source('data/KpiRail.tsx')).toContain('gap-4'),
    },
    {
      what: 'Modal sizes sm / xl / full',
      why: 'The mockup declares exactly one modal box, which is our lg. The other '
        + 'three are extensions for content the mockup never showed — a confirm '
        + 'prompt and the wide provenance table — and are not claimed as its.',
      pin: () => {
        const src = source('overlays/Modal.tsx');
        expect(src).toContain("sm: 'w-[min(620px,95vw)]");
        expect(src).toContain("xl: 'w-[min(1380px,98vw)]");
      },
    },
  ];

  it.each(DEVIATIONS)('documented deviation: $what', ({ pin }) => {
    // Asserting the deviation, not just describing it: if somebody later
    // "corrects" one of these back to the mockup value, this fails and they read
    // the reason before deciding.
    pin();
  });
});

/* ---------------------------------------- 3b. structural baselines (criterion 3) */

describe('rendered markup matches the committed baseline', () => {
  /** Strips the noise that changes without anything visibly changing. */
  function normalise(html: string): string {
    return html
      .replace(/\s+/g, ' ')
      .replace(/<!--.*?-->/g, '')
      .trim();
  }

  it('no story has drifted', () => {
    const current: Record<string, string> = {};
    for (const [id, Story] of ALL_STORIES) {
      const { container } = render(<Story />);
      // Overlays portal to the body, so container alone would record an empty
      // div for every modal story — the exact blind spot that let two dialogs
      // ship unstyled.
      const overlay = document.body.querySelector('[role="dialog"]')?.parentElement;
      current[id] = normalise((overlay ?? container).innerHTML);
      cleanup();
    }

    if (process.env.UPDATE_BASELINES === '1' || !fs.existsSync(BASELINE)) {
      fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
      fs.writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    }

    const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as Record<string, string>;
    const drifted = Object.keys({ ...baseline, ...current }).filter((id) => baseline[id] !== current[id]);
    expect(
      drifted,
      `markup changed for:\n${drifted.join('\n')}\n\n`
      + 'Review the change in Storybook. If it is intended, re-record with '
      + 'UPDATE_BASELINES=1 npx vitest run tests/unit/storybookGate.test.tsx',
    ).toEqual([]);
  });
});
