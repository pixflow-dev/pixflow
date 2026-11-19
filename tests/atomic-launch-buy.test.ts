/**
 * Atomic launch+buy proof.
 *
 * THE QUESTION: can one transaction through VerifiedBuyRouter both LAUNCH a
 * Pons token (via the factory) and BUY it — so a creator launches and takes
 * the initial buy atomically, ahead of snipers?
 *
 * THE SETUP: the real Pons factory/router/escrow do NOT exist on Robinhood
 * testnet, so this runs locally in the test VM against the REAL vendored
 * Pons factory suite (factory, launch deployer, meme hook, buyback vault,
 * launch locker, graduation executor, graduation guard, bonding curve,
 * launcher token — all real vendored source, compiled from
 * contracts/vendor/pons). The only test doubles are the suite's EXTERNAL
 * dependencies, which Pons does not ship: the Uniswap v4 singletons
 * (PoolManager / PositionManager / Permit2, stubbed — launch never calls
 * them) and the fee escrow (no implementation vendored; a faithful minimal
 * ledger — launch+buy never calls it either). Launch terms are the LIVE
 * MAINNET values, read from the real factory on 2026-11-19: launch fee
 * 0.0005 ETH, config 0 (1B supply, 100 bps curve fee, 1.68 ETH phantom,
 * 4.2 ETH graduation, poolFee 0, tickSpacing 200), snipe tax 9900 bps /
 * 3 seconds.
 *
 * THE CANONICAL DECISION (see also DESIGN.md): a token launched in the
 * same transaction is canonical-BY-CONSTRUCTION for that buy only — it did
 * not exist before this tx, so there is no clone to confuse it with. The
 * buy leg therefore skips the registry canonical check AND the snipe-tax
 * window check (a just-launched token is always inside the window), and
 * the launch does NOT write to the registry: the keeper must still observe
 * the token and register it (with the timelock) before anyone else can buy
 * it through buyVerified. Safety for the skipped window check comes from
 * the factory: the snipe tax is charged on the RECIPIENT, launchTokenFor
 * auto-exempts the originalDeployer (the caller), and the router VERIFIES
 * that exemption on-chain before buying — a factory behaviour change fails
 * closed with TaxWindow instead of executing a 99% taxed buy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVM, type VM } from '@ethereumjs/vm';
import { createCustomCommon, Hardfork, Mainnet } from '@ethereumjs/common';
import { Account, createAddressFromString, createZeroAddress, hexToBytes } from '@ethereumjs/util';
import type { Block } from '@ethereumjs/block';
import {
  decodeFunctionResult,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  parseEther,
  type Abi,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  PONS_CURVE_ABI,
  PONS_EXECUTOR_ABI,
  PONS_EXECUTOR_BYTECODE,
  PONS_FACTORY_ABI,
  PONS_FACTORY_BYTECODE,
  PONS_HOOK_ABI,
  PONS_HOOK_BYTECODE,
  PONS_LAUNCH_DEPLOYER_ABI,
  PONS_LAUNCH_DEPLOYER_BYTECODE,
  PONS_LOCKER_ABI,
  PONS_LOCKER_BYTECODE,
  PONS_TOKEN_ABI,
  PONS_VAULT_ABI,
  PONS_VAULT_BYTECODE,
  REGISTRY_ABI,
  REGISTRY_BYTECODE,
  ROUTER_ABI,
  ROUTER_BYTECODE,
  STUB_FEE_ESCROW_ABI,
  STUB_FEE_ESCROW_BYTECODE,
  STUB_PERMIT2_ABI,
  STUB_PERMIT2_BYTECODE,
  STUB_POOL_MANAGER_ABI,
  STUB_POOL_MANAGER_BYTECODE,
  STUB_POSITION_MANAGER_ABI,
  STUB_POSITION_MANAGER_BYTECODE,
} from '../src/contracts.js';
import {
  CHAIN_ID,
  GRADUATION_THRESHOLD,
  LAUNCH_SUPPLY,
  PHANTOM_QUOTE,
  T0,
  TIMELOCK_DELAY,
  errorSelector,
  hex,
  revertSelector,
  symbolHash,
} from './vm.js';

const GAS = 15_000_000n;
const ZERO = '0x0000000000000000000000000000000000000000' as const;
/** Mainnet launch fee, read live from the real factory 2026-11-19. */
const LAUNCH_FEE = parseEther('0.0005');
const BUY_VALUE = parseEther('0.05');
const CREATOR_TAX_BPS = 200;
const EMPTY_SOCIALS = { twitter: '', telegram: '', discord: '', website: '', farcaster: '' };
const ZERO_BYTES32 = ('0x' + '00'.repeat(32)) as `0x${string}`;

