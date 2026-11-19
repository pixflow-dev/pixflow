# DESIGN — Pixflow (Verified Buy Router)

Architecture, the on-chain/off-chain split, the resolver rules, and the
threat model. Fase 1 (this repo) is the contracts + test suite only. The
keeper and the website are Fase 2.

## 1. The problem (measured demand)

Clone chaos is the largest measurable user loss on Pons: 332 buys into
dead DCTY clones and 891 buys into 8 MEOW clones with no winner (19 Nov
2026, Pons API, counted exactly), ~99 duplicate symbols per day. Pons
shows all clones equally plus a text warning; GMGN labels risk but does
not block; DexScreener sorts by liquidity, so the clone wins. Nobody
EXECUTES a buy that is verified first — that is the gap.

## 2. Architecture

```
Buyer ── buyVerified(token | symbol, minTokensOut) + ETH ──► VerifiedBuyRouter
                                                                │
                    ┌───────────────────────────────────────────┼───────────────────────┐
                    │ 1. Factory: getLaunchedToken(token).curve │ (M-01: only authority)│
                    │ 2. Registry: canonical? contested? flags? │ (keeper verdict)      │
                    │ 3. Curve: native quote? open? tax window? │ (on-chain truth)      │
                    │ 4. Quote + cap from live reserves         │ (curve's own math)    │
                    └───────────────────────────────────────────┼───────────────────────┘
                                                                │ all pass
                                                                ▼
                                              PonsV2BondingCurve.buy{value: spend}
                                              (spend, minTokensOut, buyer)
                                              tokens ──► buyer directly
                                              refund ──► buyer (same tx)
                                              0.3% fee ──► feesOwed[feeRecipient]
```

Three contracts, three trust domains:

| Contract | Who writes it | What it decides | Trust assumption |
|---|---|---|---|
| `VerifiedBuyRouter` | nobody after deploy (owner only changes `feeRecipient`) | whether THIS buy executes, and the exact ETH/token flow | code (audited by tests + PoC) |
| `CanonicalRegistry` | keeper (owner) | which token is canonical per symbol; wash/dev flags | keeper honesty + 1h timelock + public events |
| Pons factory + curve | Pons | which curve belongs to a token; pricing; tax window | Pons protocol (already trusted by every buyer) |

The router NEVER decides canonical-ness itself: socials matching and
narrative attribution are not computable on-chain. The keeper computes
the verdict off-chain from on-chain facts; the registry publishes it;
the router enforces it. That split is deliberate and is the honest
answer to "who decides what's real?" — a human-operated resolver with a
public, timelocked, auditable record, not a black box.

## 3. The resolver rules (off-chain keeper, Fase 2)

The keeper resolves a symbol to a canonical token from ON-CHAIN FACTS
ONLY — it never verifies creator claims (that was the round-3 kill, and
this design answers it by not verifying claims at all):

1. **Earliest `deployed_at`** — the first launch of the symbol is the
   default candidate (DCTY: the first clone launched was the one that
   graduated).
2. **Progress dominance** — the candidate must lead the cohort in
   graduation progress by a clear margin. A later token that overtook
   the first is a signal, not a verdict on its own.
3. **Socials match** — the token's on-chain metadata (website/X in
   `description()`/`socials()`) must match the narrative source (the
   tweet, the project site, the announcement that started the wave).
   This is the TAURO lesson: a squatter launched BEFORE the real
   project, so "earliest" alone would have picked the squatter.
4. **Graduation status** — a graduated token is canonical by definition
   for its symbol (the market settled it); a graduated clone wave means
   the losers stay losers.

**Revert, don't guess:** if no token clearly wins (MEOW: 8 clones, max
389 bps, no leader; TAURO-style squatter-vs-real races), the keeper
marks the symbol CONTESTED and the router reverts every buy. A missed
buy costs the user nothing; a wrong buy costs them everything.

**Wash detection** (flag `washSuspect`): abnormal trade/progress ratio —
the PARIMATCH pattern (635 trades at 0% progress). Many trades with no
progress means wash volume, not demand. Thresholds are keeper policy,
recorded in the evidence bundle (see §5).

**Dev-dump detection** (flag `devDumped`): the dev/creator wallets sold
the majority of their position (tracked from launch buy + transfers).
A dev who dumped is not coming back; buys stop.

