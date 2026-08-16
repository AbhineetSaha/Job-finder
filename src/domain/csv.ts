/**
 * CSV parsing and import validation. Pure, no I/O.
 *
 * Every cell here is untrusted input from a file the operator did not write
 * (brief §44). Three separate concerns are handled:
 *   - structural: RFC 4180 quoting, so a quoted comma does not split a row
 *   - safety: formula injection, control characters, URL schemes, length caps
 *   - semantic: required fields, email/domain shape, duplicate detection
 */
import { z } from 'zod';
import { isValidEmailShape, normalizeDomain, safeUrl, splitName } from './normalize.js';
import { findIntraBatchDuplicates } from './dedup.js';
import { categorizeRole } from './roles.js';

/** Guard rails so a hostile or accidental file cannot exhaust memory. */
export const MAX_CSV_BYTES = 5 * 1024 * 1024;
export const MAX_CSV_ROWS = 5000;
const MAX_CELL_LENGTH = 2000;

/** Characters a spreadsheet may interpret as the start of a formula. */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

/**
 * Neutralise a cell for safe storage.
 * Strips control characters and removes a leading formula trigger, so a cell
 * like `=HYPERLINK("http://evil","click")` is stored as inert text.
 */
export function sanitizeCell(raw: string): string {
  // eslint-disable-next-line no-control-regex
  let value = raw.replace(/[\u0000-\u001f\u007f]/g, ' ');
  value = value.trim();
  while (value.length > 0 && FORMULA_PREFIXES.includes(value[0] as string)) {
    value = value.slice(1).trim();
  }
  if (value.length > MAX_CELL_LENGTH) value = value.slice(0, MAX_CELL_LENGTH);
  return value;
}

/**
 * Escape a cell for CSV *export*. A leading formula trigger is prefixed with a
 * single quote so opening the export in Excel or Sheets cannot execute it.
 */
export function escapeCellForExport(value: string | null | undefined): string {
  const raw = value ?? '';
  const guarded = FORMULA_PREFIXES.includes(raw[0] ?? '') ? `'${raw}` : raw;
  if (/[",\r\n]/.test(guarded)) {
    return `"${guarded.replaceAll('"', '""')}"`;
  }
  return guarded;
}

export function toCsv(headers: string[], rows: (string | null | undefined)[][]): string {
  const lines = [headers.map(escapeCellForExport).join(',')];
  for (const row of rows) lines.push(row.map(escapeCellForExport).join(','));
  return lines.join('\r\n');
}

/** RFC 4180 parser: handles quoted fields, escaped quotes, and CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  // Strip a UTF-8 BOM, which Excel adds and which would corrupt the first header.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    // Ignore a trailing blank line rather than emitting a phantom row.
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const char = text[i] as string;

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ',') {
      pushField();
      i += 1;
      continue;
    }
    if (char === '\r') {
      if (text[i + 1] === '\n') i += 1;
      pushRow();
      i += 1;
      continue;
    }
    if (char === '\n') {
      pushRow();
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }

  if (field !== '' || row.length > 0) pushRow();
  return rows;
}

/* -------------------------------------------------------------------------- */
/* Import schema                                                              */
/* -------------------------------------------------------------------------- */

export const IMPORT_COLUMNS = [
  'company_name',
  'website',
  'contact_name',
  'contact_role',
  'contact_email',
  'source_url',
  // Optional enrichment columns.
  'company_linkedin_url',
  'contact_linkedin_url',
  'country',
  'state',
  'city',
  'timezone',
  'industry',
  'company_size',
  'funding_stage',
  'company_description',
  'technology_stack',
  'notes',
] as const;

export const REQUIRED_COLUMNS = ['company_name', 'contact_email'] as const;

export const importRowSchema = z.object({
  company_name: z.string().min(1, 'company_name is required').max(300),
  website: z.string().max(500).optional().default(''),
  contact_name: z.string().max(200).optional().default(''),
  contact_role: z.string().max(200).optional().default(''),
  contact_email: z.string().min(1, 'contact_email is required').max(254),
  source_url: z.string().max(500).optional().default(''),
  company_linkedin_url: z.string().max(500).optional().default(''),
  contact_linkedin_url: z.string().max(500).optional().default(''),
  country: z.string().max(60).optional().default(''),
  state: z.string().max(60).optional().default(''),
  city: z.string().max(120).optional().default(''),
  timezone: z.string().max(60).optional().default(''),
  industry: z.string().max(120).optional().default(''),
  company_size: z.string().max(60).optional().default(''),
  funding_stage: z.string().max(60).optional().default(''),
  company_description: z.string().max(2000).optional().default(''),
  technology_stack: z.string().max(1000).optional().default(''),
  notes: z.string().max(2000).optional().default(''),
});

export type ImportRowInput = z.infer<typeof importRowSchema>;

export interface ParsedImportRow {
  /** 1-based row number as it appears in the file, header excluded. */
  rowNumber: number;
  raw: Record<string, string>;
  companyName: string;
  website: string | null;
  companyLinkedinUrl: string | null;
  contactName: string;
  contactRole: string | null;
  roleCategory: ReturnType<typeof categorizeRole>;
  contactEmail: string;
  contactLinkedinUrl: string | null;
  sourceUrl: string | null;
  country: string;
  state: string | null;
  city: string | null;
  timezone: string | null;
  industry: string | null;
  companySize: string | null;
  fundingStage: string | null;
  companyDescription: string | null;
  technologyStack: string[];
  notes: string | null;
}

export interface InvalidImportRow {
  rowNumber: number;
  raw: Record<string, string>;
  errors: string[];
}

export interface ImportParseResult {
  valid: ParsedImportRow[];
  invalid: InvalidImportRow[];
  /** Missing required headers; when non-empty nothing is importable. */
  missingColumns: string[];
  unknownColumns: string[];
  totalRows: number;
  truncated: boolean;
}

function splitList(value: string): string[] {
  return value
    .split(/[;,|]/)
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 50);
}

