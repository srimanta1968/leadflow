import { createContext, useContext, type ReactNode } from 'react';
import type { ContactSummary } from '../../services/api';

/**
 * What every Contact 360 pane needs and none of them should re-fetch.
 *
 * The shell has already read the summary in order to draw the header and the
 * trust rail. A pane that called the same endpoint again would double the
 * requests on every tab switch and — worse — could render a header and a body
 * disagreeing about the same record, because the two reads are not atomic.
 *
 * `summary` is nullable on purpose. The panes must render their own chrome when
 * the record could not be read, rather than blanking; an operator who followed a
 * link to a contact needs to see WHICH tab they are on and that the read failed,
 * not an empty page that looks like a contact with no data.
 */

export interface ContactRecord {
  contactId: string;
  summary: ContactSummary | null;
  loading: boolean;
  /** Non-null when the summary read failed, carrying the server's message. */
  error: string | null;
  reload: () => void;
}

const ContactRecordContext = createContext<ContactRecord | null>(null);

export function ContactRecordProvider({
  value,
  children,
}: {
  value: ContactRecord;
  children: ReactNode;
}) {
  return <ContactRecordContext.Provider value={value}>{children}</ContactRecordContext.Provider>;
}

/**
 * Read the record the shell loaded.
 *
 * Throws outside the provider rather than returning a null-shaped default: a
 * pane rendered outside Contact 360 is a routing mistake, and a silent default
 * would turn it into a pane that quietly shows nothing for every contact.
 */
export function useContactRecord(): ContactRecord {
  const value = useContext(ContactRecordContext);
  if (!value) {
    throw new Error('useContactRecord must be used inside the Contact 360 shell');
  }
  return value;
}
