# RESEARCH — Pons V2 buy mechanics (verified from source)

How `VerifiedBuyRouter` buys from a Pons V2 bonding curve, with every claim
traced to the vendored Pons source (`contracts/vendor/pons/`, unmodified
from Sourcify chain 4663 — the same vendored tree Specta uses). Nothing in
this note is guessed: the buy path was read from the curve contract, not
assumed as the mirror of `sell()`.

## 1. The buy function

`PonsV2BondingCurve.sol:438`:

```solidity
function buy(uint256 quoteIn, uint256 minTokensOut, address recipient)
    external
    payable
    nonReentrant
    onlyInitialized
    returns (uint256 tokensOut)
```

- For a native-ETH launch, `quoteIn` MUST equal `msg.value`
  (`_receiveQuote`, line 646; mismatch reverts `NativeValueMismatch`,
  line 648). The router therefore calls
  `curve.buy{value: spend}(spend, minTokensOut, buyer)`.
- For an ERC-20 quote launch, `msg.value` must be 0 and the curve pulls
  the quote via `transferFrom` (line 646–658). **VBR v1 does not support
  this** — `pairToken != address(0)` reverts `NonNativeQuote`.
- Tokens are sent to `recipient` (`safeTransfer`, line 509), so the
  router passes the BUYER as recipient and never holds tokens.
- `buy` reverts `CurveGraduated` if `graduated` is set (line 445) or if
  `sellable == 0` (line 481) — i.e. buys close once the sellable
  allocation is exhausted, not only after graduation. The router checks
  `graduated() || readyToGraduate()` first and reverts `CurveClosed`.

## 2. Buy pricing — fees come off the INPUT leg

This is the one place buy is NOT the mirror of sell, and getting it wrong
breaks the router's quote to the wei:

- **Sell** (`sell`, line 541): prices with fee 0, then subtracts fee+tax
  from the OUTPUT: `quoteOut = gross - fee - tax`.
- **Buy** (lines 472–479): subtracts fee+tax (+snipe tax) from the INPUT
  FIRST, then prices the remainder:
  ```
  spent = received
  fee   = spent * feeBps / 10000
  tax   = spent * creatorTaxBps / 10000
  snipeTax = spent * snipeTaxBps / 10000
  tokensOut = getAmountOut(spent - fee - tax - snipeTax,
                           quoteReserveBefore, tokenReserveBefore, 0)
  ```
  where `quoteReserveBefore = phantomQuote + trackedQuote
  - quoteFeeBalance - creatorTaxBalance` (line 457) and
  `tokenReserveBefore = trackedTokens` (line 458) — exactly what
  `getReserves()` returns (lines 368–371).

`quoteBuy()` in the router mirrors this exactly (with snipe tax = 0: the
router only executes after the window has passed, so the tax is always 0
at execution time). The test suite asserts the on-chain quote equals an
independent TypeScript mirror to the wei.

The constant-product math is `PonsV2BondingCurveMath.getAmountOut`
(`libraries/PonsV2BondingCurveMath.sol:25`):
```
amountInWithFee = amountIn * (10000 - feeBps)
amountOut = amountInWithFee * reserveOut / (reserveIn * 10000 + amountInWithFee)
```
called with `feeBps = 0` by the curve for both directions.

## 3. Partial fills — the clamp and the refund

Lines 483–499: if the computed `tokensOut` exceeds the sellable
allocation (`tokenReserve - reservedTokens`, `sellableTokens()` line
295), the fill is CLAMPED to `sellable` and the spend is recomputed
from the token side:

```
net   = getAmountIn(sellable, quoteReserveBefore, tokenReserveBefore, 0)
spent = min(ceil(net * 10000 / (10000 - feeBps - creatorTaxBps - snipeTaxBps)),
            received)
```

