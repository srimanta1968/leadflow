import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import type { CountKey } from './navModel';

/**
 * The live counts beside the sidebar items.
 *
 * READ FROM THE PROJECTION ENDPOINTS THE SCREENS THEMSELVES USE, so the badge and
 * the screen can never disagree: the Capture Inbox badge and the Capture Inbox
 * header are the same number from the same call.
 *
 * A COUNT THAT CANNOT BE READ IS ABSENT, NOT ZERO. `null` renders no badge at all.
 * Showing 0 when the read failed tells an operator their queue is clear, which is
 * the one wrong answer that stops them looking — worse than showing nothing.
 *
 * Refetched on navigation rather than polled. The sidebar is glanced at when
 * moving between screens, and a timer that fires while somebody is mid-triage buys
 * freshness nobody asked for at the cost of a request every few seconds.
 */
export type ShellCounts = Partial<Record<CountKey, number | null>>;

export function useShellCounts(refreshKey: string): ShellCounts {
  const [counts, setCounts] = useState<ShellCounts>({});

  useEffect(() => {
    const controller = new AbortController();
    let live = true;

    async function read(): Promise<void> {
      // Each source is settled independently: a failing lead read must not blank
      // the capture badges, which is what a single try/catch around both would do.
      const [inbox, leads] = await Promise.allSettled([
        api.captureInbox({ limit: 1 }, controller.signal),
        api.listLeads(1, 0),
      ]);
      if (!live) return;

      const next: ShellCounts = {};

      if (inbox.status === 'fulfilled') {
        const c = inbox.value.counts;
        // The Capture Inbox badge is what is UNRESOLVED — the three rungs still
        // awaiting a decision. P3/P4 are resolved and would inflate the badge into
        // something nobody needs to act on.
        next.captureUnresolved = c.newP0 + c.parsedP1 + c.candidateP2;
        next.captureSlaRisk = c.slaRisk;
        next.browserCaptures = c.browserCaptures;
      } else {
        next.captureUnresolved = null;
        next.captureSlaRisk = null;
        next.browserCaptures = null;
      }

      next.leadsOpen = leads.status === 'fulfilled' ? (leads.value.total ?? null) : null;

      setCounts(next);
    }

    void read();
    return () => {
      live = false;
      controller.abort();
    };
  }, [refreshKey]);

  return counts;
}
