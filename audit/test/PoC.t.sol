// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "forge-std/Test.sol";
import "../src/VerifiedBuyRouter.sol"; // byte-identical copy of ../../contracts/VerifiedBuyRouter.sol (sha256 verified, see AUDIT-POC.md)
import "../src/CanonicalRegistry.sol"; // byte-identical copy of ../../contracts/CanonicalRegistry.sol
import "../src/FakeCurve.sol";
import "../src/MockFactory.sol";
import "../src/MockToken.sol";

/**
 * PoC 1 — THE FAKE-CURVE ATTACK (Specta M-01 lesson, buy side).
 *
 * The attack: an attacker deploys a contract implementing the Pons curve
 * interface and tries to get VerifiedBuyRouter to send a victim's ETH to
 * it. The router derives the curve from the PONS FACTORY registry only —
 * the caller never supplies a curve address — so the attack fails at the
 * first check: the fake curve is not registered, buyVerified reverts
 * NotLaunched, and no ETH moves.
 *
 * The positive control proves the check is the REGISTRY, not the
 * interface: once the factory records the curve, the router buys through
 * it. And the lying-curve test proves the SECOND layer: even a registered
 * curve that lies about its return value cannot steal, because the router
 * verifies the buyer's actual balance delta (SlippageExceeded).
 *
 * Run: cd audit && forge test --match-contract FakeCurvePoC -vvv
 */
contract FakeCurvePoC is Test {
    MockToken token;
    FakeCurve fakeCurve;
    FakeCurve lyingCurve;
    MockFactory factory;
    CanonicalRegistry registry;
    VerifiedBuyRouter router;

    address user = address(0x1001);
    address attacker = address(0xA77A);
    address feeRecipient = address(0xFEE);

    bytes32 constant SYMBOL_HASH = keccak256("TREAL");
    bytes32 constant EVIDENCE = bytes32(uint256(0x44));

    function setUp() public {
        token = new MockToken("Test Real", "TREAL", 1_000_000_000 ether);
        fakeCurve = new FakeCurve(address(token), false);
        lyingCurve = new FakeCurve(address(token), true);
        factory = new MockFactory();
        registry = new CanonicalRegistry();
        router = new VerifiedBuyRouter(address(registry), feeRecipient, address(factory));

        // Fund both fake curves with tokens to dispense.
        token.transfer(address(fakeCurve), 500_000_000 ether);
        token.transfer(address(lyingCurve), 500_000_000 ether);

        // Register the token as canonical for TREAL (propose + warp 1h + execute).
        registry.proposeCanonical(SYMBOL_HASH, address(token), uint64(block.timestamp), EVIDENCE);
        vm.warp(block.timestamp + 3601);
        registry.executeUpdate(SYMBOL_HASH);

        vm.deal(user, 100 ether);
    }

    function testUnregisteredFakeCurveRevertsNotLaunched() public {
        // The fake curve is NOT in the factory registry, so the buy must
        // be rejected before any ETH moves — the caller cannot even name
        // a curve to the router; the factory record is the only path.
        vm.prank(user);
        vm.expectRevert(VerifiedBuyRouter.NotLaunched.selector);
        router.buyVerified{value: 0.1 ether}(address(token), 0);

        // Nothing moved.
        assertEq(user.balance, 100 ether, "buyer keeps all ETH");
        assertEq(token.balanceOf(user), 0, "buyer got no tokens");
        assertEq(address(fakeCurve).balance, 0, "fake curve gains nothing");
        assertEq(router.feesOwed(feeRecipient), 0, "no fee accrued");
    }

    function testRegisteredHonestCurveAllowsBuy() public {
        // Positive control: the check is the REGISTRY. Once the factory
        // records this curve for the token, the buy goes through.
        factory.register(address(token), address(fakeCurve));

        vm.prank(user);
        uint256 received = router.buyVerified{value: 0.1 ether}(address(token), 0);

        // Fee 0.3% of 0.1 ETH = 0.0003 ETH; net 0.0997 ETH buys at the
        // fake curve's fixed rate of 1M tokens/ETH.
        uint256 expected = (0.0997 ether * 1_000_000 ether) / 1 ether;
        assertEq(received, expected, "tokens received");
        assertEq(token.balanceOf(user), expected, "buyer token balance");
        assertEq(router.feesOwed(feeRecipient), 0.0003 ether, "fee accrued");
    }

    function testRegisteredLyingCurveIsCaughtByBalanceDelta() public {
        // Even REGISTERED, a curve that lies about its return value cannot
        // steal: the router checks the buyer's actual balance delta.
        factory.register(address(token), address(lyingCurve));

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(
                VerifiedBuyRouter.SlippageExceeded.selector, 1 ether, 1000 ether
            )
        );
        router.buyVerified{value: 0.1 ether}(address(token), 1000 ether);

        // The revert rolled everything back: no ETH, no tokens, no fee.
        assertEq(user.balance, 100 ether, "buyer keeps all ETH");
        assertEq(token.balanceOf(user), 0, "buyer got no tokens");
        assertEq(address(lyingCurve).balance, 0, "lying curve gains nothing");
        assertEq(router.feesOwed(feeRecipient), 0, "no fee accrued");
    }
}