`getAmountIn` is `libraries/PonsV2BondingCurveMath.sol:73`:
```
amountIn = amountOut * reserveIn * 10000 / ((reserveOut - amountOut) * (10000 - feeBps)) + 1
```
(with `feeBps = 0` the `* 10000` factors cancel exactly in integer
arithmetic — `floor(a*K / (b*K)) == floor(a/b)` — and the `+1` is the
library's own rounding).

The unspent difference is REFUNDED to `msg.sender` (lines 511–515,
`CurveBuyRefunded` event). The router therefore:

1. CAPS its spend at the exact amount that buys the whole sellable
   allocation (`maxSpendFor()`, mirroring the clamp math above including
   the ceiling division), so the curve never needs to refund, and
2. FORWARDS any curve refund to the buyer anyway (measured by balance
   delta), as defense in depth against rounding differences.

## 4. Slippage — the curve uses a PRICE bound, the router a QUANTITY bound

Line 500: `if (spent * minTokensOut > received * tokensOut) revert
SlippageExceeded(tokensOut, minTokensOut)`. When nothing is clamped
(`spent == received`) this reduces to `tokensOut >= minTokensOut`; when
clamped, it is a price bound (the buyer gets fewer tokens at the same
price rather than reverting).

**The router deliberately does NOT adopt the price-bound semantics:**
after the buy it checks the buyer's ACTUAL token balance delta against
`minTokensOut` and reverts `SlippageExceeded` if it falls short. A
buyer who asked for at least X tokens gets X tokens or nothing — the
router fails closed, matching its promise. (With the router's pre-cap,
the curve itself also reverts when `sellable < minTokensOut`, since the
capped spend equals the received amount and the check reduces to the
quantity bound.)

## 5. Snipe tax — window and decay

- `launchedAt` is set in `initialize()` (line 282), i.e. in the launch
  transaction itself. `snipeTaxStartBps` and `snipeTaxSeconds` are
  snapshotted from the factory at the same time (lines 283–284) — each
  launch freezes its own window, so a later factory policy change does
  not affect live curves.
- `currentSnipeTaxBps(recipient)` (lines 315–324): 0 if the recipient is
  exempt, 0 if `startBps == 0`, 0 once `elapsed >= window`; otherwise
  `startBps >> ((elapsed * 14) / window)` — fourteen successive halvings
  spread across the window.
- **Current mainnet factory policy: start 9900 bps, window 3 seconds**
  (verified from $HOOKLB on-chain forensics, 2026-11-18: second 0 ≈ 96%
  effective cap, +1s = 6.18%, +2s = 0.19%, +3s = 0%). The router reads
  `launchedAt` + `snipeTaxSeconds` from the CURVE (ground truth), never
  from the registry and never hardcoded, so a factory window change can
  never desync the check.

## 6. Factory registry — the M-01 authority

`ILaunchpadV2.sol:113` — `LaunchedToken` struct (token, curve, deployer,
creatorFeeRecipient, pairToken, graduationThreshold, poolFee,
tickSpacing, creatorTaxBps, buybackEnabled, phase, sweptQuote,
sweptTokens, sweptAt, exists); `getLaunchedToken(token)` at line 136
(selector `0x3cf28b5a`).

The router asks the FACTORY which curve belongs to a token. A fake curve
can implement every getter, but it cannot insert itself into the
factory's registry. (Specta audit finding M-01: the same check, proven
by the Foundry PoC in `audit/`.)

Mainnet addresses (Robinhood Chain 4663):
- Factory: `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`
- Fee escrow: `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e`
- Router (launch only): `0xe33E9E479dF8802cb0866d5d05258bEc4cF62948`
- Graduation threshold: 4.2 ETH (per-launch `graduationThreshold()`)

## 7. Bytecode fidelity

The vendored `PonsV2BondingCurve` compiles to 10,229 bytes deployed
with solc 0.8.35 + viaIR + optimizer runs 200 — the same size as the
mainnet curve (verified by Specta; the metadata hash differs, the logic
is identical). Tests therefore run against the REAL curve logic, not a
mock.

## 8. What the router does NOT rely on

- The Pons API (off-chain; fee fields unreliable — see Specta).
- The token's `description()`/`logo()`/`socials()` metadata (used by the
  OFF-CHAIN resolver only, see DESIGN.md).
- The registry's `launchedAt` for the tax check (evidence only; the
  curve's own values are authoritative).
- The curve's `buy()` return value (the balance delta is authoritative).
