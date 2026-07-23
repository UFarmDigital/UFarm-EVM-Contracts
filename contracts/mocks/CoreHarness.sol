// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {DeterministicSalts} from "../libraries/DeterministicSalts.sol";
import {DeterministicDeployer} from "../libraries/DeterministicDeployer.sol";
import {PauseMask} from "../libraries/PauseMask.sol";
import {Permissions} from "../libraries/Permissions.sol";

contract CoreHarness {
    function hasPermission(uint256 mask, uint256 permissionMask) external pure returns (bool) {
        return Permissions.hasAll(mask, permissionMask);
    }

    function hasAnyPermission(uint256 mask, uint256 permissionMask) external pure returns (bool) {
        return Permissions.hasAny(mask, permissionMask);
    }

    function grant(uint256 mask, uint256 permission) external pure returns (uint256) {
        return Permissions.grant(mask, permission);
    }

    function revoke(uint256 mask, uint256 permission) external pure returns (uint256) {
        return Permissions.revoke(mask, permission);
    }

    function isPaused(uint256 mask, uint256 bit) external pure returns (bool) {
        return PauseMask.isPaused(mask, bit);
    }

    function fullProtocolPause() external pure returns (uint256) {
        return PauseMask.FULL_PROTOCOL_PAUSE;
    }

    function depositRequestsPaused() external pure returns (uint256) {
        return PauseMask.DEPOSIT_REQUESTS_PAUSED;
    }

    function claimsPaused() external pure returns (uint256) {
        return PauseMask.CLAIMS_PAUSED;
    }

    function curatorSalt(address curatorOwner, bytes32 userSalt) external pure returns (bytes32) {
        return DeterministicSalts.curatorSalt(curatorOwner, userSalt);
    }

    function vaultSalt(address curatorProxyAddress, bytes32 userSalt) external pure returns (bytes32) {
        return DeterministicSalts.vaultSalt(curatorProxyAddress, userSalt);
    }

    function createXSalt(address deployer, bytes32 logicalSalt) external pure returns (bytes32) {
        return DeterministicSalts.createXSalt(deployer, logicalSalt);
    }

    function guardedSalt(bytes32 logicalSalt) external view returns (bytes32) {
        return DeterministicDeployer.guardedSalt(logicalSalt);
    }

    function deployCreate3(address createX, bytes32 logicalSalt, bytes memory initCode)
        external
        returns (address deployed)
    {
        return DeterministicDeployer.deployCreate3(createX, logicalSalt, initCode);
    }

    function coreCuratorRegistrar() external pure returns (uint256) {
        return Permissions.CORE_CURATOR_REGISTRAR;
    }

    function admin() external pure returns (uint256) {
        return Permissions.ADMIN;
    }

    function member() external pure returns (uint256) {
        return Permissions.MEMBER;
    }

    function curatorVaultCreator() external pure returns (uint256) {
        return Permissions.CURATOR_VAULT_CREATOR;
    }
}
