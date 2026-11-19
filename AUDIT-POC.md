# AUDIT-POC — Foundry proofs of the critical attack paths

Fase 1 includes Foundry proofs (not a full audit) for the two attack
paths that matter most: a fake curve stealing buyer ETH, and registry
poisoning. Run with forge 1.9.0:

```bash
cd audit && forge test      # 7/7 pass
```

## What was proven

### PoC 1 — FakeCurvePoC (3 tests)

The attack: an attacker deploys a contract implementing the Pons curve
interface and tries to get the router to send a victim's ETH to it.

- `testUnregisteredFakeCurveRevertsNotLaunched` — the fake curve is not
  in the factory registry, so `buyVerified` reverts `NotLaunched` before
  any ETH moves. Buyer keeps 100 ETH, fake curve gains 0, no fee
  accrues. (The caller cannot even NAME a curve to the router — the
  factory record is the only path.)
- `testRegisteredHonestCurveAllowsBuy` — positive control: once the
  factory records the curve, the buy goes through (fee exactly 0.3%,
  tokens at the curve's rate). The check is the REGISTRY, not the
  interface.
- `testRegisteredLyingCurveIsCaughtByBalanceDelta` — even a REGISTERED
  curve that transfers 1 token of dust but RETURNS `minTokensOut` cannot
  steal: the router's balance-delta check reverts `SlippageExceeded`
  with the exact values (received 1 ether, min 1000 ether), and the
  revert rolls everything back.

### PoC 2 — RegistryPoisoningPoC (4 tests)

The attack: a compromised keeper key re-points a symbol at a clone.

- `testNonOwnerCannotProposeAPoisonedEntry` — only the owner can propose.
- `testPoisonedProposalIsPublicAndDelayed` — the proposal is publicly
  readable (`getPending` shows the clone target + `executableAt` = now +
  1h), cannot execute early (`TimelockNotExpired` with exact values),
  and the real token stays canonical while the poison waits.
- `testDefensiveFlagCancelsThePoisonedProposal` — a wash flag raised
  during the window cancels the proposal immediately; executing
  afterwards reverts `NoPendingUpdate`.
- `testTimelockDelaysButDoesNotPreventARepoint` — the honest limit: if
  NOBODY acts during the hour, the re-point executes. The timelock buys
  time to react; it is not a veto. (Production ownership should be a
  multisig.)

## Audited copies — byte-identical verification

`audit/src/` holds copies of the audited contracts (forge compiles the
audit tree standalone). They are byte-identical to `contracts/`:

```
f11e6a23998e0e7e3af1ec6ac15f243612abc415f824613ba52408b4a608eed1  VerifiedBuyRouter.sol
45ea045c9f37fe56c852f1f227ef6d0a1503386b91a4a727751a4df598e017db  CanonicalRegistry.sol
3c40ce5c53974daa0a7ce38a2077dd69c11c71a19ced3f9fda0268115f8f2889  IPonsV2LaunchFactory.sol
```

(sha256 of both copies, verified at Fase 1 completion. Re-verify with
`sha256sum contracts/*.sol audit/src/*.sol` after any contract change —
if the hashes diverge, the PoCs are testing stale code.)

## Build note

`audit/foundry.toml` sets `via_ir = true`: `VerifiedBuyRouter` overflows
the stack on forge's legacy pipeline at the `BuyVerified` event
emission (same reason the solc-js build uses viaIR — and the same
setting Pons itself uses). The TS test suite compiles with solc-js +
viaIR + optimizer runs 200; the Foundry build mirrors those settings
(solc 0.8.30, optimizer runs 200, viaIR).

## Not covered (future audit scope)

- A full manual audit (this is a PoC, not an audit).
- The keeper (off-chain, Fase 2) — the resolver's correctness cannot be
  proven by contract tests.
- Mainnet deployment configuration (constructor args, ownership
  handover) — Fase 2 checklist item.
- Gas optimisation review (no gas golfing was done in Fase 1).
