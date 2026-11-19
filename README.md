# Pixflow

**Buy the REAL Pons token — or revert with a clear reason.**

Every narrative wave on Pons spawns a flock of clones: 332 buys went
into dead DCTY clones and 891 buys into 8 MEOW clones with no winner
(19 Nov 2026, counted exactly from the Pons API). Pons shows all clones
equally. This router checks before it buys — canonical token, wash
trading, snipe-tax window, dev dump — and executes the buy on the curve
only if every check passes. Otherwise it reverts with a specific reason
and your ETH never leaves your wallet.

**Status: Fase 2 — keeper + website + console + testnet E2E, all
verified 19 Nov 2026.** Testnet deploy live on Robinhood testnet
(46630); testnet E2E 12/12 green, including a real `buyVerified`
execution with the fee exact to the wei. No mainnet deploy. No token at
launch. Brand name is Pixflow (chosen 19 Nov 2026, see BRANDING.md);
logo received from Ivan the same day (white pixel arrow on navy
`#031045`, `assets/pixflow-logo.png`, used as-is).

## How it works

```
buyVerified(token, minTokensOut) + ETH
  1. Factory check — the curve comes from the Pons factory registry
     (getLaunchedToken), never from the caller. A fake curve cannot
     register itself. (Specta M-01 lesson.)
  2. Native-ETH quote only (v1).
  3. Canonical check — the token must be the REGISTERED canonical token
     for its own on-chain symbol (registry key = keccak256(symbol())).
  4. Not contested, not wash-suspect, not dev-dumped (registry flags).
  5. Curve open (not graduated / not ready to graduate).
  6. Snipe-tax window passed — read from the CURVE (launchedAt +
     snipeTaxSeconds; currently 3s on mainnet).
  → all pass: buy executes on the curve in the same tx. Tokens go
    STRAIGHT to the buyer. Unspent ETH refunded in the same tx.
  → any fail: revert with a clear error (NotCanonical / Contested /
    WashSuspect / TaxWindow / DevDumped / ...). No fee, no movement.
```

Also: `buyVerifiedBySymbol("DCTY", minTokensOut)` — the registry
resolves the symbol to its canonical token, then the same flow runs.

**Fee: 0.3% (30 bps) on executed buys ONLY.** The fee is a constant in
the contract (it cannot be raised later), computed on the ETH sent, and
accrues pull-based (`claimFees()`) so a fee recipient that rejects ETH
can never brick buys. A reverted buy accrues no fee. Who pays whom: the
buyer pays the fee; Ivan pays $0.

## Contracts

| Contract | What it does |
|---|---|
| `contracts/VerifiedBuyRouter.sol` | The router: verification + buy execution + 0.3% fee + refunds. |
| `contracts/CanonicalRegistry.sol` | Keeper-maintained registry: symbol → canonical token + status + flags, with an asymmetric timelock (fail-closed actions immediate, fail-open actions wait 1h). |
| `contracts/IPonsV2LaunchFactory.sol` | Minimal factory interface (the M-01 trust root). |
| `contracts/vendor/pons/` | REAL Pons V2 contracts, vendored unmodified from Sourcify (the curve tests run against genuine curve logic, 10,229 bytes deployed — same as mainnet). |
| `contracts/test/` | Test-only: `PonsFactoryStub` (Pons is not on testnet 46630), `LyingBuyCurve`, `ReentrantBuyer`. |

## Keeper (Fase 2)

The off-chain resolver that decides which token is canonical, from
on-chain facts only (`src/resolver.ts`, service in `src/keeper.ts`,
CLI in `scripts/run-keeper.ts`):

- **Rules, in order** (DESIGN.md §3): graduated token wins → socials
  match (on-chain `description()`/`socials()`) → earliest `deployed_at`
  + progress dominance (needs a ≥10% lead over the runner-up).
- **Fail closed:** ambiguous cohort → CONTESTED, never a guess. Wash
  flags (≥100 trades but ≤0.5% progress — the PARIMATCH pattern) and
  dev-dump flags (creator sold ≥50%) are defensive: they take effect
  immediately. Fail-open proposals wait the 1h timelock.
