/**
 * Pixflow keeper — watches Pons symbol cohorts, resolves them with the
 * pure resolver (src/resolver.ts), and maintains the CanonicalRegistry.
 *
 * Design notes (mirrors Specta's keeper.ts):
 * - Transport-agnostic core: viem clients are passed in (or built from
 *   plain config), no process.env reads, so the same code can move into
 *   a Cloudflare Worker cron with only the entry point changing. The
 *   Node CLI wrapper is scripts/run-keeper.ts.
 * - The keeper is UNTRUSTED by design in the fail-open direction: a
 *   canonical proposal waits out the registry's 1h timelock in full
 *   public view, and any defensive flag raised in that hour cancels it.
 *   Fail-closed actions (contest / flagWash / flagDevDump) are
 *   immediate — when a dev is dumping NOW, buys must stop NOW.
 * - executeUpdate() is permissionless; the keeper calls it as a service
 *   once a pending proposal's timelock has expired.
 * - A per-symbol failure (API down, RPC error, tx revert) is recorded
 *   and does NOT stop the pass — the symbol is retried next pass.
 * - In dryRun, everything is computed and evidence bundles are written,
 *   but NO transaction is sent.
 *
 * Evidence bundles are written to evidenceDir/<SYMBOL>-<timestamp>.json
 * (default data/evidence, gitignored via **\/data/*.json). The bundle
 * JSON is the off-chain evidence; its keccak256 is what the registry
 * records on-chain (DESIGN.md §5).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PONS_TOKEN_ABI, REGISTRY_ABI } from './contracts.js';
import { chainForId } from './chains.js';
import {
  buildEvidenceBundle,
  detectDevDump,
  resolveSymbol,
  type CohortToken,
  type CreatorHoldings,
  type NarrativeSource,
  type Resolution,
  type Verdict,
} from './resolver.js';

/** Registry Status enum (CanonicalRegistry.sol): 0 UNRESOLVED, 1 CANONICAL, 2 CONTESTED. */
export const STATUS_UNRESOLVED = 0;
export const STATUS_CANONICAL = 1;
export const STATUS_CONTESTED = 2;

export const DEFAULT_PONS_API_BASE = 'https://api.ponsfamily.com/v1';
export const PONS_API_USER_AGENT = 'Pixflow-Keeper/0.1 (Verified Buy Router keeper)';
/** Pons API pagination cap: 5 pages × 100 items — a symbol cohort larger than that is a data error. */
const PONS_API_MAX_PAGES = 5;

export interface KeeperConfig {
  rpcUrl: string;
  chainId: number;
  registryAddress: Address;
  /** Router address — unused by the keeper in v1 (kept for future passes that verify buys). */
  routerAddress?: Address;
  ponsApiBase?: string;
  /** Keeper signing key — only needed when actually sending txs (not for dry runs). */
  keeperPrivateKey?: Hex;
  symbols: string[];
  /** Operator-supplied narrative sources, keyed by symbol (TAURO rule). */
  narratives?: Record<string, NarrativeSource>;
  /** Where evidence bundles are written (default: data/evidence). */
  evidenceDir?: string;
  dryRun: boolean;
}

