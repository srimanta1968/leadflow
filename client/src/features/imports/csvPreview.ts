/**
 * Local file inspection for the import wizard.
 *
 * NOTHING HERE TOUCHES THE NETWORK, and that is the acceptance criterion rather
 * than an optimisation. The operator is about to hand over a contact export —
 * possibly a licensed third-party list they are not yet sure they may use — and
 * the wizard asks them to attest to its origin two steps LATER. Uploading first
 * and asking afterwards would mean the file had already crossed the trust
 * boundary before anybody claimed the right to send it.
 *
 * So the preview is computed in the browser from a bounded slice of the file,
 * and the bytes only leave the machine at commit, after the attestation.
 *
 * EVERY DETECTION REPORTS ITS CONFIDENCE. A delimiter guess presented as fact is
 * worse than no guess: the operator accepts it, the mapping silently shifts by
 * one column, and the error surfaces as scrambled data long after the commit.
 * Each function below returns what it decided, how sure it is, and the reason in
 * words the operator can check against their own file.
 */

/** How much of the file to read for detection. */
const PREVIEW_BYTES = 256 * 1024;
/** Rows shown in the preview table. */
export const PREVIEW_ROW_LIMIT = 20;
/** Lines used to decide the delimiter. */
const SNIFF_LINES = 20;

export type Confidence = 'high' | 'medium' | 'low';

export interface Detected<T> {
  value: T;
  confidence: Confidence;
  /** Why, in the operator's terms — shown next to the value, never hidden. */
  reason: string;
}

export const DELIMITERS = [
  { value: ',', label: 'Comma' },
  { value: ';', label: 'Semicolon' },
  { value: '\t', label: 'Tab' },
  { value: '|', label: 'Pipe' },
] as const;

export type DelimiterValue = (typeof DELIMITERS)[number]['value'];

export const ENCODINGS = ['Auto-detect UTF-8', 'Windows-1252'] as const;
export type EncodingChoice = (typeof ENCODINGS)[number];

export interface FilePreview {
  fileName: string;
  fileSize: number;
  encoding: Detected<string>;
  delimiter: Detected<DelimiterValue>;
  header: Detected<boolean>;
  /** Column names — from the header row, or synthesised when there is none. */
  columns: string[];
  /** Data rows only, capped at PREVIEW_ROW_LIMIT. */
  rows: string[][];
  /** Rows counted in the slice that was read, excluding the header. */
  rowCount: number;
  /** True when the file was larger than the slice, so rowCount is a floor. */
  truncated: boolean;
}

/**
 * Encoding, from the bytes rather than the extension.
 *
 * A BOM is proof. Without one, UTF-8 is *verified* by decoding strictly: invalid
 * UTF-8 throws, and the usual culprit in a contact export is Windows-1252 — the
 * smart quotes and accented names that Excel writes by default. Falling back to
 * it is a guess, so it is reported as one.
 */
export function detectEncoding(bytes: Uint8Array): Detected<string> {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { value: 'UTF-8', confidence: 'high', reason: 'byte-order mark present' };
  }
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    return { value: 'UTF-16', confidence: 'high', reason: 'UTF-16 byte-order mark present' };
  }

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // Pure ASCII decodes as UTF-8 too, and is genuinely ambiguous — it is valid
    // in both encodings — so it is reported as such rather than claimed.
    const hasHighBytes = bytes.some((b) => b > 0x7f);
    return hasHighBytes
      ? { value: 'UTF-8', confidence: 'high', reason: 'decodes as valid UTF-8 including multi-byte characters' }
      : { value: 'UTF-8', confidence: 'medium', reason: 'ASCII only — valid as UTF-8, but Windows-1252 would also fit' };
  } catch {
    return {
      value: 'Windows-1252',
      confidence: 'medium',
      reason: 'not valid UTF-8; Windows-1252 is the usual encoding for spreadsheet exports',
    };
  }
}

/** Split a line honouring quoted fields, so a comma inside "Smith, John" is data. */
function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/**
 * The delimiter, chosen by CONSISTENCY rather than by frequency.
 *
 * Counting occurrences picks the wrong character constantly: an address column
 * full of "Dallas, TX" makes commas win in a semicolon-delimited file. What
 * actually identifies a delimiter is that it produces the SAME number of fields
 * on every line — a real delimiter is structural, a stray one is not.
 *
 * Confidence is that consistency: unanimous across the sniffed lines is high,
 * a couple of ragged lines is medium, anything less is low and the operator is
 * told to check.
 */
export function detectDelimiter(text: string): Detected<DelimiterValue> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0).slice(0, SNIFF_LINES);

  if (lines.length === 0) {
    return { value: ',', confidence: 'low', reason: 'file appears to be empty; defaulted to comma' };
  }

  let best: { delimiter: DelimiterValue; fields: number; agreement: number } | null = null;

  for (const { value } of DELIMITERS) {
    const counts = lines.map((line) => splitLine(line, value).length);
    const modal = counts.sort((a, b) =>
      counts.filter((c) => c === b).length - counts.filter((c) => c === a).length)[0];
    // A single field means the character never appeared — not a delimiter here.
    if (modal < 2) continue;
    const agreement = counts.filter((c) => c === modal).length / counts.length;
    if (!best || agreement > best.agreement || (agreement === best.agreement && modal > best.fields)) {
      best = { delimiter: value as DelimiterValue, fields: modal, agreement };
    }
  }

  if (!best) {
    return { value: ',', confidence: 'low', reason: 'no candidate produced more than one column; defaulted to comma' };
  }

  const label = DELIMITERS.find((d) => d.value === best!.delimiter)?.label ?? best.delimiter;
  const pct = Math.round(best.agreement * 100);

  if (best.agreement === 1) {
    return { value: best.delimiter, confidence: 'high', reason: `${label} gives ${best.fields} columns on every sampled line` };
  }
  if (best.agreement >= 0.8) {
    return { value: best.delimiter, confidence: 'medium', reason: `${label} gives ${best.fields} columns on ${pct}% of sampled lines` };
  }
  return { value: best.delimiter, confidence: 'low', reason: `${label} is only consistent on ${pct}% of lines — check the delimiter and quoting` };
}