type Address = `0x${string}`;
type Account_ = ReturnType<typeof privateKeyToAccount>;

function salt(n: number): `0x${string}` {
  return ('0x' + n.toString(16).padStart(64, '0')) as `0x${string}`;
}

function launchParams(creator: Address, saltValue: `0x${string}`, overrides: Record<string, unknown> = {}) {
  return {
    name: 'Atomic Test',
    symbol: 'ATOM',
    logo: 'https://pixflow.example/logo.png',
    description: 'Atomic launch+buy proof token',
    socials: { ...EMPTY_SOCIALS },
    creatorFeeRecipient: creator,
    creatorTaxBps: CREATOR_TAX_BPS,
    buybackEnabled: false,
    expectedEconomics: ZERO_BYTES32,
    salt: saltValue,
    ...overrides,
  };
}

interface AtomicEnv {
  vm: VM;
  deployer: Account_;
  user: Account_;
  keeper: Account_;
  attacker: Account_;
  factory: Address;
  hook: Address;
  vault: Address;
  locker: Address;
  deployerContract: Address;
  executor: Address;
  escrow: Address;
  registry: Address;
  router: Address;
  /** Reference curve from a DIRECT factory launch (same config/tax) — the
   *  control for exact token-amount assertions: identical initial reserves
   *  to every atomic launch, readable BEFORE the atomic buy moves them. */
  refCurve: Address;
  refToken: Address;
  now: () => bigint;
  advanceTime: (seconds: bigint) => void;
  call: (
    to: Address | undefined,
    data: `0x${string}`,
    opts?: { caller?: Address; value?: bigint },
  ) => Promise<Awaited<ReturnType<VM['evm']['runCall']>>>;
  deploy: (bytecode: `0x${string}`, args: readonly unknown[], abi: Abi) => Promise<Address>;
  read: <T = unknown>(to: Address, abi: Abi, functionName: string, args?: readonly unknown[]) => Promise<T>;
  ethBalance: (address: Address) => Promise<bigint>;
  tokenBalance: (tokenAddr: Address, address: Address) => Promise<bigint>;
  getLaunchedToken: (tokenAddr: Address) => Promise<{
    token: Address;
    curve: Address;
    deployer: Address;
    creatorFeeRecipient: Address;
    pairToken: Address;
    graduationThreshold: bigint;
    poolFee: number;
    tickSpacing: number;
    creatorTaxBps: number;
    buybackEnabled: boolean;
    phase: number;
    sweptQuote: bigint;
    sweptTokens: bigint;
    sweptAt: bigint;
    exists: boolean;
  }>;
  launchAndBuyRaw: (
    buyer: Address,
    params: ReturnType<typeof launchParams>,
    opts?: {
      launchConfigId?: bigint;
      pairToken?: Address;
      exemptions?: Address[];
      minTokensOut?: bigint;
      value?: bigint;
      routerAddr?: Address;
    },
  ) => Promise<Awaited<ReturnType<VM['evm']['runCall']>>>;
  directBuy: (curveAddr: Address, buyer: Address, ethAmount: bigint) => Promise<bigint>;
  registerCanonical: (tokenAddr: Address, symbol: string) => Promise<void>;
  buyVerifiedRaw: (
    buyer: Address,
    tokenAddr: Address,
    ethAmount: bigint,
    minTokensOut: bigint,
  ) => Promise<Awaited<ReturnType<VM['evm']['runCall']>>>;
  entryStatus: (symbol: string) => Promise<number>;
}

