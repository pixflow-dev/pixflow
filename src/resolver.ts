/**
 * Pixflow resolver — PURE canonical-token resolution (DESIGN.md §3).
 *
 * No I/O, no network, no chain access: given a cohort of same-symbol
 * Pons tokens (plus an optional operator-supplied narrative source),
 * decide which token — if any — is the canonical one.
 *
 * The rules, in order (DESIGN.md §3):
 *   1. Earliest `deployedAt` is the default candidate.
 *   2. Progress dominance — the candidate must lead the cohort by a
 *      clear margin (DOMINANCE_MARGIN_BPS).
 *   3. Socials match — if a narrative source is supplied, a token whose
 *      on-chain socials match it beats an earlier token that doesn't
 *      (TAURO lesson: the squatter launched first).
 *   4. Graduation — a graduated token is canonical by definition.
 *
 * REVERT, DON'T GUESS: if no token clearly wins, the verdict is
 * CONTESTED and the router reverts every buy for the symbol. A missed
 * buy costs the user nothing; a wrong buy costs them everything.
 *
 * Wash (PARIMATCH pattern) and dev-dump are FLAGS, not verdicts: a
 * canonical token can still be wash-suspect or dev-dumped, and the
 * router blocks buys while either flag is set.
 */
import { keccak256, stringToHex, type Address, type Hex } from 'viem';

/** Keeper policy version — recorded in every evidence bundle. */
export const POLICY_VERSION = 'pixflow-resolver/1';

/**
 * Dominance margin (bps of graduation progress): the candidate must
 * lead the runner-up by at least this much to win on progress alone.
 * 1000 bps = 10 percentage points of the 4.2 ETH graduation curve —
 * wide enough that two clones neck-and-neck (MEOW: max 389 bps) never
 * produce a winner, narrow enough that a real leader (DCTY: graduated
 * at 10,000 bps vs losers near 0) wins decisively.
 */
export const DOMINANCE_MARGIN_BPS = 1000;

/**
 * Wash thresholds (PARIMATCH pattern: 635 trades at 0% progress).
 * Many trades with ~no progress means wash volume, not demand.
 * A token is wash-suspect when it has at least WASH_MIN_TRADES trades
 * while sitting at or below WASH_MAX_PROGRESS_BPS progress.
 */
export const WASH_MIN_TRADES = 100;
export const WASH_MAX_PROGRESS_BPS = 50;

/**
 * Dev-dump threshold: the creator sold at least this fraction (bps) of
 * their launch position. 5000 = 50% — the majority of the position.
 */
export const DEV_DUMP_SELL_FRACTION_BPS = 5000;

export interface TokenSocials {
  website: string;
  twitter: string;
  telegram: string;
  discord: string;
}

export interface CohortToken {
  address: Address;
  symbol: string;
  /** Unix timestamp (seconds) the token launched. */
  deployedAt: number;
  /** Graduation progress in bps (0–10000). */
  progressBps: number;
  buyCount: number;
  sellCount: number;
  tradeCount: number;
  graduated: boolean;
  creator: Address;
  socials: TokenSocials;
  /** On-chain description() text, if fetched (not used for matching). */
  description?: string;
}

/**
 * The tweet / site that started the narrative wave, supplied by the
 * operator. The keeper never verifies creator CLAIMS — it only checks
 * whether a token's on-chain socials match this source.
 */
export interface NarrativeSource {
  website?: string;
  twitter?: string;
}

export type Verdict = 'CANONICAL' | 'CONTESTED' | 'UNRESOLVED';

export interface Resolution {
  verdict: Verdict;
  /** The canonical token, when the verdict is CANONICAL. */
  token?: CohortToken;
  /** Human-readable reasons, one per rule applied. */
  reasons: string[];
  washSuspect: boolean;
  devDumped: boolean;
  /**
   * Diagnostic scores per token (keyed by lowercase address).
   * progress + 1000 (earliest) + 5000 (socials match) + 10000
   * (graduated). Diagnostic ONLY — the verdict comes from the rules
   * above, never from the score.
   */
  scores: Record<string, number>;
}

