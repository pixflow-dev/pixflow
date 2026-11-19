// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/**
 * @title LyingBuyCurve
 * @notice TEST-ONLY malicious curve for the balance-delta regression test
 * (tests/router.test.ts). It implements the curve interface
 * VerifiedBuyRouter uses, passes every pre-flight check (once registered
 * in the factory stub), and then LIES in buy(): it transfers a tiny
 * amount of tokens to the recipient but RETURNS minTokensOut, claiming
 * it delivered the full minimum.
 *
 * Without the router's ground-truth check (buyer's actual balance delta
 * >= minTokensOut), the router would accept the lie, keep its 0.3% fee,
 * and leave the buyer with almost nothing. With the check, buyVerified
 * reverts SlippageExceeded and the whole transaction rolls back — the
 * buyer loses nothing, not even gas beyond the reverted call.
 *
 * Fund it with tokens (plain ERC-20 transfer) before the test buys
 * through it. It keeps any ETH sent to buy() — but the buy always
 * reverts in the test, so no ETH ever stays.
 */
interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
}

contract LyingBuyCurve {
    address public token;
    address public pairToken; // address(0): native quote
    uint256 public graduationThreshold = 4.2 ether;
    uint256 public feeBps = 100;
    uint256 public creatorTaxBps = 200;
    uint256 public launchedAt; // 0: snipe-tax window already "passed"
    uint256 public snipeTaxSeconds; // 0: no tax window

    constructor(address token_) {
        token = token_;
    }

    receive() external payable {}

    function graduated() external pure returns (bool) {
        return false;
    }

    function readyToGraduate() external pure returns (bool) {
        return false;
    }

    function realQuoteReserve() external pure returns (uint256) {
        return 0.5 ether;
    }

    function getReserves() external pure returns (uint256, uint256) {
        // tokenReserve (1B) must EXCEED sellableTokens (700M), exactly as
        // on a real curve (trackedTokens > trackedTokens - reservedTokens)
        // — otherwise the router's maxSpendFor correctly returns 0.
        return (2.18 ether, 1_000_000_000 ether);
    }

    function sellableTokens() external pure returns (uint256) {
        return 700_000_000 ether;
    }

    function buy(uint256, /* quoteIn */ uint256 minTokensOut, address recipient)
        external
        payable
        returns (uint256)
    {
        // Transfer a single token's worth of dust — but REPORT that the
        // full minimum was delivered.
        IERC20Minimal(token).transfer(recipient, 1 ether);
        return minTokensOut;
    }
}
