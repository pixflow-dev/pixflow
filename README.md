# Pixflow

**Buy the REAL Pons token — or revert with a clear reason.**

Every narrative wave on Pons spawns a flock of clones: 332 buys went
into dead DCTY clones and 891 buys into 8 MEOW clones with no winner
(19 Nov 2026, counted exactly from the Pons API). Pons shows all clones
equally. This router checks before it buys — canonical token, wash
trading, snipe-tax window, dev dump — and executes the buy on the curve
only if every check passes. Otherwise it reverts with a specific reason
and your ETH never leaves your wallet.

**Status: Fase 1 — contracts + test suite.** No mainnet deploy, no
testnet deploy yet (local E2E on the ethereumjs VM only). No token at
launch. Keeper + website are Fase 2. Brand name is Pixflow (chosen
19 Nov 2026, see BRANDING.md); logo still awaited from Ivan.

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
npm test                    # 63 tests, node:test on @ethereumjs/vm
```

**63/63 pass** — 28 registry + 35 router, including: happy-path buy
math exact to the wei (fee, quote, refund), every revert reason, the
M-01 fake-curve rejection, the balance-delta defense against a lying
curve, the spend-cap / partial-fill path, the snipe-tax window (both a
long window and the real 3s window), reentrancy from the refund path,
and pull-based fees.

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
  (working name only until Ivan shares the real name + logo).

## Repo map

```
contracts/          VerifiedBuyRouter.sol, CanonicalRegistry.sol, IPonsV2LaunchFactory.sol
contracts/vendor/   Pons V2 sources (unmodified, Sourcify)
contracts/test/     PonsFactoryStub, LyingBuyCurve, ReentrantBuyer (test-only)
scripts/            compile-contracts.mjs (solc-js + viaIR, optimizer runs 200)
src/                contracts.ts (GENERATED — do not edit)
tests/              vm.ts (ethereumjs harness + time control), router.test.ts, registry.test.ts
audit/              Foundry PoCs (byte-identical contract copies + mocks)
```

## License

MIT — see [LICENSE](LICENSE).
