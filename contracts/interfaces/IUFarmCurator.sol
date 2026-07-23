// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {IUFarmPermissions} from "./IUFarmPermissions.sol";

interface IUFarmCurator is IUFarmPermissions {
    function initialize(address core_, address owner, bytes32 curatorSalt_) external;
    function core() external view returns (address);
    function curatorSalt() external view returns (bytes32);
    function createVault(
        bytes32 userSalt,
        address vaultOwner,
        string calldata name,
        string calldata symbol,
        address asset
    ) external returns (address vault);
    function isVault(address vault) external view returns (bool);
    function setVaultOperator(address vault, address operator, bool approved) external returns (bool);
    function requestVaultRedeem(address vault, uint256 shares) external returns (uint256 requestId);
    function claimVaultRedeem(address vault, address receiver) external returns (uint256 assets);
}
