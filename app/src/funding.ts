/**
 * `funding.json` (FLOSS/fund manifest, https://floss.fund) parsing.
 *
 * Implemented subset of the v1 schema:
 *   - `version`
 *   - `entity`  { type, role, name, email?, description?, webpageUrl? }
 *   - `projects[]` { guid, name, description?, repositoryUrl?, licenses?, tags? }
 * plus the DepSplit extension, per project:
 *   - `x-stellar` { owner, maintainers: [{address, bps, name?, note?}],
 *                   dependencies: [{slug, bps}] }
 * A top-level `x-stellar.owner` may provide the default owner for every project.
 *
 * `funding.channels/plans/history` are accepted and ignored.
 */
import { StrKey } from "@stellar/stellar-sdk";
import { validateTable, MAX_SLUG_LEN, type SplitTable } from "./split.js";

export const ENTITY_TYPES = ["individual", "group", "organisation", "other"] as const;
export const ENTITY_ROLES = ["owner", "steward", "maintainer", "contributor", "other"] as const;
export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface Entity {
  type: (typeof ENTITY_TYPES)[number];
  role: (typeof ENTITY_ROLES)[number];
  name: string;
  email?: string;
  description?: string;
  webpageUrl?: string;
}

export interface MaintainerEntry {
  address: string;
  bps: number;
  name?: string;
  note?: string;
}

export interface FundingProject {
  slug: string;
  name: string;
  description?: string;
  repositoryUrl?: string;
  licenses: string[];
  tags: string[];
  owner: string;
  maintainers: MaintainerEntry[];
  dependencies: { slug: string; bps: number }[];
}

export interface FundingFile {
  source: string;
  version: string;
  entity: Entity;
  projects: FundingProject[];
  /** non-fatal clean-ups applied while parsing (trimmed names, lowercased emails...) */
  warnings: string[];
}

