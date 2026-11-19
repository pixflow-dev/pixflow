/**
 * Shared in-process EVM harness for the verified-buy-router tests.
 *
 * The REAL compiled bytecode runs on @ethereumjs/vm (chain 46630):
 * the genuine PonsV2BondingCurve + PonsV2LauncherToken (vendored from
 * Sourcify, byte-identical to mainnet apart from immutables — see
 * RESEARCH.md), the test-only PonsFactoryStub, and our CanonicalRegistry
 * + VerifiedBuyRouter.
 *
 * Pattern mirrors Specta's tests/vm.ts. NOTE (ethereumjs v10): a CREATE
 * takes the init code in `data`, not `code`.
 *
 * TIME CONTROL: runCall accepts an explicit block, and the EVM only reads
 * the block header for TIMESTAMP/NUMBER/etc. This harness passes a
 * minimal block-like object (the same shape as ethereumjs' own
 * defaultBlock()) with a controllable timestamp, so the snipe-tax window
 * and registry timelock tests can move time forward deterministically.
 * Default start time is fixed (1_760_000_000) so launchedAt values are
 * realistic and reproducible.
 */
import { createVM, type VM } from '@ethereumjs/vm';
import { createCustomCommon, Hardfork, Mainnet } from '@ethereumjs/common';
import { Account, createAddressFromString, createZeroAddress, hexToBytes } from '@ethereumjs/util';
import type { Block } from '@ethereumjs/block';
import {
  decodeFunctionResult,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseEther,
  toBytes,
  toFunctionSelector,
  type Abi,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  LYING_BUY_CURVE_ABI,
  LYING_BUY_CURVE_BYTECODE,
  PONS_CURVE_ABI,
  PONS_CURVE_BYTECODE,
  PONS_FACTORY_STUB_ABI,
  PONS_FACTORY_STUB_BYTECODE,
  PONS_TOKEN_ABI,
  PONS_TOKEN_BYTECODE,
  REGISTRY_ABI,
  REGISTRY_BYTECODE,
  ROUTER_ABI,
  ROUTER_BYTECODE,
} from '../src/contracts.js';

export const CHAIN_ID = 46630;
const GAS = 15_000_000n;

/** Fixed harness epoch (2025-10-09T00:00:00Z) — all launchedAt values anchor here. */
export const T0 = 1_760_000_000n;
export const TIMELOCK_DELAY = 3600n;

/** $RYCORE mainnet launch parameters (read live 2026-11-18). */
export const PHANTOM_QUOTE = parseEther('1.68');
export const GRADUATION_THRESHOLD = parseEther('4.2');
export const FEE_BPS = 100n;
export const CREATOR_TAX_BPS = 200n;
export const LAUNCH_SUPPLY = 1_000_000_000n * 10n ** 18n;
/** Mainnet snipe-tax policy (verified from HOOKLB forensics 2026-11-18). */
export const SNIPE_TAX_START_BPS = 9900n;
export const SNIPE_TAX_SECONDS = 3n;

export function hex(data: Uint8Array): `0x${string}` {
  return `0x${Buffer.from(data).toString('hex')}` as `0x${string}`;
}

/** Selector of a custom error, e.g. errorSelector('TaxWindow()'). */
export function errorSelector(signature: string): string {
  return toFunctionSelector(signature);
}

/** First 4 bytes of a call's return data, as a 0x selector string ('' if empty). */
export function revertSelector(returnValue: Uint8Array): string {
  if (returnValue.length < 4) return '';
  return `0x${Buffer.from(returnValue.subarray(0, 4)).toString('hex')}`;
}

/** Registry key for a symbol: keccak256 of the exact symbol string. */
export function symbolHash(symbol: string): `0x${string}` {
  return keccak256(toBytes(symbol));
}