/**
 * PoC 2 — REGISTRY POISONING (the centralization caveat, made concrete).
 *
 * The registry owner is a trust point: a compromised keeper CAN re-point
 * a symbol at a clone. What the timelock buys is TIME + TRANSPARENCY:
 * the re-point is a public, on-chain proposal for a full hour before it
 * can execute, anyone can see exactly which token it points at, and any
 * defensive action (contest / flag) in that hour CANCELS it. These tests
 * prove each of those properties — and prove honestly that the timelock
 * DELAYS a malicious re-point, it does not prevent one.
 *
 * Run: cd audit && forge test --match-contract RegistryPoisoningPoC -vvv
 */
contract RegistryPoisoningPoC is Test {
    MockToken realToken;
    MockToken cloneToken;
    CanonicalRegistry registry;

    address keeper = address(0xBEEF);
    address attacker = address(0xA77A);

    bytes32 constant SYMBOL_HASH = keccak256("TREAL");
    bytes32 constant EVIDENCE = bytes32(uint256(0x44));

    function setUp() public {
        realToken = new MockToken("Test Real", "TREAL", 1_000_000_000 ether);
        cloneToken = new MockToken("Test Real Clone", "TREAL", 1_000_000_000 ether);
        // The test contract deploys the registry, so it is the owner.
        registry = new CanonicalRegistry();

        // Register the REAL token as canonical.
        registry.proposeCanonical(SYMBOL_HASH, address(realToken), uint64(block.timestamp), EVIDENCE);
        vm.warp(block.timestamp + 3601);
        registry.executeUpdate(SYMBOL_HASH);
    }

    function testNonOwnerCannotProposeAPoisonedEntry() public {
        vm.prank(attacker);
        vm.expectRevert(CanonicalRegistry.NotOwner.selector);
        registry.proposeCanonical(SYMBOL_HASH, address(cloneToken), uint64(block.timestamp), EVIDENCE);
    }

    function testPoisonedProposalIsPublicAndDelayed() public {
        // The (compromised) owner proposes the clone as canonical.
        registry.proposeCanonical(SYMBOL_HASH, address(cloneToken), uint64(block.timestamp), EVIDENCE);

        // The proposal is PUBLICLY READABLE: anyone can see the target
        // token and the earliest execution time before it can take effect.
        CanonicalRegistry.PendingUpdate memory p = registry.getPending(SYMBOL_HASH);
        assertTrue(p.exists, "proposal exists");
        assertEq(p.token, address(cloneToken), "proposal targets the clone");
        assertEq(p.executableAt, block.timestamp + 3600, "1h timelock");

        // It cannot execute early.
        vm.expectRevert(
            abi.encodeWithSelector(
                CanonicalRegistry.TimelockNotExpired.selector,
                block.timestamp + 3600,
                block.timestamp
            )
        );
        registry.executeUpdate(SYMBOL_HASH);

        // The real token is still canonical while the poison waits.
        assertEq(registry.getEntry(SYMBOL_HASH).token, address(realToken));
        assertEq(uint8(registry.getEntry(SYMBOL_HASH).status), 1); // CANONICAL
    }

    function testDefensiveFlagCancelsThePoisonedProposal() public {
        registry.proposeCanonical(SYMBOL_HASH, address(cloneToken), uint64(block.timestamp), EVIDENCE);

        // Anyone watching the proposal can ask the keeper to flag — and the
        // flag takes effect IMMEDIATELY and cancels the pending proposal.
        registry.flagWash(SYMBOL_HASH, EVIDENCE);

        vm.warp(block.timestamp + 3601);
        vm.expectRevert(CanonicalRegistry.NoPendingUpdate.selector);
        registry.executeUpdate(SYMBOL_HASH);

        // The real token is still canonical, now wash-flagged (buys blocked).
        CanonicalRegistry.Entry memory e = registry.getEntry(SYMBOL_HASH);
        assertEq(e.token, address(realToken));
        assertTrue(e.washSuspect, "wash flag set");
    }

    function testTimelockDelaysButDoesNotPreventARepoint() public {
        // Honest statement of the limit: if NOBODY acts during the hour,
        // the re-point executes. The timelock buys time to react — it is
        // not a veto. (This is why production ownership should be a
        // multisig and the keeper key must be guarded like a treasury key.)
        registry.proposeCanonical(SYMBOL_HASH, address(cloneToken), uint64(block.timestamp), EVIDENCE);
        vm.warp(block.timestamp + 3601);
        registry.executeUpdate(SYMBOL_HASH);

        CanonicalRegistry.Entry memory e = registry.getEntry(SYMBOL_HASH);
        assertEq(e.token, address(cloneToken), "re-point executed after the timelock");
        assertEq(uint8(e.status), 1); // CANONICAL
    }
}
