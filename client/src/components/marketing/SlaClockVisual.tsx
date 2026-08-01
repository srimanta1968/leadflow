/** One rung of the escalation ladder. */
const LADDER: { at: string; event: string; who: string; tone: string }[] = [
  { at: 'T+0', event: 'Lead created, owner assigned, clock starts', who: 'Owner', tone: 'text-blue' },
  { at: 'T+5', event: 'Push and SMS alert to the assigned owner', who: 'Owner', tone: 'text-blue' },
  { at: 'T+15', event: 'Backup owner notified, acceptance clock opens', who: 'Backup', tone: 'text-gold' },
  { at: 'T+30', event: 'SLA deadline — breach recorded with reason code', who: 'Manager', tone: 'text-red' },
  { at: 'T+45', event: 'Manager escalation and reassignment', who: 'Manager', tone: 'text-red' },
];

/**
 * A static rendering of the escalation ladder.
 *
 * Purely decorative in the marketing sense, but the values are the real
 * configured ladder rather than invented ones — a prospect who becomes a
 * customer should recognise this screen.
 */
export function SlaClockVisual() {
  return (
    <div className="lf-panel-raised overflow-hidden">
      <div className="flex items-center justify-between border-b border-line bg-panel2 px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-green" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-green" />
          </span>
          <span className="text-xs font-semibold uppercase tracking-wider text-muted">
            Response clock
          </span>
        </div>
        <span className="font-mono text-xs text-soft">business hours · Europe/London</span>
      </div>

      <ol className="divide-y divide-line/70">
        {LADDER.map((rung) => (
          <li key={rung.at} className="flex items-start gap-4 px-5 py-4">
            <span className={`w-12 shrink-0 font-mono text-sm font-bold ${rung.tone}`}>
              {rung.at}
            </span>
            <span className="flex-1 text-sm leading-relaxed text-text">{rung.event}</span>
            <span className="shrink-0 rounded-full border border-line2 px-2.5 py-0.5 text-[11px] font-semibold text-muted">
              {rung.who}
            </span>
          </li>
        ))}
      </ol>

      <p className="border-t border-line bg-panel2 px-5 py-3.5 text-xs leading-relaxed text-soft">
        The clock pauses outside business hours and on holidays. Only an attempt the system
        recognises as genuine human contact stops it.
      </p>
    </div>
  );
}
