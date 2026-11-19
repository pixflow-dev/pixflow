// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// NOTE (Pixflow test harness, 2026-11-19): MINIMAL COMPILE-TIME SHIM, not the
// real Uniswap BaseHook. `@uniswap/v4-hooks-public` is not published to npm
// and the repo is not fetchable from this VM (git over https blocked, raw
// fetch 404s), so the full BaseHook cannot be vendored. This stub provides
// exactly the surface the vendored PonsV2MemeHook needs to compile:
//   - the IPoolManager-typed immutable `poolManager` + constructor
//   - virtual getHookPermissions() / _beforeInitialize() / _afterSwap() with
//     the exact signatures PonsV2MemeHook overrides
// It does NOT implement the IHooks external callbacks (beforeInitialize,
// afterSwap, ...). That is safe for the atomic launch+buy proof: no v4 pool
// exists in the test VM, no swap ever runs, and the launch path only touches
// the hook's fee-policy getters (currentFeePolicy, protocolFeeRecipient) and
// its factory/buybackVault/poolManager/feeEscrow getters, all of which live in
// PonsV2MemeHook itself. Do NOT use this stub for any test that exercises
// post-graduation swaps — vendor the real BaseHook first.

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";

abstract contract BaseHook {
    error NotPoolManager();

    IPoolManager public immutable poolManager;

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    function getHookPermissions() public pure virtual returns (Hooks.Permissions memory);

    function _beforeInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96)
        internal
        virtual
        returns (bytes4)
    {
        sender;
        key;
        sqrtPriceX96;
        return IHooks.beforeInitialize.selector;
    }

    function _afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata hookData
    ) internal virtual returns (bytes4, int128) {
        sender;
        key;
        params;
        delta;
        hookData;
        return (IHooks.afterSwap.selector, 0);
    }
}
