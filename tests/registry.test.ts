/**
 * CanonicalRegistry tests — timelock behaviour, fail-closed immediacy,
 * and the invariant that a defensive action cancels a pending proposal.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, keccak256, parseEther, toBytes, type Abi } from 'viem';
import {
  createEnv,
  errorSelector,
  revertSelector,
  symbolHash,
  TIMELOCK_DELAY,
  type TestEnv,
} from './vm.js';
import { REGISTRY_ABI } from '../src/contracts.js';

const EVIDENCE = ('0x' + '22'.repeat(32)) as `0x${string}`;
const EVIDENCE_2 = ('0x' + '33'.repeat(32)) as `0x${string}`;

/** Status enum: 0 UNRESOLVED, 1 CANONICAL, 2 CONTESTED. */
const UNRESOLVED = 0;
const CANONICAL = 1;
const CONTESTED = 2;

describe('CanonicalRegistry', () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createEnv();
  });

  async function registryCall(
    functionName: string,
    args: readonly unknown[],
    caller: `0x${string}`,
  ) {
    const data = encodeFunctionData({ abi: REGISTRY_ABI as Abi, functionName, args });
    return env.call(env.registry, data, { caller });
  }

  function expectRevert(
    res: Awaited<ReturnType<TestEnv['call']>>,
    signature: string,
  ): void {
    assert.ok(res.execResult.exceptionError, `expected revert ${signature}, call succeeded`);
    assert.equal(revertSelector(res.execResult.returnValue), errorSelector(signature));
  }

  describe('deployment + reads', () => {
    it('owner is the deployer, timelock is 1 hour', async () => {
      assert.equal(await env.read<string>(env.registry, REGISTRY_ABI, 'owner'), env.deployer.address);
      assert.equal(await env.read<bigint>(env.registry, REGISTRY_ABI, 'TIMELOCK_DELAY'), 3600n);
    });

    it('unknown symbol reads UNRESOLVED with zero token', async () => {
      const e = await env.entryOf('NOPE');
      assert.equal(e.status, UNRESOLVED);
      assert.equal(e.token, '0x0000000000000000000000000000000000000000');
      assert.equal(e.washSuspect, false);
      assert.equal(e.devDumped, false);
    });

    it('symbolHashOf matches keccak256(symbol)', async () => {
      const onChain = await env.read<string>(env.registry, REGISTRY_ABI, 'symbolHashOf', ['TREAL']);
      assert.equal(onChain, keccak256(toBytes('TREAL')));
      assert.equal(onChain, symbolHash('TREAL'));
    });

    it('symbol hash is case-sensitive', async () => {
      assert.notEqual(symbolHash('TREAL'), symbolHash('treal'));
    });
  });

  describe('propose + execute (timelocked)', () => {
    it('propose then execute after 1h sets a CANONICAL entry', async () => {
      const res = await registryCall(
        'proposeCanonical',
        [symbolHash('TREAL'), env.token, env.now(), EVIDENCE],
        env.deployer.address,
      );
      assert.ok(!res.execResult.exceptionError, 'propose failed');

      const pending = await env.read<{
        token: `0x${string}`;
        launchedAt: bigint;
        evidenceHash: `0x${string}`;
        clearFlags: boolean;
        executableAt: bigint;
        exists: boolean;
      }>(env.registry, REGISTRY_ABI, 'getPending', [symbolHash('TREAL')]);
      assert.equal(pending.exists, true);
      assert.equal(pending.token, env.token);
      assert.equal(pending.executableAt, env.now() + TIMELOCK_DELAY);

      // Entry is still UNRESOLVED while the proposal waits.
      assert.equal((await env.entryOf('TREAL')).status, UNRESOLVED);

      env.advanceTime(TIMELOCK_DELAY + 1n);
      const exec = await registryCall('executeUpdate', [symbolHash('TREAL')], env.deployer.address);
      assert.ok(!exec.execResult.exceptionError, 'execute failed');

      const e = await env.entryOf('TREAL');
      assert.equal(e.status, CANONICAL);
      assert.equal(e.token, env.token);
      assert.equal(e.launchedAt, env.now() - TIMELOCK_DELAY - 1n);
      assert.equal(e.evidenceHash, EVIDENCE);
      assert.equal(e.washSuspect, false);
      assert.equal(e.devDumped, false);

      const pendingAfter = await env.read<{ exists: boolean }>(
        env.registry, REGISTRY_ABI, 'getPending', [symbolHash('TREAL')],
      );
      assert.equal(pendingAfter.exists, false);
    });

    it('execute before the timelock reverts TimelockNotExpired', async () => {
      await registryCall(
        'proposeCanonical',
        [symbolHash('TREAL'), env.token, env.now(), EVIDENCE],
        env.deployer.address,
      );
      env.advanceTime(TIMELOCK_DELAY - 1n);
      const res = await registryCall('executeUpdate', [symbolHash('TREAL')], env.deployer.address);
      expectRevert(res, 'TimelockNotExpired(uint256,uint256)');
      assert.equal((await env.entryOf('TREAL')).status, UNRESOLVED);
    });

    it('execute with no proposal reverts NoPendingUpdate', async () => {
      const res = await registryCall('executeUpdate', [symbolHash('TREAL')], env.deployer.address);
      expectRevert(res, 'NoPendingUpdate()');
    });

    it('execute is permissionless — anyone may execute after the timelock', async () => {
      await registryCall(
        'proposeCanonical',
        [symbolHash('TREAL'), env.token, env.now(), EVIDENCE],
        env.deployer.address,
      );
      env.advanceTime(TIMELOCK_DELAY + 1n);
      // The attacker executes — the timelock, not the caller, is the protection.
      const res = await registryCall('executeUpdate', [symbolHash('TREAL')], env.attacker.address);
      assert.ok(!res.execResult.exceptionError, 'permissionless execute failed');
      assert.equal((await env.entryOf('TREAL')).status, CANONICAL);
    });

    it('a new proposal replaces the pending one and resets the 1h clock', async () => {
      const { token: clone } = await env.deployCurvePair({ symbol: 'TREAL', name: 'Test Real Clone' });
      await registryCall(
        'proposeCanonical',
        [symbolHash('TREAL'), env.token, env.now(), EVIDENCE],
        env.deployer.address,
      );
      env.advanceTime(1800n); // 30 min into the first proposal
      await registryCall(
        'proposeCanonical',
        [symbolHash('TREAL'), clone, env.now(), EVIDENCE_2],
        env.deployer.address,
      );
      env.advanceTime(1801n); // 61 min after the FIRST proposal, 31 after the second
      const early = await registryCall('executeUpdate', [symbolHash('TREAL')], env.deployer.address);
      expectRevert(early, 'TimelockNotExpired(uint256,uint256)');

      env.advanceTime(1800n); // past the SECOND proposal's clock
      const exec = await registryCall('executeUpdate', [symbolHash('TREAL')], env.deployer.address);
      assert.ok(!exec.execResult.exceptionError, 'execute failed');
      const e = await env.entryOf('TREAL');
      assert.equal(e.token, clone);
      assert.equal(e.evidenceHash, EVIDENCE_2);
    });
  });

  describe('propose validation', () => {
    it('non-owner cannot propose', async () => {
      const res = await registryCall(
        'proposeCanonical',
        [symbolHash('TREAL'), env.token, env.now(), EVIDENCE],
        env.attacker.address,
      );
      expectRevert(res, 'NotOwner()');
    });

    it('zero-address token reverts InvalidToken', async () => {
      const res = await registryCall(
        'proposeCanonical',
        [symbolHash('TREAL'), '0x0000000000000000000000000000000000000000', env.now(), EVIDENCE],
        env.deployer.address,
      );
      expectRevert(res, 'InvalidToken()');
    });

    it('EOA token (no code) reverts InvalidToken', async () => {
      const res = await registryCall(
        'proposeCanonical',
        [symbolHash('TREAL'), env.attacker.address, env.now(), EVIDENCE],
        env.deployer.address,
      );
      expectRevert(res, 'InvalidToken()');
    });

    it('zero launchedAt reverts InvalidTimestamp', async () => {
      const res = await registryCall(
        'proposeCanonical',
        [symbolHash('TREAL'), env.token, 0n, EVIDENCE],
        env.deployer.address,
      );
      expectRevert(res, 'InvalidTimestamp()');
    });
  });

  describe('cancel', () => {
    it('owner can cancel; execute afterwards reverts NoPendingUpdate', async () => {
      await registryCall(
        'proposeCanonical',
        [symbolHash('TREAL'), env.token, env.now(), EVIDENCE],
        env.deployer.address,
      );
      const cancel = await registryCall('cancelProposal', [symbolHash('TREAL')], env.deployer.address);
      assert.ok(!cancel.execResult.exceptionError, 'cancel failed');
      env.advanceTime(TIMELOCK_DELAY + 1n);
      const exec = await registryCall('executeUpdate', [symbolHash('TREAL')], env.deployer.address);
      expectRevert(exec, 'NoPendingUpdate()');
    });

    it('non-owner cannot cancel', async () => {
      await registryCall(
        'proposeCanonical',
        [symbolHash('TREAL'), env.token, env.now(), EVIDENCE],
        env.deployer.address,
      );
      const res = await registryCall('cancelProposal', [symbolHash('TREAL')], env.attacker.address);
      expectRevert(res, 'NotOwner()');
    });

    it('cancel with no proposal reverts NoPendingUpdate', async () => {
      const res = await registryCall('cancelProposal', [symbolHash('TREAL')], env.deployer.address);
      expectRevert(res, 'NoPendingUpdate()');
    });
  });

  describe('fail-closed actions are immediate', () => {
    it('contest() takes effect in the same transaction', async () => {
      await env.registerCanonical(env.token, 'TREAL');
      assert.equal((await env.entryOf('TREAL')).status, CANONICAL);
      const res = await registryCall('contest', [symbolHash('TREAL'), EVIDENCE_2], env.deployer.address);
      assert.ok(!res.execResult.exceptionError, 'contest failed');
      const e = await env.entryOf('TREAL');
      assert.equal(e.status, CONTESTED);
      assert.equal(e.evidenceHash, EVIDENCE_2);
      // The token pointer survives (for the record), but buys are blocked by status.
      assert.equal(e.token, env.token);
    });

    it('flagWash() and flagDevDump() take effect immediately', async () => {
      await env.registerCanonical(env.token, 'TREAL');
      const w = await registryCall('flagWash', [symbolHash('TREAL'), EVIDENCE], env.deployer.address);
      assert.ok(!w.execResult.exceptionError, 'flagWash failed');
      assert.equal((await env.entryOf('TREAL')).washSuspect, true);
      const d = await registryCall('flagDevDump', [symbolHash('TREAL'), EVIDENCE], env.deployer.address);
      assert.ok(!d.execResult.exceptionError, 'flagDevDump failed');
      const e = await env.entryOf('TREAL');
      assert.equal(e.washSuspect, true);
      assert.equal(e.devDumped, true);
      assert.equal(e.status, CANONICAL); // flags block buys without changing status
    });

    it('non-owner cannot contest or flag', async () => {
      await env.registerCanonical(env.token, 'TREAL');
      expectRevert(
        await registryCall('contest', [symbolHash('TREAL'), EVIDENCE], env.attacker.address),
        'NotOwner()',
      );
      expectRevert(
        await registryCall('flagWash', [symbolHash('TREAL'), EVIDENCE], env.attacker.address),
        'NotOwner()',
      );
      expectRevert(
        await registryCall('flagDevDump', [symbolHash('TREAL'), EVIDENCE], env.attacker.address),
        'NotOwner()',
      );
    });
  });

  describe('defensive action cancels a pending proposal', () => {
    it('contest() cancels the pending canonical proposal', async () => {
      const { token: clone } = await env.deployCurvePair({ symbol: 'TREAL', name: 'Clone' });
      await registryCall(
        'proposeCanonical',
        [symbolHash('TREAL'), clone, env.now(), EVIDENCE],
        env.deployer.address,
      );
      await registryCall('contest', [symbolHash('TREAL'), EVIDENCE_2], env.deployer.address);
      env.advanceTime(TIMELOCK_DELAY + 1n);
      const exec = await registryCall('executeUpdate', [symbolHash('TREAL')], env.deployer.address);
      expectRevert(exec, 'NoPendingUpdate()');
      assert.equal((await env.entryOf('TREAL')).status, CONTESTED);
    });

    it('flagWash() cancels the pending proposal (a flag can never be silently cleared by it)', async () => {
      await env.registerCanonical(env.token, 'TREAL');
      const { token: clone } = await env.deployCurvePair({ symbol: 'TREAL', name: 'Clone' });
      await registryCall(
        'proposeCanonical',
        [symbolHash('TREAL'), clone, env.now(), EVIDENCE],
        env.deployer.address,
      );
      await registryCall('flagWash', [symbolHash('TREAL'), EVIDENCE_2], env.deployer.address);
      env.advanceTime(TIMELOCK_DELAY + 1n);
      const exec = await registryCall('executeUpdate', [symbolHash('TREAL')], env.deployer.address);
      expectRevert(exec, 'NoPendingUpdate()');
      const e = await env.entryOf('TREAL');
      assert.equal(e.token, env.token); // original still canonical
      assert.equal(e.washSuspect, true);
    });
  });

  describe('flag clearing is timelocked', () => {
    it('proposeClearFlags + execute clears flags, keeps token + status', async () => {
      await env.registerCanonical(env.token, 'TREAL');
      await registryCall('flagWash', [symbolHash('TREAL'), EVIDENCE], env.deployer.address);
      await registryCall('flagDevDump', [symbolHash('TREAL'), EVIDENCE], env.deployer.address);

      await registryCall('proposeClearFlags', [symbolHash('TREAL'), EVIDENCE_2], env.deployer.address);
      // Flags still set while the proposal waits.
      assert.equal((await env.entryOf('TREAL')).washSuspect, true);

      env.advanceTime(TIMELOCK_DELAY - 1n);
      expectRevert(
        await registryCall('executeUpdate', [symbolHash('TREAL')], env.deployer.address),
        'TimelockNotExpired(uint256,uint256)',
      );
      env.advanceTime(2n);
      const exec = await registryCall('executeUpdate', [symbolHash('TREAL')], env.deployer.address);
      assert.ok(!exec.execResult.exceptionError, 'execute failed');
      const e = await env.entryOf('TREAL');
      assert.equal(e.washSuspect, false);
      assert.equal(e.devDumped, false);
      assert.equal(e.token, env.token);
      assert.equal(e.status, CANONICAL);
      assert.equal(e.evidenceHash, EVIDENCE_2);
    });

    it('executing a NEW canonical resets the old token’s flags', async () => {
      await env.registerCanonical(env.token, 'TREAL');
      await registryCall('flagWash', [symbolHash('TREAL'), EVIDENCE], env.deployer.address);
      assert.equal((await env.entryOf('TREAL')).washSuspect, true);

      const { token: clone } = await env.deployCurvePair({ symbol: 'TREAL', name: 'Clone' });
      await registryCall(
        'proposeCanonical',
        [symbolHash('TREAL'), clone, env.now(), EVIDENCE_2],
        env.deployer.address,
      );
      env.advanceTime(TIMELOCK_DELAY + 1n);
      await registryCall('executeUpdate', [symbolHash('TREAL')], env.deployer.address);
      const e = await env.entryOf('TREAL');
      assert.equal(e.token, clone);
      assert.equal(e.status, CANONICAL);
      assert.equal(e.washSuspect, false); // fresh assessment for the new token
      assert.equal(e.devDumped, false);
    });
  });

  describe('ownership transfer (two-step)', () => {
    it('transfer + accept moves ownership; old owner loses propose rights', async () => {
      const req = await registryCall('transferOwnership', [env.keeper.address], env.deployer.address);
      assert.ok(!req.execResult.exceptionError, 'transferOwnership failed');
      // Still the old owner until accepted.
      assert.equal(await env.read<string>(env.registry, REGISTRY_ABI, 'owner'), env.deployer.address);
      const acc = await registryCall('acceptOwnership', [], env.keeper.address);
      assert.ok(!acc.execResult.exceptionError, 'acceptOwnership failed');
      assert.equal(await env.read<string>(env.registry, REGISTRY_ABI, 'owner'), env.keeper.address);

      // Old owner can no longer propose; new owner can.
      expectRevert(
        await registryCall(
          'proposeCanonical',
          [symbolHash('TREAL'), env.token, env.now(), EVIDENCE],
          env.deployer.address,
        ),
        'NotOwner()',
      );
      const ok = await registryCall(
        'proposeCanonical',
        [symbolHash('TREAL'), env.token, env.now(), EVIDENCE],
        env.keeper.address,
      );
      assert.ok(!ok.execResult.exceptionError, 'new owner propose failed');
    });

    it('only the pending owner can accept', async () => {
      await registryCall('transferOwnership', [env.keeper.address], env.deployer.address);
      expectRevert(
        await registryCall('acceptOwnership', [], env.attacker.address),
        'NotPendingOwner()',
      );
    });

    it('transfer to zero address reverts', async () => {
      expectRevert(
        await registryCall(
          'transferOwnership',
          ['0x0000000000000000000000000000000000000000'],
          env.deployer.address,
        ),
        'ZeroAddress()',
      );
    });

    it('non-owner cannot initiate a transfer', async () => {
      expectRevert(
        await registryCall('transferOwnership', [env.attacker.address], env.attacker.address),
        'NotOwner()',
      );
    });
  });

  describe('fee math sanity (no ETH ever touches the registry)', () => {
    it('registry holds no ETH and rejects direct sends', async () => {
      const res = await env.call(env.registry, '0x', { caller: env.user.address, value: parseEther('1') });
      assert.ok(res.execResult.exceptionError, 'registry should reject plain ETH sends');
      assert.equal(await env.ethBalance(env.registry), 0n);
    });
  });
});
