#!/usr/bin/env node
/**
 * depsplit CLI
 *
 *   depsplit import <funding.json>... [--out plan.json]     build a register plan (offline)
 *   depsplit register <plan.json> [--dry-run]               register every project in plan order
 *   depsplit update-splits <plan.json> <slug> [--dry-run]   push a new table version for one project
 *   depsplit pay <slug|id> <amount> --memo <text> [--dry-run]
 *   depsplit distribute <slug|id> [--dry-run]               settle one hop of that project's pool
 *   depsplit withdraw [--to G...] [--dry-run]               pull the signer's balance
 *   depsplit statement <payer> [--out file.csv]             CSV for the payer's books (offline)
 *   depsplit project <slug|id> | balance <addr> | pool <slug|id>   views (RPC)
 *
 * Environment (see .env.example): SOROBAN_RPC_URL, NETWORK_PASSPHRASE,
 * DEPSPLIT_CONTRACT_ID, DEPSPLIT_SECRET, USDC_CONTRACT_ID, DEPSPLIT_REGISTRY,
 * DEPSPLIT_PAYMENTS.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { buildRegisterPlan, parseFundingJson, type RegisterPlan, FundingParseError } from "./funding.js";
import {
  balanceOp,
  decodeInvocation,
  distributePoolOp,
  memoHash,
  networkFromEnv,
  payOp,
  PLACEHOLDER_ACCOUNT,
  PLACEHOLDER_CONTRACT_ID,
  poolOp,
  projectIdBySlugOp,
  projectOp,
  registerProjectOp,
  SplitRouterRpc,
  updateSplitsOp,
  withdrawOp,
  type DepShareArg,
  type ProjectView,
  type ShareArg,
} from "./contract.js";
import { loadRegistry, registryIdBySlug, registryLookup, saveRegistry, type Registry, type RegistryTable } from "./registry.js";
import { formatAmount, parseAmount } from "./split.js";
import {
  buildStatement,
  parsePaymentsCsv,
  paymentRowToCsvRecord,
  PAYMENTS_HEADER,
  statementToCsv,
  toCsv,
  type PaymentRow,
} from "./statement.js";

// ---------------------------------------------------------------------------
// Argument parsing (pure, tested offline)
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const name = a.slice(2);
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[name] = next;
          i++;
        } else {
          flags[name] = true;
        }
      }
    } else {
      positionals.push(a);
    }
  }
  return { command, positionals, flags };
}

export function flagString(flags: ParsedArgs["flags"], name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

// ---------------------------------------------------------------------------
// Paths and environment
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
/** <root>/app/dist/src -> <root> */
export const PROJECT_ROOT = path.resolve(here, "..", "..", "..");

function envPaths() {
  return {
    registry: process.env.DEPSPLIT_REGISTRY ?? path.join(PROJECT_ROOT, "data", "registry.json"),
    payments: process.env.DEPSPLIT_PAYMENTS ?? path.join(PROJECT_ROOT, "data", "payments.csv"),
    token: process.env.USDC_CONTRACT_ID ?? "",
  };
}

function signerFromEnv(): Keypair {
  const secret = process.env.DEPSPLIT_SECRET;
  if (!secret) throw new Error("DEPSPLIT_SECRET is not set");
  return Keypair.fromSecret(secret);
}

function jsonReplacer(_k: string, v: unknown) {
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Uint8Array) return Buffer.from(v).toString("hex");
  // Buffer#toJSON runs before the replacer: undo it so bytes print as hex.
  if (v && typeof v === "object" && (v as { type?: string }).type === "Buffer" && Array.isArray((v as { data?: unknown }).data)) {
    return Buffer.from((v as { data: number[] }).data).toString("hex");
  }
  return v;
}

