// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

interface IUFarmPermissions {
    function setPermissionMask(address account, uint256 newMask) external;
    function permissionMask(address account) external view returns (uint256);
    function accountHasPermission(address account, uint256 mask) external view returns (bool);
    function accountHasAnyPermission(address account, uint256 mask) external view returns (bool);
}