export interface TestEnv {
  vm: VM;
  deployer: ReturnType<typeof privateKeyToAccount>;
  user: ReturnType<typeof privateKeyToAccount>;
  keeper: ReturnType<typeof privateKeyToAccount>;
  attacker: ReturnType<typeof privateKeyToAccount>;
  stub: `0x${string}`;
  registry: `0x${string}`;
  router: `0x${string}`;
  curve: `0x${string}`;
  token: `0x${string}`;
  /** Current harness time (block.timestamp for every call). */
  now: () => bigint;
  /** Set the harness time (must not move backwards). */
  setTime: (t: bigint) => void;
  /** Advance the harness time by `seconds`. */
  advanceTime: (seconds: bigint) => void;
  /** Low-level call. Returns the raw runCall result. */
  call: (
    to: `0x${string}` | undefined,
    data: `0x${string}`,
    opts?: { caller?: `0x${string}`; value?: bigint },
  ) => Promise<Awaited<ReturnType<VM['evm']['runCall']>>>;
  /** View call: returns the decoded result of `functionName` on `to`. */
  read: <T = unknown>(
    to: `0x${string}`,
    abi: Abi,
    functionName: string,
    args?: readonly unknown[],
  ) => Promise<T>;
  ethBalance: (address: `0x${string}`) => Promise<bigint>;
  tokenBalance: (tokenAddr: `0x${string}`, address: `0x${string}`) => Promise<bigint>;
  progressBps: (curveAddr?: `0x${string}`) => Promise<bigint>;
  /** Direct curve buy (bypasses the router) — moves progress / gives tokens. */
  directBuy: (curveAddr: `0x${string}`, buyer: `0x${string}`, ethAmount: bigint) => Promise<bigint>;
  /** Deploy a second curve+token pair. */
  deployCurvePair: (opts?: {
    pairToken?: `0x${string}`;
    name?: string;
    symbol?: string;
    /** Register the pair in the factory stub (default true). Pass false to
     *  deploy an UNREGISTERED curve — buyVerified must reject it (M-01). */
    register?: boolean;
    /** Snipe-tax params snapshotted at initialize (default 0/0 = disabled). */
    snipeTaxStartBps?: bigint;
    snipeTaxSeconds?: bigint;
  }) => Promise<{ curve: `0x${string}`; token: `0x${string}` }>;
  /** Deploy a LyingBuyCurve for `token`, fund it, register it as the token's curve. */
  deployLyingBuyCurve: (tokenAddr: `0x${string}`, fundAmount: bigint) => Promise<`0x${string}`>;
  /** Full canonical registration: propose + fast-forward 1h + execute. */
  registerCanonical: (
    tokenAddr: `0x${string}`,
    symbol: string,
    opts?: { launchedAt?: bigint; evidence?: `0x${string}` },
  ) => Promise<void>;
  /** Router buyVerified call (raw result — check exceptionError yourself). */
  buyVerifiedRaw: (
    buyer: `0x${string}`,
    tokenAddr: `0x${string}`,
    ethAmount: bigint,
    minTokensOut: bigint,
  ) => Promise<Awaited<ReturnType<VM['evm']['runCall']>>>;
  /** Router buyVerifiedBySymbol call (raw result). */
  buyVerifiedBySymbolRaw: (
    buyer: `0x${string}`,
    symbol: string,
    ethAmount: bigint,
    minTokensOut: bigint,
  ) => Promise<Awaited<ReturnType<VM['evm']['runCall']>>>;
  /** Router quoteBuy view. */
  quoteBuy: (curveAddr: `0x${string}`, quoteIn: bigint) => Promise<bigint>;
  /** Router maxSpendFor view. */
  maxSpendFor: (curveAddr: `0x${string}`) => Promise<bigint>;
  /** Registry getEntry view. */
  entryOf: (symbol: string) => Promise<{
    token: `0x${string}`;
    status: number;
    launchedAt: bigint;
    washSuspect: boolean;
    devDumped: boolean;
    evidenceHash: `0x${string}`;
    updatedAt: bigint;
  }>;
}

