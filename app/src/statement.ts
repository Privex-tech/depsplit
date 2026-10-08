/**
 * Payer statement: expands each payment into the split lines the contract
 * credited (mirroring `credit_table`) so a foundation's books show who was
 * paid what, per memo. Input is the payer's local payments CSV (written by
 * `depsplit pay`, or maintained by hand) plus the split tables per version
 * from the registry / plan.
 */
import { formatAmount, parseAmount, splitAmount, type SplitTable } from "./split.js";

export interface PaymentRow {
  date: string;
  payer: string;
  projectSlug: string;
  projectId?: number;
  version?: number;
  amount: bigint;
  memo: string;
  memoHash?: string;
  txHash?: string;
}

export const PAYMENTS_HEADER = ["date", "payer", "project_slug", "project_id", "version", "amount", "memo", "memo_hash", "tx_hash"] as const;

export const STATEMENT_HEADER = [
  "payment_date",
  "payer",
  "memo",
  "tx_hash",
  "project_slug",
  "project_id",
  "version",
  "line_type",
  "recipient",
  "bps",
  "amount",
] as const;

export interface StatementLine {
  payment_date: string;
  payer: string;
  memo: string;
  tx_hash: string;
  project_slug: string;
  project_id: string;
  version: string;
  line_type: "payment" | "maintainer" | "dependency" | "dust" | "unresolved";
  recipient: string;
  bps: string;
  amount: string;
}

/** Tables by slug and version: tables[slug][version]. */
export type TableLookup = (slug: string, version?: number) => { table: SplitTable; version: number; projectId?: number } | undefined;

// ---------------------------------------------------------------------------
// CSV (RFC 4180-ish: quotes, embedded commas, CRLF, BOM, blank lines)
// ---------------------------------------------------------------------------

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((f) => f.trim() !== "")) rows.push(row);
  }
  return rows;
}

export function csvEscape(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toCsv(header: readonly string[], rows: readonly Record<string, string>[]): string {
  const lines = [header.join(",")];
  for (const r of rows) lines.push(header.map((h) => csvEscape(r[h] ?? "")).join(","));
  return lines.join("\n") + "\n";
}

/** Parse the payer's payments CSV. Tolerates column order by header name, whitespace, thousands separators. */
export function parsePaymentsCsv(text: string): { rows: PaymentRow[]; problems: string[] } {
  const raw = parseCsv(text);
  const problems: string[] = [];
  if (raw.length === 0) return { rows: [], problems: ["payments file is empty"] };
  const header = raw[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const col = (name: string) => header.indexOf(name);
  for (const required of ["date", "payer", "project_slug", "amount", "memo"]) {
    if (col(required) < 0) problems.push(`payments file is missing column "${required}"`);
  }
  if (problems.length > 0) return { rows: [], problems };
  const rows: PaymentRow[] = [];
  raw.slice(1).forEach((r, i) => {
    const line = i + 2;
    const get = (name: string) => (col(name) >= 0 ? (r[col(name)] ?? "").trim() : "");
    try {
      const amount = parseAmount(get("amount"));
      const idText = get("project_id");
      const verText = get("version");
      rows.push({
        date: get("date"),
        payer: get("payer"),
        projectSlug: get("project_slug").toLowerCase(),
        projectId: idText ? parseInt(idText, 10) : undefined,
        version: verText ? parseInt(verText, 10) : undefined,
        amount,
        memo: get("memo"),
        memoHash: get("memo_hash") || undefined,
        txHash: get("tx_hash") || undefined,
      });
    } catch (e) {
      problems.push(`line ${line}: ${(e as Error).message}`);
    }
  });
  return { rows, problems };
}

export function paymentRowToCsvRecord(p: PaymentRow): Record<string, string> {
  return {
    date: p.date,
    payer: p.payer,
    project_slug: p.projectSlug,
    project_id: p.projectId?.toString() ?? "",
    version: p.version?.toString() ?? "",
    amount: formatAmount(p.amount),
    memo: p.memo,
    memo_hash: p.memoHash ?? "",
    tx_hash: p.txHash ?? "",
  };
}

// ---------------------------------------------------------------------------
// Statement
// ---------------------------------------------------------------------------

/**
 * Build the statement lines for `payer`: one `payment` line per payment, then
 * one line per credited share exactly as the contract split it. Payments to
 * unknown projects produce a single `unresolved` line rather than aborting.
 */
export function buildStatement(payer: string, payments: PaymentRow[], lookup: TableLookup): StatementLine[] {
  const out: StatementLine[] = [];
  const mine = payments.filter((p) => p.payer.trim() === payer.trim());
  for (const p of mine) {
    const found = lookup(p.projectSlug, p.version);
    const base = {
      payment_date: p.date,
      payer: p.payer,
      memo: p.memo,
      tx_hash: p.txHash ?? "",
      project_slug: p.projectSlug,
    };
    if (!found) {
      out.push({
        ...base,
        project_id: p.projectId?.toString() ?? "",
        version: p.version?.toString() ?? "",
        line_type: "unresolved",
        recipient: p.projectSlug,
        bps: "",
        amount: formatAmount(p.amount),
      });
      continue;
    }
    const projectId = (found.projectId ?? p.projectId)?.toString() ?? "";
    const version = found.version.toString();
    out.push({
      ...base,
      project_id: projectId,
      version,
      line_type: "payment",
      recipient: p.projectSlug,
      bps: "10000",
      amount: formatAmount(p.amount),
    });
    const split = splitAmount(p.amount, found.table);
    for (const l of split.lines) {
      out.push({
        ...base,
        project_id: projectId,
        version,
        line_type: l.type,
        recipient: l.recipient,
        bps: l.type === "dust" ? "" : l.bps.toString(),
        amount: formatAmount(l.amount),
      });
    }
  }
  return out;
}

export function statementToCsv(lines: StatementLine[]): string {
  return toCsv(STATEMENT_HEADER, lines as unknown as Record<string, string>[]);
}

export function sumAmounts(lines: StatementLine[], type?: StatementLine["line_type"]): bigint {
  return lines
    .filter((l) => (type ? l.line_type === type : true))
    .reduce((acc, l) => acc + parseAmount(l.amount), 0n);
}