/** Constant-product net quote, mirroring the curve's math (fee+tax only, no snipe tax). */
async function expectedTokensFromCurve(
  env: AtomicEnv,
  curveAddr: Address,
  quoteIn: bigint,
): Promise<bigint> {
  const [quoteReserve, tokenReserve] = await env.read<[bigint, bigint]>(
    curveAddr,
    PONS_CURVE_ABI,
    'getReserves',
  );
  if (quoteReserve === 0n || tokenReserve === 0n || quoteIn === 0n) return 0n;
  const fee = (quoteIn * 100n) / 10_000n;
  const tax = (quoteIn * BigInt(CREATOR_TAX_BPS)) / 10_000n;
  if (fee + tax >= quoteIn) return 0n;
  const netIn = quoteIn - fee - tax;
  const tokensOut = (netIn * 10_000n * tokenReserve) / (quoteReserve * 10_000n + netIn * 10_000n);
  const sellable = await env.read<bigint>(curveAddr, PONS_CURVE_ABI, 'sellableTokens');
  return tokensOut > sellable ? sellable : tokensOut;
}

async function createAtomicEnv(): Promise<AtomicEnv> {
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

  let currentTime = T0;
  let blockNumber = 0n;
  function currentBlock(): Block {
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
  function advanceTime(seconds: bigint): void {
    currentTime += seconds;
    blockNumber += 1n;
  }

  async function call(
    to: Address | undefined,
    data: `0x${string}`,
    opts: { caller?: Address; value?: bigint } = {},
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

  async function deploy(bytecode: `0x${string}`, args: readonly unknown[], abi: Abi): Promise<Address> {
    const data = encodeDeployData({ abi, bytecode, args });
    const res = await call(undefined, data);
    if (res.execResult.exceptionError) {
      throw new Error(
        `deploy failed: ${res.execResult.exceptionError.error} (revert ${revertSelector(res.execResult.returnValue)})`,
      );
    }
    if (!res.createdAddress) throw new Error('deploy produced no address');
    return getAddress(res.createdAddress.toString());
  }

  async function read<T>(to: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
    const data = encodeFunctionData({ abi, functionName, args });
    const res = await call(to, data);
    if (res.execResult.exceptionError) {
      throw new Error(`read ${functionName} failed: ${res.execResult.exceptionError.error}`);
    }
    return decodeFunctionResult({ abi, functionName, data: hex(res.execResult.returnValue) }) as T;
  }

  async function transact(
    to: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[],
    opts: { caller?: Address; value?: bigint } = {},
  ): Promise<Awaited<ReturnType<VM['evm']['runCall']>>> {
    const data = encodeFunctionData({ abi, functionName, args });
    const res = await call(to, data, opts);
    if (res.execResult.exceptionError) {
      throw new Error(
        `${functionName} failed: ${res.execResult.exceptionError.error} (revert ${revertSelector(res.execResult.returnValue)})`,
      );
    }
    return res;
  }

  async function ethBalance(address: Address): Promise<bigint> {
    const account = await vm.stateManager.getAccount(createAddressFromString(address));
    return account?.balance ?? 0n;
  }

  async function tokenBalance(tokenAddr: Address, address: Address): Promise<bigint> {
    return read<bigint>(tokenAddr, PONS_TOKEN_ABI, 'balanceOf', [address]);
  }

  // ---- Deploy the real Pons factory suite (+ minimal external stubs) ----
  // Order resolves the chicken-and-egg wiring: stubs -> hook/vault/locker
  // -> factory (ctor deploys the guard) -> setFactory x3 + setBuybackVault
  // -> deployer/executor -> factory wiring -> launch config -> router ->
  // launch forwarder.
  const poolManager = await deploy(STUB_POOL_MANAGER_BYTECODE, [], STUB_POOL_MANAGER_ABI);
  const positionManager = await deploy(
    STUB_POSITION_MANAGER_BYTECODE,
    [poolManager],
    STUB_POSITION_MANAGER_ABI,
  );
  const permit2 = await deploy(STUB_PERMIT2_BYTECODE, [], STUB_PERMIT2_ABI);
  const escrow = await deploy(STUB_FEE_ESCROW_BYTECODE, [], STUB_FEE_ESCROW_ABI);
  const hook = await deploy(
    PONS_HOOK_BYTECODE,
    [poolManager, escrow, deployer.address, deployer.address],
    PONS_HOOK_ABI,
  );
  const vault = await deploy(
    PONS_VAULT_BYTECODE,
    [deployer.address, hook, escrow],
    PONS_VAULT_ABI,
  );
  const locker = await deploy(
    PONS_LOCKER_BYTECODE,
    [deployer.address, positionManager],
    PONS_LOCKER_ABI,
  );
  const factory = await deploy(
    PONS_FACTORY_BYTECODE,
    [
      deployer.address,
      poolManager,
      positionManager,
      permit2,
      locker,
      hook,
      escrow,
      vault,
      LAUNCH_FEE,
    ],
    PONS_FACTORY_ABI,
  );
  await transact(hook, PONS_HOOK_ABI, 'setFactory', [factory]);
  await transact(hook, PONS_HOOK_ABI, 'setBuybackVault', [vault]);
  await transact(vault, PONS_VAULT_ABI, 'setFactory', [factory]);
  await transact(locker, PONS_LOCKER_ABI, 'setFactory', [factory]);
  const deployerContract = await deploy(PONS_LAUNCH_DEPLOYER_BYTECODE, [factory], PONS_LAUNCH_DEPLOYER_ABI);
  const executor = await deploy(
    PONS_EXECUTOR_BYTECODE,
    [positionManager, permit2, locker, factory],
    PONS_EXECUTOR_ABI,
  );
  await transact(factory, PONS_FACTORY_ABI, 'setGraduationExecutor', [executor]);
  await transact(factory, PONS_FACTORY_ABI, 'setLaunchDeployer', [deployerContract]);
  // Mainnet launch config 0, read live 2026-11-19.
  await transact(factory, PONS_FACTORY_ABI, 'addLaunchConfig', [
    {
      supply: LAUNCH_SUPPLY,
      curveFeeBps: 100n,
      phantomQuote: PHANTOM_QUOTE,
      graduationThreshold: GRADUATION_THRESHOLD,
      poolFee: 0,
      tickSpacing: 200,
      enabled: true,
    },
  ]);
  await transact(factory, PONS_FACTORY_ABI, 'setLaunchEnabled', [true]);
  await transact(factory, PONS_FACTORY_ABI, 'setSnipeTaxStartBps', [9900n]);
  await transact(factory, PONS_FACTORY_ABI, 'setSnipeTaxSeconds', [3n]);

  const registry = await deploy(REGISTRY_BYTECODE, [], REGISTRY_ABI);
  const router = await deploy(
    ROUTER_BYTECODE,
    [registry, deployer.address, factory],
    ROUTER_ABI,
  );
  await transact(factory, PONS_FACTORY_ABI, 'setLaunchForwarder', [router]);

  // ---- Reference launch (direct, for exact-amount assertions) ----
  // launchToken is overloaded; disambiguate with the full signature.
  const refParams = launchParams(deployer.address, salt(900), {
    name: 'Reference Token',
    symbol: 'REF',
  });
  const refData = encodeFunctionData({
    abi: PONS_FACTORY_ABI,
    functionName: 'launchToken',
    args: [refParams, 0n, ZERO],
  });
  const refRes = await call(factory, refData, { caller: deployer.address, value: LAUNCH_FEE });
  if (refRes.execResult.exceptionError) {
    throw new Error(
      `reference launch failed: ${refRes.execResult.exceptionError.error} (revert ${revertSelector(refRes.execResult.returnValue)})`,
    );
  }
  const [refToken, refCurve] = decodeFunctionResult({
    abi: PONS_FACTORY_ABI,
    functionName: 'launchToken',
    data: hex(refRes.execResult.returnValue),
  }) as [Address, Address];

  async function getLaunchedToken(tokenAddr: Address) {
    return read<AtomicEnv['getLaunchedToken'] extends (...args: never[]) => Promise<infer R> ? R : never>(
      factory,
      PONS_FACTORY_ABI,
      'getLaunchedToken',
      [tokenAddr],
    );
  }

  async function launchAndBuyRaw(
    buyer: Address,
    params: ReturnType<typeof launchParams>,
    opts: {
      launchConfigId?: bigint;
      pairToken?: Address;
      exemptions?: Address[];
      minTokensOut?: bigint;
      value?: bigint;
      routerAddr?: Address;
    } = {},
  ) {
    const data = encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: 'launchAndBuy',
      args: [
        params,
        opts.launchConfigId ?? 0n,
        opts.pairToken ?? ZERO,
        opts.exemptions ?? [],
        opts.minTokensOut ?? 0n,
      ],
    });
    return call(opts.routerAddr ?? router, data, {
      caller: buyer,
      value: opts.value ?? LAUNCH_FEE + BUY_VALUE,
    });
  }

  async function directBuy(curveAddr: Address, buyer: Address, ethAmount: bigint): Promise<bigint> {
    const data = encodeFunctionData({
      abi: PONS_CURVE_ABI,
      functionName: 'buy',
      args: [ethAmount, 0n, buyer],
    });
    const res = await call(curveAddr, data, { caller: buyer, value: ethAmount });
    if (res.execResult.exceptionError) {
      throw new Error(
        `direct buy failed: ${res.execResult.exceptionError.error} (revert ${revertSelector(res.execResult.returnValue)})`,
      );
    }
    return decodeFunctionResult({
      abi: PONS_CURVE_ABI,
      functionName: 'buy',
      data: hex(res.execResult.returnValue),
    }) as bigint;
  }

  async function registerCanonical(tokenAddr: Address, symbol: string): Promise<void> {
    const evidence = ('0x' + '11'.repeat(32)) as `0x${string}`;
    await transact(registry, REGISTRY_ABI, 'proposeCanonical', [
      symbolHash(symbol),
      tokenAddr,
      now(),
      evidence,
    ]);
    advanceTime(TIMELOCK_DELAY + 1n);
    await transact(registry, REGISTRY_ABI, 'executeUpdate', [symbolHash(symbol)]);
  }

  async function buyVerifiedRaw(buyer: Address, tokenAddr: Address, ethAmount: bigint, minTokensOut: bigint) {
    const data = encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: 'buyVerified',
      args: [tokenAddr, minTokensOut],
    });
    return call(router, data, { caller: buyer, value: ethAmount });
  }

  async function entryStatus(symbol: string): Promise<number> {
    const entry = await read<{ status: number }>(registry, REGISTRY_ABI, 'getEntry', [symbolHash(symbol)]);
    return entry.status;
  }

  return {
    vm,
    deployer,
    user,
    keeper,
    attacker,
    factory,
    hook,
    vault,
    locker,
    deployerContract,
    executor,
    escrow,
    registry,
    router,
    refCurve,
    refToken,
    now,
    advanceTime,
    call,
    deploy,
    read,
    ethBalance,
    tokenBalance,
    getLaunchedToken,
    launchAndBuyRaw,
    directBuy,
    registerCanonical,
    buyVerifiedRaw,
    entryStatus,
  };
}