export class FundingParseError extends Error {
  constructor(
    public readonly source: string,
    public readonly problems: string[],
  ) {
    super(`${source}: ${problems.length} problem(s)\n  - ${problems.join("\n  - ")}`);
    this.name = "FundingParseError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function urlOf(v: unknown): string | undefined {
  // schema: { "url": "...", "wellKnown": "..." } — also tolerate a bare string
  if (typeof v === "string") return v.trim() || undefined;
  if (isRecord(v)) return str(v.url)?.trim() || undefined;
  return undefined;
}

export function isValidStellarAddress(a: unknown): a is string {
  return typeof a === "string" && (StrKey.isValidEd25519PublicKey(a) || StrKey.isValidContract(a));
}

/** Parse the text of one funding.json. Throws FundingParseError with every problem found. */
export function parseFundingJson(text: string, source = "funding.json"): FundingFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new FundingParseError(source, [`not valid JSON: ${(e as Error).message}`]);
  }
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(raw)) throw new FundingParseError(source, ["top level must be an object"]);

  const version = str(raw.version) ?? "";
  if (version !== "v1") problems.push(`version must be "v1" (got ${JSON.stringify(raw.version)})`);

  // ---- entity ---------------------------------------------------------
  let entity: Entity | undefined;
  if (!isRecord(raw.entity)) {
    problems.push("entity is required");
  } else {
    const e = raw.entity;
    const type = str(e.type)?.trim().toLowerCase();
    const role = str(e.role)?.trim().toLowerCase();
    const nameRaw = str(e.name);
    if (!type || !(ENTITY_TYPES as readonly string[]).includes(type)) {
      problems.push(`entity.type must be one of ${ENTITY_TYPES.join("|")}`);
    }
    if (!role || !(ENTITY_ROLES as readonly string[]).includes(role)) {
      problems.push(`entity.role must be one of ${ENTITY_ROLES.join("|")}`);
    }
    if (!nameRaw || !nameRaw.trim()) problems.push("entity.name is required");
    const name = (nameRaw ?? "").trim();
    if (nameRaw && name !== nameRaw) warnings.push(`entity.name trimmed ("${nameRaw}")`);
    let email = str(e.email)?.trim();
    if (email && email !== email.toLowerCase()) {
      warnings.push(`entity.email lowercased (${email})`);
      email = email.toLowerCase();
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      warnings.push(`entity.email does not look like an email (${email})`);
    }
    entity = {
      type: type as Entity["type"],
      role: role as Entity["role"],
      name,
      email: email || undefined,
      description: str(e.description)?.trim() || undefined,
      webpageUrl: urlOf(e.webpageUrl),
    };
  }

  // ---- default owner -------------------------------------------------
  const topExt = isRecord(raw["x-stellar"]) ? raw["x-stellar"] : undefined;
  const defaultOwner = str(topExt?.owner)?.trim();
  if (defaultOwner !== undefined && !isValidStellarAddress(defaultOwner)) {
    problems.push(`x-stellar.owner is not a valid Stellar address (${defaultOwner})`);
  }

  // ---- projects ------------------------------------------------------
  const projects: FundingProject[] = [];
  if (!Array.isArray(raw.projects) || raw.projects.length === 0) {
    problems.push("projects must be a non-empty array");
  } else {
    const seen = new Set<string>();
    raw.projects.forEach((p, i) => {
      const where = `projects[${i}]`;
      if (!isRecord(p)) {
        problems.push(`${where} must be an object`);
        return;
      }
      const guidRaw = str(p.guid) ?? "";
      const slug = guidRaw.trim().toLowerCase();
      if (slug !== guidRaw) warnings.push(`${where}.guid normalised ("${guidRaw}" -> "${slug}")`);
      if (!slug) problems.push(`${where}.guid is required`);
      else if (!SLUG_RE.test(slug)) problems.push(`${where}.guid "${slug}" must match ${SLUG_RE}`);
      else if (Buffer.byteLength(slug) > MAX_SLUG_LEN) problems.push(`${where}.guid longer than ${MAX_SLUG_LEN} bytes`);
      if (seen.has(slug)) problems.push(`${where}.guid "${slug}" is duplicated in this file`);
      seen.add(slug);

      const nameRaw = str(p.name) ?? "";
      const name = nameRaw.trim();
      if (!name) problems.push(`${where}.name is required`);
      else if (name !== nameRaw) warnings.push(`${where}.name trimmed`);

      const licenses = Array.isArray(p.licenses)
        ? p.licenses.filter((l): l is string => typeof l === "string").map((l) => l.trim())
        : [];
      const tags = Array.isArray(p.tags) ? p.tags.filter((t): t is string => typeof t === "string").map((t) => t.trim()) : [];

      const ext = isRecord(p["x-stellar"]) ? p["x-stellar"] : undefined;
      if (!ext) {
        problems.push(`${where} ("${slug}") has no x-stellar block (owner, maintainers, dependencies)`);
        return;
      }
      const owner = str(ext.owner)?.trim() ?? defaultOwner;
      if (!owner) problems.push(`${where}.x-stellar.owner is required (or a top-level x-stellar.owner)`);
      else if (!isValidStellarAddress(owner)) problems.push(`${where}.x-stellar.owner is not a valid Stellar address (${owner})`);

      const maintainers: MaintainerEntry[] = [];
      if (!Array.isArray(ext.maintainers)) {
        problems.push(`${where}.x-stellar.maintainers must be an array`);
      } else {
        ext.maintainers.forEach((m, j) => {
          const mw = `${where}.x-stellar.maintainers[${j}]`;
          if (!isRecord(m)) {
            problems.push(`${mw} must be an object`);
            return;
          }
          const addrRaw = str(m.address) ?? "";
          const address = addrRaw.trim();
          if (address !== addrRaw) warnings.push(`${mw}.address trimmed`);
          if (!isValidStellarAddress(address)) problems.push(`${mw}.address is not a valid Stellar address (${address || "missing"})`);
          const bps = coerceBps(m.bps, mw, problems, warnings);
          maintainers.push({
            address,
            bps,
            name: str(m.name)?.trim() || undefined,
            note: str(m.note)?.trim() || undefined,
          });
        });
      }

      const dependencies: { slug: string; bps: number }[] = [];
      if (ext.dependencies !== undefined) {
        if (!Array.isArray(ext.dependencies)) {
          problems.push(`${where}.x-stellar.dependencies must be an array`);
        } else {
          const seenDeps = new Set<string>();
          ext.dependencies.forEach((d, j) => {
            const dw = `${where}.x-stellar.dependencies[${j}]`;
            if (!isRecord(d)) {
              problems.push(`${dw} must be an object`);
              return;
            }
            const depRaw = str(d.slug) ?? "";
            const depSlug = depRaw.trim().toLowerCase();
            if (depSlug !== depRaw) warnings.push(`${dw}.slug normalised ("${depRaw}" -> "${depSlug}")`);
            if (!depSlug || !SLUG_RE.test(depSlug)) problems.push(`${dw}.slug "${depSlug}" is not a valid slug`);
            if (seenDeps.has(depSlug)) problems.push(`${dw}.slug "${depSlug}" is duplicated in this project`);
            seenDeps.add(depSlug);
            const bps = coerceBps(d.bps, dw, problems, warnings);
            dependencies.push({ slug: depSlug, bps });
          });
        }
      }

      const table: SplitTable = {
        owner: owner ?? "",
        maintainers: maintainers.map((m) => ({ address: m.address, bps: m.bps })),
        dependencies: dependencies.map((d) => ({ slug: d.slug, bps: d.bps })),
      };
      for (const problem of validateTable(table, slug)) problems.push(`${where} ("${slug}"): ${problem}`);

      projects.push({
        slug,
        name,
        description: str(p.description)?.trim() || undefined,
        repositoryUrl: urlOf(p.repositoryUrl),
        licenses,
        tags,
        owner: owner ?? "",
        maintainers,
        dependencies,
      });
    });
  }

  if (problems.length > 0 || !entity) throw new FundingParseError(source, problems);
  return { source, version, entity, projects, warnings };
}

