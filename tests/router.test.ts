/**
 * VerifiedBuyRouter tests — happy-path buy math (exact to the wei), every
 * revert reason, the M-01 fake-curve rejection, the balance-delta defense
 * against a lying curve, the spend cap / partial-fill path, the snipe-tax
 * window, and pull-based fees.
 *
 * Setup per test: fresh env + the default token registered as canonical
 * for 'TREAL' (propose + 1h timelock + execute, via env.registerCanonical).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeFunctionResult,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  parseEther,
  type Abi,
} from 'viem';
import {
  createEnv,
  errorSelector,
  expectedBuyTokens,
  expectedMaxSpend,
  hex,
  revertSelector,
  symbolHash,
  SNIPE_TAX_SECONDS,
  SNIPE_TAX_START_BPS,
  TIMELOCK_DELAY,
  type TestEnv,
} from './vm.js';
import {
  PONS_CURVE_ABI,
  PONS_TOKEN_ABI,
  REENTRANT_BUYER_ABI,
  REENTRANT_BUYER_BYTECODE,
  REGISTRY_ABI,
  ROUTER_ABI,
  ROUTER_BYTECODE,
} from '../src/contracts.js';

const EVIDENCE = ('0x' + '44'.repeat(32)) as `0x${string}`;
const ZERO = '0x0000000000000000000000000000000000000000' as const;

type CallResult = Awaited<ReturnType<TestEnv['call']>>;

function expectRevert(res: CallResult, signature: string): void {
  assert.ok(res.execResult.exceptionError, `expected revert ${signature}, call succeeded`);
  assert.equal(revertSelector(res.execResult.returnValue), errorSelector(signature));
}

function decodeBuy(res: CallResult): bigint {
  assert.ok(!res.execResult.exceptionError, `buy failed: ${res.execResult.exceptionError?.error}`);
  return decodeFunctionResult({
    abi: ROUTER_ABI,
    functionName: 'buyVerified',
    data: hex(res.execResult.returnValue),
  }) as bigint;
}

describe('VerifiedBuyRouter', () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createEnv();
    await env.registerCanonical(env.token, 'TREAL');
  });

  async function routerCall(
    functionName: string,
    args: readonly unknown[],
    caller: `0x${string}`,
    value = 0n,
  ) {
    const data = encodeFunctionData({ abi: ROUTER_ABI as Abi, functionName, args });
    return env.call(env.router, data, { caller, value });
  }

  async function registryCall(
    functionName: string,
    args: readonly unknown[],
    caller: `0x${string}`,
  ) {
    const data = encodeFunctionData({ abi: REGISTRY_ABI as Abi, functionName, args });
    return env.call(env.registry, data, { caller });
  }

  describe('deployment', () => {
    it('owner / registry / factory / feeRecipient are set', async () => {
      assert.equal(await env.read<string>(env.router, ROUTER_ABI, 'owner'), env.deployer.address);
      assert.equal(await env.read<string>(env.router, ROUTER_ABI, 'registry'), env.registry);
      assert.equal(await env.read<string>(env.router, ROUTER_ABI, 'ponsFactory'), env.stub);
      assert.equal(await env.read<string>(env.router, ROUTER_ABI, 'feeRecipient'), env.deployer.address);
      assert.equal(await env.read<bigint>(env.router, ROUTER_ABI, 'FEE_BPS'), 30n);
    });

    it('constructor reverts on zero registry / factory / feeRecipient', async () => {
      const cases: Array<readonly [`0x${string}`, `0x${string}`, `0x${string}`]> = [
        [ZERO, env.deployer.address, env.stub],
        [env.registry, ZERO, env.stub],
        [env.registry, env.deployer.address, ZERO],
      ];
      for (const args of cases) {
        const data = encodeDeployData({ abi: ROUTER_ABI, bytecode: ROUTER_BYTECODE, args });
        const res = await env.call(undefined, data);
        expectRevert(res, 'ZeroAddress()');
      }
    });

    it('constructor reverts when registry / factory has no code', async () => {
      const cases: Array<readonly [`0x${string}`, `0x${string}`, `0x${string}`]> = [
        [env.attacker.address, env.deployer.address, env.stub],
        [env.registry, env.deployer.address, env.attacker.address],
      ];
      for (const args of cases) {
        const data = encodeDeployData({ abi: ROUTER_ABI, bytecode: ROUTER_BYTECODE, args });
        const res = await env.call(undefined, data);
        expectRevert(res, 'ZeroAddress()');
      }
    });
  });

  describe('view helpers', () => {
    it('quoteBuy matches the TS mirror math exactly', async () => {
      for (const amount of [parseEther('0.001'), parseEther('0.1'), parseEther('1'), parseEther('3')]) {
        const onChain = await env.quoteBuy(env.curve, amount);
        const expected = await expectedBuyTokens(env, env.curve, amount);
        assert.equal(onChain, expected, `quoteBuy mismatch at ${amount}`);
        assert.ok(onChain > 0n);
      }
    });

    it('quoteBuy returns 0 for a zero input', async () => {
      assert.equal(await env.quoteBuy(env.curve, 0n), 0n);
    });

    it('maxSpendFor matches the TS mirror math exactly', async () => {
      const onChain = await env.maxSpendFor(env.curve);
      const expected = await expectedMaxSpend(env, env.curve);
      assert.equal(onChain, expected);
      assert.ok(onChain > 0n);
      // The cap is ~the graduation threshold grossed up for fee+tax.
      assert.ok(onChain > parseEther('4.2'));
      assert.ok(onChain < parseEther('4.4'));
    });
  });

  describe('happy-path buy (exact fee math)', () => {
    it('buyVerified delivers exactly the quoted tokens, fee exactly 0.3%', async () => {
      const value = parseEther('0.1');
      const fee = (value * 30n) / 10_000n; // 0.0003 ETH
      const net = value - fee;
      const expected = await expectedBuyTokens(env, env.curve, net);

      const ethBefore = await env.ethBalance(env.user.address);
      const progressBefore = await env.progressBps();
      const res = await env.buyVerifiedRaw(env.user.address, env.token, value, 0n);
      const received = decodeBuy(res);

      assert.equal(received, expected, 'tokens received != TS mirror quote');
      assert.equal(await env.tokenBalance(env.token, env.user.address), expected);
      // Buyer spent exactly msg.value — no refund on a normal (uncapped) buy.
      assert.equal(ethBefore - (await env.ethBalance(env.user.address)), value);
      // Fee accrued exactly, to the wei; router holds exactly the fee.
      assert.equal(await env.read<bigint>(env.router, ROUTER_ABI, 'feesOwed', [env.deployer.address]), fee);
      assert.equal(await env.ethBalance(env.router), fee);
      // Progress moved up.
      assert.ok((await env.progressBps()) > progressBefore);
    });

    it('buyVerified with minTokensOut == exact quote succeeds; +1 reverts', async () => {
      const value = parseEther('0.1');
      const net = value - (value * 30n) / 10_000n;
      const expected = await expectedBuyTokens(env, env.curve, net);

      const ok = await env.buyVerifiedRaw(env.user.address, env.token, value, expected);
      assert.ok(!ok.execResult.exceptionError, 'buy at exact quote should succeed');

      // Second buy: fresh quote, then ask for one token more.
      const expected2 = await expectedBuyTokens(env, env.curve, net);
      const ethBefore = await env.ethBalance(env.user.address);
      const tokensBefore = await env.tokenBalance(env.token, env.user.address);
      const bad = await env.buyVerifiedRaw(env.user.address, env.token, value, expected2 + 1n);
      expectRevert(bad, 'SlippageExceeded(uint256,uint256)');
      // Failed buy moves nothing.
      assert.equal(await env.ethBalance(env.user.address), ethBefore);
      assert.equal(await env.tokenBalance(env.token, env.user.address), tokensBefore);
    });

    it('dust buy: fee rounds DOWN to 0, buy still executes', async () => {
      const value = 100n; // 100 wei: fee = 100*30/10000 = 0
      const expected = await expectedBuyTokens(env, env.curve, value);
      assert.ok(expected > 0n);
      const res = await env.buyVerifiedRaw(env.user.address, env.token, value, 0n);
      assert.equal(decodeBuy(res), expected);
      assert.equal(await env.read<bigint>(env.router, ROUTER_ABI, 'feesOwed', [env.deployer.address]), 0n);
      assert.equal(await env.ethBalance(env.router), 0n);
    });

    it('buyVerifiedBySymbol resolves the canonical token and buys it', async () => {
      const value = parseEther('0.1');
      const net = value - (value * 30n) / 10_000n;
      const expected = await expectedBuyTokens(env, env.curve, net);
      const res = await env.buyVerifiedBySymbolRaw(env.user.address, 'TREAL', value, 0n);
      assert.ok(!res.execResult.exceptionError, 'buy by symbol failed');
      const received = decodeFunctionResult({
        abi: ROUTER_ABI,
        functionName: 'buyVerifiedBySymbol',
        data: hex(res.execResult.returnValue),
      }) as bigint;
      assert.equal(received, expected);
      assert.equal(await env.tokenBalance(env.token, env.user.address), expected);
    });

    it('buyVerifiedBySymbol is case-sensitive (lowercase symbol reverts)', async () => {
      const res = await env.buyVerifiedBySymbolRaw(env.user.address, 'treal', parseEther('0.1'), 0n);
      expectRevert(res, 'NotCanonical()');
    });

    it('buyVerifiedBySymbol with an unknown symbol reverts NotCanonical', async () => {
      const res = await env.buyVerifiedBySymbolRaw(env.user.address, 'NOPE', parseEther('0.1'), 0n);
      expectRevert(res, 'NotCanonical()');
    });
  });

  describe('revert reasons', () => {
    it('zero value reverts ZeroAmount', async () => {
      const res = await env.buyVerifiedRaw(env.user.address, env.token, 0n, 0n);
      expectRevert(res, 'ZeroAmount()');
    });

    it('EOA as token reverts InvalidToken', async () => {
      const res = await env.buyVerifiedRaw(env.user.address, env.attacker.address, parseEther('0.1'), 0n);
      expectRevert(res, 'InvalidToken()');
    });

    it('unregistered token (factory has no record) reverts NotLaunched — M-01', async () => {
      const { token: unregistered } = await env.deployCurvePair({
        symbol: 'GHOST',
        name: 'Ghost',
        register: false,
      });
      // Even a registry entry cannot save a token the factory never launched:
      // register it as canonical for GHOST, then buy — the factory check fires first.
      await env.registerCanonical(unregistered, 'GHOST');
      const res = await env.buyVerifiedRaw(env.user.address, unregistered, parseEther('0.1'), 0n);
      expectRevert(res, 'NotLaunched()');
    });

    it('clone with the same symbol reverts NotCanonical', async () => {
      const { token: clone } = await env.deployCurvePair({ symbol: 'TREAL', name: 'Test Real Clone' });
      const res = await env.buyVerifiedRaw(env.user.address, clone, parseEther('0.1'), 0n);
      expectRevert(res, 'NotCanonical()');
      // And the clone cannot be bought by symbol either — the symbol resolves to the original.
      const bySymbol = await env.buyVerifiedBySymbolRaw(env.user.address, 'TREAL', parseEther('0.1'), 0n);
      assert.ok(!bySymbol.execResult.exceptionError, 'symbol buy should hit the ORIGINAL');
      assert.equal(await env.tokenBalance(env.token, env.user.address) > 0n, true);
      assert.equal(await env.tokenBalance(clone, env.user.address), 0n);
    });

    it('launched but unregistered symbol reverts NotCanonical', async () => {
      const { token: other } = await env.deployCurvePair({ symbol: 'OTHER', name: 'Other' });
      const res = await env.buyVerifiedRaw(env.user.address, other, parseEther('0.1'), 0n);
      expectRevert(res, 'NotCanonical()');
    });

    it('registry entry pointing at a token with a DIFFERENT symbol reverts NotCanonical', async () => {
      // Keeper error (or malice): register tokenB (symbol OTHER) as the
      // canonical for hash('TREAL'). The router re-derives the key from
      // the token's OWN symbol(), so the mismatch is caught.
      const { token: other } = await env.deployCurvePair({ symbol: 'OTHER', name: 'Other' });
      const prop = await registryCall(
        'proposeCanonical',
        [symbolHash('TREAL'), other, env.now(), EVIDENCE],
        env.deployer.address,
      );
      assert.ok(!prop.execResult.exceptionError, 'propose failed');
      env.advanceTime(TIMELOCK_DELAY + 1n);
      await registryCall('executeUpdate', [symbolHash('TREAL')], env.deployer.address);
      const res = await env.buyVerifiedRaw(env.user.address, other, parseEther('0.1'), 0n);
      expectRevert(res, 'NotCanonical()');
      const bySymbol = await env.buyVerifiedBySymbolRaw(env.user.address, 'TREAL', parseEther('0.1'), 0n);
      expectRevert(bySymbol, 'NotCanonical()');
    });

    it('contested symbol reverts Contested (both entry points)', async () => {
      await registryCall('contest', [symbolHash('TREAL'), EVIDENCE], env.deployer.address);
      expectRevert(
        await env.buyVerifiedRaw(env.user.address, env.token, parseEther('0.1'), 0n),
        'Contested()',
      );
      expectRevert(
        await env.buyVerifiedBySymbolRaw(env.user.address, 'TREAL', parseEther('0.1'), 0n),
        'Contested()',
      );
    });

    it('wash flag reverts WashSuspect', async () => {
      await registryCall('flagWash', [symbolHash('TREAL'), EVIDENCE], env.deployer.address);
      expectRevert(
        await env.buyVerifiedRaw(env.user.address, env.token, parseEther('0.1'), 0n),
        'WashSuspect()',
      );
    });

    it('dev-dump flag reverts DevDumped', async () => {
      await registryCall('flagDevDump', [symbolHash('TREAL'), EVIDENCE], env.deployer.address);
      expectRevert(
        await env.buyVerifiedRaw(env.user.address, env.token, parseEther('0.1'), 0n),
        'DevDumped()',
      );
    });

    it('non-native quote curve reverts NonNativeQuote', async () => {
      // A curve quoting in an ERC-20 (here: the default token itself as the
      // quote asset — only the pairToken address matters for the check).
      const { token: quoted } = await env.deployCurvePair({
        symbol: 'QUOTED',
        name: 'Quoted',
        pairToken: env.token,
      });
      await env.registerCanonical(quoted, 'QUOTED');
      const res = await env.buyVerifiedRaw(env.user.address, quoted, parseEther('0.1'), 0n);
      expectRevert(res, 'NonNativeQuote()');
    });
  });

  describe('snipe-tax window', () => {
    it('buy inside the window reverts TaxWindow; after the window it succeeds', async () => {
      // A 2-hour window (not 3s) so the 1h registry timelock does not eat
      // the window before the test can observe the revert — the check is
      // `launchedAt + snipeTaxSeconds`, identical logic at any window.
      const { curve, token } = await env.deployCurvePair({
        symbol: 'TAXED',
        name: 'Taxed',
        snipeTaxStartBps: SNIPE_TAX_START_BPS,
        snipeTaxSeconds: 7200n,
      });
      const launchedAt = await env.read<bigint>(curve, PONS_CURVE_ABI, 'launchedAt');
      await env.registerCanonical(token, 'TAXED', { launchedAt });
      // 3601s elapsed of a 7200s window: still inside.
      assert.ok(env.now() - launchedAt < 7200n);
      expectRevert(
        await env.buyVerifiedRaw(env.user.address, token, parseEther('0.1'), 0n),
        'TaxWindow()',
      );
      // Advance past the window edge.
      env.advanceTime(7200n - (env.now() - launchedAt) + 1n);
      const value = parseEther('0.1');
      const net = value - (value * 30n) / 10_000n;
      const expected = await expectedBuyTokens(env, curve, net);
      const res = await env.buyVerifiedRaw(env.user.address, token, value, 0n);
      assert.equal(decodeBuy(res), expected, 'post-window buy must match the untaxed quote');
    });

    it('with the real 3s window, a registered token buys cleanly with zero snipe tax', async () => {
      const { curve, token } = await env.deployCurvePair({
        symbol: 'FAST',
        name: 'Fast',
        snipeTaxStartBps: SNIPE_TAX_START_BPS,
        snipeTaxSeconds: SNIPE_TAX_SECONDS,
      });
      const launchedAt = await env.read<bigint>(curve, PONS_CURVE_ABI, 'launchedAt');
      await env.registerCanonical(token, 'FAST', { launchedAt });
      // The 1h timelock outlasts the 3s window — the tax reads 0 by now.
      assert.equal(
        await env.read<bigint>(curve, PONS_CURVE_ABI, 'currentSnipeTaxBps', [env.user.address]),
        0n,
      );
      const value = parseEther('0.1');
      const net = value - (value * 30n) / 10_000n;
      const expected = await expectedBuyTokens(env, curve, net);
      const res = await env.buyVerifiedRaw(env.user.address, token, value, 0n);
      assert.equal(decodeBuy(res), expected, 'no snipe tax may be charged after the window');
    });
  });

  describe('spend cap / partial fill / curve closed', () => {
    it('a buy larger than the cap buys exactly the sellable allocation and refunds the rest', async () => {
      const value = parseEther('50');
      const fee = (value * 30n) / 10_000n;
      const net = value - fee;
      const cap = await expectedMaxSpend(env, env.curve);
      const sellableBefore = await env.read<bigint>(env.curve, PONS_CURVE_ABI, 'sellableTokens');
      assert.ok(net > cap, 'test needs an over-cap buy');

      const ethBefore = await env.ethBalance(env.user.address);
      const res = await env.buyVerifiedRaw(env.user.address, env.token, value, 0n);
      const received = decodeBuy(res);

      assert.equal(received, sellableBefore, 'capped buy must deliver exactly the sellable allocation');
      assert.equal(await env.tokenBalance(env.token, env.user.address), sellableBefore);
      // Buyer spent exactly cap + fee; the rest was refunded in the same tx.
      assert.equal(ethBefore - (await env.ethBalance(env.user.address)), cap + fee);
      // Router holds exactly the fee — no stranded refund.
      assert.equal(await env.ethBalance(env.router), fee);
      assert.equal(await env.read<bigint>(env.router, ROUTER_ABI, 'feesOwed', [env.deployer.address]), fee);
      // The curve is now ready to graduate.
      assert.equal(await env.read<boolean>(env.curve, PONS_CURVE_ABI, 'readyToGraduate'), true);
      assert.equal(await env.maxSpendFor(env.curve), 0n);
    });

    it('buy on a drained curve reverts CurveClosed', async () => {
      await env.buyVerifiedRaw(env.user.address, env.token, parseEther('50'), 0n);
      expectRevert(
        await env.buyVerifiedRaw(env.user.address, env.token, parseEther('0.1'), 0n),
        'CurveClosed()',
      );
    });

    it('a capped buy that cannot meet minTokensOut reverts instead of partially filling', async () => {
      const sellable = await env.read<bigint>(env.curve, PONS_CURVE_ABI, 'sellableTokens');
      const ethBefore = await env.ethBalance(env.user.address);
      // Ask for one token more than the entire sellable allocation.
      const res = await env.buyVerifiedRaw(env.user.address, env.token, parseEther('50'), sellable + 1n);
      expectRevert(res, 'SlippageExceeded(uint256,uint256)');
      assert.equal(await env.ethBalance(env.user.address), ethBefore);
      assert.equal(await env.tokenBalance(env.token, env.user.address), 0n);
    });
  });

  describe('lying curve — balance-delta defense', () => {
    it('a curve that lies about tokensOut is caught: SlippageExceeded, buyer loses nothing', async () => {
      await env.deployLyingBuyCurve(env.token, parseEther('10'));
      const ethBefore = await env.ethBalance(env.user.address);
      const tokensBefore = await env.tokenBalance(env.token, env.user.address);
      // The lying curve returns minTokensOut while transferring 1 token.
      // minTokensOut = 1000 tokens: the lie claims success, the balance
      // delta (1 token) proves otherwise.
      const res = await env.buyVerifiedRaw(env.user.address, env.token, parseEther('0.1'), parseEther('1000'));
      expectRevert(res, 'SlippageExceeded(uint256,uint256)');
      assert.equal(await env.ethBalance(env.user.address), ethBefore);
      assert.equal(await env.tokenBalance(env.token, env.user.address), tokensBefore);
      assert.equal(await env.read<bigint>(env.router, ROUTER_ABI, 'feesOwed', [env.deployer.address]), 0n);
      assert.equal(await env.ethBalance(env.router), 0n);
    });
  });

  describe('registry poisoning is gated by the timelock', () => {
    it('a proposed (not yet executed) re-point changes nothing until the timelock passes', async () => {
      const { token: clone } = await env.deployCurvePair({ symbol: 'TREAL', name: 'Clone' });
      await registryCall(
        'proposeCanonical',
        [symbolHash('TREAL'), clone, env.now(), EVIDENCE],
        env.deployer.address,
      );
      // Before execution: the original still buys, the clone still reverts.
      const ok = await env.buyVerifiedRaw(env.user.address, env.token, parseEther('0.1'), 0n);
      assert.ok(!ok.execResult.exceptionError, 'original must still buy while the re-point waits');
      expectRevert(
        await env.buyVerifiedRaw(env.user.address, clone, parseEther('0.1'), 0n),
        'NotCanonical()',
      );
      // After the timelock: the clone IS canonical (the timelock delays a
      // malicious re-point, it does not prevent one — that is the honest
      // centralization caveat, documented in the README).
      env.advanceTime(TIMELOCK_DELAY + 1n);
      await registryCall('executeUpdate', [symbolHash('TREAL')], env.deployer.address);
      expectRevert(
        await env.buyVerifiedRaw(env.user.address, env.token, parseEther('0.1'), 0n),
        'NotCanonical()',
      );
      const cloneBuy = await env.buyVerifiedRaw(env.user.address, clone, parseEther('0.1'), 0n);
      assert.ok(!cloneBuy.execResult.exceptionError, 'clone buys after the re-point executes');
    });
  });

  describe('fees (pull-based)', () => {
    it('claimFees pays the exact accrued amount; second claim reverts', async () => {
      await env.buyVerifiedRaw(env.user.address, env.token, parseEther('0.1'), 0n);
      await env.buyVerifiedRaw(env.keeper.address, env.token, parseEther('0.2'), 0n);
      const expectedFee = (parseEther('0.1') * 30n) / 10_000n + (parseEther('0.2') * 30n) / 10_000n;
      assert.equal(await env.read<bigint>(env.router, ROUTER_ABI, 'feesOwed', [env.deployer.address]), expectedFee);

      const ethBefore = await env.ethBalance(env.deployer.address);
      const claim = await routerCall('claimFees', [], env.deployer.address);
      assert.ok(!claim.execResult.exceptionError, 'claim failed');
      assert.equal((await env.ethBalance(env.deployer.address)) - ethBefore, expectedFee);
      assert.equal(await env.read<bigint>(env.router, ROUTER_ABI, 'feesOwed', [env.deployer.address]), 0n);
      assert.equal(await env.ethBalance(env.router), 0n);

      expectRevert(await routerCall('claimFees', [], env.deployer.address), 'NothingToClaim()');
    });

    it('an account with no accrued fees cannot claim', async () => {
      expectRevert(await routerCall('claimFees', [], env.attacker.address), 'NothingToClaim()');
    });

    it('setFeeRecipient redirects FUTURE fees only; accrued fees stay with the old recipient', async () => {
      await env.buyVerifiedRaw(env.user.address, env.token, parseEther('0.1'), 0n);
      const fee1 = (parseEther('0.1') * 30n) / 10_000n;
      const set = await routerCall('setFeeRecipient', [env.keeper.address], env.deployer.address);
      assert.ok(!set.execResult.exceptionError, 'setFeeRecipient failed');
      assert.equal(await env.read<string>(env.router, ROUTER_ABI, 'feeRecipient'), env.keeper.address);

      await env.buyVerifiedRaw(env.user.address, env.token, parseEther('0.1'), 0n);
      assert.equal(await env.read<bigint>(env.router, ROUTER_ABI, 'feesOwed', [env.deployer.address]), fee1);
      assert.equal(await env.read<bigint>(env.router, ROUTER_ABI, 'feesOwed', [env.keeper.address]), fee1);
    });

    it('setFeeRecipient: only owner, never zero address', async () => {
      expectRevert(
        await routerCall('setFeeRecipient', [env.keeper.address], env.attacker.address),
        'NotOwner()',
      );
      expectRevert(
        await routerCall('setFeeRecipient', [ZERO], env.deployer.address),
        'ZeroAddress()',
      );
    });
  });

  describe('no fund escape', () => {
    it('direct ETH sends to the router revert (UnexpectedEther)', async () => {
      const res = await env.call(env.router, '0x', { caller: env.user.address, value: parseEther('1') });
      expectRevert(res, 'UnexpectedEther()');
      assert.equal(await env.ethBalance(env.router), 0n);
    });

    it('reentrancy from the refund path is blocked with Reentrant', async () => {
      // Deploy the malicious buyer (funded by the test via its own balance:
      // the deployer funds it, then it attacks with a capped buy).
      const data = encodeDeployData({
        abi: REENTRANT_BUYER_ABI,
        bytecode: REENTRANT_BUYER_BYTECODE,
        args: [env.router, env.token],
      });
      const deployRes = await env.call(undefined, data, { caller: env.deployer.address });
      assert.ok(!deployRes.execResult.exceptionError, 'ReentrantBuyer deploy failed');
      const buyerAddr = getAddress(deployRes.createdAddress!.toString());

      const sellableBefore = await env.read<bigint>(env.curve, PONS_CURVE_ABI, 'sellableTokens');
      const cap = await expectedMaxSpend(env, env.curve);
      const value = parseEther('50');
      const fee = (value * 30n) / 10_000n;
      const net = value - fee;

      // Attack with an over-cap buy (forces the refund path, which is the
      // only reentrancy surface — tokens go via ERC-20, no callback).
      const attackData = encodeFunctionData({
        abi: REENTRANT_BUYER_ABI,
        functionName: 'attack',
        args: [0n],
      });
      const attackRes = await env.call(buyerAddr, attackData, { caller: env.deployer.address, value });
      assert.ok(!attackRes.execResult.exceptionError, `attack tx failed: ${attackRes.execResult.exceptionError?.error}`);

      // The refund fired receive(), the inner buy was attempted and REJECTED
      // by the guard — with the Reentrant selector, specifically.
      assert.equal(await env.read<boolean>(buyerAddr, REENTRANT_BUYER_ABI, 'reentered'), true);
      assert.equal(await env.read<boolean>(buyerAddr, REENTRANT_BUYER_ABI, 'innerSucceeded'), false);
      assert.equal(
        await env.read<string>(buyerAddr, REENTRANT_BUYER_ABI, 'innerRevertSelector'),
        errorSelector('Reentrant()'),
      );
      // Exactly ONE buy executed: the attacker got the sellable allocation
      // once, and the router accrued exactly one fee. The refund (net - cap)
      // stayed in the attacker contract — it is their money, correctly returned.
      assert.equal(await env.tokenBalance(env.token, buyerAddr), sellableBefore);
      assert.equal(await env.ethBalance(buyerAddr), net - cap);
      assert.equal(await env.read<bigint>(env.router, ROUTER_ABI, 'feesOwed', [env.deployer.address]), fee);
      assert.equal(await env.ethBalance(env.router), fee);
    });
  });
});