function decodeLaunchAndBuy(env: AtomicEnv, res: Awaited<ReturnType<AtomicEnv['call']>>) {
  assert.equal(res.execResult.exceptionError, undefined);
  return decodeFunctionResult({
    abi: ROUTER_ABI,
    functionName: 'launchAndBuy',
    data: hex(res.execResult.returnValue),
  }) as [Address, Address, bigint];
}

test('launchAndBuy launches a real Pons token and buys it in one transaction', async () => {
  const env = await createAtomicEnv();
  const params = launchParams(env.user.address, salt(1));

  // Exact expectation from the reference curve's identical initial reserves:
  // the buy leg is 0.05 ETH minus the 0.3% router fee, priced with fee+tax
  // only — NO snipe tax, even though the buy lands in the launch second.
  const buyFee = (BUY_VALUE * 30n) / 10_000n;
  const expected = await expectedTokensFromCurve(env, env.refCurve, BUY_VALUE - buyFee);
  assert.ok(expected > 0n, 'reference quote must be positive');

  const res = await env.launchAndBuyRaw(env.user.address, params);
  const [token, curve, received] = decodeLaunchAndBuy(env, res);

  // The launch leg: a real factory-registered token+curve pair.
  const launch = await env.getLaunchedToken(token);
  assert.equal(launch.exists, true);
  assert.equal(launch.curve, curve);
  assert.equal(launch.deployer, env.user.address);
  assert.equal(launch.creatorFeeRecipient, env.user.address);
  assert.equal(launch.pairToken, ZERO);
  assert.equal(launch.creatorTaxBps, CREATOR_TAX_BPS);
  const symbol = await env.read<string>(token, PONS_TOKEN_ABI, 'symbol');
  const name = await env.read<string>(token, PONS_TOKEN_ABI, 'name');
  assert.equal(symbol, 'ATOM');
  assert.equal(name, 'Atomic Test');
  const totalSupply = await env.read<bigint>(token, PONS_TOKEN_ABI, 'totalSupply');
  assert.equal(totalSupply, LAUNCH_SUPPLY);

  // The buy leg: tokens straight to the buyer, EXACTLY the tax-free amount
  // — the snipe tax did not touch the atomic buy.
  assert.equal(received, expected);
  assert.equal(await env.tokenBalance(token, env.user.address), received);
  assert.equal(await env.tokenBalance(token, env.router), 0n);

  // Why it worked: the factory auto-exempted the originalDeployer, and the
  // window was live for everyone else at this same timestamp.
  assert.equal(await env.read<boolean>(curve, PONS_CURVE_ABI, 'snipeTaxExempt', [env.user.address]), true);
  assert.equal(await env.read<bigint>(curve, PONS_CURVE_ABI, 'currentSnipeTaxBps', [env.user.address]), 0n);
  assert.equal(
    await env.read<bigint>(curve, PONS_CURVE_ABI, 'currentSnipeTaxBps', [env.attacker.address]),
    9900n,
  );
});

