import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { RAIL_NODES, railProgress } from '../../src/components/app/ResolveCaptureModal';

const MODAL_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'components', 'app', 'ResolveCaptureModal.tsx'),
  'utf8'
);

/**
 * The same source with comments removed.
 *
 * Every "this must NOT appear" assertion runs against this rather than the raw
 * file. The comments in that component explain each guarantee by NAMING the
 * anti-pattern it avoids — "Not setReached('P1') because we clicked Save P1" —
 * so a negative match on the raw source fails on the sentence that documents
 * the rule. Banning the explanation is not the same as banning the behaviour,
 * and only one of them is worth a test.
 */
const MODAL_CODE = MODAL_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('the four-node rail', () => {
  it('carries the mockup’s four nodes and captions in order', () => {
    expect(RAIL_NODES.map((node) => node.id)).toEqual(['P0', 'P1', 'P2', 'P3']);
    expect(RAIL_NODES.map((node) => node.caption)).toEqual([
      'Raw evidence',
      'Review parse',
      'Search MDM',
      'Governed decision',
    ]);
  });

  it('marks earlier nodes done, the reached node current and later nodes ahead', () => {
    expect(railProgress('P2')).toEqual([
      { id: 'P0', state: 'done' },
      { id: 'P1', state: 'done' },
      { id: 'P2', state: 'current' },
      { id: 'P3', state: 'ahead' },
    ]);
  });

  it('shows nothing done at P0', () => {
    expect(railProgress('P0').map((node) => node.state)).toEqual([
      'current',
      'ahead',
      'ahead',
      'ahead',
    ]);
  });

  it('ADVANCES FROM THE RESPONSE, never from the click', () => {
    // The criterion is that the rail reflects the record's REAL trust state. A
    // rail that moved on click would show P2 for a record still sitting at P0
    // upstream, and the steward would adjudicate against a picture that is not
    // true. The button being pressed is not evidence the promotion succeeded.
    expect(MODAL_SOURCE).toMatch(/setReached\(resolved\.rail\.reachedNode/);
    // And there must be no optimistic literal anywhere.
    expect(MODAL_CODE).not.toMatch(/setReached\('P[1-3]'\)/);
  });
});

describe('steward corrections', () => {
  it('renders every proposed field as an editable input, not a label', () => {
    // "Correct any parsed field before promotion" is only true if each chip is
    // an input. A read-only chip with an edit affordance somewhere else is a
    // different screen.
    expect(MODAL_SOURCE).toMatch(/proposal\.map/);
    expect(MODAL_SOURCE).toMatch(/<input\s+id=\{`chip-\$\{chip\.field\}`\}/);
    expect(MODAL_SOURCE).toMatch(/setCorrections/);
  });

  it('sends the corrections with the request', () => {
    expect(MODAL_SOURCE).toMatch(/api\.resolveCapture\(captureId, \{ stage, corrections \}\)/);
  });

  it('keeps the raw evidence read-only', () => {
    // The evidence is what arrived. Editing it here would destroy the thing
    // every promotion is checked against — corrections belong on the parse.
    const rawBlock = MODAL_CODE.slice(
      MODAL_CODE.indexOf('aria-label="Raw Capture"'),
      MODAL_CODE.indexOf('aria-label="Normalization Proposal"')
    );
    expect(rawBlock).toContain('<pre>{rawEvidence}</pre>');
    expect(rawBlock).not.toContain('<input');
    expect(rawBlock).not.toContain('<textarea');
  });
});

describe('organization candidate', () => {
  it('proposes a REPRESENTS relationship', () => {
    expect(MODAL_SOURCE).toMatch(/proposedRelationship/);
    expect(MODAL_SOURCE).toMatch(/propose \{result\.organizationCandidate\.proposedRelationship\}/);
  });

  it('offers NO merge affordance at all', () => {
    // The absence is the design. Merging two records is far harder to undo than
    // proposing an edge, and a shared domain is evidence of association rather
    // than of identity — so there is no control here that could collapse them.
    expect(MODAL_CODE).not.toMatch(/\bmerge\w*\s*\(/i);
    expect(MODAL_CODE).not.toMatch(/name="merge/i);
    expect(MODAL_CODE).not.toMatch(/onClick=\{[^}]*[Mm]erge/);
  });

  it('says the relationship is not established until reviewed', () => {
    expect(MODAL_SOURCE).toContain('not established until it is reviewed');
  });
});

describe('reversibility', () => {
  it('surfaces the reference a retraction would quote', () => {
    // A promotion with no way back is a merge in disguise. Showing the handle
    // is what makes "reversible" a fact the steward can act on rather than a
    // claim in a doc.
    expect(MODAL_SOURCE).toMatch(/result\?\.reversalRef/);
    expect(MODAL_SOURCE).toContain('This promotion is reversible');
  });
});

describe('failure reporting', () => {
  it('says nothing was promoted when the call fails', () => {
    // A steward who sees a bare error does not know whether the promotion
    // half-happened. The one thing they need is whether the record moved.
    expect(MODAL_SOURCE).toContain('Nothing was promoted');
  });
});
