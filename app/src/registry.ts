/**
 * Local registry: what this operator has registered, per contract. It is a
 * cache of on-chain state (project ids and every table version) so that the
 * CLI can resolve dependency slugs to ids and the statement generator can
 * mirror the exact table a payment was split with. It is never a source of
 * truth: `depsplit project <slug>` always reads the chain.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { MaintainerEntry } from "./funding.js";
import type { SplitTable } from "./split.js";
import type { TableLookup } from "./statement.js";

export interface RegistryTable {
  owner: string;
  maintainers: MaintainerEntry[];
  dependencies: { slug: string; bps: number; projectId: number }[];
}

export interface RegistryProject {
  id: number;
  slug: string;
  name?: string;
  owner: string;
  version: number;
  tables: Record<string, RegistryTable>;
  registeredTx?: string;
}

export interface Registry {
  network: string;
  contractId: string;
  projects: Record<string, RegistryProject>;
}

export function emptyRegistry(network: string, contractId: string): Registry {
  return { network, contractId, projects: {} };
}

export async function loadRegistry(file: string, network: string, contractId: string): Promise<Registry> {
  try {
    const text = await fs.readFile(file, "utf8");
    const reg = JSON.parse(text) as Registry;
    if (!reg.projects) reg.projects = {};
    return reg;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry(network, contractId);
    throw e;
  }
}

export async function saveRegistry(file: string, reg: Registry): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(reg, null, 2) + "\n");
}

export function registryIdBySlug(reg: Registry, slug: string): number | undefined {
  return reg.projects[slug]?.id;
}

export function registrySlugById(reg: Registry, id: number): string | undefined {
  return Object.values(reg.projects).find((p) => p.id === id)?.slug;
}

/** TableLookup over the registry (by slug; version defaults to the latest). */
export function registryLookup(reg: Registry): TableLookup {
  return (slug, version) => {
    const p = reg.projects[slug];
    if (!p) return undefined;
    const v = version ?? p.version;
    const t = p.tables[String(v)];
    if (!t) return undefined;
    const table: SplitTable = {
      owner: t.owner,
      maintainers: t.maintainers.map((m) => ({ address: m.address, bps: m.bps })),
      dependencies: t.dependencies.map((d) => ({ slug: d.slug, bps: d.bps, projectId: d.projectId })),
    };
    return { table, version: v, projectId: p.id };
  };
}
