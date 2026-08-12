import { useEffect, useRef, useState } from 'react';
import { EXPERIENCES, type ExperienceLevel } from './navModel';

/**
 * The workspace experience picker, from the phase-7 usability package.
 *
 * IT SAYS WHAT IT DOES NOT DO, and that sentence is the most important thing on
 * the panel: "This changes the visible workspace immediately. It does not change
 * your role or permissions." Without it, an operator who cannot see Governance
 * has two candidate explanations — a level they chose, or a grant they lack —
 * and no way to tell them apart. With it, experience is obviously a preference
 * and Locked is obviously policy.
 *
 * RECOMMENDED AND CURRENT ARE DIFFERENT LABELS on purpose. The reference marks
 * Guided Start as recommended while showing Full Workspace as current, which is
 * only coherent if the two are distinct ideas: one is our advice, the other is
 * their state. Collapsing them would make the recommendation read as a
 * correction.
 */

const RECOMMENDED: ExperienceLevel = 1;

export function ExperienceSwitcher({
  level,
  onChange,
}: {
  level: ExperienceLevel;
  onChange: (next: ExperienceLevel) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const current = EXPERIENCES.find((e) => e.level === level) ?? EXPERIENCES[3];

  // Close on outside click and on Escape. A picker that traps the operator is
  // worse than one that is hard to find.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        name="experience_switcher"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        className="flex w-full items-center justify-between gap-3 rounded-xl border border-line2 bg-panel2 px-3 py-2 text-left hover:border-blue/60"
      >
        <span className="min-w-0">
          <span className="block text-[10px] font-semibold uppercase tracking-wider text-soft">
            Experience
          </span>
          <span className="block truncate text-sm font-semibold text-text">{current.label}</span>
        </span>
        <span aria-hidden="true" className="shrink-0 text-xs text-soft">
          {open ? '⌃' : '⌄'}
        </span>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-2 w-[26rem] max-w-[92vw] rounded-2xl border border-line bg-panel p-4 shadow-panel">
          <p className="text-sm font-semibold text-text">Choose your experience</p>
          {/* The sentence the whole control depends on. */}
          <p className="mt-1 text-xs leading-relaxed text-soft">
            This changes the visible workspace immediately. It does not change your role or
            permissions.
          </p>

          <ul className="mt-3 space-y-2">
            {EXPERIENCES.map((experience, index) => {
              const isCurrent = experience.level === level;
              return (
                <li key={experience.key}>
                  <button
                    type="button"
                    name={`experience_${experience.key}`}
                    onClick={() => {
                      onChange(experience.level);
                      setOpen(false);
                    }}
                    className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left ${
                      isCurrent ? 'border-blue/60 bg-panel3' : 'border-line bg-panel2 hover:border-blue/40'
                    }`}
                  >
                    <span className="mt-0.5 shrink-0 font-mono text-[10px] text-soft">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-text">{experience.label}</span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-soft">
                        {experience.detail}
                      </span>
                    </span>
                    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-soft">
                      {isCurrent ? 'Current' : experience.level === RECOMMENDED ? 'Recommended' : 'Open'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          <button
            type="button"
            name="use_recommendation"
            onClick={() => {
              onChange(RECOMMENDED);
              setOpen(false);
            }}
            className="lf-btn-secondary mt-3 w-full px-3 py-1.5"
          >
            Use recommendation
          </button>
        </div>
      )}
    </div>
  );
}
