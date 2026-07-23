// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

interface IUFarmEscrow {
    function core() external view returns (address);

    function creditFrom(address asset, address from, address beneficiary, uint256 amount, uint64 lockedTill) external;

    function releaseTo(address asset, address beneficiary, address to, uint256 amount) external;
    function releaseToVault(address asset, address beneficiary, uint256 amount) external;
    function unlock(address asset, address beneficiary) external;
    function withdraw(address vault, address asset, uint256 amount, address to) external;

    function balanceOf(address vault, address asset, address beneficiary)
        external
        view
        returns (uint256 amount, uint64 lockedTill);
}