export async function createEnv(): Promise<TestEnv> {
  const common = createCustomCommon(
    { name: 'robinhood-testnet', chainId: CHAIN_ID, defaultHardfork: Hardfork.Cancun },
    Mainnet,
  );
  const vm = await createVM({ common });

  const deployer = privateKeyToAccount(generatePrivateKey());
  const user = privateKeyToAccount(generatePrivateKey());
  const keeper = privateKeyToAccount(generatePrivateKey());
  const attacker = privateKeyToAccount(generatePrivateKey());

  for (const a of [deployer, user, keeper, attacker]) {
    await vm.stateManager.putAccount(
      createAddressFromString(a.address),
      new Account(0n, parseEther('100')),
    );
  }

  // ---- time control ----
  let currentTime = T0;
  let blockNumber = 0n;
  function currentBlock(): Block {
    // Minimal block-like object — the same shape ethereumjs' own
    // defaultBlock() returns (evm.js), with our timestamp/number.
    // The EVM only reads header fields during runCall.
    return {
      header: {
        number: blockNumber,
        coinbase: createZeroAddress(),
        timestamp: currentTime,
        difficulty: 0n,
        prevRandao: new Uint8Array(32),
        gasLimit: 0n,
        baseFeePerGas: undefined,
        slotNumber: 0n,
        getBlobGasPrice: () => undefined,
      },
    } as unknown as Block;
  }
  function now(): bigint {
    return currentTime;
  }
  function setTime(t: bigint): void {
    if (t < currentTime) throw new Error('time cannot move backwards');
    currentTime = t;
    blockNumber += 1n;
  }
  function advanceTime(seconds: bigint): void {
    setTime(currentTime + seconds);
  }

  async function call(
    to: `0x${string}` | undefined,
    data: `0x${string}`,
    opts: { caller?: `0x${string}`; value?: bigint } = {},
  ) {
    return vm.evm.runCall({
      caller: createAddressFromString(opts.caller ?? deployer.address),
      to: to ? createAddressFromString(to) : undefined,
      data: hexToBytes(data),
      value: opts.value ?? 0n,
      gasLimit: GAS,
      block: currentBlock(),
    });
  }

  async function deploy(bytecode: `0x${string}`, args: readonly unknown[], abi: Abi): Promise<`0x${string}`> {
    const data = encodeDeployData({ abi, bytecode, args });
    const res = await call(undefined, data);
    if (res.execResult.exceptionError) {
      throw new Error(`deploy failed: ${res.execResult.exceptionError.error} (revert ${revertSelector(res.execResult.returnValue)})`);
    }
    if (!res.createdAddress) throw new Error('deploy produced no address');
    return getAddress(res.createdAddress.toString());
  }

  async function read<T>(to: `0x${string}`, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
    const data = encodeFunctionData({ abi, functionName, args });
    const res = await call(to, data);
    if (res.execResult.exceptionError) {
      throw new Error(`read ${functionName} failed: ${res.execResult.exceptionError.error}`);
    }
    return decodeFunctionResult({ abi, functionName, data: hex(res.execResult.returnValue) }) as T;
  }

  async function ethBalance(address: `0x${string}`): Promise<bigint> {
    const account = await vm.stateManager.getAccount(createAddressFromString(address));
    return account?.balance ?? 0n;
  }

  async function tokenBalance(tokenAddr: `0x${string}`, address: `0x${string}`): Promise<bigint> {
    return read<bigint>(tokenAddr, PONS_TOKEN_ABI, 'balanceOf', [address]);
  }

  async function progressBps(curveAddr?: `0x${string}`): Promise<bigint> {
    const c = curveAddr ?? curve;
    const real = await read<bigint>(c, PONS_CURVE_ABI, 'realQuoteReserve');
    const threshold = await read<bigint>(c, PONS_CURVE_ABI, 'graduationThreshold');
    return (real * 10_000n) / threshold;
  }

  async function directBuy(curveAddr: `0x${string}`, buyer: `0x${string}`, ethAmount: bigint): Promise<bigint> {
    const data = encodeFunctionData({
      abi: PONS_CURVE_ABI,
      functionName: 'buy',
      args: [ethAmount, 0n, buyer],
    });
    const res = await call(curveAddr, data, { caller: buyer, value: ethAmount });
    if (res.execResult.exceptionError) {
      throw new Error(`direct buy failed: ${res.execResult.exceptionError.error} (revert ${revertSelector(res.execResult.returnValue)})`);
    }
    return decodeFunctionResult({ abi: PONS_CURVE_ABI, functionName: 'buy', data: hex(res.execResult.returnValue) }) as bigint;
  }

  async function setSnipeTax(startBps: bigint, seconds: bigint): Promise<void> {
    const data = encodeFunctionData({
      abi: PONS_FACTORY_STUB_ABI,
      functionName: 'setSnipeTax',
      args: [startBps, seconds],
    });
    const res = await call(stub, data);
    if (res.execResult.exceptionError) throw new Error('setSnipeTax failed');
  }

  async function deployCurvePair(opts: {
    pairToken?: `0x${string}`;
    name?: string;
    symbol?: string;
    register?: boolean;
    snipeTaxStartBps?: bigint;
    snipeTaxSeconds?: bigint;
  } = {}): Promise<{ curve: `0x${string}`; token: `0x${string}` }> {
    const pairToken = opts.pairToken ?? ('0x0000000000000000000000000000000000000000' as const);
    // Snipe-tax params are snapshotted by the curve at initialize(), so
    // set them on the stub first, then restore the disabled default.
    await setSnipeTax(opts.snipeTaxStartBps ?? 0n, opts.snipeTaxSeconds ?? 0n);
    const curveAddr = await deploy(PONS_CURVE_BYTECODE, [
      pairToken,
      deployer.address,
      stub,
      stub, // feePolicy (stub stands in; never exercised buy-side)
      {
        protocolFeeRecipient: deployer.address,
        protocolFeeShareBps: 3000,
        buybackBurnBps: 5000,
        hookFeeBps: 0,
        maxInternalPriceImpactBps: 300,
      },
      stub, // feeEscrow
      stub, // buybackVault
      PHANTOM_QUOTE,
      FEE_BPS,
      CREATOR_TAX_BPS,
      false, // buybackEnabled
      GRADUATION_THRESHOLD,
    ], PONS_CURVE_ABI);
    const tokenAddr = await deploy(PONS_TOKEN_BYTECODE, [
      opts.name ?? 'Test Real',
      opts.symbol ?? 'TREAL',
      '',
      '',
      { twitter: '', telegram: '', discord: '', website: '', farcaster: '' },
      deployer.address,
      curveAddr,
      stub,
      LAUNCH_SUPPLY,
    ], PONS_TOKEN_ABI);
    const initData = encodeFunctionData({
      abi: PONS_FACTORY_STUB_ABI,
      functionName: 'initializeCurve',
      args: [curveAddr, tokenAddr],
    });
    const initRes = await call(stub, initData);
    if (initRes.execResult.exceptionError) {
      throw new Error(`initializeCurve failed: ${initRes.execResult.exceptionError.error} (revert ${revertSelector(initRes.execResult.returnValue)})`);
    }
    await setSnipeTax(0n, 0n);
    if (opts.register !== false) {
      const regData = encodeFunctionData({
        abi: PONS_FACTORY_STUB_ABI,
        functionName: 'registerLaunch',
        args: [tokenAddr, curveAddr],
      });
      const regRes = await call(stub, regData);
      if (regRes.execResult.exceptionError) {
        throw new Error(`registerLaunch failed: ${regRes.execResult.exceptionError.error} (revert ${revertSelector(regRes.execResult.returnValue)})`);
      }
    }
    return { curve: curveAddr, token: tokenAddr };
  }

  async function deployLyingBuyCurve(tokenAddr: `0x${string}`, fundAmount: bigint): Promise<`0x${string}`> {
    const lying = await deploy(LYING_BUY_CURVE_BYTECODE, [tokenAddr], LYING_BUY_CURVE_ABI);
    // Fund it with tokens: buy some from the real curve first, then send.
    const realCurve = (await read<readonly unknown[]>(stub, PONS_FACTORY_STUB_ABI, 'getLaunchedToken', [tokenAddr])) as unknown as { curve: `0x${string}` };
    await directBuy(realCurve.curve, deployer.address, parseEther('0.5'));
    const fundData = encodeFunctionData({
      abi: PONS_TOKEN_ABI,
      functionName: 'transfer',
      args: [lying, fundAmount],
    });
    const fundRes = await call(tokenAddr, fundData, { caller: deployer.address });
    if (fundRes.execResult.exceptionError) throw new Error('funding LyingBuyCurve failed');
    // Point the factory registry at the lying curve (positive control:
    // the factory "knows" this curve, so the M-01 check passes and only
    // the balance-delta check stands between the buyer and the lie).
    const regData = encodeFunctionData({
      abi: PONS_FACTORY_STUB_ABI,
      functionName: 'registerLaunch',
      args: [tokenAddr, lying],
    });
    const regRes = await call(stub, regData);
    if (regRes.execResult.exceptionError) throw new Error('registering LyingBuyCurve failed');
    return lying;
  }

  async function registerCanonical(
    tokenAddr: `0x${string}`,
    symbol: string,
    opts: { launchedAt?: bigint; evidence?: `0x${string}` } = {},
  ): Promise<void> {
    const launchedAt = opts.launchedAt ?? now();
    const evidence = opts.evidence ?? ('0x' + '11'.repeat(32) as `0x${string}`);
    const propData = encodeFunctionData({
      abi: REGISTRY_ABI,
      functionName: 'proposeCanonical',
      args: [symbolHash(symbol), tokenAddr, launchedAt, evidence],
    });
    const propRes = await call(registry, propData, { caller: deployer.address });
    if (propRes.execResult.exceptionError) {
      throw new Error(`proposeCanonical failed: ${propRes.execResult.exceptionError.error} (revert ${revertSelector(propRes.execResult.returnValue)})`);
    }
    advanceTime(TIMELOCK_DELAY + 1n);
    const execData = encodeFunctionData({
      abi: REGISTRY_ABI,
      functionName: 'executeUpdate',
      args: [symbolHash(symbol)],
    });
    const execRes = await call(registry, execData, { caller: deployer.address });
    if (execRes.execResult.exceptionError) {
      throw new Error(`executeUpdate failed: ${execRes.execResult.exceptionError.error} (revert ${revertSelector(execRes.execResult.returnValue)})`);
    }
  }

  async function buyVerifiedRaw(
    buyer: `0x${string}`,
    tokenAddr: `0x${string}`,
    ethAmount: bigint,
    minTokensOut: bigint,
  ) {
    const data = encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: 'buyVerified',
      args: [tokenAddr, minTokensOut],
    });
    return call(router, data, { caller: buyer, value: ethAmount });
  }

  async function buyVerifiedBySymbolRaw(
    buyer: `0x${string}`,
    symbol: string,
    ethAmount: bigint,
    minTokensOut: bigint,
  ) {
    const data = encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: 'buyVerifiedBySymbol',
      args: [symbol, minTokensOut],
    });
    return call(router, data, { caller: buyer, value: ethAmount });
  }

  async function quoteBuy(curveAddr: `0x${string}`, quoteIn: bigint): Promise<bigint> {
    return read<bigint>(router, ROUTER_ABI, 'quoteBuy', [curveAddr, quoteIn]);
  }

  async function maxSpendFor(curveAddr: `0x${string}`): Promise<bigint> {
    return read<bigint>(router, ROUTER_ABI, 'maxSpendFor', [curveAddr]);
  }

  async function entryOf(symbol: string) {
    // viem decodes a struct return as an object with named fields.
    const raw = await read<{
      token: `0x${string}`;
      status: number;
      launchedAt: bigint;
      washSuspect: boolean;
      devDumped: boolean;
      evidenceHash: `0x${string}`;
      updatedAt: bigint;
    }>(registry, REGISTRY_ABI, 'getEntry', [symbolHash(symbol)]);
    return { ...raw };
  }

  // Deploy order: stub -> registry -> curve -> token -> router.
  const stub = await deploy(PONS_FACTORY_STUB_BYTECODE, [], PONS_FACTORY_STUB_ABI);
  const registry = await deploy(REGISTRY_BYTECODE, [], REGISTRY_ABI);
  const { curve, token } = await deployCurvePair();
  const router = await deploy(ROUTER_BYTECODE, [registry, deployer.address, stub], ROUTER_ABI);

  return {
    vm,
    deployer,
    user,
    keeper,
    attacker,
    stub,
    registry,
    router,
    curve,
    token,
    now,
    setTime,
    advanceTime,
    call,
    read,
    ethBalance,
    tokenBalance,
    progressBps,
    directBuy,
    deployCurvePair,
    deployLyingBuyCurve,
    registerCanonical,
    buyVerifiedRaw,
    buyVerifiedBySymbolRaw,
    quoteBuy,
    maxSpendFor,
    entryOf,
  };
}

