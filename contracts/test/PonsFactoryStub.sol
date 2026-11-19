// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../IPonsV2LaunchFactory.sol";

/**
 * @title PonsFactoryStub
 * @notice TEST-ONLY stand-in for PonsV2LaunchFactory, adapted from the
 * Specta repo (~/workspace/exit-executor/contracts/test/PonsFactoryStub.sol).
 * Pons V2 is NOT deployed on Robinhood Chain testnet 46630 (verified: 0
 * bytes of code at the factory address), so unit tests deploy the REAL
 * PonsV2BondingCurve contract with this stub playing the factory's role.
 *
 * The curve only needs three things from its factory:
 *   - snipeTaxStartBps() / snipeTaxSeconds() — read by initialize().
 *     CONFIGURABLE here (setSnipeTax) so the tax-window tests can run
 *     with a real 3-second window (mainnet value) or with 0 (disabled).
 *     Default 0/0 (no snipe tax), matching the Specta stub.
 *   - graduate(address) — called by _tryAutoGraduate() inside buy(), wrapped
 *     in try/catch by the curve, so this no-op is safe.
 *   - initialize() forwarding — initialize() is onlyFactory, so the stub
 *     (which IS the factory as far as the curve is concerned) forwards it.
 *
 * The stub also stands in for feePolicy (feeSweepOperator), feeEscrow
 * (credit/creditToken) and buybackVault in the curve constructor, because
 * the constructor only requires non-zero addresses. Those paths are never
 * exercised by buy-side tests (buyback is disabled, sweeps are not called).
 *
 * REGISTRY (Specta audit fix M-01): the stub additionally implements the
 * factory's getLaunchedToken() registry, so VerifiedBuyRouter's curve
 * verification runs end-to-end exactly as it will on mainnet — there is
 * NO address(0) skip in the router. Test launches are recorded with
 * registerLaunch(), called by the test harness after initializeCurve().
 * A curve that was never registered is rejected by buyVerified, which is
 * how the M-01 regression test proves the fix.
 *
 * NEVER deploy this stub on mainnet and NEVER point VerifiedBuyRouter at
 * a curve whose factory is this stub outside of tests: on mainnet, buys
 * must reference real Pons curves deployed by the real factory.
 */
interface IPonsCurveInit {
    function initialize(address token) external;
}

contract PonsFactoryStub {
    mapping(address token => IPonsV2LaunchFactory.LaunchedToken) private _launchedTokens;

    uint256 private _snipeTaxStartBps;
    uint256 private _snipeTaxSeconds;

    /**
     * @notice Set the snipe-tax parameters curves snapshot at initialize().
     * Call BEFORE initializeCurve for the values to take effect on that
     * curve. Test-only: on mainnet these are factory policy (currently
     * start 9900 bps, window 3 seconds — verified from HOOKLB forensics).
     */
    function setSnipeTax(uint256 startBps, uint256 seconds_) external {
        _snipeTaxStartBps = startBps;
        _snipeTaxSeconds = seconds_;
    }

    function snipeTaxStartBps() external view returns (uint256) {
        return _snipeTaxStartBps;
    }

    function snipeTaxSeconds() external view returns (uint256) {
        return _snipeTaxSeconds;
    }

    function graduate(address) external {}

    function feeSweepOperator() external view returns (address) {
        return address(this);
    }

    function initializeCurve(address curve, address token) external {
        IPonsCurveInit(curve).initialize(token);
    }

    /**
     * @notice Record a test launch in the registry, mirroring what the real
     * factory does at launch time. Only token/curve/exists are populated —
     * those are the fields VerifiedBuyRouter reads. Calling it twice for
     * the same token OVERWRITES the record (used by the lying-curve test
     * to point a token at a malicious curve the factory "knows").
     */
    function registerLaunch(address token, address curve) external {
        IPonsV2LaunchFactory.LaunchedToken storage rec = _launchedTokens[token];
        rec.token = token;
        rec.curve = curve;
        rec.exists = true;
    }

    function getLaunchedToken(address token)
        external
        view
        returns (IPonsV2LaunchFactory.LaunchedToken memory)
    {
        return _launchedTokens[token];
    }

    function credit(address) external payable {}

    function creditToken(address, address, uint256) external {}
}