const log = (...a: unknown[]) => console.log(...a);

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdImport(args: ParsedArgs) {
  if (args.positionals.length === 0) throw new Error("usage: depsplit import <funding.json>... [--out plan.json]");
  const paths = envPaths();
  const net = networkFromEnv();
  const reg = await loadRegistry(paths.registry, net.networkPassphrase, net.contractId);
  const files = [];
  for (const file of args.positionals) {
    const text = await fs.readFile(file, "utf8");
    files.push(parseFundingJson(text, path.basename(file)));
  }
  const plan = buildRegisterPlan(files, Object.keys(reg.projects));
  const out = flagString(args.flags, "out");
  const json = JSON.stringify(plan, null, 2) + "\n";
  if (out) {
    await fs.writeFile(out, json);
    log(`plan written to ${out}`);
  } else {
    process.stdout.write(json);
  }
  log(`\n${plan.projects.length} project(s) in registration order:`);
  for (const p of plan.projects) {
    const deps = p.dependencies.map((d) => `${d.slug}:${d.bps}`).join(", ") || "none";
    const notes = p.maintainers.filter((m) => m.note).map((m) => `\n      note (${m.name ?? m.address.slice(0, 6)}): ${m.note}`).join("");
    log(`  ${p.slug}  maintainers=${p.maintainers.length}  deps=${deps}  owner=${p.owner.slice(0, 6)}...${notes}`);
  }
  if (plan.warnings.length) {
    log(`\n${plan.warnings.length} warning(s):`);
    for (const w of plan.warnings) log(`  - ${w}`);
  }
}

async function readPlan(file: string): Promise<RegisterPlan> {
  return JSON.parse(await fs.readFile(file, "utf8")) as RegisterPlan;
}

async function resolveDeps(
  deps: { slug: string; bps: number }[],
  reg: Registry,
  client: SplitRouterRpc | undefined,
  viewer: string,
): Promise<{ args: DepShareArg[]; table: RegistryTable["dependencies"] }> {
  const args: DepShareArg[] = [];
  const table: RegistryTable["dependencies"] = [];
  for (const d of deps) {
    let id = registryIdBySlug(reg, d.slug);
    if (id === undefined && client) {
      const found = await client.view<number | null>(projectIdBySlugOp(client.cfg.contractId, d.slug), viewer);
      if (found !== null && found !== undefined) id = Number(found);
    }
    if (id === undefined) throw new Error(`dependency "${d.slug}" is not registered (locally or on-chain)`);
    args.push({ project_id: id, bps: d.bps });
    table.push({ slug: d.slug, bps: d.bps, projectId: id });
  }
  return { args, table };
}

async function cmdRegister(args: ParsedArgs) {
  const [planFile] = args.positionals;
  if (!planFile) throw new Error("usage: depsplit register <plan.json> [--dry-run]");
  const dry = args.flags["dry-run"] === true;
  const paths = envPaths();
  const net = networkFromEnv();
  const plan = await readPlan(planFile);
  const reg = await loadRegistry(paths.registry, net.networkPassphrase, net.contractId);
  const client = dry ? undefined : new SplitRouterRpc(net);
  const signer = dry ? undefined : signerFromEnv();
  const contractId = net.contractId || PLACEHOLDER_CONTRACT_ID;

  for (const p of plan.projects) {
    if (reg.projects[p.slug]) {
      log(`skip ${p.slug}: already registered as #${reg.projects[p.slug].id}`);
      continue;
    }
    const maintainers: ShareArg[] = p.maintainers.map((m) => ({ addr: m.address, bps: m.bps }));
    let depArgs: DepShareArg[];
    let depTable: RegistryTable["dependencies"];
    if (dry) {
      // Dry run: ids come from the local registry or are provisional (plan order).
      depArgs = [];
      depTable = [];
      for (const d of p.dependencies) {
        const id = registryIdBySlug(reg, d.slug) ?? plan.projects.findIndex((x) => x.slug === d.slug) + 1;
        depArgs.push({ project_id: id, bps: d.bps });
        depTable.push({ slug: d.slug, bps: d.bps, projectId: id });
      }
    } else {
      ({ args: depArgs, table: depTable } = await resolveDeps(p.dependencies, reg, client, signer!.publicKey()));
    }
    const op = registerProjectOp(contractId, p.owner, p.slug, maintainers, depArgs);
    if (dry) {
      log(JSON.stringify(decodeInvocation(op), jsonReplacer, 2));
      continue;
    }
    if (signer!.publicKey() !== p.owner) {
      throw new Error(`${p.slug}: DEPSPLIT_SECRET is ${signer!.publicKey()} but the plan's owner is ${p.owner}`);
    }
    const { hash, result } = await client!.invoke<number>(op, signer!);
    const id = Number(result);
    reg.projects[p.slug] = {
      id,
      slug: p.slug,
      name: p.name,
      owner: p.owner,
      version: 1,
      tables: { "1": { owner: p.owner, maintainers: p.maintainers, dependencies: depTable } },
      registeredTx: hash,
    };
    await saveRegistry(paths.registry, reg);
    log(`registered ${p.slug} as #${id} (v1) tx ${hash}`);
  }
}

