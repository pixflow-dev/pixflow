// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "./IPonsV2LaunchFactory.sol";

/**
 * @notice Minimal stand-in for the Pons V2 launch factory registry — only
 * the getLaunchedToken record the router reads. Registration is
 * permissionless here (the test plays the factory's role); on mainnet
 * only the real factory writes this mapping, which is exactly why the
 * router trusts it.
 */
contract MockFactory {
    mapping(address token => IPonsV2LaunchFactory.LaunchedToken) private _launched;

    function register(address token, address curve) external {
        IPonsV2LaunchFactory.LaunchedToken storage rec = _launched[token];
        rec.token = token;
        rec.curve = curve;
        rec.exists = true;
    }

    function getLaunchedToken(address token)
        external
        view
        returns (IPonsV2LaunchFactory.LaunchedToken memory)
    {
        return _launched[token];
    }
}