export interface PonsApiConfig {
  baseUrl?: string;
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface RegistryEntryView {
  token: Address;
  status: number;
  launchedAt: bigint;
  washSuspect: boolean;
  devDumped: boolean;
  evidenceHash: Hex;
  updatedAt: bigint;
}

export interface PendingUpdateView {
  token: Address;
  launchedAt: bigint;
  evidenceHash: Hex;
  clearFlags: boolean;
  executableAt: bigint;
  exists: boolean;
}

export type PlannedAction =
  | { kind: 'contest'; symbolHash: Hex; evidenceHash: Hex }
  | { kind: 'flagWash'; symbolHash: Hex; evidenceHash: Hex }
  | { kind: 'flagDevDump'; symbolHash: Hex; evidenceHash: Hex }
  | {
      kind: 'proposeCanonical';
      symbolHash: Hex;
      token: Address;
      launchedAt: number;
      evidenceHash: Hex;
    }
  | { kind: 'executeUpdate'; symbolHash: Hex }
  | { kind: 'cancelProposal'; symbolHash: Hex };

export interface ExecutedAction {
  kind: PlannedAction['kind'];
  txHash?: Hex;
  dryRun: boolean;
  error?: string;
}

export interface SymbolResult {
  symbol: string;
  verdict: Verdict;
  canonicalToken?: Address;
  cohortSize: number;
  evidenceHash?: Hex;
  evidenceFile?: string;
  actions: PlannedAction[];
  executed: ExecutedAction[];
  /** True when the dev-dump check ran with real holdings data. */
  devDumpChecked: boolean;
  error?: string;
}

export interface KeeperReport {
  chainId: number;
  registry: Address;
  dryRun: boolean;
  startedAt: string;
  symbols: SymbolResult[];
  txHashes: Hex[];
  counts: {
    symbols: number;
    resolved: number;
    contested: number;
    unresolved: number;
    actionsPlanned: number;
    actionsExecuted: number;
    failed: number;
  };
}

export interface KeeperRunOptions {
  /** Override the Pons API fetch (tests). */
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Inject viem clients (tests); otherwise built from config. */
  publicClient?: PublicClient;
  walletClient?: WalletClient;
  /** Unix seconds; defaults to Date.now()/1000. */
  now?: () => number;
  /**
   * Creator-holdings provider for the dev-dump check. Without it the
   * check is skipped (devDumped=false, noted in the report): live
   * holdings need a launch-buy + transfer scan the keeper does not do
   * in v1 (an indexer / event scan is the honest source — see the
   * Fase 2 notes in DESIGN.md §9).
   */
  creatorHoldings?: (token: CohortToken) => Promise<CreatorHoldings | null>;
  /** Override evidence-bundle writing (tests); default writes to disk. */
  writeEvidence?: (filename: string, content: string) => void | Promise<void>;
}

/** Registry key for a symbol: keccak256 of the EXACT symbol string (matches symbolHashOf). */
export function symbolHashFor(symbol: string): Hex {
  return keccak256(stringToHex(symbol));
}

export function createKeeperPublicClient(config: KeeperConfig): PublicClient {
  return createPublicClient({
    chain: chainForId(config.chainId),
    transport: http(config.rpcUrl),
  });
}

export function createKeeperWalletClient(config: KeeperConfig): WalletClient {
  if (!config.keeperPrivateKey) throw new Error('keeperPrivateKey is required to send transactions');
  return createWalletClient({
    account: privateKeyToAccount(config.keeperPrivateKey),
    chain: chainForId(config.chainId),
    transport: http(config.rpcUrl),
  });
}

// ---------------------------------------------------------------------------
// Cohort fetching (Pons API + on-chain socials enrichment)
// ---------------------------------------------------------------------------

function toUnixSeconds(value: unknown): number {
  if (typeof value === 'number') return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  if (typeof value === 'string') {
    const n = Number(value);
    if (!Number.isNaN(n) && value.trim() !== '') return toUnixSeconds(n);
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return 0;
}

interface PonsApiItem {
  address?: string;
  symbol?: string;
  progress_bps?: number;
  buy_count?: number;
  sell_count?: number;
  graduated_at?: string | number | null;
  graduated?: boolean;
  launched_at?: string | number;
  deployed_at?: string | number;
  creator?: string;
  deployer?: string;
}

function mapApiItem(item: PonsApiItem, fallbackSymbol: string): CohortToken {
  const buyCount = item.buy_count ?? 0;
  const sellCount = item.sell_count ?? 0;
  return {
    address: item.address as Address,
    symbol: item.symbol ?? fallbackSymbol,
    deployedAt: toUnixSeconds(item.launched_at ?? item.deployed_at ?? 0),
    progressBps: item.progress_bps ?? 0,
    buyCount,
    sellCount,
    tradeCount: buyCount + sellCount,
    graduated: item.graduated === true || item.graduated_at !== null && item.graduated_at !== undefined,
    creator: (item.creator ?? item.deployer ?? '0x0000000000000000000000000000000000000000') as Address,
    socials: { website: '', twitter: '', telegram: '', discord: '' },
  };
}

/**
 * Fetch a symbol's cohort from the Pons API and enrich each token with
 * its on-chain socials() + deployer() + description() (PonsV2LauncherToken:
 * socials() returns (twitter, telegram, discord, website, farcaster)).
 *
 * Enrichment failures are non-fatal: a token whose socials() call fails
 * keeps empty socials (the resolver treats empty socials as "no match",
 * which fails closed under the TAURO rule).
 */
export async function fetchCohort(
  client: PublicClient,
  ponsApi: PonsApiConfig,
  symbol: string,
): Promise<CohortToken[]> {
  const baseUrl = (ponsApi.baseUrl ?? DEFAULT_PONS_API_BASE).replace(/\/+$/, '');
  const fetchFn = ponsApi.fetchFn ?? fetch;
  const items: PonsApiItem[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < PONS_API_MAX_PAGES; page++) {
    const url =
      `${baseUrl}/tokens?search=${encodeURIComponent(symbol)}&limit=100` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const res = await fetchFn(url, { headers: { 'User-Agent': PONS_API_USER_AGENT } });
    if (!res.ok) throw new Error(`Pons API ${res.status} for symbol ${symbol}`);
    const data = (await res.json()) as { items?: PonsApiItem[]; data?: PonsApiItem[]; next_cursor?: string | null };
    const pageItems = data.items ?? data.data ?? [];
    items.push(...pageItems);
    cursor = data.next_cursor ?? null;
    if (!cursor || pageItems.length === 0) break;
  }

  // Only same-symbol tokens belong in the cohort (the API search is fuzzy).
  const cohort = items
    .filter((i) => i.address && (i.symbol ?? symbol).toUpperCase() === symbol.toUpperCase())
    .map((i) => mapApiItem(i, symbol));
  if (cohort.length === 0) return cohort;

  await enrichCohort(client, cohort);
  return cohort;
}

async function enrichCohort(client: PublicClient, cohort: CohortToken[]): Promise<void> {
  // One multicall for the whole cohort; fall back to individual reads
  // if multicall is unavailable on the chain (unknown Multicall3).
  try {
    const results = await client.multicall({
      contracts: cohort.flatMap((t) => [
        { address: t.address, abi: PONS_TOKEN_ABI, functionName: 'socials' },
        { address: t.address, abi: PONS_TOKEN_ABI, functionName: 'deployer' },
        { address: t.address, abi: PONS_TOKEN_ABI, functionName: 'description' },
      ]),
      allowFailure: true,
    });
    cohort.forEach((token, i) => {
      const socials = results[i * 3];
      if (socials.status === 'success') {
        const [twitter, telegram, discord, website] = socials.result as unknown as [
          string,
          string,
          string,
          string,
          string,
        ];
        token.socials = {
          website: website ?? '',
          twitter: twitter ?? '',
          telegram: telegram ?? '',
          discord: discord ?? '',
        };
      }
      const deployer = results[i * 3 + 1];
      if (
        deployer.status === 'success' &&
        token.creator === '0x0000000000000000000000000000000000000000'
      ) {
        token.creator = deployer.result as unknown as Address;
      }
      const description = results[i * 3 + 2];
      if (description.status === 'success' && typeof description.result === 'string') {
        token.description = description.result;
      }
    });
    return;
  } catch {
    // Multicall unavailable — fall through to individual reads.
  }
  await Promise.all(
    cohort.map(async (token) => {
      try {
        const [twitter, telegram, discord, website] = (await client.readContract({
          address: token.address,
          abi: PONS_TOKEN_ABI,
          functionName: 'socials',
        })) as unknown as [string, string, string, string, string];
        token.socials = {
          website: website ?? '',
          twitter: twitter ?? '',
          telegram: telegram ?? '',
          discord: discord ?? '',
        };
      } catch {
        // Keep empty socials (fail-closed under the TAURO rule).
      }
      try {
        if (token.creator === '0x0000000000000000000000000000000000000000') {
          token.creator = (await client.readContract({
            address: token.address,
            abi: PONS_TOKEN_ABI,
            functionName: 'deployer',
          })) as unknown as Address;
        }
      } catch {
        // Creator stays the zero address; dev-dump check needs holdings anyway.
      }
      try {
        token.description = (await client.readContract({
          address: token.address,
          abi: PONS_TOKEN_ABI,
          functionName: 'description',
        })) as unknown as string;
      } catch {
        // Description is informational only.
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Registry reads + action planning (pure — unit-testable without a chain)
// ---------------------------------------------------------------------------

export async function readRegistryState(
  client: PublicClient,
  registryAddress: Address,
  symbol: string,
): Promise<{ entry: RegistryEntryView; pending: PendingUpdateView }> {
  const symbolHash = symbolHashFor(symbol);
  const [entry, pending] = await Promise.all([
    client.readContract({
      address: registryAddress,
      abi: REGISTRY_ABI,
      functionName: 'getEntry',
      args: [symbolHash],
    }),
    client.readContract({
      address: registryAddress,
      abi: REGISTRY_ABI,
      functionName: 'getPending',
      args: [symbolHash],
    }),
  ]);
  return {
    entry: {
      token: entry.token,
      status: entry.status,
      launchedAt: entry.launchedAt,
      washSuspect: entry.washSuspect,
      devDumped: entry.devDumped,
      evidenceHash: entry.evidenceHash,
      updatedAt: entry.updatedAt,
    },
    pending: {
      token: pending.token,
      launchedAt: pending.launchedAt,
      evidenceHash: pending.evidenceHash,
      clearFlags: pending.clearFlags,
      executableAt: pending.executableAt,
      exists: pending.exists,
    },
  };
}

/**
 * Decide which registry writes a resolution calls for, given the current
 * on-chain state. Pure — no chain access.
 *
 * Ordering rules (the registry's own invariants drive them):
 * - A CONTESTED verdict contests immediately and supersedes flags in the
 *   same pass (buys are already blocked; contest() also cancels any
 *   pending proposal, so an executable pending update is NOT executed
 *   when the symbol is now contested).
 * - An already-CONTESTED symbol with a pending proposal gets the
 *   proposal cancelled (fail-closed: a stale proposal must not unblock
 *   buys for an ambiguous symbol).
 * - executeUpdate runs FIRST when it applies (flags/contests cancel
 *   pending proposals, so executing after flagging would revert).
 * - proposeCanonical is skipped when the same token is already pending
 *   (no clock reset) and when a pending update was just executed this
 *   pass (next pass re-evaluates against the new entry).
 * - UNRESOLVED (empty cohort) plans nothing new, but a pending update
 *   still executes — the timelock is the protection, and skipping the
 *   keeper's execution would not stop anyone else executing it.
 */
export function planActions(
  symbol: string,
  resolution: Resolution,
  evidenceHash: Hex,
  entry: RegistryEntryView,
  pending: PendingUpdateView,
  nowSeconds: number,
): PlannedAction[] {
  const symbolHash = symbolHashFor(symbol);
  const pendingExecutable = pending.exists && Number(pending.executableAt) <= nowSeconds;

  if (resolution.verdict === 'CONTESTED') {
    if (entry.status !== STATUS_CONTESTED) {
      // contest() cancels any pending proposal itself.
      return [{ kind: 'contest', symbolHash, evidenceHash }];
    }
    // Already contested — but a proposal made after the contest must not
    // silently unblock buys later.
    if (pending.exists) return [{ kind: 'cancelProposal', symbolHash }];
    return [];
  }

  const actions: PlannedAction[] = [];
  if (pendingExecutable) actions.push({ kind: 'executeUpdate', symbolHash });

  if (resolution.verdict === 'UNRESOLVED') return actions;

  // CANONICAL from here on.
  const token = resolution.token;
  if (!token) return actions;
  if (resolution.washSuspect && !entry.washSuspect) {
    actions.push({ kind: 'flagWash', symbolHash, evidenceHash });
  }
  if (resolution.devDumped && !entry.devDumped) {
    actions.push({ kind: 'flagDevDump', symbolHash, evidenceHash });
  }
  const needsProposal =
    entry.status !== STATUS_CANONICAL ||
    entry.token.toLowerCase() !== token.address.toLowerCase();
  const alreadyPending =
    pending.exists && pending.token.toLowerCase() === token.address.toLowerCase();
  if (needsProposal && !alreadyPending && !pendingExecutable) {
    actions.push({
      kind: 'proposeCanonical',
      symbolHash,
      token: token.address,
      launchedAt: token.deployedAt,
      evidenceHash,
    });
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------------------

async function executeAction(
  walletClient: WalletClient,
  publicClient: PublicClient,
  config: KeeperConfig,
  action: PlannedAction,
): Promise<Hex> {
  const chain = chainForId(config.chainId);
  const account = walletClient.account;
  if (!account) throw new Error('wallet client has no account');
  const base = { address: config.registryAddress, abi: REGISTRY_ABI, account, chain } as const;
  let txHash: Hex;
  switch (action.kind) {
    case 'contest':
      txHash = await walletClient.writeContract({
        ...base,
        functionName: 'contest',
        args: [action.symbolHash, action.evidenceHash],
      });
      break;
    case 'flagWash':
      txHash = await walletClient.writeContract({
        ...base,
        functionName: 'flagWash',
        args: [action.symbolHash, action.evidenceHash],
      });
      break;
    case 'flagDevDump':
      txHash = await walletClient.writeContract({
        ...base,
        functionName: 'flagDevDump',
        args: [action.symbolHash, action.evidenceHash],
      });
      break;
    case 'proposeCanonical':
      txHash = await walletClient.writeContract({
        ...base,
        functionName: 'proposeCanonical',
        args: [action.symbolHash, action.token, BigInt(action.launchedAt), action.evidenceHash],
      });
      break;
    case 'executeUpdate':
      txHash = await walletClient.writeContract({
        ...base,
        functionName: 'executeUpdate',
        args: [action.symbolHash],
      });
      break;
    case 'cancelProposal':
      txHash = await walletClient.writeContract({
        ...base,
        functionName: 'cancelProposal',
        args: [action.symbolHash],
      });
      break;
  }
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') throw new Error(`tx ${txHash} reverted on-chain`);
  return txHash;
}

function defaultWriteEvidence(evidenceDir: string, filename: string, content: string): void {
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(path.join(evidenceDir, filename), content);
}

function evidenceTimestamp(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/[:.]/g, '-');
}

// ---------------------------------------------------------------------------
// One keeper pass
// ---------------------------------------------------------------------------

/**
 * One keeper pass: for each symbol — fetch cohort, resolve, build +
 * write the evidence bundle, read the registry, plan actions, and (in
 * live mode) execute them. A per-symbol failure is recorded and does
 * NOT stop the pass.
 */
export async function runKeeperOnce(
  config: KeeperConfig,
  opts: KeeperRunOptions = {},
): Promise<KeeperReport> {
  const dryRun = config.dryRun;
  const nowSeconds = opts.now ? opts.now() : Math.floor(Date.now() / 1000);
  const publicClient = opts.publicClient ?? createKeeperPublicClient(config);
  const walletClient = dryRun
    ? null
    : (opts.walletClient ?? createKeeperWalletClient(config));
  const evidenceDir = config.evidenceDir ?? path.join(process.cwd(), 'data', 'evidence');

  const report: KeeperReport = {
    chainId: config.chainId,
    registry: config.registryAddress,
    dryRun,
    startedAt: new Date().toISOString(),
    symbols: [],
    txHashes: [],
    counts: {
      symbols: config.symbols.length,
      resolved: 0,
      contested: 0,
      unresolved: 0,
      actionsPlanned: 0,
      actionsExecuted: 0,
      failed: 0,
    },
  };

  for (const symbol of config.symbols) {
    const result: SymbolResult = {
      symbol,
      verdict: 'UNRESOLVED',
      cohortSize: 0,
      actions: [],
      executed: [],
      devDumpChecked: false,
    };
    report.symbols.push(result);
    try {
      const cohort = await fetchCohort(
        publicClient,
        { baseUrl: config.ponsApiBase, fetchFn: opts.fetchFn },
        symbol,
      );
      result.cohortSize = cohort.length;
      const narrative = config.narratives?.[symbol];
      let resolution = resolveSymbol(symbol, cohort, narrative);

      // Dev-dump check needs holdings data (injected provider; skipped in v1 otherwise).
      if (resolution.token && opts.creatorHoldings) {
        try {
          const holdings = await opts.creatorHoldings(resolution.token);
          if (holdings) {
            const dump = detectDevDump(resolution.token, holdings);
            result.devDumpChecked = true;
            if (dump.devDumped && !resolution.devDumped) {
              resolution = {
                ...resolution,
                devDumped: true,
                reasons: [...resolution.reasons, `dev-dump flag: ${dump.reason}`],
              };
            }
          }
        } catch (err) {
          result.executed.push({
            kind: 'flagDevDump',
            dryRun,
            error: `holdings lookup failed: ${errorMessage(err)}`,
          });
        }
      }

      result.verdict = resolution.verdict;
      if (resolution.token) result.canonicalToken = resolution.token.address;
      if (resolution.verdict === 'CANONICAL') report.counts.resolved++;
      else if (resolution.verdict === 'CONTESTED') report.counts.contested++;
      else report.counts.unresolved++;

      const { bundle, evidenceHash } = buildEvidenceBundle(symbol, cohort, resolution, {
        chainId: config.chainId,
        narrative,
        resolvedAt: new Date(nowSeconds * 1000).toISOString(),
      });
      result.evidenceHash = evidenceHash;
      const filename = `${symbol}-${evidenceTimestamp(nowSeconds * 1000)}.json`;
      const content = JSON.stringify(bundle, null, 2);
      if (opts.writeEvidence) await opts.writeEvidence(filename, content);
      else defaultWriteEvidence(evidenceDir, filename, content);
      result.evidenceFile = filename;

      const { entry, pending } = await readRegistryState(
        publicClient,
        config.registryAddress,
        symbol,
      );
      const actions = planActions(symbol, resolution, evidenceHash, entry, pending, nowSeconds);
      result.actions = actions;
      report.counts.actionsPlanned += actions.length;

      for (const action of actions) {
        if (dryRun || !walletClient) {
          result.executed.push({ kind: action.kind, dryRun: true });
          continue;
        }
        try {
          const txHash = await executeAction(walletClient, publicClient, config, action);
          result.executed.push({ kind: action.kind, txHash, dryRun: false });
          report.txHashes.push(txHash);
          report.counts.actionsExecuted++;
        } catch (err) {
          result.executed.push({
            kind: action.kind,
            dryRun: false,
            error: errorMessage(err),
          });
          report.counts.failed++;
        }
      }
    } catch (err) {
      result.error = errorMessage(err);
      report.counts.failed++;
    }
  }

  return report;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.split('\n')[0];
  return String(err);
}