test('launch fee is forwarded exactly; the 0.3% fee applies to the buy leg only', async () => {
  const env = await createAtomicEnv();
  const params = launchParams(env.user.address, salt(1));

  const deployerBefore = await env.ethBalance(env.deployer.address);
  const userBefore = await env.ethBalance(env.user.address);
  const res = await env.launchAndBuyRaw(env.user.address, params);
  decodeLaunchAndBuy(env, res);

  // The 0.0005 ETH launch fee went to the protocol fee recipient (deployer),
  // to the wei — the router kept none of it.
  assert.equal(await env.ethBalance(env.deployer.address), deployerBefore + LAUNCH_FEE);
  // The buyer spent exactly launch fee + buy value: no refund was due
  // (spend == net) and nothing stranded.
  assert.equal(await env.ethBalance(env.user.address), userBefore - LAUNCH_FEE - BUY_VALUE);
  // The router fee is 0.3% of the 0.05 ETH BUY leg (0.00015 ETH) — NOT
  // 0.3% of the 0.0505 ETH total (which would be 0.0001515 ETH).
  const expectedFee = (BUY_VALUE * 30n) / 10_000n;
  assert.equal(expectedFee, parseEther('0.00015'));
  assert.equal(await env.read<bigint>(env.router, ROUTER_ABI, 'feesOwed', [env.deployer.address]), expectedFee);
  assert.equal(await env.ethBalance(env.router), expectedFee);
});

