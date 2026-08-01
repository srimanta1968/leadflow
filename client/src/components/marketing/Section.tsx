import { ReactNode } from 'react';

interface SectionProps {
  /** Anchor target, so footer and in-page links can address the section. */
  id?: string;
  eyebrow?: string;
  title: ReactNode;
  lede?: ReactNode;
  children: ReactNode;
  /** Centre the heading block. Used for full-width feature sections. */
  centered?: boolean;
  /** Alternate surface, for banding adjacent sections apart. */
  tone?: 'base' | 'raised';
}

/**
 * The standard marketing section: consistent vertical rhythm, one heading
 * treatment, one lede treatment. Pages compose these rather than hand-rolling
 * spacing, so the page reads as one system top to bottom.
 */
export function Section({
  id,
  eyebrow,
  title,
  lede,
  children,
  centered = false,
  tone = 'base',
}: SectionProps) {
  return (
    <section
      id={id}
      className={`scroll-mt-20 border-t border-line/60 py-20 sm:py-24 ${
        tone === 'raised' ? 'bg-bg2' : 'bg-bg'
      }`}
    >
      <div className="lf-container">
        <div className={centered ? 'mx-auto max-w-3xl text-center' : 'max-w-3xl'}>
          {eyebrow && <p className="lf-eyebrow">{eyebrow}</p>}
          <h2 className={`lf-h2 ${eyebrow ? 'mt-3' : ''}`}>{title}</h2>
          {lede && <p className="lf-lede mt-5">{lede}</p>}
        </div>
        <div className="mt-14">{children}</div>
      </div>
    </section>
  );
}
