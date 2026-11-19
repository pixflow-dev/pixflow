// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/**
 * @title FakeCurve
 * @notice Attacker-controlled contract implementing the curve interface
 * VerifiedBuyRouter uses. Two modes:
 * - HONEST (lying = false): buy() transfers tokens at a fixed rate
 *   (1 ETH -> 1,000,000 tokens) and reports the true amount. Used as the
 *   positive control: once the factory REGISTERS this curve, the router
 *   buys through it — proving the check is the registry, not the
 *   interface.
 * - LYING (lying = true): buy() transfers 1 token of dust but RETURNS
 *   minTokensOut, claiming full delivery. Used to prove the router's
 *   balance-delta check catches the lie (SlippageExceeded) even when
 *   the curve IS registered.
 *
 * Fund it with tokens before the test buys through it.
 */
interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
}

contract FakeCurve {
    address public token;
    address public pairToken; // address(0): native quote
    uint256 public graduationThreshold = 4.2 ether;
    uint256 public feeBps = 100;
    uint256 public creatorTaxBps = 200;
    uint256 public launchedAt; // 0: snipe-tax window already "passed"
    uint256 public snipeTaxSeconds; // 0: no tax window
    bool public lying;

    uint256 public constant TOKENS_PER_ETH = 1_000_000 ether;

    constructor(address token_, bool lying_) {
        token = token_;
        lying = lying_;
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
        return (2.18 ether, 1_000_000_000 ether);
    }

    function sellableTokens() external pure returns (uint256) {
        return 700_000_000 ether;
    }

    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient)
        external
        payable
        returns (uint256)
    {
        require(msg.value == quoteIn, "value mismatch");
        if (lying) {
            // Transfer dust, report the full minimum.
            IERC20Minimal(token).transfer(recipient, 1 ether);
            return minTokensOut;
        }
        uint256 tokensOut = (quoteIn * TOKENS_PER_ETH) / 1 ether;
        IERC20Minimal(token).transfer(recipient, tokensOut);
        return tokensOut;
    }
}
