# Vendored Pons V2 sources (UNMODIFIED)

These files are the **real Pons V2 contracts**, downloaded verbatim from
Sourcify (chain 4663, verified source of the PonsV2LaunchFactory
`0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`) on 2026-11-18. They are
MIT-licensed (SPDX headers intact) and are NOT our code — do not edit them.

Why they are here: Pons V2 is **not deployed on RH testnet 46630**, so the
only faithful way to test VerifiedBuyRouter against real Pons behaviour
is to compile the genuine sources and deploy them in unit tests, with
`PonsFactoryStub` (our own test-only contract, `contracts/test/`)
playing the factory's role on testnet, and the REAL factory suite
playing it in the atomic-launch tests (`tests/atomic-launch-buy.test.ts`).

Files compiled by the build (see `scripts/compile-contracts.mjs`, which
resolves imports recursively):
- `contracts/src/v2/PonsV2LaunchFactory.sol` — the factory (launch,
  `launchTokenFor`, registry, wiring checks).
- `contracts/src/v2/PonsV2LaunchDeployer.sol` — CREATE2 deployer for
  curve/token pairs.
- `contracts/src/v2/hooks/PonsV2MemeHook.sol` — the v4 hook / fee policy.
- `contracts/src/v2/PonsV2BuybackVault.sol` — the buyback-and-lock vault.
- `contracts/src/v2/PonsV2LaunchLocker.sol` — the graduation LP locker.
- `contracts/src/v2/PonsV2GraduationExecutor.sol` — the graduation executor.
- `contracts/src/v2/PonsV2GraduationGuard.sol` + `libraries/PonsV2GraduationMath.sol` — seed-viability checks (run at launch).
- `contracts/src/v2/PonsV2BondingCurve.sol` — the curve (sell/buy/pricing).
- `contracts/src/v2/libraries/PonsV2BondingCurveMath.sol` — x·y=k math.
- `contracts/src/v2/PonsV2LauncherToken.sol` — the ERC-20 launch token.
- `contracts/src/v2/interfaces/ILaunchpadV2.sol` — fee-policy interfaces.
- `contracts/src/v2/interfaces/ILaunchpadV2Graduation.sol` — graduation interface.
- `contracts/lib/openzeppelin-contracts/...` — the OZ version Pons compiled
  against (vendored from the same Sourcify response, so the build is
  reproducible without an npm OpenZeppelin dependency).

The Pons tree also imports Uniswap v4 (`@uniswap/v4-core`,
`@uniswap/v4-periphery` — installed from npm as devDependencies) and two
packages that are NOT on npm, for which minimal compile-time shims live
in `contracts/vendor/` (NOT under `pons/`, because they are our code,
not Pons'):
- `uniswap-hooks-public/src/base/BaseHook.sol` — `@uniswap/v4-hooks-public`
  is git-only and not fetchable from this VM; the shim provides the
  `poolManager` immutable + the three virtuals `PonsV2MemeHook`
  overrides. It does NOT implement the IHooks external callbacks — safe
  for launch tests (no pool exists, no swap runs), not for swap tests.
- `permit2/src/interfaces/IAllowanceTransfer.sol` — the `permit2` npm
  package was unpublished 2026-08-11; the shim declares the interface
  surface the Pons suite + periphery reference. Nothing in the
  launch+buy path calls Permit2 (graduation only).

Fidelity check: the curve compiles to exactly 10,229 bytes deployed,
matching the on-chain mainnet deployment size. See RESEARCH.md §7.