async function cmdUpdateSplits(args: ParsedArgs) {
  const [planFile, slug] = args.positionals;
  if (!planFile || !slug) throw new Error("usage: depsplit update-splits <plan.json> <slug> [--dry-run]");
  const dry = args.flags["dry-run"] === true;
  const paths = envPaths();
  const net = networkFromEnv();
  const plan = await readPlan(planFile);
  const p = plan.projects.find((x) => x.slug === slug);
  if (!p) throw new Error(`"${slug}" is not in ${planFile}`);
  const reg = await loadRegistry(paths.registry, net.networkPassphrase, net.contractId);
  const existing = reg.projects[slug];
  if (!existing) throw new Error(`"${slug}" is not in the local registry; register it first`);
  const client = dry ? undefined : new SplitRouterRpc(net);
  const signer = dry ? undefined : signerFromEnv();
  const { args: depArgs, table: depTable } = await resolveDeps(p.dependencies, reg, client, signer?.publicKey() ?? existing.owner);
  const maintainers: ShareArg[] = p.maintainers.map((m) => ({ addr: m.address, bps: m.bps }));
  const op = updateSplitsOp(net.contractId || PLACEHOLDER_CONTRACT_ID, existing.id, maintainers, depArgs);
  if (dry) {
    log(JSON.stringify(decodeInvocation(op), jsonReplacer, 2));
    return;
  }
  const { hash, result } = await client!.invoke<number>(op, signer!);
  const version = Number(result);
  existing.version = version;
  existing.tables[String(version)] = { owner: existing.owner, maintainers: p.maintainers, dependencies: depTable };
  await saveRegistry(paths.registry, reg);
  log(`${slug} (#${existing.id}) now at version ${version}, tx ${hash}`);
}

async function resolveProject(ref: string, reg: Registry, client: SplitRouterRpc | undefined, viewer?: string): Promise<{ id: number; slug: string; version?: number }> {
  if (/^\d+$/.test(ref)) {
    const id = parseInt(ref, 10);
    const local = Object.values(reg.projects).find((p) => p.id === id);
    if (local) return { id, slug: local.slug, version: local.version };
    if (client && viewer) {
      try {
        const view = await client.view<ProjectView>(projectOp(client.cfg.contractId, id), viewer);
        return { id, slug: view.slug, version: Number(view.version) };
      } catch (e) {
        if (e instanceof Error && e.message.includes("simulation failed")) {
          throw new Error(`project #${id} not found on-chain`);
        }
        throw e;
      }
    }
    return { id, slug: `#${id}` };
  }
  const local = reg.projects[ref];
  if (local) return { id: local.id, slug: ref, version: local.version };
  if (client && viewer) {
    try {
      const found = await client.view<number | null>(projectIdBySlugOp(client.cfg.contractId, ref), viewer);
      if (found !== null && found !== undefined) return { id: Number(found), slug: ref };
    } catch (e) {
      if (e instanceof Error && e.message.includes("simulation failed")) {
        // Fall through to the default throw Error
      } else {
        throw e;
      }
    }
  }
  throw new Error(`project "${ref}" not found (not in registry${client ? " or on-chain" : ""})`);
}