test('the launched token is NOT canonical until the keeper registers it', async () => {
  const env = await createAtomicEnv();
  const params = launchParams(env.user.address, salt(1));
  const res = await env.launchAndBuyRaw(env.user.address, params);
  const [token] = decodeLaunchAndBuy(env, res);

  // The launch wrote NOTHING to the registry: status stays UNRESOLVED (0).
  assert.equal(await env.entryStatus('ATOM'), 0);

  // So nobody else can buy it through buyVerified yet — NotCanonical.
  const blocked = await env.buyVerifiedRaw(env.attacker.address, token, parseEther('0.01'), 0n);
  assert.ok(blocked.execResult.exceptionError, 'buyVerified must revert before registration');
  assert.equal(revertSelector(blocked.execResult.returnValue), errorSelector('NotCanonical()'));

  // The keeper observes the launch and registers it (1h timelock); the
  // window has also passed by then, so buyVerified works.
  await env.registerCanonical(token, 'ATOM');
  assert.equal(await env.entryStatus('ATOM'), 1);
  const ok = await env.buyVerifiedRaw(env.attacker.address, token, parseEther('0.01'), 0n);
  assert.equal(ok.execResult.exceptionError, undefined);
  assert.ok((await env.tokenBalance(token, env.attacker.address)) > 0n);
});

