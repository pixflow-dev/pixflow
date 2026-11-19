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
 *
 * The launch side (TokenParams / Socials / launchTokenFor / launchFee) is
 * the factory's ATOMIC LAUNCH-AND-BUY entrypoint: launchTokenFor exists
 * specifically for "the trusted atomic launch-and-buy router" (factory
 * docstring, PonsV2LaunchFactory.sol) — only the configured launchForwarder
 * may call it, and it takes the real initiating user as originalDeployer
 * (never tx.origin). Struct layouts must match the factory's exactly.
 */
interface IPonsV2LaunchFactory {
    enum GraduationPhase {
        NotGraduated,
        Swept,
        PoolCreated,
        Rescued
    }

    struct Socials {
        string twitter;
        string telegram;
        string discord;
        string website;
        string farcaster;
    }

    struct TokenParams {
        string name;
        string symbol;
        string logo;
        string description;
        Socials socials;
        address creatorFeeRecipient;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        bytes32 expectedEconomics;
        bytes32 salt;
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

    function launchFee() external view returns (uint256);

    function launchTokenFor(
        TokenParams calldata params,
        uint256 launchConfigId,
        address pairToken,
        address originalDeployer,
        address[] calldata snipeTaxExemptions
    ) external payable returns (address token, address curve);
}