- **Evidence:** every verdict writes a JSON evidence bundle off-chain
  (`data/evidence/`, gitignored) and submits its keccak256 hash
  on-chain with the proposal, so anyone can re-derive the decision.
- **Live dry-run 19 Nov 2026:** DCTY → CANONICAL (cohort 17, earliest
  token graduated, 448 buys); MEOW → CONTESTED (8-clone wave, max
  389 bps, no leader).

```bash
# dry-run against the Pons API + testnet registry (no tx sent)
npx tsx scripts/run-keeper.ts --once --dry-run
# one live pass (proposes / flags on testnet)
npx tsx scripts/run-keeper.ts --once
# watch loop (default 60s poll)
npx tsx scripts/run-keeper.ts --watch
```

The CLI **refuses mainnet** unless `KEEPER_ALLOW_MAINNET=1` is set
explicitly. Honest limits: dev-dump detection on live data needs an
indexer (the holder-history lookup is not wired yet — the rule is
implemented and unit-tested, the live feed is not); narrative checks
are config-only.

## Website + console (Fase 2)

- **Preview:** https://pixflow-preview.rycore.workers.dev
  (Cloudflare Worker, `wrangler.toml`; redeploy with
  `python3 ~/workspace/custom-connectors/custom.cloudflare/bin/cf-env.py wrangler deploy`).
- **Landing** (`site/index.html`): live clone-wave feed from a Pons API
  snapshot (`site/data/waves.json`, 19 Nov 2026 — DCTY CANONICAL,
  MEOW CONTESTED), per-symbol resolver reasoning, and every executed
  buy as shareable proof. Pixel-flow hero canvas (pixels assembling
  into the arrow) — no particle-network/blobs. Logo small in the nav
  only, never a hero centerpiece.
- **Console** (`site/console.html`): wallet connect (browser extension),
  buy by token address or by symbol, pre-flight panel mirroring the
  router's own check order with the exact revert reason shown, quote
  before signing, receipt + `BuyVerified` event decode, fee claim.
  Testnet 46630 only; mainnet refused (`MAINNET_ENABLED = false`).
  Rebuild after editing: `node site/build-console.mjs`.
- Verified 19 Nov 2026: 0px horizontal overflow at 360px / 320px /
  1280px on both pages (scrollWidth vs clientWidth), 0 console errors.

## Testnet deployment (Fase 2, Robinhood testnet 46630)

Deployed 19 Nov 2026 (`scripts/deploy-testnet.ts`; Pons is not on
testnet, so the factory is the `PonsFactoryStub` — same pattern as
Specta). Snipe tax 9900 bps / 3s (mainnet policy).

| Component | Address |
|---|---|
| PonsFactoryStub | `0x284a6466a30bacd769dfb4ed80369fba72617b0b` |
| PonsV2BondingCurve (test) | `0xce4934d133fd866a3d3f185f40ae39fa484413d5` |
| TPIX (test token, 1B supply) | `0x525205296f9357ddaec95f4834d82d22756da9b9` |
| CanonicalRegistry | `0xce1131be137e07949ee2d8461a15ea0b1ca4bdd7` |
| VerifiedBuyRouter | `0xbbff316971d74aa23c2705a5a25f4451b3e51bd6` |

**E2E 12/12 green** (`scripts/e2e-testnet.ts`, resumable via
`data/testnet-e2e.json`): keeper resolves TPIX → proposeCanonical
(`0x38cf64cc…746a`) → buy-before-timelock reverts → 1h timelock
expires → executeUpdate (`0xc56b48f8…6ce7c`) → entry CANONICAL →
`buyVerifiedBySymbol("TPIX")` executes
(`0x73b7b829…0a0c8`: 28,781.61 TPIX for 0.00004985 ETH, fee exactly
0.3% = 0.00000015 ETH, refund 0) → `claimFees`
(`0xad0b454a…8ae5`, feesOwed back to 0) → MEOW marked CONTESTED
(immediate, fail-closed) → contested buy reverts `Contested`.

Deployer key lives OUTSIDE this repo
(`~/workspace/rycore/data/testnet-deployer.json`, mode 600) and is
never committed. The testnet faucet was HTTP-429 from the VM, so the
E2E ran on the deployer's remaining ~0.00016 ETH — it fit.