/** bps may arrive as 4000, "4000" or 40.0 (%): only integers 1..10000 are accepted, strings are coerced with a warning. */
function coerceBps(v: unknown, where: string, problems: string[], warnings: string[]): number {
  if (typeof v === "number") {
    if (!Number.isInteger(v)) problems.push(`${where}.bps must be an integer number of basis points (got ${v})`);
    return v;
  }
  if (typeof v === "string" && /^\s*\d+\s*$/.test(v)) {
    warnings.push(`${where}.bps given as a string ("${v}"), coerced`);
    return parseInt(v, 10);
  }
  problems.push(`${where}.bps is missing or not a number (got ${JSON.stringify(v)})`);
  return NaN;
}

// ---------------------------------------------------------------------------
// Register plan
// ---------------------------------------------------------------------------

export interface PlanProject {
  slug: string;
  name: string;
  repositoryUrl?: string;
  entity: string;
  owner: string;
  maintainers: MaintainerEntry[];
  dependencies: { slug: string; bps: number }[];
  source: string;
}

export interface RegisterPlan {
  generatedAt: string;
  sources: string[];
  /** in registration order: every dependency precedes its dependants */
  projects: PlanProject[];
  warnings: string[];
}

/**
 * Merge parsed files into a registration plan, ordered so that every
 * dependency is registered before the projects that depend on it (the
 * contract requires dependencies to exist). `known` lists slugs already
 * registered on-chain (from the local registry) which need not be in the files.
 * Throws on unresolved dependencies, duplicates across files or cycles.
 */
export function buildRegisterPlan(files: FundingFile[], known: Iterable<string> = []): RegisterPlan {
  const problems: string[] = [];
  const bySlug = new Map<string, PlanProject>();
  const knownSet = new Set(known);
  const warnings: string[] = [];
  for (const f of files) {
    warnings.push(...f.warnings.map((w) => `${f.source}: ${w}`));
    for (const p of f.projects) {
      if (bySlug.has(p.slug)) {
        problems.push(`project "${p.slug}" appears in both ${bySlug.get(p.slug)!.source} and ${f.source}`);
        continue;
      }
      if (knownSet.has(p.slug)) {
        warnings.push(`${f.source}: "${p.slug}" is already registered; it is skipped (use update-splits to change its table)`);
        continue;
      }
      bySlug.set(p.slug, {
        slug: p.slug,
        name: p.name,
        repositoryUrl: p.repositoryUrl,
        entity: f.entity.name,
        owner: p.owner,
        maintainers: p.maintainers,
        dependencies: p.dependencies,
        source: f.source,
      });
    }
  }
  for (const p of bySlug.values()) {
    for (const d of p.dependencies) {
      if (!bySlug.has(d.slug) && !knownSet.has(d.slug)) {
        problems.push(`"${p.slug}" depends on "${d.slug}" which is neither in the imported files nor already registered`);
      }
    }
  }
  if (problems.length > 0) throw new FundingParseError("plan", problems);

  // Dependency-first order that otherwise keeps file order: depth-first,
  // emitting a project only after its (in-set) dependencies. Cycles are
  // detected on the way (grey node revisited).
  const ordered: PlanProject[] = [];
  const state = new Map<string, "grey" | "black">();
  const visit = (slug: string, trail: string[]) => {
    const st = state.get(slug);
    if (st === "black") return;
    if (st === "grey") {
      const cycle = [...trail.slice(trail.indexOf(slug)), slug];
      throw new FundingParseError("plan", [
        `dependency cycle ${cycle.join(" -> ")}: register these without the back-edge, then add it with update-splits (distribution is one hop per call, so a cycle is safe once registered)`,
      ]);
    }
    state.set(slug, "grey");
    const p = bySlug.get(slug)!;
    for (const d of p.dependencies) if (bySlug.has(d.slug)) visit(d.slug, [...trail, slug]);
    state.set(slug, "black");
    ordered.push(p);
  };
  for (const slug of bySlug.keys()) visit(slug, []);
  return {
    generatedAt: new Date().toISOString(),
    sources: files.map((f) => f.source),
    projects: ordered,
    warnings,
  };
}