export interface CreatorHoldings {
  /** Tokens the creator bought at launch (0 = no launch buy). */
  launchBuyTokens: bigint;
  /**
   * Tokens currently held by the creator + known creator wallets.
   * Transfers to KNOWN creator wallets count as still held; transfers
   * to fresh unknown wallets look like sells (fail-closed — see
   * detectDevDump).
   */
  currentBalance: bigint;
  /** Tokens the creator transferred out (informational, see below). */
  transferredOut: bigint;
}

export interface WashCheck {
  washSuspect: boolean;
  reason: string;
}

export interface DevDumpCheck {
  devDumped: boolean;
  /** Fraction of the launch position sold, in bps (0 when no launch buy). */
  soldFractionBps: number;
  reason: string;
}

// ---------------------------------------------------------------------------
// Socials matching
// ---------------------------------------------------------------------------

/**
 * Normalize a social value for comparison: lowercase, strip scheme /
 * www / trailing slash, map x.com → twitter.com, strip a leading @.
 * A bare handle ("foo") and a profile URL ("x.com/foo") normalize to
 * the same handle when compared as twitter values.
 */
export function normalizeSocial(value: string): string {
  let v = value.trim().toLowerCase();
  v = v.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  v = v.replace(/^x\.com\//, 'twitter.com/');
  v = v.replace(/^@/, '');
  return v;
}

/** Extract the handle from a normalized twitter value (URL or bare handle). */
function twitterHandle(normalized: string): string {
  const m = normalized.match(/^(?:twitter\.com\/)?([a-z0-9_]+)$/);
  return m ? m[1] : normalized;
}

/**
 * Does a token's on-chain socials match the narrative source?
 * Rule: at least one supplied narrative field must match, and NO
 * supplied field may conflict (token has a non-empty, different value
 * for it). A token with no socials at all never matches. An empty
 * token field is "no evidence either way", not a conflict.
 */
export function socialsMatch(socials: TokenSocials, narrative: NarrativeSource): boolean {
  let matched = false;
  const fields: Array<[string, string | undefined, 'url' | 'twitter']> = [
    [socials.website, narrative.website, 'url'],
    [socials.twitter, narrative.twitter, 'twitter'],
  ];
  for (const [tokenValue, narrativeValue, kind] of fields) {
    if (!narrativeValue) continue;
    if (!tokenValue) continue; // no evidence either way
    const a = normalizeSocial(tokenValue);
    const b = normalizeSocial(narrativeValue);
    const equal = kind === 'twitter' ? twitterHandle(a) === twitterHandle(b) : a === b;
    if (equal) matched = true;
    else return false; // conflicting field: not a match
  }
  return matched;
}

// ---------------------------------------------------------------------------
// Wash + dev-dump detection (pure, independently testable)
// ---------------------------------------------------------------------------

/**
 * PARIMATCH pattern: many trades with ~0 progress = wash volume, not
 * demand. Flags when tradeCount >= WASH_MIN_TRADES while progress is
 * at or below WASH_MAX_PROGRESS_BPS.
 */
export function detectWash(token: CohortToken): WashCheck {
  const washSuspect =
    token.tradeCount >= WASH_MIN_TRADES && token.progressBps <= WASH_MAX_PROGRESS_BPS;
  const reason = washSuspect
    ? `${token.tradeCount} trades at ${token.progressBps} bps progress — ` +
      `≥${WASH_MIN_TRADES} trades with ≤${WASH_MAX_PROGRESS_BPS} bps progress ` +
      `(PARIMATCH wash pattern)`
    : `${token.tradeCount} trades at ${token.progressBps} bps progress — ` +
      `below wash thresholds (≥${WASH_MIN_TRADES} trades at ≤${WASH_MAX_PROGRESS_BPS} bps)`;
  return { washSuspect, reason };
}

/**
 * Dev-dump: the creator sold the majority of their launch position.
 *
 *   soldFraction = (launchBuyTokens - currentBalance) / launchBuyTokens
 *
 * where currentBalance counts the creator + KNOWN creator wallets.
 * `transferredOut` is recorded for the evidence bundle but does NOT
 * enter the formula: a transfer to a known creator wallet is still
 * held (it is inside currentBalance), and a transfer to a fresh
 * unknown wallet is indistinguishable from a sell — counting it as
 * sold is fail-closed, which is the correct direction for a flag that
 * only BLOCKS buys.
 *
 * LIMITATION (documented honestly): a dev who splits holdings across
 * fresh wallets looks dumped even if they still hold. The flag is
 * reversible (proposeClearFlags, timelocked) and a false positive
 * costs a missed buy, not a lost buy.
 */
export function detectDevDump(token: CohortToken, holdings: CreatorHoldings): DevDumpCheck {
  if (holdings.launchBuyTokens <= 0n) {
    return {
      devDumped: false,
      soldFractionBps: 0,
      reason: `creator of ${token.address} made no launch buy — dev-dump check not applicable`,
    };
  }
  const sold =
    holdings.launchBuyTokens > holdings.currentBalance
      ? holdings.launchBuyTokens - holdings.currentBalance
      : 0n;
  const soldFractionBps = Number((sold * 10000n) / holdings.launchBuyTokens);
  const devDumped = soldFractionBps >= DEV_DUMP_SELL_FRACTION_BPS;
  const pct = (soldFractionBps / 100).toFixed(1);
  const reason = devDumped
    ? `creator sold ${pct}% of launch position ` +
      `(${sold} of ${holdings.launchBuyTokens} tokens; current balance ${holdings.currentBalance})`
    : `creator holds ${(100 - soldFractionBps / 100).toFixed(1)}% of launch position ` +
      `(sold ${pct}%, below the ${DEV_DUMP_SELL_FRACTION_BPS / 100}% dev-dump threshold)`;
  return { devDumped, soldFractionBps, reason };
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

function scoreToken(
  token: CohortToken,
  earliest: CohortToken,
  narrative?: NarrativeSource,
): number {
  let score = token.progressBps;
  if (token.address.toLowerCase() === earliest.address.toLowerCase()) score += 1000;
  if (narrative && socialsMatch(token.socials, narrative)) score += 5000;
  if (token.graduated) score += 10000;
  return score;
}

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function iso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

/**
 * Resolve a symbol's cohort to a canonical token (or CONTESTED /
 * UNRESOLVED). Pure: no I/O, fully unit-testable.
 *
 * @param symbol The symbol being resolved (used in reasons only; the
 *   registry key is keccak256 of the exact on-chain symbol string).
 * @param cohort Same-symbol tokens, any order.
 * @param narrative Optional operator-supplied narrative source. When
 *   supplied, a socials match is DECISIVE (TAURO rule) — and when no
 *   token matches it, the verdict is CONTESTED, not a guess at the
 *   earliest token: the real token may not have launched yet.
 * @param creatorHoldings Optional per-token creator holdings (keyed by
 *   lowercase token address) for the dev-dump check. Without it the
 *   dev-dump check is skipped (devDumped=false) and the reasons say so.
 */
export function resolveSymbol(
  symbol: string,
  cohort: CohortToken[],
  narrative?: NarrativeSource,
  creatorHoldings?: ReadonlyMap<string, CreatorHoldings>,
): Resolution {
  const scores: Record<string, number> = {};
  if (cohort.length === 0) {
    return {
      verdict: 'UNRESOLVED',
      reasons: [`no tokens found for symbol ${symbol}`],
      washSuspect: false,
      devDumped: false,
      scores,
    };
  }

  // Deterministic order: earliest first, ties broken by address.
  const sorted = [...cohort].sort(
    (a, b) => a.deployedAt - b.deployedAt || (a.address < b.address ? -1 : 1),
  );
  const earliest = sorted[0];
  for (const t of sorted) scores[t.address.toLowerCase()] = scoreToken(t, earliest, narrative);

  const finish = (
    verdict: Verdict,
    token: CohortToken | undefined,
    reasons: string[],
  ): Resolution => {
    let washSuspect = false;
    let devDumped = false;
    if (token) {
      const wash = detectWash(token);
      washSuspect = wash.washSuspect;
      if (washSuspect) reasons.push(`wash flag: ${wash.reason}`);
      const holdings = creatorHoldings?.get(token.address.toLowerCase());
      if (holdings) {
        const dump = detectDevDump(token, holdings);
        devDumped = dump.devDumped;
        if (devDumped) reasons.push(`dev-dump flag: ${dump.reason}`);
      } else {
        reasons.push('dev-dump check skipped: no creator-holdings data supplied');
      }
    }
    return { verdict, token, reasons, washSuspect, devDumped, scores };
  };

  // Rule 4 — graduation is canonical by definition (the market settled it).
  const graduated = sorted.filter((t) => t.graduated);
  if (graduated.length === 1) {
    const winner = graduated[0];
    const reasons = [
      `${short(winner.address)} graduated (${winner.progressBps} bps) — canonical by definition`,
    ];
    if (winner.address.toLowerCase() === earliest.address.toLowerCase()) {
      reasons.push(`also the earliest launch in the cohort (deployed ${iso(winner.deployedAt)})`);
    } else {
      reasons.push(
        `launched after the earliest token (${short(earliest.address)}) but graduation settles it`,
      );
    }
    if (narrative && socialsMatch(winner.socials, narrative)) {
      reasons.push('on-chain socials match the narrative source');
    }
    return finish('CANONICAL', winner, reasons);
  }
  if (graduated.length > 1) {
    return finish(
      'CONTESTED',
      undefined,
      [
        `${graduated.length} tokens graduated (${graduated.map((t) => short(t.address)).join(', ')}) — ` +
          `the market settled on more than one token; cannot pick one`,
      ],
    );
  }

  // Rule 3 — socials match (decisive when a narrative source is supplied).
  if (narrative && (narrative.website || narrative.twitter)) {
    const matches = sorted.filter((t) => socialsMatch(t.socials, narrative));
    if (matches.length === 1) {
      const winner = matches[0];
      const reasons = [
        `on-chain socials match the narrative source` +
          `${narrative.twitter ? ` (twitter ${narrative.twitter})` : ''}` +
          `${narrative.website ? ` (website ${narrative.website})` : ''}`,
      ];
      if (winner.address.toLowerCase() !== earliest.address.toLowerCase()) {
        reasons.push(
          `later launch (deployed ${iso(winner.deployedAt)}) beats the earlier squatter ` +
            `${short(earliest.address)} (deployed ${iso(earliest.deployedAt)}, no socials match) — TAURO rule`,
        );
      } else {
        reasons.push(`also the earliest launch in the cohort (deployed ${iso(winner.deployedAt)})`);
      }
      reasons.push(`progress ${winner.progressBps} bps, ${winner.tradeCount} trades`);
      return finish('CANONICAL', winner, reasons);
    }
    if (matches.length > 1) {
      return finish(
        'CONTESTED',
        undefined,
        [
          `${matches.length} tokens match the narrative source ` +
            `(${matches.map((t) => short(t.address)).join(', ')}) — cannot distinguish`,
        ],
      );
    }
    return finish(
      'CONTESTED',
      undefined,
      [
        `narrative source supplied but no token's on-chain socials match it — ` +
          `the real token may not have launched yet`,
      ],
    );
  }

  // Rules 1 + 2 — earliest + progress dominance (no narrative supplied).
  if (sorted.length === 1) {
    return finish(
      'CANONICAL',
      earliest,
      [
        `only token in the cohort for ${symbol} (deployed ${iso(earliest.deployedAt)}, ` +
          `${earliest.progressBps} bps progress)`,
      ],
    );
  }
  const byProgress = [...sorted].sort((a, b) => b.progressBps - a.progressBps);
  const leader = byProgress[0];
  const runnerUp = byProgress[1];
  if (leader.address.toLowerCase() === earliest.address.toLowerCase()) {
    const margin = leader.progressBps - runnerUp.progressBps;
    if (margin >= DOMINANCE_MARGIN_BPS) {
      return finish(
        'CANONICAL',
        earliest,
        [
          `earliest launch in the cohort (deployed ${iso(earliest.deployedAt)})`,
          `leads the cohort by ${margin.toLocaleString()} bps ` +
            `(${leader.progressBps.toLocaleString()} vs ${runnerUp.progressBps.toLocaleString()}), ` +
            `above the ${DOMINANCE_MARGIN_BPS.toLocaleString()} bps dominance margin`,
        ],
      );
    }
    return finish(
      'CONTESTED',
      undefined,
      [
        `no clear leader: earliest token ${short(earliest.address)} leads by only ` +
          `${margin.toLocaleString()} bps (${leader.progressBps} vs ${runnerUp.progressBps}), ` +
          `inside the ${DOMINANCE_MARGIN_BPS.toLocaleString()} bps dominance margin`,
      ],
    );
  }
  // A later token overtook the earliest: a signal, not a verdict on its own.
  return finish(
    'CONTESTED',
    undefined,
    [
      `later token ${short(leader.address)} overtook the earliest ${short(earliest.address)} ` +
        `(${leader.progressBps} vs ${earliest.progressBps} bps) — an overtake is a signal, ` +
        `not a verdict, and no narrative source was supplied to confirm it`,
    ],
  );
}

// ---------------------------------------------------------------------------
// Evidence bundles (DESIGN.md §5)
// ---------------------------------------------------------------------------

export interface EvidenceMeta {
  /** ISO timestamp; defaults to now. Inject a fixed value for determinism tests. */
  resolvedAt?: string;
  chainId?: number;
  narrative?: NarrativeSource;
}

export interface EvidenceBundleResult {
  bundle: Record<string, unknown>;
  /** keccak256 of the canonical (stable-key-order) JSON of the bundle. */
  evidenceHash: Hex;
}

/**
 * Canonical JSON: object keys sorted recursively, undefined values
 * dropped (same as JSON.stringify). Two bundles with the same content
 * hash identically regardless of construction order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function hashEvidenceBundle(bundle: Record<string, unknown>): Hex {
  return keccak256(stringToHex(canonicalJson(bundle)));
}

/**
 * Build the off-chain evidence bundle for a resolution + its hash.
 * The bundle goes off-chain (a JSON file in Fase 2, IPFS in
 * production); the hash is what the registry records on-chain, so the
 * verdict stays checkable after the fact.
 */
export function buildEvidenceBundle(
  symbol: string,
  cohort: CohortToken[],
  resolution: Resolution,
  meta: EvidenceMeta = {},
): EvidenceBundleResult {
  const bundle: Record<string, unknown> = {
    symbol,
    resolvedAt: meta.resolvedAt ?? new Date().toISOString(),
    policy: {
      version: POLICY_VERSION,
      dominanceMarginBps: DOMINANCE_MARGIN_BPS,
      washMinTrades: WASH_MIN_TRADES,
      washMaxProgressBps: WASH_MAX_PROGRESS_BPS,
      devDumpSellFractionBps: DEV_DUMP_SELL_FRACTION_BPS,
    },
    chainId: meta.chainId,
    narrative: meta.narrative ?? null,
    cohort: cohort.map((t) => ({
      address: t.address,
      symbol: t.symbol,
      deployedAt: t.deployedAt,
      deployedAtIso: iso(t.deployedAt),
      progressBps: t.progressBps,
      buyCount: t.buyCount,
      sellCount: t.sellCount,
      tradeCount: t.tradeCount,
      graduated: t.graduated,
      creator: t.creator,
      socials: t.socials,
      ...(t.description !== undefined ? { description: t.description } : {}),
    })),
    resolution: {
      verdict: resolution.verdict,
      token: resolution.token?.address ?? null,
      reasons: resolution.reasons,
      washSuspect: resolution.washSuspect,
      devDumped: resolution.devDumped,
      scores: resolution.scores,
    },
    socialsComparison: cohort.map((t) => ({
      address: t.address,
      socials: t.socials,
      matchesNarrative: meta.narrative ? socialsMatch(t.socials, meta.narrative) : null,
    })),
  };
  return { bundle, evidenceHash: hashEvidenceBundle(bundle) };
}
