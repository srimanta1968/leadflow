import { ReactNode } from 'react';

interface FieldProps {
  /** DOM id of the control this label and error belong to. */
  id: string;
  label: ReactNode;
  /** Validation message, or null when the field is valid. */
  error?: string | null;
  /** Helper text shown when there is no error. */
  hint?: string;
  required?: boolean;
  /** Span both columns of a two-column grid. */
  wide?: boolean;
  /**
   * Render the control. Receives the wiring it must spread onto the input so
   * the label, the error and the invalid state are correctly associated.
   */
  children: (wiring: {
    id: string;
    'aria-invalid': boolean;
    'aria-describedby': string | undefined;
    className: string;
  }) => ReactNode;
}

/**
 * A labelled form control with its validation message.
 *
 * Every form uses this rather than hand-wiring inputs, which is what makes the
 * accessibility guarantees hold everywhere instead of only where somebody
 * remembered: the label is always associated with the control, an invalid field
 * always sets `aria-invalid`, and the message is always announced through
 * `aria-describedby`. A red border alone is invisible to a screen reader and to
 * anyone who cannot distinguish the colour.
 */
export function Field({
  id,
  label,
  error,
  hint,
  required = false,
  wide = false,
  children,
}: FieldProps) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = error ? errorId : hint ? hintId : undefined;

  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <label className="lf-label" htmlFor={id}>
        {label}
        {!required && (
          <span className="font-normal normal-case text-soft"> (optional)</span>
        )}
      </label>

      {children({
        id,
        'aria-invalid': Boolean(error),
        'aria-describedby': describedBy,
        className: `lf-input ${error ? 'border-red/70 focus:border-red' : ''}`,
      })}

      {error ? (
        <p id={errorId} className="mt-1.5 text-xs font-medium text-red" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="mt-1.5 text-xs leading-relaxed text-soft">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

interface FormErrorProps {
  /** Form-level message — one that belongs to no single field. */
  error: string | null;
}

/** Banner for a failure that is not attributable to one field. */
export function FormError({ error }: FormErrorProps) {
  if (!error) {
    return null;
  }
  return (
    <p
      className="mt-5 rounded-xl border border-red/40 bg-red/10 px-4 py-3 text-sm text-red"
      role="alert"
    >
      {error}
    </p>
  );
}