test('a sniper buying in the launch second loses ~99% to the snipe tax', async () => {
  const env = await createAtomicEnv();
  const params = launchParams(env.user.address, salt(1));
  const res = await env.launchAndBuyRaw(env.user.address, params);
  const [, curve] = decodeLaunchAndBuy(env, res);

  // Same timestamp as the launch (time never advanced): the window is live.
  assert.equal(await env.read<bigint>(curve, PONS_CURVE_ABI, 'currentSnipeTaxBps', [env.attacker.address]), 9900n);
  const taxFree = await expectedTokensFromCurve(env, curve, parseEther('0.05'));
  const sniperReceived = await env.directBuy(curve, env.attacker.address, parseEther('0.05'));
  // The snipe tax is capped so the buyer keeps 1% of the input leg (after
  // the 1% fee + 2% creator tax); the sniper gets ~1% of the tax-free
  // amount. This is what the atomic buy avoids.
  assert.ok(sniperReceived > 0n, 'sniper buy executes, it is just taxed');
  assert.ok(sniperReceived * 100n < taxFree * 3n, `sniper got ${sniperReceived} of ${taxFree} tax-free`);
});

test('launchAndBuy honours a pinned economics digest and rejects a wrong one', async () => {
  const env = await createAtomicEnv();
  const digest = await env.read<`0x${string}`>(
    env.factory,
    PONS_FACTORY_ABI,
    'previewLaunchEconomics',
    [0n, ZERO],
  );
  // Pinned correctly: succeeds.
  const good = await env.launchAndBuyRaw(
    env.user.address,
    launchParams(env.user.address, salt(1), { expectedEconomics: digest }),
  );
  decodeLaunchAndBuy(env, good);

  // Pinned wrong: the factory's economics check reverts the whole tx.
  const bad = await env.launchAndBuyRaw(
    env.user.address,
    launchParams(env.user.address, salt(2), { expectedEconomics: ('0x' + '01'.repeat(32)) as `0x${string}` }),
  );
  assert.ok(bad.execResult.exceptionError, 'wrong economics pin must revert');
  assert.equal(
    revertSelector(bad.execResult.returnValue),
    errorSelector('LaunchEconomicsMismatch(bytes32,bytes32)'),
  );
});

test('launchAndBuy reverts when the router is not the launch forwarder', async () => {
  const env = await createAtomicEnv();
  // A second router pointed at the same factory — the factory's
  // launchForwarder is the FIRST router, so this one is untrusted.
  const otherRouter = await env.deploy(
    ROUTER_BYTECODE,
    [env.registry, env.deployer.address, env.factory],
    ROUTER_ABI,
  );
  const res = await env.launchAndBuyRaw(env.user.address, launchParams(env.user.address, salt(1)), {
    routerAddr: otherRouter,
  });
  assert.ok(res.execResult.exceptionError, 'untrusted router must revert');
  assert.equal(revertSelector(res.execResult.returnValue), errorSelector('NotLaunchForwarder()'));
});

