// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/**
 * @title ReentrantBuyer
 * @notice TEST-ONLY malicious buyer for the reentrancy regression test
 * (tests/router.test.ts). It buys through VerifiedBuyRouter with an
 * amount large enough to trigger the cap refund, then tries to re-enter
 * buyVerified() from its receive() while the refund is being paid.
 *
 * The router's single-slot reentrancy guard must reject the inner call
 * with Reentrant — the test asserts the recorded revert selector, not
 * just failure, so a missing guard (which would surface a different
 * revert, e.g. CurveClosed on the drained curve) is distinguished.
 */
interface IRouterBuy {
    function buyVerified(address token, uint256 minTokensOut) external payable returns (uint256);
}

contract ReentrantBuyer {
    address public immutable router;
    address public immutable token;
    bool public reentered;
    bool public innerSucceeded;
    bytes4 public innerRevertSelector;

    constructor(address router_, address token_) {
        router = router_;
        token = token_;
    }

    function attack(uint256 minTokensOut) external payable {
        IRouterBuy(router).buyVerified{value: msg.value}(token, minTokensOut);
    }

    receive() external payable {
        reentered = true;
        (bool ok, bytes memory data) = router.call{value: address(this).balance}(
            abi.encodeWithSelector(IRouterBuy.buyVerified.selector, token, 0)
        );
        innerSucceeded = ok;
        if (!ok && data.length >= 4) {
            innerRevertSelector = bytes4(data);
        }
    }
}
