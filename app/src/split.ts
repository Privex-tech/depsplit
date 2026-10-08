/**
 * Split maths that mirrors `contracts/split_router` exactly.
 *
 * All amounts are bigint stroops (7 decimals). Shares round *down*; the
 * remainder ("dust") goes to the project owner, so the sum of all lines is
 * always equal to the amount paid. Dependency shares are one hop: they are
 * credited to the dependency's pool, never re-split here.
 */

export const BPS_DENOMINATOR = 10_000;
export const MAX_MAINTAINERS = 32;
export const MAX_DEPENDENCIES = 32;
export const MAX_SLUG_LEN = 64;
export const DECIMALS = 7;
export const STROOPS_PER_UNIT = 10_000_000n;

export interface MaintainerShare {
  address: string;
  bps: number;
}

export interface DependencyShare {
  slug: string;
  bps: number;
  /** on-chain id once known */
  projectId?: number;
}

export interface SplitTable {
  owner: string;
  maintainers: MaintainerShare[];
  dependencies: DependencyShare[];
}

export type SplitLineType = "maintainer" | "dependency" | "dust";

export interface SplitLine {
  type: SplitLineType;
  /** maintainer address, dependency slug, or owner address for dust */
  recipient: string;
  bps: number;
  amount: bigint;
}

export interface SplitResult {
  lines: SplitLine[];
  dust: bigint;
  total: bigint;
}

/** `amount * bps / 10_000`, floored, like the contract's `share_of`. */
export function shareOf(amount: bigint, bps: number): bigint {
  if (amount < 0n) throw new Error("amount must not be negative");
  if (!Number.isInteger(bps) || bps < 0 || bps > BPS_DENOMINATOR) {
    throw new Error(`bps out of range: ${bps}`);
  }
  return (amount * BigInt(bps)) / BigInt(BPS_DENOMINATOR);
}

/**
 * Split `amount` with `table` exactly as `credit_table` does on-chain.
 * Throws if the table is invalid (the contract would reject it too).
 */
export function splitAmount(amount: bigint, table: SplitTable): SplitResult {
  if (amount <= 0n) throw new Error("amount must be > 0");
  const problems = validateTable(table);
  if (problems.length > 0) throw new Error(`invalid split table: ${problems.join("; ")}`);

  const lines: SplitLine[] = [];
  let credited = 0n;
  for (const m of table.maintainers) {
    const part = shareOf(amount, m.bps);
    lines.push({ type: "maintainer", recipient: m.address, bps: m.bps, amount: part });
    credited += part;
  }
  for (const d of table.dependencies) {
    const part = shareOf(amount, d.bps);
    lines.push({ type: "dependency", recipient: d.slug, bps: d.bps, amount: part });
    credited += part;
  }
  const dust = amount - credited;
  if (dust < 0n) throw new Error("internal: credited more than paid");
  if (dust > 0n) {
    lines.push({ type: "dust", recipient: table.owner, bps: 0, amount: dust });
  }
  return { lines, dust, total: amount };
}

/**
 * Validate a table with the same rules as the contract's `validate_table`.
 * Returns a list of human-readable problems (empty when valid).
 * Dependency *existence* is not checked here: that needs the registry/chain.
 */
export function validateTable(table: SplitTable, selfSlug?: string): string[] {
  const problems: string[] = [];
  if (!Array.isArray(table.maintainers) || table.maintainers.length === 0) {
    problems.push("a table needs at least one maintainer");
  }
  if ((table.maintainers?.length ?? 0) > MAX_MAINTAINERS) {
    problems.push(`more than ${MAX_MAINTAINERS} maintainers`);
  }
  if ((table.dependencies?.length ?? 0) > MAX_DEPENDENCIES) {
    problems.push(`more than ${MAX_DEPENDENCIES} dependencies`);
  }
  let total = 0;
  const seenAddr = new Set<string>();
  for (const m of table.maintainers ?? []) {
    if (seenAddr.has(m.address)) problems.push(`duplicate maintainer ${m.address}`);
    seenAddr.add(m.address);
    if (!Number.isInteger(m.bps)) {
      problems.push(`maintainer ${m.address}: bps must be an integer (got ${JSON.stringify(m.bps)})`);
      continue;
    }
    if (m.bps <= 0) problems.push(`maintainer ${m.address}: bps must be > 0`);
    total += m.bps;
  }
  const seenDep = new Set<string>();
  for (const d of table.dependencies ?? []) {
    if (selfSlug !== undefined && d.slug === selfSlug) problems.push("a project cannot depend on itself");
    if (seenDep.has(d.slug)) problems.push(`duplicate dependency ${d.slug}`);
    seenDep.add(d.slug);
    if (!Number.isInteger(d.bps)) {
      problems.push(`dependency ${d.slug}: bps must be an integer (got ${JSON.stringify(d.bps)})`);
      continue;
    }
    if (d.bps <= 0) problems.push(`dependency ${d.slug}: bps must be > 0`);
    total += d.bps;
  }
  if (total !== BPS_DENOMINATOR && problems.length === 0) {
    problems.push(`bps must sum to ${BPS_DENOMINATOR}, got ${total}`);
  } else if (total !== BPS_DENOMINATOR) {
    problems.push(`bps sum is ${total}, expected ${BPS_DENOMINATOR}`);
  }
  return problems;
}

/** "1234.5678901" | "5,000" | " 12 " -> stroops. Rejects > 7 decimals and junk. */
export function parseAmount(text: string): bigint {
  const cleaned = String(text).trim().replace(/,/g, "").replace(/_/g, "");
  const m = /^(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (!m) throw new Error(`cannot parse amount "${text}"`);
  const whole = BigInt(m[1]);
  const frac = m[2] ?? "";
  if (frac.length > DECIMALS) {
    throw new Error(`amount "${text}" has more than ${DECIMALS} decimals (stroop precision)`);
  }
  const fracStroops = frac.length === 0 ? 0n : BigInt(frac.padEnd(DECIMALS, "0"));
  const value = whole * STROOPS_PER_UNIT + fracStroops;
  if (value <= 0n) throw new Error(`amount "${text}" must be > 0`);
  return value;
}

/** stroops -> "1234.5678901" (always 7 decimals, matches the contract's units). */
export function formatAmount(stroops: bigint): string {
  const neg = stroops < 0n;
  const abs = neg ? -stroops : stroops;
  const whole = abs / STROOPS_PER_UNIT;
  const frac = (abs % STROOPS_PER_UNIT).toString().padStart(DECIMALS, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}
