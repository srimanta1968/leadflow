import { useState } from 'react';
import { api, ApiError, type BookLiveResult } from '../../services/api';
import { useToast } from '../../components/feedback/ToastProvider';

/**
 * Booking flow, public booking page and the event content standard
 * (SOP §09 and §45).
 *
 * BOOK LIVE, ON THE CALL. The SOP's rule is that the rep creates the event while
 * still speaking and VERIFIES RECEIPT before ending the call, and the whole
 * screen is arranged around that sequence rather than around a calendar grid.
 * The reason is unglamorous and decisive: "I'll send you a link" converts far
 * worse than "I've just sent it, can you see it?", and the difference is
 * entirely in whether the rep is still on the phone when the invite fails.
 *
 * A VERBAL FOLLOW-UP IS NOT A NEXT ACTION. "Will call back" satisfies nobody: it
 * has no date, no owner commitment and nothing to breach, so it is invisible to
 * every queue and every clock in the system. The form therefore has no way to
 * express it — the NEXT is a booked event or it is not a NEXT.
 *
 * THE CONTENT STANDARD IS CHECKED, NOT ASSUMED. An event missing its meeting
 * link or its cancellation link generates a support call at the worst possible
 * moment, so the result reports each required field rather than a single
 * "booked".
 */

/** The event content standard, per §45. */
const CONTENT_STANDARD = [
  'Purpose',
  'Agenda',
  'Meeting link',
  'Contact details',
  'Company',
  'CRM record id',
  'Assigned rep',
  'Cancellation link',
  'Reschedule link',
];

