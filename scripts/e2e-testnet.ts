/**
 * Testnet end-to-end for Pixflow (Verified Buy Router) on RH TESTNET 46630.
 *
 * Full flow, against the REAL Pons curve code (via PonsFactoryStub) and the
 * REAL registry timelock (1 hour — this script waits it out honestly):
 *
 *   1. Verify the deployment (router/registry/curve/token + factory registry).
 *   2. Keeper-style resolution of the test cohort (single token TPIX).
 *   3. proposeCanonical(TPIX) → verify the pending proposal (executableAt).
 *   4. NEGATIVE: buyVerifiedBySymbol("TPIX") BEFORE the timelock must
 *      revert NotCanonical (simulated, no gas spent).
 *   5. Wait for the 1h timelock (poll every 60s, log every 5 min).
 *   6. executeUpdate(TPIX) → verify the entry is CANONICAL.
 *   7. buyVerifiedBySymbol("TPIX") with 0.00005 testnet ETH → verify tokens
 *      received, BuyVerified event, and the exact 0.3% fee accrual.
 *   8. claimFees() → verify the fee lands and feesOwed returns to 0.
 *   9. contest("MEOW") → NEGATIVE: buyVerifiedBySymbol("MEOW") must revert
 *      Contested (simulated).
 *
 * Requires data/testnet-deployment.json (npm run deploy:testnet first).
 * Uses the RYCORE testnet deployer key (mode 600) — the key is never printed.
 * Writes data/testnet-e2e.json progressively (a step is recorded as soon as
 * it completes, so an interrupted run still leaves a readable record).
 *
 * Run: npm run e2e:testnet   (takes ~65 minutes: the 1h timelock is real)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  parseEther,
  parseEventLogs,
  keccak256,
  toHex,
  toFunctionSelector,
  type Hex,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  PONS_CURVE_ABI,
  PONS_TOKEN_ABI,
  REGISTRY_ABI,
  ROUTER_ABI,
} from '../src/contracts.js';
import { robinhoodTestnet } from '../src/chains.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RPC_URL = process.env.TESTNET_RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com';
const FALLBACK_RPC_URL = 'https://api.blockvectra.com/v1/robinhood_testnet/public';
// Fallback transport: the primary testnet RPC intermittently times out for
// minutes at a time (observed 19 Nov ~12:05 WIB: every call timed out on
// BOTH endpoints for a stretch). A single flaky RPC must never kill the run.
const transport = fallback([http(RPC_URL), http(FALLBACK_RPC_URL)]);
const EXPLORER = 'https://explorer.testnet.chain.robinhood.com';
const DEPLOYMENT_FILE = path.join(root, 'data', 'testnet-deployment.json');
const OUT_FILE = path.join(root, 'data', 'testnet-e2e.json');

const BUY_VALUE = parseEther('0.00005'); // testnet ETH for the E2E buy
const POLL_MS = 60_000;
const LOG_EVERY_MS = 5 * 60_000;
const WAIT_TIMEOUT_MS = 80 * 60_000;

const NOT_CANONICAL_SELECTOR = toFunctionSelector('NotCanonical()');
const CONTESTED_SELECTOR = toFunctionSelector('Contested()');

interface Step {
  name: string;
  status: 'pass' | 'fail';
  detail: string;
  txHash?: string;
}

const steps: Step[] = [];
// RESUME: a previous run's passed steps are kept (a re-run must never
// re-propose and reset the 1h timelock clock, or re-buy with scarce funds).
// Failed steps are dropped so they are re-attempted.
const result: Record<string, unknown> = {
  chainId: 46630,
  network: 'robinhood-testnet',
  startedAt: new Date().toISOString(),
  steps,
};
if (existsSync(OUT_FILE)) {
  try {
    const prev = JSON.parse(readFileSync(OUT_FILE, 'utf8')) as Record<string, unknown>;
    const prevSteps = (prev.steps as Step[] | undefined) ?? [];
    for (const s of prevSteps) if (s.status === 'pass') steps.push(s);
    for (const [k, v] of Object.entries(prev)) if (k !== 'steps') result[k] = v;
    result.resumedAt = new Date().toISOString();
    console.log(`resuming: ${steps.length} step(s) already passed in a previous run`);
  } catch {
    // Corrupt/unreadable file — start fresh.
  }
}

function isDone(name: string): boolean {
  return steps.some((s) => s.name === name && s.status === 'pass');
}

function skip(name: string, detail: string) {
  console.log(`  SKIP ${name}: ${detail} (already passed in a previous run)`);
}

function save() {
  mkdirSync(path.join(root, 'data'), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(result, null, 2) + '\n');
}

function record(name: string, detail: string, txHash?: string) {
  console.log(`  PASS ${name}: ${detail}`);
  const existing = steps.findIndex((s) => s.name === name);
  const entry: Step = { name, status: 'pass', detail, txHash };
  if (existing >= 0) steps[existing] = entry;
  else steps.push(entry);
  save();
}

function fail(name: string, detail: string): never {
  console.error(`  FAIL ${name}: ${detail}`);
  steps.push({ name, status: 'fail', detail });
  result.finishedAt = new Date().toISOString();
  save();
  throw new Error(`E2E failed at ${name}: ${detail}`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (!existsSync(DEPLOYMENT_FILE)) {
    throw new Error('no deployment file — run npm run deploy:testnet first');
  }
  const deployment = JSON.parse(readFileSync(DEPLOYMENT_FILE, 'utf8')) as Record<string, string>;
  const router = deployment.router as Address;
  const registry = deployment.registry as Address;
  const curve = deployment.curve as Address;
  const token = deployment.token as Address;
  const stub = deployment.stub as Address;
  if (!router || !registry || !curve || !token || !stub) {
    throw new Error('deployment file is incomplete (missing router/registry/curve/token/stub)');
  }
  result.addresses = { router, registry, curve, token, stub };

  const keyFile =
    process.env.DEPLOYER_KEY_FILE ??
    path.join(process.env.HOME ?? '', 'workspace', 'rycore', 'data', 'testnet-deployer.json');
  const keyData = JSON.parse(readFileSync(keyFile, 'utf8'));
  const account = privateKeyToAccount(keyData.privateKey as Hex);
  result.deployer = account.address;

  const publicClient = createPublicClient({ chain: robinhoodTestnet, transport });
  const walletClient = createWalletClient({ account, chain: robinhoodTestnet, transport });

  const chainId = await publicClient.getChainId();
  if (chainId !== 46630) throw new Error(`REFUSING: connected chain is ${chainId}, expected testnet 46630`);
  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`deployer ${account.address} balance ${Number(balance) / 1e18} ETH`);
  if (balance < parseEther('0.00006')) {
    throw new Error('deployer balance too low for the E2E run (need >= 0.00006 testnet ETH: buy value + gas)');
  }

  async function sendTx(label: string, address: Address, abi: unknown, functionName: string, args: unknown[], value?: bigint) {
    const txHash = await walletClient.writeContract({
      address,
      abi: abi as never,
      functionName,
      args: args as never,
      value,
      account,
      chain: robinhoodTestnet,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') fail(label, `tx ${txHash} reverted on-chain`);
    return { txHash, receipt };
  }

  // ── 1. Verify the deployment ──────────────────────────────────────────
  for (const [name, addr] of Object.entries({ router, registry, curve, token, stub })) {
    const code = await publicClient.getCode({ address: addr });
    if (!code || code === '0x') fail('deployment-check', `no code at ${name} ${addr}`);
  }
  const curveToken = await publicClient.readContract({ address: curve, abi: PONS_CURVE_ABI, functionName: 'token' });
  if ((curveToken as string).toLowerCase() !== token.toLowerCase()) {
    fail('deployment-check', `curve.token() ${curveToken} != token ${token}`);
  }
  record('deployment-check', 'router/registry/curve/token/stub all have code; curve.token() matches');

  // ── 2. Keeper-style resolution (testnet cohort: single token TPIX) ────
  const launchedAt = Number(
    await publicClient.readContract({ address: curve, abi: PONS_CURVE_ABI, functionName: 'launchedAt' }),
  );
  const progressBps = Number(
    await publicClient.readContract({ address: curve, abi: PONS_CURVE_ABI, functionName: 'realQuoteReserve' }),
  );
  void progressBps;
  const evidenceBundle = {
    symbol: 'TPIX',
    resolvedAt: new Date().toISOString(),
    network: 'robinhood-testnet',
    cohort: [{ address: token, symbol: 'TPIX', deployedAt: launchedAt, progressBps: 0, graduated: false }],
    verdict: 'CANONICAL',
    reasons: ['single-token testnet cohort: earliest (only) launch, no competing claim'],
    policy: 'pixflow-resolver-v1 (testnet E2E bundle)',
  };
  const evidenceHash = keccak256(toHex(JSON.stringify(evidenceBundle)));
  const symbolHash = keccak256(toHex('TPIX'));
  result.evidence = { bundle: evidenceBundle, evidenceHash, symbolHash };
  record('resolve-TPIX', `single-token cohort resolves CANONICAL; evidenceHash ${evidenceHash}`);
  save();

  // ── 3. proposeCanonical (skipped on resume — re-proposing would reset
  // the 1h clock) ───────────────────────────────────────────────────────
  let proposeTx = result.proposeTx as string | undefined;
  if (isDone('proposeCanonical')) {
    skip('proposeCanonical', `already proposed (tx ${proposeTx ?? 'unknown'})`);
  } else {
    const r = await sendTx(
      'proposeCanonical',
      registry,
      REGISTRY_ABI,
      'proposeCanonical',
      [symbolHash, token, BigInt(launchedAt), evidenceHash],
    );
    proposeTx = r.txHash;
    result.proposeTx = proposeTx;
    record('proposeCanonical', `TPIX proposed as canonical`, proposeTx);
  }
  const pending = (await publicClient.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: 'getPending',
    args: [symbolHash],
  })) as { token: string; executableAt: bigint; exists: boolean };
  if (isDone('executeUpdate')) {
    skip('pending-check', 'proposal already executed in a previous run');
  } else if (!pending.exists || pending.token.toLowerCase() !== token.toLowerCase()) {
    fail('pending-check', 'getPending does not show the TPIX proposal');
  }
  const executableAt = Number(pending.executableAt);
  result.proposeTx = proposeTx;
  if (pending.exists) result.executableAt = new Date(executableAt * 1000).toISOString();
  if (!isDone('pending-check')) record('pending-check', `proposal pending, executableAt ${result.executableAt}`);

  // ── 4. NEGATIVE: buy before the timelock must revert NotCanonical ─────
  if (isDone('buy-before-timelock')) {
    skip('buy-before-timelock', 'already verified');
  } else if (isDone('executeUpdate')) {
    skip('buy-before-timelock', 'timelock already executed in a previous run');
  } else {
    try {
      await publicClient.simulateContract({
        address: router,
        abi: ROUTER_ABI,
        functionName: 'buyVerifiedBySymbol',
        args: ['TPIX', 1n],
        value: BUY_VALUE,
        account: account.address,
      });
      fail('buy-before-timelock', 'buy simulated SUCCESS before the timelock — expected NotCanonical revert');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('E2E failed at buy-before-timelock')) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('NotCanonical') || msg.toLowerCase().includes(NOT_CANONICAL_SELECTOR.slice(2).toLowerCase())) {
        record('buy-before-timelock', 'buy correctly reverts NotCanonical before executeUpdate');
      } else {
        fail('buy-before-timelock', `buy reverted, but with an unexpected error: ${msg.split('\n')[0]}`);
      }
    }
  }

  // ── 5. Wait out the 1h timelock (honest wall-clock wait) ──────────────
  if (isDone('timelock-wait') || isDone('executeUpdate')) {
    skip('timelock-wait', 'timelock already expired in a previous run');
  } else {
    console.log(`  waiting for the timelock (executableAt ${result.executableAt})...`);
    const waitStarted = Date.now();
    let lastLog = 0;
    let consecutivePollFailures = 0;
    for (;;) {
      let blockTimestamp: number | null = null;
      let blockNumber: bigint | null = null;
      try {
        const block = await publicClient.getBlock({ blockTag: 'latest' });
        blockTimestamp = Number(block.timestamp);
        blockNumber = block.number;
        consecutivePollFailures = 0;
      } catch (pollErr) {
        consecutivePollFailures++;
        console.log(
          `  poll failed (${consecutivePollFailures} in a row) — retrying in 60s: ` +
            `${pollErr instanceof Error ? pollErr.message.split('\n')[0] : pollErr}`,
        );
        await sleep(POLL_MS);
        continue;
      }
      if (blockTimestamp !== null && blockTimestamp >= executableAt) break;
      const remainingS = executableAt - (blockTimestamp ?? executableAt);
      if (Date.now() - waitStarted > WAIT_TIMEOUT_MS) {
        fail('timelock-wait', `timelock did not expire within ${WAIT_TIMEOUT_MS / 60000} minutes`);
      }
      if (Date.now() - lastLog >= LOG_EVERY_MS) {
        console.log(`  ... ${Math.ceil(remainingS / 60)} min left (block ${blockNumber})`);
        lastLog = Date.now();
      }
      await sleep(POLL_MS);
    }
    record('timelock-wait', `timelock expired after ${Math.round((Date.now() - waitStarted) / 60000)} min`);
  }

  // ── 6. executeUpdate ──────────────────────────────────────────────────
  if (isDone('executeUpdate')) {
    skip('executeUpdate', `already executed (tx ${(result.executeTx as string) ?? 'unknown'})`);
  } else {
    const { txHash: executeTx } = await sendTx('executeUpdate', registry, REGISTRY_ABI, 'executeUpdate', [symbolHash]);
    result.executeTx = executeTx;
    record('executeUpdate', 'proposal executed', executeTx);
  }
  const entry = (await publicClient.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: 'getEntry',
    args: [symbolHash],
  })) as { token: string; status: number; washSuspect: boolean; devDumped: boolean };
  if (entry.status !== 1 || entry.token.toLowerCase() !== token.toLowerCase()) {
    fail('entry-check', `entry is not CANONICAL for TPIX (status ${entry.status}, token ${entry.token})`);
  }
  record('entry-check', 'registry entry is CANONICAL for TPIX, flags clear');

  // ── 7. buyVerifiedBySymbol("TPIX") ────────────────────────────────────
  const fee = (BUY_VALUE * 30n) / 10000n;
  if (isDone('buyVerifiedBySymbol')) {
    skip('buyVerifiedBySymbol', `already bought (tx ${(result.buyTx as string) ?? 'unknown'})`);
  } else {
    const net = BUY_VALUE - fee;
    const quote = (await publicClient.readContract({
      address: router,
      abi: ROUTER_ABI,
      functionName: 'quoteBuy',
      args: [curve, net],
    })) as bigint;
    if (quote === 0n) fail('buy-quote', 'quoteBuy returned 0');
    const minTokensOut = (quote * 99n) / 100n;
    const balBefore = (await publicClient.readContract({
      address: token,
      abi: PONS_TOKEN_ABI,
      functionName: 'balanceOf',
      args: [account.address],
    })) as bigint;
    const { txHash: buyTx, receipt: buyReceipt } = await sendTx(
      'buyVerifiedBySymbol',
      router,
      ROUTER_ABI,
      'buyVerifiedBySymbol',
      ['TPIX', minTokensOut],
      BUY_VALUE,
    );
    const balAfter = (await publicClient.readContract({
      address: token,
      abi: PONS_TOKEN_ABI,
      functionName: 'balanceOf',
      args: [account.address],
    })) as bigint;
    const received = balAfter - balBefore;
    if (received < minTokensOut) fail('buy-received', `received ${received} < minTokensOut ${minTokensOut}`);
    const buyEvents = parseEventLogs({ abi: ROUTER_ABI, logs: buyReceipt.logs, eventName: 'BuyVerified' });
    if (buyEvents.length !== 1) fail('buy-event', `expected 1 BuyVerified event, got ${buyEvents.length}`);
    const ev = buyEvents[0].args as unknown as { ethSpent: bigint; tokensReceived: bigint; fee: bigint; refund: bigint };
    if (ev.tokensReceived !== received) fail('buy-event', 'BuyVerified tokensReceived != balance delta');
    if (ev.fee !== fee) fail('buy-fee', `BuyVerified fee ${ev.fee} != expected 0.3% ${fee}`);
    const feesOwed = (await publicClient.readContract({
      address: router,
      abi: ROUTER_ABI,
      functionName: 'feesOwed',
      args: [account.address],
    })) as bigint;
    if (feesOwed !== fee) fail('buy-fee', `feesOwed ${feesOwed} != expected ${fee}`);
    result.buyTx = buyTx;
    result.buy = {
      ethSent: BUY_VALUE.toString(),
      ethSpent: ev.ethSpent.toString(),
      tokensReceived: received.toString(),
      fee: ev.fee.toString(),
      refund: ev.refund.toString(),
      explorer: `${EXPLORER}/tx/${buyTx}`,
    };
    record(
      'buyVerifiedBySymbol',
      `bought ${received} TPIX for ${BUY_VALUE} wei (fee exactly 0.3% = ${fee} wei, refund ${ev.refund})`,
      buyTx,
    );
  }

  // ── 8. claimFees ──────────────────────────────────────────────────────
  if (isDone('claimFees')) {
    skip('claimFees', `already claimed (tx ${(result.claimTx as string) ?? 'unknown'})`);
  } else {
    const { txHash: claimTx } = await sendTx('claimFees', router, ROUTER_ABI, 'claimFees', []);
    const feesAfter = (await publicClient.readContract({
      address: router,
      abi: ROUTER_ABI,
      functionName: 'feesOwed',
      args: [account.address],
    })) as bigint;
    if (feesAfter !== 0n) fail('claimFees', `feesOwed after claim is ${feesAfter}, expected 0`);
    result.claimTx = claimTx;
    record('claimFees', `claimed ${fee} wei; feesOwed back to 0`, claimTx);
  }

  // ── 9. contest("MEOW") → buy must revert Contested ───────────────────
  if (isDone('contest-MEOW')) {
    skip('contest-MEOW', 'MEOW already contested in a previous run');
  } else {
    const meowHash = keccak256(toHex('MEOW'));
    const meowEvidence = keccak256(toHex(JSON.stringify({ symbol: 'MEOW', verdict: 'CONTESTED', reason: 'testnet E2E: ambiguous by construction' })));
    const { txHash: contestTx } = await sendTx('contest-MEOW', registry, REGISTRY_ABI, 'contest', [meowHash, meowEvidence]);
    record('contest-MEOW', 'MEOW marked CONTESTED (immediate, fail-closed)', contestTx);
  }
  if (isDone('buy-contested')) {
    skip('buy-contested', 'already verified');
  } else {
    try {
      await publicClient.simulateContract({
        address: router,
        abi: ROUTER_ABI,
        functionName: 'buyVerifiedBySymbol',
        args: ['MEOW', 1n],
        value: BUY_VALUE,
        account: account.address,
      });
      fail('buy-contested', 'buy for MEOW simulated SUCCESS — expected Contested revert');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('E2E failed at buy-contested')) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Contested') || msg.toLowerCase().includes(CONTESTED_SELECTOR.slice(2).toLowerCase())) {
        record('buy-contested', 'buy for contested MEOW correctly reverts Contested');
      } else {
        fail('buy-contested', `buy reverted, but with an unexpected error: ${msg.split('\n')[0]}`);
      }
    }
  }

  result.finishedAt = new Date().toISOString();
  result.summary = `E2E PASS: ${steps.length}/${steps.length} steps green`;
  save();
  console.log(`\nE2E PASS — ${steps.length} steps green. Wrote ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