async function cmdPay(args: ParsedArgs) {
  const [ref, amountText] = args.positionals;
  const memo = flagString(args.flags, "memo");
  if (!ref || !amountText || !memo) throw new Error('usage: depsplit pay <slug|id> <amount> --memo "<text>" [--token C...] [--dry-run]');
  const dry = args.flags["dry-run"] === true;
  const paths = envPaths();
  const net = networkFromEnv();
  const token = flagString(args.flags, "token") ?? paths.token;
  if (!token) throw new Error("USDC_CONTRACT_ID (or --token) is not set");
  const amount = parseAmount(amountText);
  const reg = await loadRegistry(paths.registry, net.networkPassphrase, net.contractId);
  const client = dry ? undefined : new SplitRouterRpc(net);
  const signer = dry ? undefined : signerFromEnv();
  const payer = signer?.publicKey() ?? flagString(args.flags, "from") ?? PLACEHOLDER_ACCOUNT;
  const project = await resolveProject(ref, reg, client, payer);
  const hash = memoHash(memo);
  const op = payOp(net.contractId || PLACEHOLDER_CONTRACT_ID, project.id, payer, token, amount, hash);
  if (dry) {
    log(JSON.stringify({ ...decodeInvocation(op), memo, memo_hash: hash.toString("hex") }, jsonReplacer, 2));
    return;
  }
  // The version the payment is split with is the project's current one.
  const view = await client!.view<ProjectView>(projectOp(net.contractId, project.id), payer);
  const { hash: txHash } = await client!.invoke(op, signer!);
  const row: PaymentRow = {
    date: new Date().toISOString().slice(0, 10),
    payer,
    projectSlug: project.slug,
    projectId: project.id,
    version: Number(view.version),
    amount,
    memo,
    memoHash: hash.toString("hex"),
    txHash,
  };
  await appendPayment(paths.payments, row);
  log(`paid ${formatAmount(amount)} to ${project.slug} (#${project.id}, table v${view.version}) memo "${memo}" tx ${txHash}`);
  log(`recorded in ${paths.payments}`);
}

async function appendPayment(file: string, row: PaymentRow) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  let exists = true;
  try {
    await fs.access(file);
  } catch {
    exists = false;
  }
  const text = toCsv(PAYMENTS_HEADER, [paymentRowToCsvRecord(row)]);
  if (!exists) await fs.writeFile(file, text);
  else await fs.appendFile(file, text.split("\n").slice(1).join("\n"));
}

async function cmdDistribute(args: ParsedArgs) {
  const [ref] = args.positionals;
  if (!ref) throw new Error("usage: depsplit distribute <slug|id> [--token C...] [--dry-run]");
  const dry = args.flags["dry-run"] === true;
  const paths = envPaths();
  const net = networkFromEnv();
  const token = flagString(args.flags, "token") ?? paths.token;
  if (!token) throw new Error("USDC_CONTRACT_ID (or --token) is not set");
  const reg = await loadRegistry(paths.registry, net.networkPassphrase, net.contractId);
  const client = dry ? undefined : new SplitRouterRpc(net);
  const signer = dry ? undefined : signerFromEnv();
  const project = await resolveProject(ref, reg, client, signer?.publicKey());
  const op = distributePoolOp(net.contractId || PLACEHOLDER_CONTRACT_ID, project.id, token);
  if (dry) {
    log(JSON.stringify(decodeInvocation(op), jsonReplacer, 2));
    return;
  }
  const { hash, result } = await client!.invoke<bigint>(op, signer!);
  log(`distributed ${formatAmount(BigInt(result))} from the pool of ${project.slug} (#${project.id}) one hop down, tx ${hash}`);
  log("if that project has dependencies, run `depsplit distribute <dep>` for each of them to settle the next hop");
}

async function cmdWithdraw(args: ParsedArgs) {
  const dry = args.flags["dry-run"] === true;
  const paths = envPaths();
  const net = networkFromEnv();
  const token = flagString(args.flags, "token") ?? paths.token;
  if (!token) throw new Error("USDC_CONTRACT_ID (or --token) is not set");
  const signer = dry ? undefined : signerFromEnv();
  const to = flagString(args.flags, "to") ?? signer?.publicKey() ?? PLACEHOLDER_ACCOUNT;
  if (!StrKey.isValidEd25519PublicKey(to) && !StrKey.isValidContract(to)) throw new Error(`invalid --to address ${to}`);
  const op = withdrawOp(net.contractId || PLACEHOLDER_CONTRACT_ID, token, to);
  if (dry) {
    log(JSON.stringify(decodeInvocation(op), jsonReplacer, 2));
    return;
  }
  if (to !== signer!.publicKey()) throw new Error("withdraw must be signed by the recipient (`to`)");
  const client = new SplitRouterRpc(net);
  const { hash, result } = await client.invoke<bigint>(op, signer!);
  log(`withdrew ${formatAmount(BigInt(result))} to ${to}, tx ${hash}`);
}