**Speed requirement:** the resolver must resolve within MINUTES of a
wave starting. A correct verdict that arrives after buyers already
bought the clone is worthless. (Round-6 risk #4 — the keeper is the
product's hardest operational problem, not the contracts.)

## 4. The registry timelock — asymmetric by design

- **Fail-CLOSED is immediate:** `contest()`, `flagWash()`,
  `flagDevDump()` take effect in the same transaction. These can only
  BLOCK buys. When a dev is dumping NOW, the registry must stop buys
  NOW, not in an hour.
- **Fail-OPEN is timelocked (1 hour):** `proposeCanonical()` and
  `proposeClearFlags()` wait 1h before `executeUpdate()` can run. These
  UNBLOCK buys, so they wait — in full public view (`getPending()` shows
  the target token and the earliest execution time).
- **A defensive action cancels a pending proposal.** A flag raised after
  a proposal can never be silently cleared by that proposal executing
  later. Invariant, tested: a pending proposal can only execute if no
  defensive action happened since it was proposed.
- **Execution is permissionless:** anyone may call `executeUpdate()`
  after the timelock. The timelock, not the caller, is the protection.

## 5. Evidence bundles

Every registry change carries an `evidenceHash` — the keccak256 of the
off-chain evidence bundle (the resolver's inputs: Pons API snapshots,
progress readings, socials comparison, trade-pattern analysis). The
bundle itself lives off-chain (IPFS in production); the hash on-chain
makes the verdict checkable after the fact. A keeper that cannot show
its evidence for a verdict is a keeper that should not be trusted.

## 6. Fee model

- Buyer pays **0.3% (30 bps) ONLY on an executed buy**. Every revert
  happens before any fee accrues; a failed buy costs the user gas only.
- The fee is a **constant**, not settable — it cannot be raised later.
- The fee is computed on the ETH sent (`msg.value`), integer division
  rounds DOWN (the buyer keeps the dust).
- Fees accrue **pull-based** (`feesOwed` + `claimFees()`, Specta L-03):
  a feeRecipient that rejects ETH can never brick buys.
- In the rare capped-buy case (buyer sends more than the remaining
  sellable allocation), unspent ETH is refunded in the same tx; the fee
  stays 0.3% of the amount sent (documented honestly in the README).
- **Who pays whom:** the buyer pays the fee; Ivan pays $0 (contracts +
  keeper + site run on free tiers, same pattern as Specta).

## 7. What the router guarantees (and what it does not)

Guaranteed by code, tested:
- A buy executes ONLY for the registered canonical token of its symbol,
  only on a real Pons curve (factory-verified), only after the snipe-tax
  window, only when no wash/dev flag is set, only while the curve is
  open, and only if the buyer actually receives ≥ `minTokensOut`.
- Tokens go straight to the buyer; the router never holds tokens.
- The router cannot send user ETH anywhere except: the curve (the buy)
  and back to the buyer (the refund). The only other ETH it ever holds
  is accrued fees, claimable only by the feeRecipient.
- A reverted buy moves nothing (atomicity) and accrues no fee.

NOT guaranteed (stated plainly):
- **The registry can be wrong.** A keeper error or a compromised keeper
  key can point a symbol at a clone — after a 1h public timelock. The
  timelock buys time to react; it is not a veto. Mitigations: multisig
  ownership in production, public evidence bundles, community watchers
  on the `CanonicalProposed` event.
- **The resolver can be slow.** If a wave starts and the keeper takes
  30 minutes to resolve, early buyers get no protection (they buy
  directly, or wait). Speed is an operational target, not a contract
  property.
- **Some buyers WANT clones.** Deliberate clone buyers (cheap entry,
  "the clone might pump too") are not served by this product — it serves
  careful buyers, who are a minority. That is the honest market sizing.
- **The router does not protect against a bad token, only a wrong one.**
  The canonical token can still dump 50% after graduation (graduates do,
  routinely). VBR answers "is this the real DCTY?", not "is DCTY a good
  buy?".

## 8. Kill criteria (round 6, unchanged)

- <50 executed buys in month 1.
- Pons adds an "original" badge + its own buy routing.
- Resolution disputes >10% of symbols.
- Keeper cost > fee income for 2 consecutive months.

## 9. Fase 2 (not in this repo yet)

- Keeper: resolver service (watches Pons launches, resolves symbols,
  proposes registry updates, flags wash/dev-dump) + evidence bundles.
- Website: live clone-wave feed, per-symbol resolver reasoning, every
  executed buy as shareable proof. (Brand name + logo come from Ivan —
  see BRANDING.md.)
- Testnet end-to-end (the testnet deployer is nearly empty; needs a
  faucet top-up first) and a mainnet deploy checklist.
- Production ownership: registry owner → multisig; router owner →
  Ivan's backed-up wallet (owner can only change `feeRecipient`).

## 10. Atomic launch+buy (PROVEN 19 Nov 2026)

One transaction through the router both LAUNCHES a Pons token and
buys it — `launchAndBuy(params, launchConfigId, pairToken,
snipeTaxExemptions, minTokensOut)` — so the creator's opening buy
lands in the launch block, ahead of snipers. Proven in
`tests/atomic-launch-buy.test.ts` (11 tests) against the REAL vendored
Pons factory suite in the local VM (Pons is not on RH testnet, so no
testnet proof is possible): the launch leg deploys a genuine
factory-registered token+curve pair, the buy leg delivers EXACTLY the
tax-free amount (verified against a reference curve with identical
initial reserves), and a non-exempt sniper buying in the same second
loses ~99% to the snipe tax (the control that shows what the atomic
buy avoids).

Why it works (all three are Pons design, not luck):
1. The factory has a dedicated entrypoint for this — `launchTokenFor`,
   documented as "Launches for the initiating user of the trusted
   atomic launch-and-buy router". Only the configured `launchForwarder`
   may call it, and it takes the real initiating user as
   `originalDeployer` (never `tx.origin`).
2. The snipe tax is charged on the RECIPIENT, not the caller
   (`currentSnipeTaxBps(recipient)`), and `launchTokenFor`
   auto-exempts the originalDeployer (and the creator fee recipient).
   The buy's recipient is the caller, so it pays no snipe tax even in
   the launch second — when the tax peaks at 99%.
3. The launch fee (0.0005 ETH on mainnet, read live) is forwarded
   exactly; the router's 0.3% fee applies to the BUY leg only.

The canonical decision: a token launched in the same transaction is
canonical-BY-CONSTRUCTION for that buy only — it did not exist before
this tx, so there is no clone to confuse it with. The buy leg
therefore skips the registry canonical check AND the snipe-tax window
check (a just-launched token is always inside the window), and the
launch does NOT write to the registry: the keeper must still observe
the token and register it (with the timelock) before anyone else can
buy it through `buyVerified`. The skipped window check is backed by a
defense-in-depth read: the router verifies
`curve.snipeTaxExempt(caller)` on-chain before buying, so a factory
behaviour change fails closed with `TaxWindow` instead of executing a
99% taxed buy. The buy leg shares `_executeBuy` with `buyVerified`
(same fee, quote, spend cap, balance-delta slippage check, refund) —
the only difference is which checks gate entry.

Shipping caveat (permissioned dependency): on mainnet the Pons
factory owner must set this router as `launchForwarder` — the router
cannot do that for itself, and Pons' own router already offers
launchAndBuy. Until that is granted, `launchAndBuy` reverts
`NotLaunchForwarder` on mainnet (proven by test). The feature is
worth shipping only if that grant is obtained; without it the router
is buy-only, which is still the core product.

What is real vs stubbed in the proof: factory, launch deployer, meme
hook, buyback vault, launch locker, graduation executor, graduation
guard, bonding curve and launcher token are ALL real vendored source
(the curve still compiles to exactly 10,229 B deployed, matching
mainnet). Stubbed only: the Uniswap v4 singletons (PoolManager /
PositionManager / Permit2 — launch never calls them), the fee escrow
(no implementation vendored; a faithful minimal ledger — launch+buy
never calls it), and two compile-time shims (`BaseHook`,
`IAllowanceTransfer` — see their file headers; the hook's swap
callbacks are out of scope for this proof). Launch terms are the live
mainnet values (config 0, 0.0005 ETH fee, 9900 bps / 3s snipe tax).
