// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "./IPonsV2LaunchFactory.sol";
import "./CanonicalRegistry.sol";

/**
 * @title VerifiedBuyRouter
 * @notice Buy the REAL Pons token — or revert with a clear reason.
 *
 * A buyer calls buyVerified(token, minTokensOut) (or buyVerifiedBySymbol
 * with the symbol string) and sends ETH. Before ANY ETH moves, the router
 * checks, in order:
 *   1. The token is a real Pons V2 launch — the curve is read from the
 *      PONS FACTORY registry (getLaunchedToken), never from the caller.
 *      A fake curve cannot register itself (Specta audit finding M-01).
 *   2. The curve quotes in native ETH (v1 limitation, same as Specta).
 *   3. The token is the REGISTERED CANONICAL token for its own on-chain
 *      symbol (the registry key is keccak256 of the token's symbol(),
 *      so a caller cannot smuggle in a different symbol).
 *   4. The symbol is not CONTESTED, not wash-suspect, not dev-dumped.
 *   5. The curve is still tradeable (not graduated / not ready).
 *   6. The snipe-tax window has passed — read from the CURVE itself
 *      (launchedAt + snipeTaxSeconds), the ground truth. Currently 3
 *      seconds on mainnet (verified); reading it from the curve means a
 *      factory window change can never desync the check.
 * Any failure reverts with a specific custom error and the buyer's ETH
 * never leaves their wallet.
 *
 * On success the buy executes against the curve in the SAME transaction:
 * tokens go STRAIGHT to the buyer (recipient = buyer — the router never
 * holds tokens), and the router takes a 0.3% fee on the ETH sent, ONLY
 * when the buy executes. Fees accrue pull-based (claimFees, Specta L-03
 * pattern) so a feeRecipient that rejects ETH can never brick buys.
 *
 * Buy mechanics (see RESEARCH.md for the Pons source references):
 * - The curve's buy() takes the 1% trade fee + creator tax OFF THE INPUT
 *   LEG (unlike sell(), which takes them off the output). quoteBuy()
 *   mirrors that exactly, so the router's pre-flight quote matches the
 *   curve's execution to the wei.
 * - The router CAPS the spend at the exact amount that buys the whole
 *   remaining sellable allocation (computed from live reserves with the
 *   curve's own getAmountIn math + gross-up), so the curve never needs
 *   to refund. Any unspent ETH is refunded to the buyer immediately.
 *   A curve refund (rounding dust, if a future curve version changes
 *   rounding) is ALSO forwarded to the buyer — measured by balance delta,
 *   never trusted from the curve's return value.
 * - Slippage is verified against the BALANCE DELTA the buyer actually
 *   received, not the curve's reported tokensOut (the buy-side equivalent
 *   of Specta's L-01 defense): a curve that lies about its return value
 *   cannot make the router accept fewer tokens than minTokensOut.
 * - NOTE: minTokensOut is a QUANTITY bound here, not the curve's native
 *   price bound. If the curve cannot deliver minTokensOut tokens at all
 *   (fewer sellable than the minimum), the buy reverts instead of
 *   partially filling — the router fails closed, matching its promise.
 *
 * What the router does NOT do: it does not decide WHICH token is canonical
 * — that is the keeper + CanonicalRegistry's job (off-chain resolver, see
 * DESIGN.md). The router enforces the registry's verdict on-chain; a wrong
 * registry entry is a keeper failure, mitigated by the registry's 1h
 * timelock + public events, not by this contract.
 */
