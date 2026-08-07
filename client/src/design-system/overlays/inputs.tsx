import { useEffect, useRef, useState, type ReactNode } from 'react';
import { isSignable, signatureHash, type SignatureStroke } from './signature';
import { toneClass, type SemanticRole } from '../tokens';

/**
 * The specialised inputs: tabs, drop zone, signature canvas and the small
 * governance primitives.
 */

/* ------------------------------------------------------------------ Tabs */

export interface TabDef { id: string; label: string; panel: ReactNode }

/**
 * Contact 360's eight tabs.
 *
 * Arrow keys move between tabs and Enter/Space is unnecessary because selection
 * follows focus — the WAI-ARIA pattern for a tablist whose panels are cheap. The
 * panel is rendered only when active: eight tabs of provenance tables mounted at
 * once is eight times the work for one visible result.
 */
export function Tabs({ tabs, initial }: { tabs: TabDef[]; initial?: string }) {
  const [active, setActive] = useState(initial ?? tabs[0]?.id);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  function onKeyDown(e: React.KeyboardEvent, index: number): void {
    const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    setActive(next.id);
    refs.current[next.id]?.focus();
  }

  return (
    <div>
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-line" aria-label="Sections">
        {tabs.map((tab, i) => (
          <button
            key={tab.id}
            ref={(el) => { refs.current[tab.id] = el; }}
            role="tab"
            type="button"
            aria-selected={active === tab.id}
            aria-controls={`panel-${tab.id}`}
            // Only the active tab is tabbable, so Tab moves OUT of the tablist
            // into the panel rather than through eight buttons first.
            tabIndex={active === tab.id ? 0 : -1}
            onClick={() => setActive(tab.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              active === tab.id
                ? 'border-blue text-text'
                : 'border-transparent text-muted hover:text-text'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab) =>
        active === tab.id ? (
          <div key={tab.id} id={`panel-${tab.id}`} role="tabpanel" tabIndex={0} className="pt-4 outline-none">
            {tab.panel}
          </div>
        ) : null,
      )}
    </div>
  );
}

/* -------------------------------------------------------------- DropZone */

export interface DropZoneProps {
  accept: string;
  label: string;
  hint?: string;
  onFile: (file: File) => void;
  /** Renders an image preview for image/* files. */
  preview?: boolean;
}

/**
 * CSV, vCard and image upload.
 *
 * NOTHING LEAVES THE BROWSER HERE. The component hands the File to its caller
 * and, for images, renders a local object URL — the upload itself is the
 * caller's decision, made after a person has seen what they picked. A drop zone
 * that transmits on drop takes that decision away, and the file most likely to
 * be dropped by mistake is a customer list.
 */
export function DropZone({ accept, label, hint, onFile, preview }: DropZoneProps) {
  const [over, setOver] = useState(false);
  const [chosen, setChosen] = useState<File | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!preview || !chosen || !chosen.type.startsWith('image/')) return undefined;
    const objectUrl = URL.createObjectURL(chosen);
    setUrl(objectUrl);
    // Revoked on replace and unmount — an un-revoked object URL keeps the whole
    // file alive in memory for the life of the tab.
    return () => { URL.revokeObjectURL(objectUrl); setUrl(null); };
  }, [chosen, preview]);

  function take(file: File | undefined): void {
    if (!file) return;
    setChosen(file);
    onFile(file);
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files[0]); }}
        className={`flex w-full flex-col items-center gap-1 rounded-xl border border-dashed px-4 py-8 text-center transition-colors ${
          over ? 'border-blue bg-blue/5' : 'border-line2 hover:border-line2 hover:bg-panel2'
        }`}
      >
        <span className="text-sm font-semibold text-text">{label}</span>
        {hint && <span className="text-xs text-soft">{hint}</span>}
        {chosen && (
          <span className="mt-2 font-mono text-xs text-muted">
            {chosen.name} · {(chosen.size / 1024).toFixed(0)} KB
          </span>
        )}
      </button>
      <input
        ref={input}
        type="file"
        accept={accept}
        className="sr-only"
        onChange={(e) => take(e.target.files?.[0])}
      />
      {url && <img src={url} alt="Selected file preview" className="mt-3 max-h-48 rounded-lg border border-line" />}
    </div>
  );
}