/** Constant-product net quote for BUYING with `quoteIn` ETH, mirroring the curve's math. */
export async function expectedBuyTokens(
  env: TestEnv,
  curveAddr: `0x${string}`,
  quoteIn: bigint,
): Promise<bigint> {
  const [quoteReserve, tokenReserve] = await env.read<[bigint, bigint]>(
    curveAddr, PONS_CURVE_ABI, 'getReserves',
  );
  if (quoteReserve === 0n || tokenReserve === 0n || quoteIn === 0n) return 0n;
  const fee = (quoteIn * FEE_BPS) / 10_000n;
  const tax = (quoteIn * CREATOR_TAX_BPS) / 10_000n;
  if (fee + tax >= quoteIn) return 0n;
  const netIn = quoteIn - fee - tax;
  const tokensOut = (netIn * 10_000n * tokenReserve) / (quoteReserve * 10_000n + netIn * 10_000n);
  const sellable = await env.read<bigint>(curveAddr, PONS_CURVE_ABI, 'sellableTokens');
  return tokensOut > sellable ? sellable : tokensOut;
}

/** Exact ETH spend that buys the whole remaining sellable allocation (TS mirror of maxSpendFor). */
export async function expectedMaxSpend(env: TestEnv, curveAddr: `0x${string}`): Promise<bigint> {
  const sellable = await env.read<bigint>(curveAddr, PONS_CURVE_ABI, 'sellableTokens');
  if (sellable === 0n) return 0n;
  const [quoteReserve, tokenReserve] = await env.read<[bigint, bigint]>(
    curveAddr, PONS_CURVE_ABI, 'getReserves',
  );
  if (quoteReserve === 0n || tokenReserve <= sellable) return 0n;
  const net = (sellable * quoteReserve) / (tokenReserve - sellable) + 1n;
  const denom = 10_000n - FEE_BPS - CREATOR_TAX_BPS;
  return (net * 10_000n + denom - 1n) / denom;
}
