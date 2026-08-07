import { describe, expect, it } from 'vitest';
import {
  fuzzyScore,
  groupRanked,
  rankCommands,
  usageBoost,
  type Rankable,
} from '../../src/design-system/shell/commandRanking';
import { COMMANDS, GROUP_ORDER } from '../../src/design-system/shell/commandRegistry';

/**
 * The palette's ranking, which IS the feature.
 *
 * A palette that finds the right command second is a worse sidebar. Everything
 * below is about the first hit being right, and none of it is observable through
 * the component — which is why the logic is pure and tested here.
 */

const cmd = (id: string, title: string, group = 'Navigation', keywords?: string[]): Rankable =>
  ({ id, title, group, keywords });

const DAY = 24 * 60 * 60 * 1000;

describe('fuzzy matching', () => {
  it('matches a subsequence and reports where it hit', () => {
    const r = fuzzyScore('cap', 'Quick Capture');
    expect(r).not.toBeNull();
    expect(r!.hits).toHaveLength(3);
  });

  it('returns null rather than zero when nothing matches', () => {
    // Null and 0 are different: 0 is a weak match a caller might still show.
    expect(fuzzyScore('zzz', 'Quick Capture')).toBeNull();
  });

  it('prefers a consecutive run over scattered characters', () => {
    const run = fuzzyScore('cap', 'Capture Inbox')!.score;
    const scattered = fuzzyScore('cap', 'Campaign Enrollment')!.score;
    expect(run).toBeGreaterThan(scattered);
  });

  it('makes initials work by rewarding word boundaries', () => {
    // "qc" should find Quick Capture, not a word that merely contains q…c.
    const initials = fuzzyScore('qc', 'Quick Capture')!.score;
    const midword = fuzzyScore('qc', 'Frequency Cap Policy')!.score;
    expect(initials).toBeGreaterThan(midword);
  });

  it('treats an empty query as a match on everything, scoring nothing', () => {
    expect(fuzzyScore('', 'anything')).toEqual({ score: 0, hits: [] });
  });
});

describe('recency and frequency', () => {
  const now = Date.now();

  it('damps frequency so an old favourite cannot pin itself to the top', () => {
    const twice = usageBoost({ count: 2, lastUsedAt: now }, now);
    const twoHundred = usageBoost({ count: 200, lastUsedAt: now }, now);
    // Logarithmic: 100x the uses is nowhere near 100x the boost, or the palette
    // becomes a list of what you did last month.
    expect(twoHundred).toBeLessThan(twice * 4);
    expect(twoHundred).toBeGreaterThan(twice);
  });

  it('decays recency on a half-life', () => {
    const fresh = usageBoost({ count: 1, lastUsedAt: now }, now);
    const weekOld = usageBoost({ count: 1, lastUsedAt: now - 7 * DAY }, now);
    const monthOld = usageBoost({ count: 1, lastUsedAt: now - 28 * DAY }, now);
    expect(fresh).toBeGreaterThan(weekOld);
    expect(weekOld).toBeGreaterThan(monthOld);
  });

  it('gives an unused command nothing at all', () => {
    expect(usageBoost(undefined, now)).toBe(0);
    expect(usageBoost({ count: 0, lastUsedAt: now }, now)).toBe(0);
  });
});

describe('ranking', () => {
  const now = Date.now();
  const items = [
    cmd('a', 'Capture Inbox'),
    cmd('b', 'Campaign Enrollment'),
    cmd('c', 'Quick Capture'),
  ];

  it('opens showing EVERYTHING, with what you use most first', () => {
    const ranked = rankCommands('', items, { c: { count: 5, lastUsedAt: now } }, now);
    // Most-used first...
    expect(ranked[0].item.id).toBe('c');
    // ...but nothing is hidden. Filtering to used-only meant a browser with no
    // history opened an EMPTY palette, which makes the first keystroke mandatory
    // and the feature slower than the sidebar it replaces.
    expect(ranked).toHaveLength(items.length);
  });

  it('shows the full list to somebody who has never used it', () => {
    const ranked = rankCommands('', items, {}, now);
    expect(ranked).toHaveLength(items.length);
    // Deterministic order rather than whatever the registry happened to hold.
    expect(ranked.map((r) => r.item.title)).toEqual(
      [...items.map((i) => i.title)].sort((a, b) => a.localeCompare(b)),
    );
  });

  it('lets usage break a tie without overturning a clearly better match', () => {
    const usage = { b: { count: 3, lastUsedAt: now } };
    const ranked = rankCommands('capture', items, usage, now);
    // 'Campaign Enrollment' does not contain "capture" at all, so no amount of
    // use should surface it here.
    expect(ranked.map((r) => r.item.id)).not.toContain('b');
    expect(ranked[0].item.id).toBe('a');
  });

  it('finds a command by a keyword that is not in its name', () => {
    const withKeyword = [cmd('k', 'Quick Contact', 'Action', ['new lead'])];
    const ranked = rankCommands('new lead', withKeyword, {}, now);
    expect(ranked).toHaveLength(1);
    // Keyword hits do not highlight — they are a way to FIND a command, not a
    // second name for it.
    expect(ranked[0].hits).toEqual([]);
  });

  it('orders ties deterministically so the list cannot shuffle under your fingers', () => {
    const twins = [cmd('y', 'Same Name'), cmd('x', 'Same Name')];
    const first = rankCommands('same', twins, {}, now).map((r) => r.item.id);
    const second = rankCommands('same', twins, {}, now).map((r) => r.item.id);
    expect(first).toEqual(second);
  });
});

describe('grouping and the registry', () => {
  it('emits groups in the mockup order and drops the empty ones', () => {
    const ranked = rankCommands('capture', COMMANDS, {}, Date.now());
    const groups = groupRanked(ranked, GROUP_ORDER).map((g) => g.group);
    expect(groups).toEqual(GROUP_ORDER.filter((g) => groups.includes(g)));
    expect(groups).not.toContain('Contact'); // entity search is not local
  });

  it('offers no command that cannot be run', () => {
    // The sidebar shows planned screens greyed because it is a map of the product.
    // The palette is a list of things you can do NOW, so an unrunnable entry is
    // noise at the top of a list whose value is that the first hit is right.
    expect(COMMANDS.filter((c) => c.planned)).toEqual([]);
    for (const c of COMMANDS) {
      expect(Boolean(c.to || c.intent), `${c.title} goes nowhere`).toBe(true);
    }
  });

  it('stays fast enough to rank on every keystroke', () => {
    // AC asks for first results under 150ms. The LOCAL half is what this file can
    // honestly measure: entity search is a network call to sdk-search and is not
    // reachable here. 2000 commands is ~20x the real registry.
    const many = Array.from({ length: 2000 }, (_, i) => cmd(`i${i}`, `Command number ${i}`));
    const started = performance.now();
    rankCommands('cn12', many, {}, Date.now());
    expect(performance.now() - started).toBeLessThan(50);
  });
});