async function cmdStatement(args: ParsedArgs) {
  const [payer] = args.positionals;
  if (!payer) throw new Error("usage: depsplit statement <payer G...> [--payments file.csv] [--registry file.json] [--out file.csv]");
  const paths = envPaths();
  const net = networkFromEnv();
  const paymentsFile = flagString(args.flags, "payments") ?? paths.payments;
  const registryFile = flagString(args.flags, "registry") ?? paths.registry;
  const reg = await loadRegistry(registryFile, net.networkPassphrase, net.contractId);
  const { rows, problems } = parsePaymentsCsv(await fs.readFile(paymentsFile, "utf8"));
  for (const p of problems) console.error(`warning: ${p}`);
  const lines = buildStatement(payer, rows, registryLookup(reg));
  const csv = statementToCsv(lines);
  const out = flagString(args.flags, "out");
  if (out) {
    await fs.writeFile(out, csv);
    log(`statement for ${payer}: ${lines.filter((l) => l.line_type === "payment").length} payment(s), ${lines.length} line(s) -> ${out}`);
  } else {
    process.stdout.write(csv);
  }
}

async function cmdView(args: ParsedArgs) {
  const paths = envPaths();
  const net = networkFromEnv();
  const client = new SplitRouterRpc(net);
  const viewer = flagString(args.flags, "viewer") ?? process.env.DEPSPLIT_VIEWER ?? signerFromEnv().publicKey();
  const reg = await loadRegistry(paths.registry, net.networkPassphrase, net.contractId);
  const token = flagString(args.flags, "token") ?? paths.token;
  switch (args.command) {
    case "project": {
      const project = await resolveProject(args.positionals[0] ?? "", reg, client, viewer);
      const view = await client.view<ProjectView>(projectOp(net.contractId, project.id), viewer);
      log(JSON.stringify(view, jsonReplacer, 2));
      break;
    }
    case "balance": {
      const addr = args.positionals[0];
      if (!addr) throw new Error("usage: depsplit balance <address> [--token C...]");
      const bal = await client.view<bigint>(balanceOp(net.contractId, token, addr), viewer);
      log(`${formatAmount(BigInt(bal))} withdrawable by ${addr}`);
      break;
    }
    case "pool": {
      const project = await resolveProject(args.positionals[0] ?? "", reg, client, viewer);
      const bal = await client.view<bigint>(poolOp(net.contractId, token, project.id), viewer);
      log(`${formatAmount(BigInt(bal))} pooled for ${project.slug} (#${project.id}), waiting for distribute`);
      break;
    }
  }
}

function usage() {
  log(`depsplit — dependency-aware payout splits on Stellar

  import <funding.json>... [--out plan.json]        parse FLOSS/fund manifests + x-stellar into a register plan
  register <plan.json> [--dry-run]                  register projects in dependency order (owner signs)
  update-splits <plan.json> <slug> [--dry-run]      new table version for one project (owner signs)
  pay <slug|id> <amount> --memo "<text>" [--dry-run] pay a project in USDC (payer signs), record locally
  distribute <slug|id> [--dry-run]                  split a project's pool one hop (anyone)
  withdraw [--to G...] [--dry-run]                  pull your balance (recipient signs)
  statement <payer> [--out file.csv]                CSV of payments and split lines for the payer's books
  project <slug|id> | balance <addr> | pool <slug|id>   read chain state

  --dry-run prints the decoded contract invocation without touching the network.`);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  try {
    switch (args.command) {
      case "import":
        await cmdImport(args);
        break;
      case "register":
        await cmdRegister(args);
        break;
      case "update-splits":
        await cmdUpdateSplits(args);
        break;
      case "pay":
        await cmdPay(args);
        break;
      case "distribute":
        await cmdDistribute(args);
        break;
      case "withdraw":
        await cmdWithdraw(args);
        break;
      case "statement":
        await cmdStatement(args);
        break;
      case "project":
      case "balance":
      case "pool":
        await cmdView(args);
        break;
      case "help":
      case "--help":
      case "-h":
        usage();
        break;
      default:
        usage();
        return 2;
    }
    return 0;
  } catch (e) {
    if (e instanceof FundingParseError) console.error(e.message);
    else console.error(`error: ${(e as Error).message}`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then((code) => process.exit(code));
}