test('launchAndBuy reverts InsufficientBuyValue when msg.value covers only the launch fee', async () => {
  const env = await createAtomicEnv();
  const exact = await env.launchAndBuyRaw(env.user.address, launchParams(env.user.address, salt(1)), {
    value: LAUNCH_FEE,
  });
  assert.ok(exact.execResult.exceptionError, 'launch fee alone must revert');
  assert.equal(revertSelector(exact.execResult.returnValue), errorSelector('InsufficientBuyValue()'));

  const short = await env.launchAndBuyRaw(env.user.address, launchParams(env.user.address, salt(2)), {
    value: LAUNCH_FEE - 1n,
  });
  assert.ok(short.execResult.exceptionError, 'less than the launch fee must revert');
  assert.equal(revertSelector(short.execResult.returnValue), errorSelector('InsufficientBuyValue()'));
});

test('launchAndBuy reverts NonNativeQuote for an ERC-20 pair token', async () => {
  const env = await createAtomicEnv();
  const res = await env.launchAndBuyRaw(env.user.address, launchParams(env.user.address, salt(1)), {
    pairToken: env.refToken,
  });
  assert.ok(res.execResult.exceptionError, 'ERC-20 quote must revert');
  assert.equal(revertSelector(res.execResult.returnValue), errorSelector('NonNativeQuote()'));
});

test('snipe-tax exemptions are forwarded to the curve', async () => {
  const env = await createAtomicEnv();
  const res = await env.launchAndBuyRaw(env.user.address, launchParams(env.user.address, salt(1)), {
    exemptions: [env.attacker.address],
  });
  const [, curve] = decodeLaunchAndBuy(env, res);
  // The bundle wallet is exempt from the first second, like the creator.
  assert.equal(
    await env.read<boolean>(curve, PONS_CURVE_ABI, 'snipeTaxExempt', [env.attacker.address]),
    true,
  );
  assert.equal(await env.read<bigint>(curve, PONS_CURVE_ABI, 'currentSnipeTaxBps', [env.attacker.address]), 0n);
  // ...and a non-exempt bystander still faces the full 99%.
  assert.equal(
    await env.read<bigint>(curve, PONS_CURVE_ABI, 'currentSnipeTaxBps', [env.keeper.address]),
    9900n,
  );
});

test('reusing a salt reverts with FailedDeployment', async () => {
  const env = await createAtomicEnv();
  const params = launchParams(env.user.address, salt(1));
  const first = await env.launchAndBuyRaw(env.user.address, params);
  const [token] = decodeLaunchAndBuy(env, first);
  const balanceBefore = await env.tokenBalance(token, env.user.address);

  const second = await env.launchAndBuyRaw(env.user.address, params);
  assert.ok(second.execResult.exceptionError, 'salt reuse must revert');
  assert.equal(revertSelector(second.execResult.returnValue), errorSelector('FailedDeployment()'));
  // The failed second launch changed nothing about the first.
  assert.equal(await env.tokenBalance(token, env.user.address), balanceBefore);
  assert.equal((await env.getLaunchedToken(token)).exists, true);
});

test('a failed buy rolls the launch back: retrying with the same salt succeeds', async () => {
  const env = await createAtomicEnv();
  const params = launchParams(env.user.address, salt(1));
  // Impossible slippage bound: the buy cannot deliver the whole supply.
  const failed = await env.launchAndBuyRaw(env.user.address, params, { minTokensOut: LAUNCH_SUPPLY });
  assert.ok(failed.execResult.exceptionError, 'impossible minTokensOut must revert');

  // If the launch had persisted, this retry would revert FailedDeployment
  // (same salt, same params, same originalDeployer). It succeeds — the
  // failed tx left no trace. Launch and buy are truly atomic.
  const retry = await env.launchAndBuyRaw(env.user.address, params, { minTokensOut: 0n });
  const [token, curve, received] = decodeLaunchAndBuy(env, retry);
  assert.equal((await env.getLaunchedToken(token)).exists, true);
  assert.ok(received > 0n);
  assert.equal(await env.tokenBalance(token, env.user.address), received);
  assert.ok(curve !== ZERO);
});
