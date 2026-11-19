// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/**
 * @notice Minimal view of the Pons V2 launch factory registry — the
 * authoritative record of which curve belongs to which token.
 *
 * Struct + function copied from the vendored Pons source
 * (contracts/vendor/pons/contracts/src/v2/interfaces/ILaunchpadV2.sol):
 * `IPonsV2LaunchFactory.LaunchedToken` and `getLaunchedToken`. The struct
 * layout must match the factory's exactly (it is ABI-decoded as a tuple),
 * so any change here must be checked against the vendored interface.
 *
 * ExitExecutor asks the FACTORY (never the curve itself) whether a curve
 * is genuine: a fake curve can return any address from its own factory()
 * getter, but it cannot insert itself into the factory's registry
 * (audit finding M-01). The testnet stand-in PonsFactoryStub implements
 * the same function for test launches.
 */
interface IPonsV2LaunchFactory {
    enum GraduationPhase {
        NotGraduated,
        Swept,
        PoolCreated,
        Rescued
    }

    struct LaunchedToken {
        address token;
        address curve;
        address deployer;
        address creatorFeeRecipient;
        address pairToken;
        uint256 graduationThreshold;
        uint24 poolFee;
        int24 tickSpacing;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        GraduationPhase phase;
        uint256 sweptQuote;
        uint256 sweptTokens;
        uint256 sweptAt;
        bool exists;
    }

    function getLaunchedToken(address token) external view returns (LaunchedToken memory);
}
