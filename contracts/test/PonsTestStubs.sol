// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// Test doubles for the Pons factory suite's EXTERNAL dependencies — contracts
// the Pons source references but does not ship:
//   - PoolManager / PositionManager / Permit2: Uniswap v4 singletons (their
//     real implementations are out of scope; launch never calls them — the
//     factory only stores their addresses and cross-checks them at wiring
//     time; the executor/hook call them only at graduation / on swaps).
//   - FeeEscrow: Pons' escrow implementation is not in the vendored source
//     (only IPonsV2FeeEscrow). This stub is a faithful minimal ledger:
//     credit/creditToken record balances, balanceOf/balanceOfToken read them,
//     claim/claimToken pay them out. Launch+buy never calls it (the launch
//     fee goes straight to the protocol fee recipient; curve fees accrue
//     internally until sweepFees, which is out of scope here).
// The Pons contracts themselves (factory, deployer, hook, vault, locker,
// executor, guard, curve, token) are ALL real vendored source.

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
// Absolute (project-rooted) import: resolves to the same solc source key the
// Pons tree itself uses, so the stub implements the canonical interface.
import {IPonsV2FeeEscrow} from "contracts/src/v2/interfaces/ILaunchpadV2.sol";

contract StubPoolManager {}

contract StubPositionManager {
    IPoolManager public immutable poolManager;

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
    }
}

contract StubPermit2 {}

contract StubFeeEscrow is IPonsV2FeeEscrow {
    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _tokenBalances;

    function credit(address recipient) external payable override {
        _balances[recipient] += msg.value;
    }

    function creditToken(address recipient, address token, uint256 amount) external override {
        _tokenBalances[recipient][token] += amount;
    }

    function claim() external override returns (uint256 amount) {
        amount = _balances[msg.sender];
        _balances[msg.sender] = 0;
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        require(ok, "transfer failed");
    }

    function claim(uint256 amount) external override returns (uint256) {
        require(_balances[msg.sender] >= amount, "insufficient balance");
        _balances[msg.sender] -= amount;
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        require(ok, "transfer failed");
        return amount;
    }

    function claimToken(address token) external override returns (uint256 amount) {
        amount = _tokenBalances[msg.sender][token];
        _tokenBalances[msg.sender][token] = 0;
        (bool ok,) = token.call(abi.encodeWithSignature("transfer(address,uint256)", msg.sender, amount));
        require(ok, "transfer failed");
    }

    function claimToken(address token, uint256 amount) external override returns (uint256) {
        require(_tokenBalances[msg.sender][token] >= amount, "insufficient balance");
        _tokenBalances[msg.sender][token] -= amount;
        (bool ok,) = token.call(abi.encodeWithSignature("transfer(address,uint256)", msg.sender, amount));
        require(ok, "transfer failed");
        return amount;
    }

    function balanceOf(address recipient) external view override returns (uint256) {
        return _balances[recipient];
    }

    function balanceOfToken(address recipient, address token) external view override returns (uint256) {
        return _tokenBalances[recipient][token];
    }

    receive() external payable {}
}
