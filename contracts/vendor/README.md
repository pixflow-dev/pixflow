# Vendored Pons V2 sources (UNMODIFIED)

These files are the **real Pons V2 contracts**, downloaded verbatim from
Sourcify (chain 4663, verified source of the PonsV2LaunchFactory
`0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`) on 2026-11-18. They are
MIT-licensed (SPDX headers intact) and are NOT our code — do not edit them.

Why they are here: Pons V2 is **not deployed on RH testnet 46630**, so the
only faithful way to test VerifiedBuyRouter against real curve behaviour is to
compile the genuine `PonsV2BondingCurve.sol` + `PonsV2LauncherToken.sol` and
deploy them in unit tests, with `PonsFactoryStub` (our own
test-only contract, `contracts/test/`) playing the factory's role.

Files used by the build (the rest of the factory tree is present for
reference but not compiled):
- `contracts/src/v2/PonsV2BondingCurve.sol` — the curve (sell/buy/pricing).
- `contracts/src/v2/libraries/PonsV2BondingCurveMath.sol` — x·y=k math.
- `contracts/src/v2/PonsV2LauncherToken.sol` — the ERC-20 launch token.
- `contracts/src/v2/interfaces/ILaunchpadV2.sol` — fee-policy interfaces.
- `contracts/src/v2/interfaces/ILaunchpadV2Graduation.sol` — graduation interface.
- `contracts/src/v2/PonsV2BuybackVault.sol` — imported by the curve (type only).
- `contracts/lib/openzeppelin-contracts/...` — the OZ version Pons compiled
  against (vendored from the same Sourcify response, so the build is
  reproducible without an npm OpenZeppelin dependency).

Fidelity check: the testnet-deployed curve's runtime bytecode should match
the mainnet curve's code apart from immutable slots (factory/deployer/
creatorTaxBps differ per launch). See RESEARCH.md §7.