/**
 * Parse and validate an uploaded CSV. Never throws on bad input — invalid rows
 * are collected with reasons so the operator can download and fix them
 * (brief §10).
 */
export function parseImportCsv(text: string): ImportParseResult {
  const grid = parseCsv(text);
  if (grid.length === 0) {
    return {
      valid: [],
      invalid: [],
      missingColumns: [...REQUIRED_COLUMNS],
      unknownColumns: [],
      totalRows: 0,
      truncated: false,
    };
  }

  const headerRow = (grid[0] ?? []).map((h) => sanitizeCell(h).toLowerCase().replace(/\s+/g, '_'));
  const knownColumns = new Set<string>(IMPORT_COLUMNS);
  const missingColumns = REQUIRED_COLUMNS.filter((c) => !headerRow.includes(c));
  const unknownColumns = headerRow.filter((h) => h !== '' && !knownColumns.has(h));

  if (missingColumns.length > 0) {
    return {
      valid: [],
      invalid: [],
      missingColumns,
      unknownColumns,
      totalRows: Math.max(0, grid.length - 1),
      truncated: false,
    };
  }

  const bodyRows = grid.slice(1);
  const truncated = bodyRows.length > MAX_CSV_ROWS;
  const considered = truncated ? bodyRows.slice(0, MAX_CSV_ROWS) : bodyRows;

  const valid: ParsedImportRow[] = [];
  const invalid: InvalidImportRow[] = [];

  considered.forEach((cells, index) => {
    const rowNumber = index + 1;
    const raw: Record<string, string> = {};
    headerRow.forEach((header, columnIndex) => {
      if (!header) return;
      raw[header] = sanitizeCell(cells[columnIndex] ?? '');
    });

    // Skip entirely blank lines silently — trailing newlines are not errors.
    if (Object.values(raw).every((v) => v === '')) return;

    const parsed = importRowSchema.safeParse(raw);
    if (!parsed.success) {
      invalid.push({
        rowNumber,
        raw,
        errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'row'}: ${i.message}`),
      });
      return;
    }

    const data = parsed.data;
    const errors: string[] = [];

    if (!isValidEmailShape(data.contact_email)) {
      errors.push(`contact_email: "${data.contact_email}" is not a valid email address`);
    }
    if (data.website && !normalizeDomain(data.website)) {
      errors.push(`website: "${data.website}" is not a valid domain or URL`);
    }
    if (data.timezone && !isValidTimeZone(data.timezone)) {
      errors.push(`timezone: "${data.timezone}" is not a valid IANA time zone`);
    }

    if (errors.length > 0) {
      invalid.push({ rowNumber, raw, errors });
      return;
    }

    const { fullName } = splitName(data.contact_name);
    valid.push({
      rowNumber,
      raw,
      companyName: data.company_name,
      website: safeUrl(data.website),
      companyLinkedinUrl: safeUrl(data.company_linkedin_url),
      contactName: fullName,
      contactRole: data.contact_role || null,
      roleCategory: categorizeRole(data.contact_role),
      contactEmail: data.contact_email,
      contactLinkedinUrl: safeUrl(data.contact_linkedin_url),
      sourceUrl: safeUrl(data.source_url),
      country: data.country || 'US',
      state: data.state || null,
      city: data.city || null,
      timezone: data.timezone || null,
      industry: data.industry || null,
      companySize: data.company_size || null,
      fundingStage: data.funding_stage || null,
      companyDescription: data.company_description || null,
      technologyStack: splitList(data.technology_stack),
      notes: data.notes || null,
    });
  });

  // Reject duplicates within the file itself before anything is written.
  const intra = findIntraBatchDuplicates(
    valid.map((v) => ({
      companyName: v.companyName,
      companyDomainOrWebsite: v.website,
      contactName: v.contactName,
      contactEmail: v.contactEmail,
    })),
  );

  if (intra.length > 0) {
    const dropIndexes = new Set(intra.map((c) => c.index));
    const reasonByIndex = new Map(intra.map((c) => [c.index, c.reason]));
    const kept: ParsedImportRow[] = [];
    valid.forEach((row, index) => {
      if (dropIndexes.has(index)) {
        invalid.push({
          rowNumber: row.rowNumber,
          raw: row.raw,
          errors: [reasonByIndex.get(index) ?? 'Duplicate row within the uploaded file.'],
        });
      } else {
        kept.push(row);
      }
    });
    invalid.sort((a, b) => a.rowNumber - b.rowNumber);
    return {
      valid: kept,
      invalid,
      missingColumns: [],
      unknownColumns,
      totalRows: considered.length,
      truncated,
    };
  }

  invalid.sort((a, b) => a.rowNumber - b.rowNumber);
  return { valid, invalid, missingColumns: [], unknownColumns, totalRows: considered.length, truncated };
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** CSV of the rows that failed, with an `errors` column, for download and repair. */
export function invalidRowsToCsv(invalid: InvalidImportRow[]): string {
  const headers = [...IMPORT_COLUMNS, 'errors'];
  const rows = invalid.map((row) => [
    ...IMPORT_COLUMNS.map((column) => row.raw[column] ?? ''),
    row.errors.join('; '),
  ]);
  return toCsv(headers, rows);
}