contract VerifiedBuyRouter {
    uint256 public constant FEE_BPS = 30; // 0.3% of the executed buy value
    uint256 public constant BPS = 10_000;

    error ZeroAmount();
    error InvalidToken();
    error NotLaunched();
    error NonNativeQuote();
    error NotCanonical();
    error Contested();
    error WashSuspect();
    error DevDumped();
    error CurveClosed();
    error TaxWindow();
    error QuoteUnavailable();
    error SlippageExceeded(uint256 received, uint256 minTokensOut);
    error NothingToClaim();
    error TransferFailed();
    error UnexpectedEther();
    error NotOwner();
    error ZeroAddress();
    error Reentrant();

    event BuyVerified(
        address indexed buyer,
        address indexed token,
        address indexed curve,
        bytes32 symbolHash,
        uint256 ethSpent,
        uint256 tokensReceived,
        uint256 fee,
        uint256 refund
    );
    event FeeRecipientUpdated(address indexed previousRecipient, address indexed newRecipient);
    event FeesClaimed(address indexed recipient, uint256 amount);

    address public immutable owner;
    // Keeper-maintained canonical registry (read-only from here).
    ICanonicalRegistry public immutable registry;
    // Pons V2 launch factory (mainnet 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    // the PonsFactoryStub on testnet). Its getLaunchedToken registry is the
    // authority for which curve belongs to which token (Specta M-01).
    // Immutable and required (no address(0) skip): a router that cannot
    // verify curves must not exist.
    address public immutable ponsFactory;
    address public feeRecipient;

    // Accrued, unclaimed 0.3% fees per recipient (Specta L-03 pattern).
    // Accrual is per recipient at execution time, so a later
    // setFeeRecipient cannot redirect fees already earned.
    mapping(address => uint256) public feesOwed;

    // Reentrancy guard (single storage slot; no OpenZeppelin dependency so
    // this contract stays self-contained and easy to audit).
    uint256 private _status;
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    // Curve currently being bought from during buyVerified().
    // receive() only accepts ETH from this address, so stray ETH can never
    // strand here. (A force-feed via selfdestruct could still strand ETH —
    // by design there is no rescue function; refunds are computed from
    // measured balance deltas, never from the raw balance, so accounting
    // is unaffected.)
    address private _executingCurve;

    modifier nonReentrant() {
        if (_status == _ENTERED) revert Reentrant();
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }

    constructor(address registry_, address feeRecipient_, address ponsFactory_) {
        if (registry_ == address(0) || registry_.code.length == 0) revert ZeroAddress();
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        if (ponsFactory_ == address(0) || ponsFactory_.code.length == 0) revert ZeroAddress();
        owner = msg.sender;
        registry = ICanonicalRegistry(registry_);
        feeRecipient = feeRecipient_;
        ponsFactory = ponsFactory_;
        _status = _NOT_ENTERED;
    }

    /**
     * @notice The owner may redirect future fees (e.g. to Ivan's mainnet
     * wallet at launch). This changes ONLY where the 0.3% fee goes — it
     * confers no power over user funds or buy execution.
     */
    function setFeeRecipient(address newRecipient) external {
        if (msg.sender != owner) revert NotOwner();
        if (newRecipient == address(0)) revert ZeroAddress();
        emit FeeRecipientUpdated(feeRecipient, newRecipient);
        feeRecipient = newRecipient;
    }

    /**
     * @notice Buy `token` with the sent ETH, after all verification checks.
     * Tokens go straight to the caller; unspent ETH (fee excluded) is
     * refunded in the same transaction.
     * @param token Pons V2 token to buy (must be the registered canonical
     * token for its own symbol).
     * @param minTokensOut Minimum tokens the buyer accepts (QUANTITY bound
     * — see the contract-level notice). Reverts SlippageExceeded if the
     * buyer actually receives less.
     * @return received Tokens the buyer actually received (balance delta).
     */
    function buyVerified(address token, uint256 minTokensOut)
        external
        payable
        nonReentrant
        returns (uint256 received)
    {
        return _buy(token, minTokensOut);
    }

    /**
     * @notice Buy by symbol: the registry resolves the symbol to its
     * canonical token, then the same checks + execution run. The token's
     * own on-chain symbol is re-verified inside _buy, so a registry entry
     * pointing at a token whose symbol does not match still reverts.
     * @param symbol Exact on-chain symbol string (case-sensitive).
     */
    function buyVerifiedBySymbol(string calldata symbol, uint256 minTokensOut)
        external
        payable
        nonReentrant
        returns (uint256 received)
    {
        bytes32 symbolHash = keccak256(bytes(symbol));
        CanonicalRegistry.Entry memory entry = registry.getEntry(symbolHash);
        if (entry.status == CanonicalRegistry.Status.CONTESTED) revert Contested();
        if (entry.status != CanonicalRegistry.Status.CANONICAL || entry.token == address(0)) {
            revert NotCanonical();
        }
        return _buy(entry.token, minTokensOut);
    }

    function _buy(address token, uint256 minTokensOut) internal returns (uint256 received) {
        if (msg.value == 0) revert ZeroAmount();
        if (token == address(0) || token.code.length == 0) revert InvalidToken();

        // M-01: the factory registry is the ONLY authority for which curve
        // belongs to a token. The caller never supplies a curve address,
        // so a fake curve can never be smuggled in — it cannot register
        // itself in the factory.
        IPonsV2LaunchFactory.LaunchedToken memory launch =
            IPonsV2LaunchFactory(ponsFactory).getLaunchedToken(token);
        if (!launch.exists || launch.curve == address(0)) revert NotLaunched();
        IPonsV2BondingCurve curve = IPonsV2BondingCurve(launch.curve);

        // v1: native-ETH quote curves only (USDG/NVDA-quoted curves are
        // rejected; ERC-20 quote support is a later phase).
        if (curve.pairToken() != address(0)) revert NonNativeQuote();

        // Canonical check: the registry key comes from the token's OWN
        // on-chain symbol — a caller cannot claim a token is the canonical
        // "DCTY" when its symbol says otherwise.
        bytes32 symbolHash = keccak256(bytes(IERC20Metadata(token).symbol()));
        CanonicalRegistry.Entry memory entry = registry.getEntry(symbolHash);
        if (entry.status == CanonicalRegistry.Status.CONTESTED) revert Contested();
        if (entry.status != CanonicalRegistry.Status.CANONICAL || entry.token != token) revert NotCanonical();
        if (entry.washSuspect) revert WashSuspect();
        if (entry.devDumped) revert DevDumped();

        // The curve must still be tradeable: buys close once the sellable
        // allocation is exhausted (readyToGraduate), not only after the
        // graduated flag is set.
        if (curve.graduated() || curve.readyToGraduate()) revert CurveClosed();

        // Snipe-tax window, read from the CURVE (ground truth): the
        // launch timestamp + window snapshotted at initialize(). The
        // registry keeps its own launchedAt as evidence, but the router
        // never trusts it for this check — a wrong registry value must
        // not let a buy land inside the tax window.
        if (block.timestamp < curve.launchedAt() + curve.snipeTaxSeconds()) revert TaxWindow();

        // Fee: 0.3% of the ETH sent, charged ONLY when the buy executes
        // (every revert above happens before any fee accrues). Integer
        // division rounds DOWN — the buyer keeps the dust.
        uint256 fee = (msg.value * FEE_BPS) / BPS;
        uint256 net = msg.value - fee;

        // Pre-flight quote from live reserves with the curve's own formula.
        // A zero quote (empty reserves, dust input) reverts cleanly here
        // instead of inside the curve with an opaque math error.
        if (quoteBuy(launch.curve, net) == 0) revert QuoteUnavailable();

        // Cap the spend at the exact amount that buys the whole remaining
        // sellable allocation, so the curve never needs to refund us.
        // (The cap uses the same reserves the curve will use — same
        // transaction, no interleaving possible.)
        uint256 spend = net;
        uint256 cap = maxSpendFor(launch.curve);
        if (cap == 0) revert QuoteUnavailable();
        if (spend > cap) spend = cap;

        uint256 buyerTokensBefore = IERC20Metadata(token).balanceOf(msg.sender);
        uint256 ethBefore = address(this).balance;

        _executingCurve = launch.curve;
        // Tokens go STRAIGHT to the buyer (recipient = msg.sender): the
        // router never holds tokens, so there is nothing to steal from it.
        // The return value is deliberately NOT trusted — the balance delta
        // below is the ground truth (buy-side L-01 defense).
        curve.buy{value: spend}(spend, minTokensOut, msg.sender);
        _executingCurve = address(0);

        // Ground-truth slippage check: what the buyer ACTUALLY received.
        // A curve that lies about its return value cannot make the router
        // accept fewer tokens than minTokensOut.
        received = IERC20Metadata(token).balanceOf(msg.sender) - buyerTokensBefore;
        if (received < minTokensOut) revert SlippageExceeded(received, minTokensOut);

        // Refund: (a) the unspent cap remainder, (b) any ETH the curve
        // refunded (measured by balance delta — normally 0, since the cap
        // matches the curve's own clamp math exactly). Both go back to the
        // buyer in the same transaction.
        // ethBefore includes msg.value + prior accrued fees; `spend` left
        // as the buy's value, so anything above (ethBefore - spend) is a
        // curve refund that belongs to the buyer.
        uint256 curveRefund = address(this).balance - (ethBefore - spend);
        uint256 refund = (net - spend) + curveRefund;
        if (refund != 0) _sendEth(msg.sender, refund);

        if (fee != 0) feesOwed[feeRecipient] += fee;
        emit BuyVerified(
            msg.sender, token, launch.curve, symbolHash, spend - curveRefund, received, fee, refund
        );
    }

    /**
     * @notice Pull accrued 0.3% fees. Anyone with a nonzero accrued balance
     * may claim their own (fees accrue per recipient at execution time, so
     * a later setFeeRecipient cannot redirect fees already earned).
     */
    function claimFees() external nonReentrant {
        uint256 amount = feesOwed[msg.sender];
        if (amount == 0) revert NothingToClaim();
        feesOwed[msg.sender] = 0;
        _sendEth(msg.sender, amount);
        emit FeesClaimed(msg.sender, amount);
    }

    /**
     * @notice Expected token output for buying with `quoteIn` ETH into
     * `curve` right now — the same number curve.buy() will deliver if
     * state does not move. Mirrors PonsV2BondingCurveMath.getAmountOut
     * with fee 0 in the math (the curve prices with fee 0, then takes
     * fee+tax off the INPUT leg before pricing — see RESEARCH.md).
     * The snipe tax is NOT included: the router only executes after the
     * window has passed, so it is always 0 at execution time. The result
     * is clamped to the sellable allocation, mirroring the curve's
     * partial-fill behaviour. Returns 0 when unpriceable.
     */
    function quoteBuy(address curveAddr, uint256 quoteIn) public view returns (uint256) {
        if (quoteIn == 0) return 0;
        IPonsV2BondingCurve c = IPonsV2BondingCurve(curveAddr);
        (uint256 quoteReserve, uint256 tokenReserve) = c.getReserves();
        if (quoteReserve == 0 || tokenReserve == 0) return 0;
        uint256 fee = (quoteIn * c.feeBps()) / BPS;
        uint256 tax = (quoteIn * c.creatorTaxBps()) / BPS;
        if (fee + tax >= quoteIn) return 0;
        uint256 netIn = quoteIn - fee - tax;
        uint256 amountInWithFee = netIn * BPS;
        uint256 tokensOut = (amountInWithFee * tokenReserve) / (quoteReserve * BPS + amountInWithFee);
        uint256 sellable = c.sellableTokens();
        if (tokensOut > sellable) tokensOut = sellable;
        return tokensOut;
    }

    /**
     * @notice Exact ETH spend that buys the WHOLE remaining sellable
     * allocation of `curve` right now — the cap _buy applies. Mirrors the
     * curve's own clamp arithmetic (PonsV2BondingCurveMath.getAmountIn
     * with fee 0, grossed up for fee+tax with ceiling division), so a
     * capped buy lands exactly on the allocation boundary with no refund.
     * Returns 0 when the curve has nothing sellable left.
     */
    function maxSpendFor(address curveAddr) public view returns (uint256) {
        IPonsV2BondingCurve c = IPonsV2BondingCurve(curveAddr);
        uint256 sellable = c.sellableTokens();
        if (sellable == 0) return 0;
        (uint256 quoteReserve, uint256 tokenReserve) = c.getReserves();
        if (quoteReserve == 0 || tokenReserve <= sellable) return 0;
        // getAmountIn(sellable, quoteReserve, tokenReserve, 0):
        //   net = sellable * quoteReserve / (tokenReserve - sellable) + 1
        // (the * BPS factors in the library cancel exactly — floor(a*K /
        // (b*K)) == floor(a/b) — and the +1 is the library's own rounding).
        uint256 net = (sellable * quoteReserve) / (tokenReserve - sellable) + 1;
        // Gross up for fee + creator tax, rounding UP exactly like the
        // curve's clamp (Math.mulDiv with Ceil).
        uint256 denom = BPS - c.feeBps() - c.creatorTaxBps();
        if (denom == 0) return 0;
        return (net * BPS + denom - 1) / denom;
    }

    /**
     * @notice Only accepts ETH from the curve currently being bought from
     * (a buy refund). Anything else reverts instead of stranding.
     */
    receive() external payable {
        if (msg.sender != _executingCurve) revert UnexpectedEther();
    }

    function _sendEth(address to, uint256 amount) private {
        (bool sent,) = payable(to).call{value: amount}("");
        if (!sent) revert TransferFailed();
    }
}

/**
 * @notice Minimal interface of a Pons V2 bonding curve
 * (PonsV2BondingCurve.sol, verified source from Sourcify chain 4663).
 * Only the functions VerifiedBuyRouter needs. The buy() signature is
 * the mirror of sell(): buy(quoteIn, minTokensOut, recipient) payable,
 * with quoteIn == msg.value for native-ETH launches.
 */
interface IPonsV2BondingCurve {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient)
        external
        payable
        returns (uint256 tokensOut);
    function token() external view returns (address);
    function pairToken() external view returns (address);
    function realQuoteReserve() external view returns (uint256);
    function graduationThreshold() external view returns (uint256);
    function graduated() external view returns (bool);
    function readyToGraduate() external view returns (bool);
    function getReserves() external view returns (uint256 quoteReserve, uint256 tokenReserve);
    function feeBps() external view returns (uint256);
    function creatorTaxBps() external view returns (uint256);
    function launchedAt() external view returns (uint256);
    function snipeTaxSeconds() external view returns (uint256);
    function sellableTokens() external view returns (uint256);
}

interface IERC20Metadata {
    function symbol() external view returns (string memory);
    function balanceOf(address account) external view returns (uint256);
}
