/**
 * Keeper tests — decision logic + dry-run behaviour with mocked fetch
 * and mocked viem clients. No network, no chain, no transactions.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Address, Hex, PublicClient, WalletClient } from 'viem';
import {
  fetchCohort,
  planActions,
  runKeeperOnce,
  STATUS_CANONICAL,
  STATUS_CONTESTED,
  STATUS_UNRESOLVED,
  symbolHashFor,
  type KeeperConfig,
  type PendingUpdateView,
  type RegistryEntryView,
} from '../src/keeper.js';
import { resolveSymbol, type CohortToken } from '../src/resolver.js';
import { assertChainAllowed, parseKeeperArgs } from '../scripts/run-keeper.js';

const T0 = 1794000000;
const NOW = T0 + 3600; // fixed "now" for timelock tests
const REGISTRY = '0x1000000000000000000000000000000000000001' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const EVIDENCE = ('0x' + 'ab'.repeat(32)) as Hex;

let addrCounter = 100;
function addr(): Address {
  addrCounter++;
  return `0x${addrCounter.toString(16).padStart(40, '0')}` as Address;
}

function emptyEntry(): RegistryEntryView {
  return {
    token: ZERO,
    status: STATUS_UNRESOLVED,
    launchedAt: 0n,
    washSuspect: false,
    devDumped: false,
    evidenceHash: ('0x' + '00'.repeat(32)) as Hex,
    updatedAt: 0n,
  };
}

function noPending(): PendingUpdateView {
  return {
    token: ZERO,
    launchedAt: 0n,
    evidenceHash: ('0x' + '00'.repeat(32)) as Hex,
    clearFlags: false,
    executableAt: 0n,
    exists: false,
  };
}

function mkToken(overrides: Partial<CohortToken> = {}): CohortToken {
  return {
    address: addr(),
    symbol: 'TEST',
    deployedAt: T0,
    progressBps: 0,
    buyCount: 0,
    sellCount: 0,
    tradeCount: 0,
    graduated: false,
    creator: addr(),
    socials: { website: '', twitter: '', telegram: '', discord: '' },
    ...overrides,
  };
}

// --- Mock Pons API ----------------------------------------------------------

interface ApiItem {
  address: string;
  symbol: string;
  progress_bps: number;
  buy_count: number;
  sell_count: number;
  graduated_at: string | null;
  launched_at: string;
}

const DCTY_WINNER = '0x2000000000000000000000000000000000000001';
const DCTY_LOSER = '0x2000000000000000000000000000000000000002';

function dctyItems(): ApiItem[] {
  return [
    {
      address: DCTY_WINNER,
      symbol: 'DCTY',
      progress_bps: 10000,
      buy_count: 332,
      sell_count: 40,
      graduated_at: '2026-11-19T10:00:00Z',
      launched_at: new Date(T0 * 1000).toISOString(),
    },
    {
      address: DCTY_LOSER,
      symbol: 'DCTY',
      progress_bps: 10,
      buy_count: 2,
      sell_count: 0,
      graduated_at: null,
      launched_at: new Date((T0 + 600) * 1000).toISOString(),
    },
  ];
}

function meowItems(): ApiItem[] {
  const progress = [389, 340, 210, 180, 120, 95, 40, 12];
  return progress.map((p, i) => ({
    address: `0x300000000000000000000000000000000000000${i + 1}`,
    symbol: 'MEOW',
    progress_bps: p,
    buy_count: 100 + i,
    sell_count: 10,
    graduated_at: null,
    launched_at: new Date((T0 + i * 900) * 1000).toISOString(),
  }));
}

function mockFetch(pages: Record<string, { items: ApiItem[]; next_cursor: string | null }[]>) {
  const calls: string[] = [];
  const fetchFn = async (url: string): Promise<Response> => {
    calls.push(url);
    const u = new URL(url);
    const symbol = u.searchParams.get('search') ?? '';
    const cursor = u.searchParams.get('cursor');
    const symbolPages = pages[symbol] ?? [{ items: [], next_cursor: null }];
    const page = cursor ? symbolPages[1] ?? { items: [], next_cursor: null } : symbolPages[0];
    return { ok: true, json: async () => page } as unknown as Response;
  };
  return { fetchFn, calls };
}

// --- Mock viem clients ------------------------------------------------------

function mockPublicClient(opts: {
  entries?: Map<string, RegistryEntryView>;
  pendings?: Map<string, PendingUpdateView>;
  socials?: Map<string, [string, string, string, string, string]>;
} = {}) {
  const entries = opts.entries ?? new Map();
  const pendings = opts.pendings ?? new Map();
  const socials = opts.socials ?? new Map();
  const readContract = async (args: { functionName: string; args?: unknown[] }) => {
    if (args.functionName === 'getEntry') {
      return entries.get((args.args?.[0] as string) ?? '') ?? emptyEntry();
    }
    if (args.functionName === 'getPending') {
      return pendings.get((args.args?.[0] as string) ?? '') ?? noPending();
    }
    throw new Error(`unexpected readContract ${args.functionName}`);
  };
  const multicall = async (args: {
    contracts: Array<{ address: Address; functionName: string }>;
  }) =>
    args.contracts.map((c) => {
      if (c.functionName === 'socials') {
        return {
          status: 'success',
          result: socials.get(c.address.toLowerCase()) ?? ['', '', '', '', ''],
        };
      }
      if (c.functionName === 'deployer') {
        return { status: 'success', result: '0x4000000000000000000000000000000000000001' };
      }
      if (c.functionName === 'description') {
        return { status: 'success', result: 'a test token' };
      }
      return { status: 'failure', error: new Error('unknown') };
    });
  return {
    readContract,
    multicall,
    waitForTransactionReceipt: async () => ({ status: 'success' }),
  } as unknown as PublicClient;
}

function mockWalletClient() {
  const writes: Array<{ functionName: string; args: unknown[] }> = [];
  const client = {
    account: { address: '0x5000000000000000000000000000000000000001' },
    writeContract: async (args: { functionName: string; args: unknown[] }) => {
      writes.push({ functionName: args.functionName, args: args.args });
      return ('0x' + 'cd'.repeat(32)) as Hex;
    },
  } as unknown as WalletClient;
  return { client, writes };
}

function baseConfig(overrides: Partial<KeeperConfig> = {}): KeeperConfig {
  return {
    rpcUrl: 'https://example.invalid',
    chainId: 46630,
    registryAddress: REGISTRY,
    symbols: ['DCTY'],
    dryRun: true,
    ...overrides,
  };
}

// --- fetchCohort ------------------------------------------------------------

describe('fetchCohort', () => {
  it('maps Pons API items and enriches with on-chain socials', async () => {
    const { fetchFn, calls } = mockFetch({ DCTY: [{ items: dctyItems(), next_cursor: null }] });
    const socials = new Map([
      [DCTY_WINNER.toLowerCase(), ['https://x.com/dcty', '', '', 'https://dcty.example', ''] as [string, string, string, string, string]],
    ]);
    const client = mockPublicClient({ socials });
    const cohort = await fetchCohort(client, { fetchFn }, 'DCTY');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes('search=DCTY'), calls[0]);
    assert.equal(cohort.length, 2);
    const winner = cohort.find((t) => t.address === DCTY_WINNER)!;
    assert.equal(winner.deployedAt, T0);
    assert.equal(winner.progressBps, 10000);
    assert.equal(winner.tradeCount, 372);
    assert.equal(winner.graduated, true);
    assert.equal(winner.socials.twitter, 'https://x.com/dcty');
    assert.equal(winner.socials.website, 'https://dcty.example');
    assert.equal(winner.description, 'a test token');
  });

  it('follows pagination cursors', async () => {
    const { fetchFn, calls } = mockFetch({
      DCTY: [
        { items: dctyItems().slice(0, 1), next_cursor: 'page2' },
        { items: dctyItems().slice(1), next_cursor: null },
      ],
    });
    const cohort = await fetchCohort(mockPublicClient(), { fetchFn }, 'DCTY');
    assert.equal(calls.length, 2);
    assert.equal(cohort.length, 2);
  });

  it('throws a clear error when the Pons API fails', async () => {
    const fetchFn = async () =>
      ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response;
    await assert.rejects(fetchCohort(mockPublicClient(), { fetchFn }, 'DCTY'), /Pons API 500/);
  });
});

// --- planActions (pure decision logic) --------------------------------------

describe('planActions', () => {
  const winner = mkToken({ symbol: 'DCTY', deployedAt: T0, progressBps: 10000, graduated: true });
  const canonical = resolveSymbol('DCTY', [winner]);
  const contested = resolveSymbol(
    'MEOW',
    [389, 340, 210].map((p, i) => mkToken({ symbol: 'MEOW', deployedAt: T0 + i * 900, progressBps: p })),
  );
  assert.equal(canonical.verdict, 'CANONICAL');
  assert.equal(contested.verdict, 'CONTESTED');

  it('proposes CANONICAL when no entry exists', () => {
    const actions = planActions('DCTY', canonical, EVIDENCE, emptyEntry(), noPending(), NOW);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].kind, 'proposeCanonical');
    assert.equal((actions[0] as { token: Address }).token, winner.address);
  });

  it('plans nothing when the entry already matches', () => {
    const entry = { ...emptyEntry(), token: winner.address, status: STATUS_CANONICAL };
    const actions = planActions('DCTY', canonical, EVIDENCE, entry, noPending(), NOW);
    assert.deepEqual(actions, []);
  });

  it('proposes when the entry points at a different token', () => {
    const entry = { ...emptyEntry(), token: addr(), status: STATUS_CANONICAL };
    const actions = planActions('DCTY', canonical, EVIDENCE, entry, noPending(), NOW);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].kind, 'proposeCanonical');
  });

  it('proposes when the entry is CONTESTED but the verdict is now CANONICAL', () => {
    const entry = { ...emptyEntry(), token: winner.address, status: STATUS_CONTESTED };
    const actions = planActions('DCTY', canonical, EVIDENCE, entry, noPending(), NOW);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].kind, 'proposeCanonical');
  });

  it('contests immediately when the verdict is CONTESTED', () => {
    const actions = planActions('MEOW', contested, EVIDENCE, emptyEntry(), noPending(), NOW);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].kind, 'contest');
  });

  it('plans nothing when already CONTESTED with no pending proposal', () => {
    const entry = { ...emptyEntry(), status: STATUS_CONTESTED };
    const actions = planActions('MEOW', contested, EVIDENCE, entry, noPending(), NOW);
    assert.deepEqual(actions, []);
  });

  it('cancels a pending proposal on an already-CONTESTED symbol', () => {
    const entry = { ...emptyEntry(), status: STATUS_CONTESTED };
    const pending: PendingUpdateView = {
      ...noPending(),
      token: winner.address,
      exists: true,
      executableAt: BigInt(NOW + 3600),
    };
    const actions = planActions('MEOW', contested, EVIDENCE, entry, pending, NOW);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].kind, 'cancelProposal');
  });

  it('flags wash when newly detected, not when already flagged', () => {
    const washToken = mkToken({ deployedAt: T0, progressBps: 10, tradeCount: 635 });
    const r = resolveSymbol('WASH', [washToken]);
    assert.equal(r.washSuspect, true);
    const fresh = planActions('WASH', r, EVIDENCE, emptyEntry(), noPending(), NOW);
    assert.ok(fresh.some((a) => a.kind === 'flagWash'));
    assert.ok(fresh.some((a) => a.kind === 'proposeCanonical'));
    const flagged = planActions('WASH', r, EVIDENCE, { ...emptyEntry(), washSuspect: true }, noPending(), NOW);
    assert.ok(!flagged.some((a) => a.kind === 'flagWash'));
  });

  it('flags dev-dump when newly detected', () => {
    const t = mkToken({ deployedAt: T0, progressBps: 120 });
    const holdings = new Map([[t.address.toLowerCase(), {
      launchBuyTokens: 1000n,
      currentBalance: 100n,
      transferredOut: 900n,
    }]]);
    const r = resolveSymbol('DUMP', [t], undefined, holdings);
    assert.equal(r.devDumped, true);
    const actions = planActions('DUMP', r, EVIDENCE, emptyEntry(), noPending(), NOW);
    assert.ok(actions.some((a) => a.kind === 'flagDevDump'));
  });

  it('plans executeUpdate only when a pending proposal is past executableAt', () => {
    const entry = { ...emptyEntry(), token: winner.address, status: STATUS_CANONICAL };
    const past: PendingUpdateView = {
      ...noPending(),
      token: winner.address,
      exists: true,
      executableAt: BigInt(NOW - 1),
    };
    const future: PendingUpdateView = {
      ...noPending(),
      token: winner.address,
      exists: true,
      executableAt: BigInt(NOW + 3600),
    };
    const pastActions = planActions('DCTY', canonical, EVIDENCE, entry, past, NOW);
    assert.deepEqual(pastActions.map((a) => a.kind), ['executeUpdate']);
    const futureActions = planActions('DCTY', canonical, EVIDENCE, entry, future, NOW);
    assert.deepEqual(futureActions, []);
  });

  it('skips proposeCanonical when the same token is already pending', () => {
    const pending: PendingUpdateView = {
      ...noPending(),
      token: winner.address,
      exists: true,
      executableAt: BigInt(NOW + 3600),
    };
    const actions = planActions('DCTY', canonical, EVIDENCE, emptyEntry(), pending, NOW);
    assert.deepEqual(actions, []);
  });

  it('replaces a pending proposal for a different token', () => {
    const pending: PendingUpdateView = {
      ...noPending(),
      token: addr(),
      exists: true,
      executableAt: BigInt(NOW + 3600),
    };
    const actions = planActions('DCTY', canonical, EVIDENCE, emptyEntry(), pending, NOW);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].kind, 'proposeCanonical');
  });
});

// --- runKeeperOnce (dry-run + live with mocks) ------------------------------

describe('runKeeperOnce', () => {
  it('dry-run plans proposeCanonical for a CANONICAL cohort and sends no txs', async () => {
    const { fetchFn } = mockFetch({ DCTY: [{ items: dctyItems(), next_cursor: null }] });
    const evidenceDir = mkdtempSync(path.join(tmpdir(), 'pixflow-evidence-'));
    const report = await runKeeperOnce(baseConfig({ evidenceDir }), {
      fetchFn,
      publicClient: mockPublicClient(),
      now: () => NOW,
    });
    assert.equal(report.dryRun, true);
    assert.equal(report.txHashes.length, 0);
    assert.equal(report.counts.resolved, 1);
    const s = report.symbols[0];
    assert.equal(s.verdict, 'CANONICAL');
    assert.equal(s.canonicalToken, DCTY_WINNER);
    assert.equal(s.cohortSize, 2);
    assert.equal(s.actions.length, 1);
    assert.equal(s.actions[0].kind, 'proposeCanonical');
    assert.equal(s.executed.length, 1);
    assert.equal(s.executed[0].dryRun, true);
    assert.equal(s.executed[0].txHash, undefined);
    // Evidence bundle was written to disk.
    const files = readdirSync(evidenceDir);
    assert.equal(files.length, 1);
    assert.ok(files[0].startsWith('DCTY-') && files[0].endsWith('.json'), files[0]);
    const bundle = JSON.parse(readFileSync(path.join(evidenceDir, files[0]), 'utf8'));
    assert.equal(bundle.symbol, 'DCTY');
    assert.equal(bundle.resolution.verdict, 'CANONICAL');
    assert.equal(bundle.policy.version, 'pixflow-resolver/1');
  });

  it('dry-run plans contest for a CONTESTED cohort and sends no txs', async () => {
    const { fetchFn } = mockFetch({ MEOW: [{ items: meowItems(), next_cursor: null }] });
    const written = new Map<string, string>();
    const report = await runKeeperOnce(baseConfig({ symbols: ['MEOW'] }), {
      fetchFn,
      publicClient: mockPublicClient(),
      now: () => NOW,
      writeEvidence: (filename, content) => {
        written.set(filename, content);
      },
    });
    assert.equal(report.txHashes.length, 0);
    assert.equal(report.counts.contested, 1);
    const s = report.symbols[0];
    assert.equal(s.verdict, 'CONTESTED');
    assert.equal(s.cohortSize, 8);
    assert.deepEqual(s.actions.map((a) => a.kind), ['contest']);
    assert.equal(s.executed[0].dryRun, true);
    assert.equal(written.size, 1);
  });

  it('a per-symbol failure does not stop the pass', async () => {
    const { fetchFn } = mockFetch({ DCTY: [{ items: dctyItems(), next_cursor: null }] });
    const failingFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      if (new URL(url).searchParams.get('search') === 'MEOW') {
        return { ok: false, status: 503, json: async () => ({}) } as unknown as Response;
      }
      return fetchFn(url);
    };
    const report = await runKeeperOnce(baseConfig({ symbols: ['MEOW', 'DCTY'] }), {
      fetchFn: failingFetch,
      publicClient: mockPublicClient(),
      now: () => NOW,
      writeEvidence: () => {},
    });
    assert.equal(report.symbols.length, 2);
    assert.ok(report.symbols[0].error?.includes('503'), report.symbols[0].error);
    assert.equal(report.symbols[1].verdict, 'CANONICAL');
    assert.equal(report.counts.failed, 1);
  });

  it('live mode with a mock wallet executes the planned action', async () => {
    const { fetchFn } = mockFetch({ DCTY: [{ items: dctyItems(), next_cursor: null }] });
    const { client: walletClient, writes } = mockWalletClient();
    const report = await runKeeperOnce(baseConfig({ dryRun: false }), {
      fetchFn,
      publicClient: mockPublicClient(),
      walletClient,
      now: () => NOW,
      writeEvidence: () => {},
    });
    assert.equal(report.dryRun, false);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].functionName, 'proposeCanonical');
    assert.deepEqual(writes[0].args[0], symbolHashFor('DCTY'));
    assert.equal(writes[0].args[1], DCTY_WINNER);
    assert.equal(report.txHashes.length, 1);
    assert.equal(report.counts.actionsExecuted, 1);
  });
});

// --- CLI guards --------------------------------------------------------------

describe('CLI guards', () => {
  it('refuses mainnet unless explicitly allowed', () => {
    assert.throws(() => assertChainAllowed(4663, false), /REFUSING mainnet/);
    assert.doesNotThrow(() => assertChainAllowed(4663, true));
    assert.doesNotThrow(() => assertChainAllowed(46630, false));
  });

  it('parses --once / --watch / --dry-run', () => {
    assert.deepEqual(parseKeeperArgs(['--once']), { once: true, watch: false, dryRun: false });
    assert.deepEqual(parseKeeperArgs(['--watch', '--dry-run']), {
      once: false,
      watch: true,
      dryRun: true,
    });
    assert.throws(() => parseKeeperArgs([]), /usage/);
    assert.throws(() => parseKeeperArgs(['--once', '--watch']), /exactly one/);
  });
});