## The honest caveats

- **The registry is a trust point.** The keeper decides which token is
  canonical (off-chain, from on-chain facts only — see DESIGN.md). A
  compromised keeper key CAN re-point a symbol at a clone — after a 1h
  timelock, in full public view, and any defensive flag raised in that
  hour cancels the proposal. The timelock buys time to react; it is not
  a veto. Production ownership should be a multisig.
- **The router answers "is this the real DCTY?", not "is DCTY a good
  buy?".** The canonical token can still dump after graduation.
- **Capped buys:** if you send more ETH than the remaining sellable
  allocation, the router buys the whole allocation and refunds the rest
  in the same tx — but the 0.3% fee is still charged on the full amount
  you sent.
- **v1 limits:** native-ETH quotes only; no ERC-20-quoted curves
  (USDG/NVDA); `minTokensOut` is a strict quantity bound (the router
  fails closed where the curve would partially fill at the same price).

## Tests

```bash
npm install
npm run compile:contracts   # solc-js, generates src/contracts.ts
npm test                    # 113 tests, node:test
npx tsc --noEmit            # typecheck (clean)
```

**113/113 pass** — 63 contracts (28 registry + 35 router, on the
ethereumjs VM) + 50 keeper resolver (29 resolver rules + 21 keeper
service, incl. the DCTY/MEOW fixtures from DESIGN.md §1). Contract
coverage includes: happy-path buy math exact to the wei (fee, quote,
refund), every revert reason, the M-01 fake-curve rejection, the
balance-delta defense against a lying curve, the spend-cap /
partial-fill path, the snipe-tax window (both a long window and the
real 3s window), reentrancy from the refund path, and pull-based fees.

Foundry PoCs (`audit/`, forge 1.9.0):

```bash
cd audit && forge test      # 7/7 pass
```

- `FakeCurvePoC`: unregistered fake curve → `NotLaunched`; registered
  honest curve → buy succeeds (the check is the registry); registered
  LYING curve → `SlippageExceeded` (balance-delta defense).
- `RegistryPoisoningPoC`: non-owner cannot propose; a poisoned proposal
  is public + delayed 1h; a defensive flag cancels it; and honestly —
  the timelock delays a re-point, it does not prevent one.

See [AUDIT-POC.md](AUDIT-POC.md) for the PoC write-up and the sha256
verification of the audited copies.

## Docs

- [DESIGN.md](DESIGN.md) — architecture, on-chain/off-chain split,
  resolver rules, threat model, kill criteria.
- [RESEARCH.md](RESEARCH.md) — Pons V2 buy mechanics with source
  file/line references (the buy function is NOT assumed to mirror sell).
- [BRANDING.md](BRANDING.md) — the one place brand identity lives
  (name, logo, palette, motif).
- [MAINNET-CHECKLIST.md](MAINNET-CHECKLIST.md) — what must happen
  before any mainnet deploy (multisig ownership, Blockscout source
  verification, no secrets in repo).

## Repo map

```
contracts/          VerifiedBuyRouter.sol, CanonicalRegistry.sol, IPonsV2LaunchFactory.sol
contracts/vendor/   Pons V2 sources (unmodified, Sourcify)
contracts/test/     PonsFactoryStub, LyingBuyCurve, ReentrantBuyer (test-only)
scripts/            compile-contracts.mjs (solc-js + viaIR, optimizer runs 200)
                    run-keeper.ts (keeper CLI: --once/--watch/--dry-run)
                    deploy-testnet.ts, e2e-testnet.ts (testnet 46630, resumable)
src/                contracts.ts (GENERATED — do not edit)
                    resolver.ts (canonical/contested rules), keeper.ts (service)
                    chains.ts (RH chain defs), errors.ts
tests/              vm.ts (ethereumjs harness + time control), router.test.ts, registry.test.ts
                    resolver.test.ts, keeper.test.ts
site/               landing + console (static; console.bundle.js built by build-console.mjs)
data/               GITIGNORED: deployment + E2E state, keeper evidence bundles
audit/              Foundry PoCs (byte-identical contract copies + mocks)
wrangler.toml       pixflow-preview Worker (site/ as static assets)
```

## License

MIT — see [LICENSE](LICENSE).