const looksNumeric = (v: string): boolean => v !== '' && !Number.isNaN(Number(v.replace(/[,$%]/g, '')));
const looksDate = (v: string): boolean => /^\d{4}-\d{2}-\d{2}/.test(v) || /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(v);

/**
 * Whether the first row names the columns or is already data.
 *
 * Two signals, and they agree in the easy cases: a header's cells are text
 * rather than numbers or dates, and they are all distinct. Data rows routinely
 * repeat a value across columns and routinely contain numbers.
 *
 * Deliberately conservative — a file with one text row followed by more text
 * rows is genuinely ambiguous, and the honest answer is medium confidence with
 * a prompt to look, not a confident guess that shifts every row by one.
 */
export function detectHeader(rows: string[][]): Detected<boolean> {
  if (rows.length === 0) {
    return { value: false, confidence: 'low', reason: 'no rows to inspect' };
  }
  const first = rows[0];
  const distinct = new Set(first.map((c) => c.toLowerCase())).size === first.length;
  const anyNumeric = first.some((c) => looksNumeric(c) || looksDate(c));
  const anyEmpty = first.some((c) => c === '');

  if (anyNumeric) {
    return { value: false, confidence: 'high', reason: 'first row contains numbers or dates, so it is data rather than column names' };
  }
  if (anyEmpty) {
    return { value: false, confidence: 'low', reason: 'first row has blank cells, which is unusual for column names' };
  }
  if (!distinct) {
    return { value: false, confidence: 'medium', reason: 'first row repeats a value, and column names are normally distinct' };
  }

  // The strongest positive signal: the row below is shaped differently.
  const second = rows[1];
  if (second && second.some((c) => looksNumeric(c) || looksDate(c))) {
    return { value: true, confidence: 'high', reason: 'first row is all text and distinct while the second contains numbers or dates' };
  }
  return { value: true, confidence: 'medium', reason: 'first row is all text and distinct, but the rows below are text too — worth confirming' };
}

/** Parse the decoded slice into rows, honouring quotes. */
export function parseRows(text: string, delimiter: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => splitLine(line, delimiter));
}

/**
 * Inspect a file the operator chose, entirely in the browser.
 *
 * Reads only the first PREVIEW_BYTES so a 200 MB export does not have to be
 * held in memory to show five rows; `truncated` says so, and rowCount is
 * reported as a floor rather than a total the wizard cannot actually know yet.
 */
export async function previewFile(
  file: File,
  overrides: { delimiter?: DelimiterValue; hasHeader?: boolean } = {}
): Promise<FilePreview> {
  const slice = file.slice(0, PREVIEW_BYTES);
  const bytes = new Uint8Array(await slice.arrayBuffer());

  const encoding = detectEncoding(bytes);
  const decoder = new TextDecoder(encoding.value === 'Windows-1252' ? 'windows-1252' : 'utf-8');
  const text = decoder.decode(bytes);

  const detectedDelimiter = detectDelimiter(text);
  const delimiter = overrides.delimiter ?? detectedDelimiter.value;
  const allRows = parseRows(text, delimiter);

  const detectedHeader = detectHeader(allRows);
  const hasHeader = overrides.hasHeader ?? detectedHeader.value;

  const columns = hasHeader && allRows.length > 0
    ? allRows[0]
    : (allRows[0] ?? []).map((_, i) => `Column ${i + 1}`);
  const dataRows = hasHeader ? allRows.slice(1) : allRows;

  return {
    fileName: file.name,
    fileSize: file.size,
    encoding,
    // When the operator overrode a detection, the panel must stop claiming the
    // machine chose it — the confidence shown belongs to whoever decided.
    delimiter: overrides.delimiter
      ? { value: delimiter, confidence: 'high', reason: 'set by you' }
      : detectedDelimiter,
    header: overrides.hasHeader === undefined
      ? detectedHeader
      : { value: hasHeader, confidence: 'high', reason: 'set by you' },
    columns,
    rows: dataRows.slice(0, PREVIEW_ROW_LIMIT),
    rowCount: dataRows.length,
    truncated: file.size > PREVIEW_BYTES,
  };
}

/** The canonical template offered on step 2, so a custom CSV can start correct. */
export const CANONICAL_TEMPLATE_COLUMNS = [
  'external_id',
  'first_name',
  'last_name',
  'organization',
  'email',
  'phone',
  'street',
  'city',
  'region',
  'postal_code',
  'country',
  'source_note',
];

/** A small, honest sample so the wizard can be exercised without a real export. */
export const SAMPLE_CSV = [
  CANONICAL_TEMPLATE_COLUMNS.join(','),
  'NS-1001,Marcus,Webb,NorthStar Roofing,marcus.webb@example.com,555-0142,12 Oak Street,Dallas,TX,75201,US,storm route',
  'NS-1002,Dana,Ruiz,,dana.ruiz@example.com,555-0187,88 Cedar Lane,Plano,TX,75024,US,referral',
  'NS-1003,Priya,Nair,Nair Property Group,priya@example.com,555-0110,4 Elm Court,Frisco,TX,75033,US,web form',
  'NS-1004,Tom,Okafor,,tom.okafor@example.com,555-0165,900 Pine Ridge,Irving,TX,75039,US,inspection',
].join('\n');
