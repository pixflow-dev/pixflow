# MAINNET DEPLOY CHECKLIST — Pixflow (Verified Buy Router)

Do NOT deploy to mainnet until every box is checked. Mainnet is
Robinhood Chain 4663; the Pons V2 factory is
`0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` (verified, same address the
router trusts on-chain). There is no upgradeability: a wrong deploy
means redeploy + re-verify + re-resolve every symbol.

## 0. Pre-conditions (all must be green)

- [ ] `npm test` — all tests pass (63 Fase 1 + keeper/resolver tests).
- [ ] `cd audit && forge test` — 7/7 PoC pass.
- [ ] Testnet E2E green (`data/testnet-e2e.json`: propose → timelock →
      execute → buy → claim → contest all pass).
- [ ] No secrets in the repo: `git grep -iE 'privateKey|mnemonic|api[_-]?key|0x[0-9a-f]{64}'`
      returns only false positives (test keys in `tests/`, artifact
      bytecode). `.env`, `*.key`, `*keystore*.json`, `data/*.json` are
      gitignored — verify with `git status --ignored`.
- [ ] `git log` shows the exact commit being deployed; the deployer
      records the commit hash in the deployment record.

## 1. Ownership decisions (Ivan's calls — decide BEFORE deploy)

- [ ] **Router owner** → Ivan's backed-up wallet. The router owner can
      ONLY change `feeRecipient` (no power over user funds or buys), but
      a lost owner key means the fee destination can never change.
- [ ] **Fee recipient** → Ivan's wallet address, confirmed in writing
      (the address that receives the 0.3% fees via pull-based
      `claimFees()`).
- [ ] **Registry owner** → see §2 below. This is the ONE open design
      decision: read it before choosing.

## 2. Registry ownership — the honest trade-off

The registry owner is a trust point (DESIGN.md §7): it names canonical
tokens and raises flags. The contract's `propose*` / `contest` /
`flag*` functions are `onlyOwner`, and `transferOwnership` is also
`onlyOwner` (two-step: propose → accept).

That creates a real tension:

- **Option A — keeper hot key owns the registry.** The keeper can
  resolve within minutes and flag a dev dump immediately (the product
  requirement). Cost: a compromised keeper key can re-point symbols —
  bounded by the 1h public timelock + public events, but NOT prevented.
  The multisig cannot seize control without the keeper key's
  cooperation (`transferOwnership` is owner-only).
- **Option B — multisig owns the registry.** No single key can
  re-point a symbol. Cost: every proposal and every flag needs multisig
  signatures — minutes become hours, and the "flag the dump NOW"
  property is lost. The keeper becomes an advisor, not an operator.
- **Option C (recommended before mainnet, needs a contract change) —
  KeeperOperator contract.** Registry owner = multisig; a small
  operator contract holds `propose`/`contest`/`flag` rights via a
  keeper key, and the multisig can revoke the operator at any time.
  Fail-closed actions stay fast, fail-open actions stay timelocked,
  and a compromised keeper key is revocable. This is a v1.1 change:
  it requires a registry redeploy (no upgradeability) and a fresh
  audit pass on the operator contract.

**Do not ship mainnet on Option A without Ivan explicitly accepting
the hot-key trust in writing.** Option C is the honest production
answer; Option B is acceptable only if Ivan accepts slow resolution.

## 3. Deploy sequence (mainnet)

1. Deploy `CanonicalRegistry` (no constructor args). Record address + tx.
2. Deploy `VerifiedBuyRouter(registry, feeRecipient, PONS_FACTORY)`.
   Constructor reverts unless registry + factory have code — a wrong
   factory address fails the deploy, it cannot silently misconfigure.
3. On-chain sanity reads (before announcing anything):
   - `router.FEE_BPS()` == 30, `router.feeRecipient()` == Ivan's wallet,
     `router.ponsFactory()` == `0x7eD...C7e`, `router.registry()` ==
     the deployed registry.
   - `registry.TIMELOCK_DELAY()` == 3600, `registry.owner()` == deployer
     (until handover).
   - `router.quoteBuy()` on a live mainnet curve returns a sane number
     (read-only, no tx).
4. Transfer registry ownership (two-step):
   `transferOwnership(newOwner)` → `acceptOwnership()` from the new
   owner. Verify `registry.owner()` changed. NEVER transfer to an
   address that cannot call `acceptOwnership`.
5. Set the router fee recipient if it differs from the deploy arg:
   `setFeeRecipient()` (owner-only, future fees only).

## 4. Blockscout source verification

Verify BOTH contracts on https://robinhoodchain.blockscout.com
(verified source is the open-source promise — Ivan's requirement):

- Compiler: solc **0.8.35**, **viaIR enabled**, optimizer **runs 200**
  (same as `scripts/compile-contracts.mjs` — a mismatch changes the
  bytecode and verification fails).
- Sources: `contracts/VerifiedBuyRouter.sol`,
  `contracts/CanonicalRegistry.sol`,
  `contracts/IPonsV2LaunchFactory.sol` (exact files from the deployed
  commit — no edits after deploy).
- Constructor args: registry = `0x` (none); router = ABI-encoded
  `(registry, feeRecipient, ponsFactory)`.
- After verification, confirm the "Read Contract" tab shows the same
  values as §3 step 3.

## 5. Keeper go-live (mainnet)

- [ ] Keeper runs on a host Ivan controls (NOT this VM for production —
      the VM is a dev box; the keeper key must not live here long-term).
- [ ] Keeper key stored as an env var / secret store, never in the repo.
- [ ] Dry run first: `KEEPER_CHAIN_ID=4663 KEEPER_ALLOW_MAINNET=1 npm run keeper -- --once --dry-run`
      — verify it reads the registry + Pons API and plans the right
      actions with ZERO transactions.
- [ ] Watch mode: `npm run keeper -- --watch` with
      `KEEPER_ALLOW_MAINNET=1`, `POLL_INTERVAL_MS=60000`.
- [ ] Alerting: watch `CanonicalProposed`, `Contested`, `WashFlagged`,
      `DevDumpFlagged`, `UpdateExecuted` events (at minimum a daily
      manual check until automated alerting exists).

## 6. Launch-day checks

- [ ] First symbol resolved + proposed + executed on mainnet (full
      1h timelock observed — do NOT shorten it; it is the product's
      core safety property).
- [ ] First real buy through the router (small amount, Ivan's own
      wallet): tokens arrive, fee is exactly 0.3%, refund (if any) is
      exact.
- [ ] Website console points at the MAINNET router/registry addresses
      (update `site/console.src.js` CONFIG — testnet addresses must not
      ship to production).
- [ ] Announce only after the first buy is verified on-chain.

## 7. What mainnet does NOT have (say it plainly)

- **No global pause.** The router has no pause function. To halt ALL
  buys, every resolved symbol must be contested (one `contest()` tx
  per symbol). If a fast global halt is required, that is a v1.1
  contract change (redeploy).
- **No keeper redundancy.** One keeper process = one point of failure
  for resolution speed (not for fund safety — a dead keeper only means
  no NEW resolutions; existing entries keep working, and
  `executeUpdate()` is permissionless).
- **No automatic dispute handling.** A wrong canonical verdict is
  corrected by a new proposal + 1h timelock, or immediately by
  `contest()`. There is no on-chain appeal process.

## 8. Kill criteria (DESIGN.md §8 — re-check monthly)

- <50 executed buys in month 1.
- Pons adds an "original" badge + its own buy routing.
- Resolution disputes >10% of symbols.
- Keeper cost > fee income for 2 consecutive months.
