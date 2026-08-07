import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { COMMANDS, GROUP_ORDER, type Command } from './commandRegistry';
import { groupRanked, rankCommands, type UsageStats } from './commandRanking';

/**
 * The ⌘K command palette.
 *
 * KEYBOARD FIRST, AND KEYBOARD ONLY IF YOU LIKE. Open with ⌘K or Ctrl+K, type,
 * arrow through, Enter to run, Escape to leave. Nothing here needs a pointer, and
 * the highlighted row is always the one Enter will run — the palette's whole
 * promise is that the thing you meant is already selected.
 *
 * PERMISSION FILTERING IS EXCLUSION, NOT DISABLING. The sidebar shows a locked
 * item because it is a map of the product; the palette is a list of things you can
 * do right now, so an action you cannot perform is simply absent. Showing it
 * greyed would put noise at the top of a list whose value is that the first hit is
 * right.
 */

const USAGE_KEY = 'leadflow.palette.usage';

function readUsage(): Record<string, UsageStats> {
  if (typeof window === 'undefined') return {};
  try {
    return JSON.parse(window.localStorage.getItem(USAGE_KEY) ?? '{}') as Record<string, UsageStats>;
  } catch {
    // A corrupt entry must not take the palette down with it.
    return {};
  }
}

function recordUse(id: string): Record<string, UsageStats> {
  const usage = readUsage();
  const prev = usage[id];
  usage[id] = { count: (prev?.count ?? 0) + 1, lastUsedAt: Date.now() };
  try {
    window.localStorage.setItem(USAGE_KEY, JSON.stringify(usage));
  } catch {
    // Private-mode or quota. Ranking degrades to relevance-only, which is fine.
  }
  return usage;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /** Actions the caller has verdicts for; a command whose action is absent is hidden. */
  isAllowed: (action: string) => boolean;
  /** Run an in-app intent (opens a modal owned by the shell). */
  onIntent: (intent: NonNullable<Command['intent']>) => void;
}

export function CommandPalette({ open, onClose, isAllowed, onIntent }: CommandPaletteProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [usage, setUsage] = useState<Record<string, UsageStats>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
    setUsage(readUsage());
    // Focus after paint so the caret is in the box without a click.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const permitted = useMemo(
    () => COMMANDS.filter((c) => !c.action || isAllowed(c.action)),
    [isAllowed],
  );

  const ranked = useMemo(
    () => rankCommands(query, permitted, usage),
    [query, permitted, usage],
  );

  const groups = useMemo(() => groupRanked(ranked, GROUP_ORDER), [ranked]);

  /** The flat order the arrow keys walk, matching what is rendered. */
  const flat = useMemo(() => groups.flatMap((g) => g.results.map((r) => r.item)), [groups]);

  const run = useCallback(
    (command: Command) => {
      setUsage(recordUse(command.id));
      onClose();
      if (command.intent) onIntent(command.intent);
      else if (command.to) navigate(command.to);
    },
    [navigate, onClose, onIntent],
  );

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      // Wraps deliberately: at the end of a short list, down should return to the
      // top rather than stick, which is what every palette a user has met does.
      setCursor((c) => (flat.length ? (c + 1) % flat.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => (flat.length ? (c - 1 + flat.length) % flat.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const chosen = flat[cursor];
      if (chosen) run(chosen);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/60 p-4 pt-[12vh]"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="lf-panel w-full max-w-xl overflow-hidden p-0 shadow-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="text"
          name="command"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setCursor(0); }}
          onKeyDown={onKeyDown}
          placeholder="Search commands, screens and contacts…"
          aria-label="Search commands"
          aria-activedescendant={flat[cursor] ? `cmd-${flat[cursor].id}` : undefined}
          className="w-full border-b border-line bg-transparent px-5 py-4 text-sm text-text outline-none placeholder:text-soft"
        />

        <div className="max-h-[52vh] overflow-y-auto p-2" role="listbox" aria-label="Results">
          {groups.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-soft">
              {query
                ? 'Nothing matches. Contact search needs the ProjexCloud search service, which is not reachable here.'
                : 'Start typing, or pick something you use often once you have run a few commands.'}
            </p>
          )}

          {groups.map((group) => (
            <div key={group.group} className="mb-1">
              <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-soft">
                {group.group}
              </p>
              {group.results.map((result) => {
                const index = flat.indexOf(result.item);
                const active = index === cursor;
                return (
                  <button
                    key={result.item.id}
                    id={`cmd-${result.item.id}`}
                    type="button"
                    role="option"
                    aria-selected={active}
                    // Hover moves the cursor so the pointer and the keyboard never
                    // disagree about which row Enter would run.
                    onMouseEnter={() => setCursor(index)}
                    onClick={() => run(result.item)}
                    className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                      active ? 'bg-panel2 text-text' : 'text-muted hover:bg-panel'
                    }`}
                  >
                    <span className="truncate">{result.item.title}</span>
                    {active && (
                      <kbd className="shrink-0 rounded border border-line2 bg-panel3 px-1.5 py-0.5 font-mono text-[10px] text-soft">
                        ↵
                      </kbd>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-4 border-t border-line px-4 py-2 text-[11px] text-soft">
          <span>↑↓ to move</span>
          <span>↵ to run</span>
          <span>esc to close</span>
        </div>
      </div>
    </div>
  );
}