/* -------------------------------------------------- SignatureCanvas */

/**
 * Captures a signature and emits its SHA-256 evidence hash.
 *
 * Strokes are recorded as coordinates rather than pixels, which is what makes
 * the hash portable — see signature.ts for why hashing the canvas image would
 * make the evidence worthless across devices.
 */
export function SignatureCanvas({
  onSigned,
  width = 480,
  height = 160,
}: {
  onSigned: (hash: string, strokes: SignatureStroke[]) => void;
  width?: number;
  height?: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [strokes, setStrokes] = useState<SignatureStroke[]>([]);
  const drawing = useRef(false);

  function point(e: React.PointerEvent): { x: number; y: number } {
    const rect = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function draw(from: { x: number; y: number }, to: { x: number; y: number }): void {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    ctx.strokeStyle = '#f4f4f6';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }

  return (
    <div>
      <canvas
        ref={canvas}
        width={width}
        height={height}
        className="w-full touch-none rounded-xl border border-line2 bg-panel2"
        onPointerDown={(e) => {
          // Pointer events rather than mouse+touch: one code path covers a
          // finger, a stylus and a mouse, which is the whole point of signing.
          drawing.current = true;
          canvas.current?.setPointerCapture(e.pointerId);
          setStrokes((s) => [...s, [point(e)]]);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const p = point(e);
          setStrokes((s) => {
            const last = s[s.length - 1];
            if (last?.length) draw(last[last.length - 1], p);
            return [...s.slice(0, -1), [...(last ?? []), p]];
          });
        }}
        onPointerUp={() => { drawing.current = false; }}
      />
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          className="lf-btn-secondary px-3 py-1.5 text-xs"
          onClick={() => {
            setStrokes([]);
            const ctx = canvas.current?.getContext('2d');
            if (ctx && canvas.current) ctx.clearRect(0, 0, canvas.current.width, canvas.current.height);
          }}
        >
          Clear
        </button>
        <button
          type="button"
          disabled={!isSignable(strokes)}
          className="lf-btn-primary px-3 py-1.5 text-xs disabled:opacity-40"
          onClick={() => void signatureHash(strokes).then((h) => onSigned(h, strokes))}
        >
          Accept signature
        </button>
        {!isSignable(strokes) && strokes.length > 0 && (
          <span className="text-[11px] text-soft">Keep going — that is too short to record.</span>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------- small primitives */

export function ChoiceGrid<T extends string>({
  options, value, onChange, name,
}: {
  options: { id: T; label: string; detail?: string }[];
  value: T | null;
  onChange: (id: T) => void;
  name: string;
}) {
  return (
    <div role="radiogroup" aria-label={name} className="grid gap-3 sm:grid-cols-2">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          onClick={() => onChange(option.id)}
          className={`rounded-xl border p-4 text-left transition-colors ${
            value === option.id ? 'border-blue bg-blue/5' : 'border-line hover:border-line2 hover:bg-panel2'
          }`}
        >
          <span className="block text-sm font-semibold text-text">{option.label}</span>
          {option.detail && <span className="mt-1 block text-xs leading-relaxed text-soft">{option.detail}</span>}
        </button>
      ))}
    </div>
  );
}

/** A governance notice. Role decides the colour; there is no free-form variant. */
export function Callout({ role = 'info', title, children }: { role?: SemanticRole; title: string; children?: ReactNode }) {
  return (
    <div className={`rounded-xl border p-4 ${role === 'blocked' ? 'border-red/40 bg-red/10' : role === 'warning' ? 'border-gold/40 bg-gold/10' : role === 'success' ? 'border-green/40 bg-green/10' : 'border-line bg-panel2'}`}>
      <p className={`text-sm font-bold ${toneClass(role)}`}>{title}</p>
      {children && <div className="mt-1 text-xs leading-relaxed text-muted">{children}</div>}
    </div>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-[11px] leading-relaxed text-soft">{children}</p>;
}

/** The required marker. aria-hidden because the field itself carries `required`. */
export function Req() {
  return <span aria-hidden="true" className="ml-0.5 text-red">*</span>;
}
