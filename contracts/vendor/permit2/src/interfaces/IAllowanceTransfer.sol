// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// NOTE (Pixflow test harness, 2026-11-19): MINIMAL COMPILE-TIME SHIM. The
// `permit2` npm package was unpublished 2026-08-11, so this interface is
// reproduced here with the declarations the vendored Pons suite and the
// @uniswap/v4-periphery interfaces reference (approve, PermitSingle /
// PermitBatch, allowance, transferFrom, lockdown, invalidateNonce).
// Nothing in the launch+buy path calls Permit2 (graduation is out of scope
// for this proof); the interface exists so the factory/executor and the
// periphery interfaces compile.

interface IAllowanceTransfer {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitSingle {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct PermitBatch {
        TokenPermissions[] permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct AllowanceTransferDetails {
        address from;
        address to;
        uint160 amount;
        address token;
    }

    struct TokenSpenderPair {
        address token;
        address spender;
    }

    function approve(address token, address spender, uint160 amount, uint48 expiration) external;

    function permit(address owner, PermitSingle memory permitSingle, bytes calldata signature) external;

    function permit(address owner, PermitBatch memory permitBatch, bytes calldata signature) external;

    function allowance(address owner, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, uint48 nonce);

    function transferFrom(address from, address to, uint160 amount, address token) external;

    function transferFrom(AllowanceTransferDetails[] calldata transferDetails, address owner, address to)
        external;

    function lockdown(TokenSpenderPair[] calldata approvals) external;

    function invalidateNonce() external;
}