export default function Calendar() {
  const [contactRef, setContactRef] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [purpose, setPurpose] = useState('');
  const [agenda, setAgenda] = useState('');
  const [result, setResult] = useState<BookLiveResult | null>(null);
  const [booking, setBooking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { notify } = useToast();

  const complete = contactRef.trim() !== '' && startsAt !== '' && purpose.trim() !== '';

  const book = async () => {
    setBooking(true);
    setError(null);
    try {
      const outcome = await api.bookLive({
        contact_ref: contactRef.trim(),
        starts_at: startsAt,
        purpose: purpose.trim(),
        agenda: agenda.trim(),
      });
      setResult(outcome);
      /* Reports what the server actually confirmed. The old branch keyed on
         `receipt_verified`, which this endpoint has never returned — so it read
         undefined and every successful booking was announced as "receipt is NOT
         verified". The reminder ladder is the real check available here: a
         booking with no reminders is the one that quietly no-shows. */
      notify(
        outcome.reminders_scheduled > 0
          ? {
              tone: 'success',
              title: 'Booked live',
              detail: `${outcome.reminders_scheduled} reminder${outcome.reminders_scheduled === 1 ? '' : 's'} scheduled. Confirm the details with the customer before ending the call.`,
            }
          : {
              tone: 'warning',
              title: 'Booked, but NO reminders were scheduled',
              detail: 'The customer will get no prompt before this meeting. Say so before you hang up.',
            },
      );
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The event could not be created.');
    } finally {
      setBooking(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold text-text">Calendar</h1>
        <p className="mt-1.5 max-w-3xl text-sm text-muted">
          Book while you are still speaking, and verify the customer received it before you hang
          up. A verbal follow-up cannot be recorded as the NEXT action - it has no date, no
          commitment and nothing to breach.
        </p>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {/* -------------------------------------------------- book live */}
        <section className="lf-panel p-5" aria-label="Book live">
          <h2 className="lf-eyebrow">Book live</h2>

          <div className="mt-3 space-y-4">
            <div>
              <label className="lf-label" htmlFor="contact_ref">
                Contact
              </label>
              <input
                id="contact_ref"
                name="contact_ref"
                className="lf-input mt-1 w-full"
                value={contactRef}
                onChange={(event) => setContactRef(event.target.value)}
              />
            </div>

            <div>
              <label className="lf-label" htmlFor="starts_at">
                Starts at
              </label>
              <input
                id="starts_at"
                name="starts_at"
                type="datetime-local"
                className="lf-input mt-1 w-full"
                value={startsAt}
                onChange={(event) => setStartsAt(event.target.value)}
              />
            </div>

            <div>
              <label className="lf-label" htmlFor="meeting_purpose">
                Purpose
              </label>
              <input
                id="meeting_purpose"
                name="meeting_purpose"
                className="lf-input mt-1 w-full"
                value={purpose}
                onChange={(event) => setPurpose(event.target.value)}
              />
            </div>

            <div>
              <label className="lf-label" htmlFor="meeting_agenda">
                Agenda
              </label>
              <textarea
                id="meeting_agenda"
                name="meeting_agenda"
                rows={3}
                className="lf-input mt-1 w-full"
                value={agenda}
                onChange={(event) => setAgenda(event.target.value)}
              />
            </div>

            <button
              type="button"
              name="book_live"
              disabled={!complete || booking}
              onClick={() => void book()}
              className="lf-btn-primary w-full px-4 py-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {booking ? 'Creating the event...' : 'Book live and verify receipt'}
            </button>

            {error && (
              <p className="rounded border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">
                {error}
              </p>
            )}
          </div>
        </section>

        {/* ------------------------------------------ receipt verification */}
        <section className="lf-panel p-5" aria-label="Receipt verification">
          <h2 className="lf-eyebrow">Receipt verification</h2>
          <p className="mt-1 text-xs text-soft">
            Checked before you end the call. An invite that silently failed is discovered by the
            customer not turning up.
          </p>

          {result ? (
            <ul className="mt-3 space-y-2 text-sm">
              <li className="text-green">
                Booked live — meeting {result.meeting_id}
              </li>
              <li className={result.reminders_scheduled > 0 ? 'text-green' : 'text-red'}>
                {result.reminders_scheduled > 0
                  ? `${result.reminders_scheduled} reminder${result.reminders_scheduled === 1 ? '' : 's'} scheduled`
                  : 'NO reminders scheduled — the customer will get no prompt before this meeting'}
              </li>
              <li className={result.meeting_link ? 'text-green' : 'text-muted'}>
                {result.meeting_link
                  ? 'Meeting link attached'
                  : 'No meeting link — say how you will reach them before you hang up'}
              </li>
              {result.note && <li className="text-muted">{result.note}</li>}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-muted">Nothing booked in this session yet.</p>
          )}

          <h3 className="lf-label mt-5">Event content standard</h3>
          <ul className="mt-2 space-y-1">
            {CONTENT_STANDARD.map((field) => {
              /* CHECKED AGAINST WHAT THE SERVER ACTUALLY CONFIRMED, not against
                 a per-field verdict it has never sent. The four it can answer
                 are answered; the rest say so rather than claiming a check that
                 did not happen — a green tick nobody computed is worse than an
                 admitted gap on a screen whose whole job is "can I hang up". */
              const present: boolean | null =
                !result ? null
                : field === 'Purpose' ? Boolean(result.purpose)
                : field === 'Agenda' ? Boolean(result.agenda)
                : field === 'Meeting link' ? Boolean(result.meeting_link)
                : field === 'Contact details' ? Boolean(result.contact_ref)
                : null;
              return (
                <li key={field} className="text-xs">
                  <span className={present === true ? 'text-green' : present === false ? 'text-red' : 'text-soft'}>
                    {present === null ? 'Not checked' : present ? 'Present' : 'Missing'}
                  </span>
                  <span className="text-muted"> — {field}</span>
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      {/* ------------------------------------------- the NEXT action rule */}
      <section className="lf-panel mt-4 p-5" aria-label="Next action rule">
        <h2 className="lf-eyebrow">What can satisfy the NEXT action</h2>
        <p className="mt-1 text-sm text-muted">
          A booked event with a date and a receipt. A verbal follow-up such as "will call back"
          cannot be recorded here, because it has no date, no owner commitment and nothing to
          breach - it would be invisible to every queue and every clock in the system.
        </p>
      </section>

      <section className="lf-panel mt-4 p-5" aria-label="Public booking page">
        <h2 className="lf-eyebrow">Public booking page</h2>
        <p className="mt-1 text-sm text-muted">
          The customer-facing page carries the same design language and the same content
          standard, so a self-served booking is indistinguishable in quality from one a rep made
          on the phone.
        </p>
      </section>
    </div>
  );
}
