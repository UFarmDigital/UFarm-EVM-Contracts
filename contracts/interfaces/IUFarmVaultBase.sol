// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {VaultTypes} from "../libraries/VaultTypes.sol";
import {IUFarmVaultBaseEvents} from "../vault/UFarmVaultEvents.sol";

interface IUFarmVaultBase is IUFarmVaultBaseEvents {
    function supportsInterface(bytes4 interfaceId) external pure returns (bool);
    function status() external view returns (VaultTypes.VaultStatus);
    function core() external view returns (address);
    function curator() external view returns (address);
    function vaultSalt() external view returns (bytes32);
    function escrow() external view returns (address);
    function asset() external view returns (address);
    function share() external view returns (address);
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function decimals() external pure returns (uint8);
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}
