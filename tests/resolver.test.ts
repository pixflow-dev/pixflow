/**
 * Resolver unit tests — pure logic, no network, no chain.
 * Fixtures mirror the real measured cases: DCTY (332 buys into dead
 * clones, first clone graduated), MEOW (891 buys into 8 clones, no
 * winner), TAURO (squatter launched before the real project),
 * PARIMATCH (635 trades at 0% progress).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Address } from 'viem';
import {
  buildEvidenceBundle,
  detectDevDump,
  detectWash,
  DEV_DUMP_SELL_FRACTION_BPS,
  DOMINANCE_MARGIN_BPS,
  POLICY_VERSION,
  resolveSymbol,
  WASH_MAX_PROGRESS_BPS,
  WASH_MIN_TRADES,
  type CohortToken,
  type NarrativeSource,
} from '../src/resolver.js';

const T0 = 1794000000; // fixed base timestamp (unix seconds)

let addrCounter = 0;
function addr(): Address {
  addrCounter++;
  return `0x${addrCounter.toString(16).padStart(40, '0')}` as Address;
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

describe('policy constants', () => {
  it('exports the documented keeper policy values', () => {
    assert.equal(POLICY_VERSION, 'pixflow-resolver/1');
    assert.equal(DOMINANCE_MARGIN_BPS, 1000);
    assert.equal(WASH_MIN_TRADES, 100);
    assert.equal(WASH_MAX_PROGRESS_BPS, 50);
    assert.equal(DEV_DUMP_SELL_FRACTION_BPS, 5000);
  });
});

describe('resolveSymbol — DCTY fixture', () => {
  // Real shape: the first clone launched was the one that graduated;
  // the losers sit near 0 progress.
  const winner = mkToken({
    symbol: 'DCTY',
    deployedAt: T0,
    progressBps: 10000,
    buyCount: 332,
    sellCount: 40,
    tradeCount: 372,
    graduated: true,
  });
  const losers = [1, 2, 3].map((i) =>
    mkToken({
      symbol: 'DCTY',
      deployedAt: T0 + i * 600,
      progressBps: i * 10,
      buyCount: i,
      tradeCount: i,
    }),
  );

  it('picks the graduated earliest clone as CANONICAL', () => {
    const r = resolveSymbol('DCTY', [losers[2], winner, losers[0], losers[1]]);
    assert.equal(r.verdict, 'CANONICAL');
    assert.equal(r.token?.address, winner.address);
  });

  it('reasons cite earliest launch AND graduation', () => {
    const r = resolveSymbol('DCTY', [winner, ...losers]);
    assert.ok(r.reasons.some((x) => /graduated/i.test(x)), `reasons: ${r.reasons.join(' | ')}`);
    assert.ok(r.reasons.some((x) => /earliest/i.test(x)), `reasons: ${r.reasons.join(' | ')}`);
  });

  it('scores the graduated winner highest', () => {
    const r = resolveSymbol('DCTY', [winner, ...losers]);
    const winnerScore = r.scores[winner.address.toLowerCase()];
    for (const loser of losers) {
      assert.ok(winnerScore > r.scores[loser.address.toLowerCase()]);
    }
  });
});

describe('resolveSymbol — MEOW fixture', () => {
  // Real shape: 8 clones, max 389 bps, no leader.
  function meowCohort(): CohortToken[] {
    const progress = [389, 340, 210, 180, 120, 95, 40, 12];
    return progress.map((p, i) =>
      mkToken({
        symbol: 'MEOW',
        deployedAt: T0 + i * 900,
        progressBps: p,
        buyCount: 100 + i,
        tradeCount: 110 + i,
      }),
    );
  }

  it('is CONTESTED: no leader within the dominance margin', () => {
    const r = resolveSymbol('MEOW', meowCohort());
    assert.equal(r.verdict, 'CONTESTED');
    assert.equal(r.token, undefined);
  });

  it('reasons cite the missing dominance margin', () => {
    const r = resolveSymbol('MEOW', meowCohort());
    assert.ok(
      r.reasons.some((x) => /dominance margin|no clear leader/i.test(x)),
      `reasons: ${r.reasons.join(' | ')}`,
    );
  });
});

describe('resolveSymbol — TAURO fixture', () => {
  const squatter = mkToken({
    symbol: 'TAURO',
    deployedAt: T0,
    progressBps: 800,
    buyCount: 90,
    tradeCount: 95,
    socials: { website: '', twitter: '', telegram: '', discord: '' },
  });
  const real = mkToken({
    symbol: 'TAURO',
    deployedAt: T0 + 3600,
    progressBps: 300,
    buyCount: 60,
    tradeCount: 70,
    socials: {
      website: 'https://tauro.example',
      twitter: 'https://x.com/tauro_real',
      telegram: '',
      discord: '',
    },
  });
  const narrative: NarrativeSource = {
    website: 'https://tauro.example',
    twitter: '@tauro_real',
  };

  it('picks the REAL token (socials match), not the earlier squatter', () => {
    const r = resolveSymbol('TAURO', [squatter, real], narrative);
    assert.equal(r.verdict, 'CANONICAL');
    assert.equal(r.token?.address, real.address);
    assert.notEqual(r.token?.address, squatter.address);
  });

  it('reasons cite the socials match and the squatter', () => {
    const r = resolveSymbol('TAURO', [squatter, real], narrative);
    assert.ok(r.reasons.some((x) => /socials match/i.test(x)), `reasons: ${r.reasons.join(' | ')}`);
    assert.ok(r.reasons.some((x) => /squatter/i.test(x)), `reasons: ${r.reasons.join(' | ')}`);
  });

  it('without a narrative source the race is CONTESTED (no guess)', () => {
    const r = resolveSymbol('TAURO', [squatter, real]);
    assert.equal(r.verdict, 'CONTESTED');
  });

  it('is CONTESTED when the narrative matches no token', () => {
    const r = resolveSymbol('TAURO', [squatter, real], { twitter: '@someone_else' });
    assert.equal(r.verdict, 'CONTESTED');
    assert.ok(r.reasons.some((x) => /no token's on-chain socials match/i.test(x)));
  });

  it('is CONTESTED when two tokens match the narrative', () => {
    const copy = mkToken({
      symbol: 'TAURO',
      deployedAt: T0 + 7200,
      progressBps: 50,
      socials: { ...real.socials },
    });
    const r = resolveSymbol('TAURO', [squatter, real, copy], narrative);
    assert.equal(r.verdict, 'CONTESTED');
  });
});

describe('resolveSymbol — dominance rules', () => {
  it('earliest token leading by >= margin wins CANONICAL', () => {
    const first = mkToken({ deployedAt: T0, progressBps: 5000 });
    const second = mkToken({ deployedAt: T0 + 600, progressBps: 3500 });
    const r = resolveSymbol('X', [first, second]);
    assert.equal(r.verdict, 'CANONICAL');
    assert.equal(r.token?.address, first.address);
    assert.ok(r.reasons.some((x) => /dominance margin/i.test(x)));
  });

  it('earliest token leading by < margin is CONTESTED', () => {
    const first = mkToken({ deployedAt: T0, progressBps: 5000 });
    const second = mkToken({ deployedAt: T0 + 600, progressBps: 4500 });
    const r = resolveSymbol('X', [first, second]);
    assert.equal(r.verdict, 'CONTESTED');
  });

  it('a later token overtaking the earliest is a signal, not a verdict', () => {
    const first = mkToken({ deployedAt: T0, progressBps: 100 });
    const later = mkToken({ deployedAt: T0 + 600, progressBps: 9500 });
    const r = resolveSymbol('X', [first, later]);
    assert.equal(r.verdict, 'CONTESTED');
    assert.ok(r.reasons.some((x) => /signal, not a verdict/i.test(x)));
  });

  it('a single-token cohort is CANONICAL (only claim)', () => {
    const only = mkToken({ deployedAt: T0, progressBps: 120 });
    const r = resolveSymbol('SOLO', [only]);
    assert.equal(r.verdict, 'CANONICAL');
    assert.equal(r.token?.address, only.address);
  });

  it('an empty cohort is UNRESOLVED', () => {
    const r = resolveSymbol('NONE', []);
    assert.equal(r.verdict, 'UNRESOLVED');
    assert.equal(r.token, undefined);
  });

  it('two graduated tokens are CONTESTED', () => {
    const a = mkToken({ deployedAt: T0, progressBps: 10000, graduated: true });
    const b = mkToken({ deployedAt: T0 + 600, progressBps: 10000, graduated: true });
    const r = resolveSymbol('X', [a, b]);
    assert.equal(r.verdict, 'CONTESTED');
  });
});

describe('detectWash — PARIMATCH fixture', () => {
  it('flags 635 trades at 0 progress as wash-suspect', () => {
    const t = mkToken({ progressBps: 0, buyCount: 400, sellCount: 235, tradeCount: 635 });
    const w = detectWash(t);
    assert.equal(w.washSuspect, true);
    assert.ok(/635 trades at 0 bps/.test(w.reason), w.reason);
  });

  it('does not flag below the trade threshold', () => {
    const t = mkToken({ progressBps: 0, tradeCount: 50 });
    assert.equal(detectWash(t).washSuspect, false);
  });

  it('does not flag high-progress tokens even with many trades', () => {
    const t = mkToken({ progressBps: 5000, tradeCount: 900 });
    assert.equal(detectWash(t).washSuspect, false);
  });

  it('propagates washSuspect into the resolution (verdict stays CANONICAL)', () => {
    const t = mkToken({ deployedAt: T0, progressBps: 10, tradeCount: 635 });
    const r = resolveSymbol('WASH', [t]);
    assert.equal(r.verdict, 'CANONICAL');
    assert.equal(r.washSuspect, true);
    assert.ok(r.reasons.some((x) => /wash flag/i.test(x)));
  });
});

describe('detectDevDump', () => {
  it('flags a creator who sold 80% of the launch position', () => {
    const t = mkToken();
    const d = detectDevDump(t, {
      launchBuyTokens: 1000n,
      currentBalance: 200n,
      transferredOut: 800n,
    });
    assert.equal(d.devDumped, true);
    assert.equal(d.soldFractionBps, 8000);
    assert.ok(/80\.0%/.test(d.reason), d.reason);
  });

  it('does not flag a creator who still holds', () => {
    const t = mkToken();
    const d = detectDevDump(t, {
      launchBuyTokens: 1000n,
      currentBalance: 900n,
      transferredOut: 100n,
    });
    assert.equal(d.devDumped, false);
    assert.equal(d.soldFractionBps, 1000);
  });

  it('flags exactly at the 50% threshold', () => {
    const t = mkToken();
    const d = detectDevDump(t, {
      launchBuyTokens: 1000n,
      currentBalance: 500n,
      transferredOut: 500n,
    });
    assert.equal(d.devDumped, true);
    assert.equal(d.soldFractionBps, 5000);
  });

  it('is not applicable when the creator made no launch buy', () => {
    const t = mkToken();
    const d = detectDevDump(t, { launchBuyTokens: 0n, currentBalance: 0n, transferredOut: 0n });
    assert.equal(d.devDumped, false);
    assert.equal(d.soldFractionBps, 0);
    assert.ok(/no launch buy/i.test(d.reason));
  });

  it('propagates devDumped into the resolution via holdings', () => {
    const t = mkToken({ deployedAt: T0, progressBps: 120 });
    const holdings = new Map([[t.address.toLowerCase(), {
      launchBuyTokens: 1000n,
      currentBalance: 100n,
      transferredOut: 900n,
    }]]);
    const r = resolveSymbol('DUMP', [t], undefined, holdings);
    assert.equal(r.verdict, 'CANONICAL');
    assert.equal(r.devDumped, true);
    assert.ok(r.reasons.some((x) => /dev-dump flag/i.test(x)));
  });
});

describe('buildEvidenceBundle', () => {
  const cohort = [
    mkToken({ symbol: 'DCTY', deployedAt: T0, progressBps: 10000, graduated: true, tradeCount: 372 }),
    mkToken({ symbol: 'DCTY', deployedAt: T0 + 600, progressBps: 10, tradeCount: 2 }),
  ];
  const meta = { resolvedAt: '2026-11-19T12:00:00.000Z', chainId: 46630 };

  it('is deterministic: same input → same hash', () => {
    const r1 = resolveSymbol('DCTY', cohort);
    const r2 = resolveSymbol('DCTY', cohort);
    const b1 = buildEvidenceBundle('DCTY', cohort, r1, meta);
    const b2 = buildEvidenceBundle('DCTY', cohort, r2, meta);
    assert.equal(b1.evidenceHash, b2.evidenceHash);
    assert.equal(b1.evidenceHash.length, 66); // 0x + 64 hex chars
  });

  it('changes hash when the input changes', () => {
    const r = resolveSymbol('DCTY', cohort);
    const b1 = buildEvidenceBundle('DCTY', cohort, r, meta);
    const changed = cohort.map((t) =>
      t.address === cohort[0].address ? { ...t, progressBps: 9999 } : t,
    );
    const b2 = buildEvidenceBundle('DCTY', changed, resolveSymbol('DCTY', changed), meta);
    assert.notEqual(b1.evidenceHash, b2.evidenceHash);
  });

  it('records policy version + thresholds, cohort snapshot, reasons, socials comparison', () => {
    const r = resolveSymbol('DCTY', cohort);
    const { bundle } = buildEvidenceBundle('DCTY', cohort, r, meta);
    assert.equal(bundle.symbol, 'DCTY');
    assert.equal(bundle.resolvedAt, meta.resolvedAt);
    const policy = bundle.policy as Record<string, unknown>;
    assert.equal(policy.version, POLICY_VERSION);
    assert.equal(policy.dominanceMarginBps, DOMINANCE_MARGIN_BPS);
    assert.equal(policy.washMinTrades, WASH_MIN_TRADES);
    assert.equal(policy.washMaxProgressBps, WASH_MAX_PROGRESS_BPS);
    assert.equal(policy.devDumpSellFractionBps, DEV_DUMP_SELL_FRACTION_BPS);
    assert.equal((bundle.cohort as unknown[]).length, 2);
    const resolution = bundle.resolution as Record<string, unknown>;
    assert.equal(resolution.verdict, 'CANONICAL');
    assert.ok(Array.isArray(resolution.reasons) && resolution.reasons.length > 0);
    assert.equal((bundle.socialsComparison as unknown[]).length, 2);
  });
});
