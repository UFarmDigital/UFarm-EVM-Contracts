// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {IUFarmPermissions} from "./IUFarmPermissions.sol";
import {IUFarmVaultAdminEvents} from "../vault/UFarmVaultEvents.sol";

interface IUFarmVaultAdmin is IUFarmPermissions, IUFarmVaultAdminEvents {
    function terminate() external;
    function setFees(uint256 managementFee_, uint256 performanceFeeSchedule_) external;
    /// @notice Updates the public deposit investment range in USD WAD.
    /// @param minDeposit Minimum allowed public deposit value in USD WAD.
    /// @param maxDeposit Maximum allowed public deposit value in USD WAD.
    function setInvestmentRange(uint256 minDeposit, uint256 maxDeposit) external;
    function setClientTier(uint8 newTier) external;
    function clientTier() external view returns (uint8);
    function setTransferRestricted(bool restricted) external;
    function transferRestricted() external view returns (bool);
    /// @notice Returns the public deposit investment range in USD WAD.
    /// @return minDeposit Minimum allowed public deposit value in USD WAD.
    /// @return maxDeposit Maximum allowed public deposit value in USD WAD.
    function investmentRange() external view returns (uint256 minDeposit, uint256 maxDeposit);
    function fees() external view returns (uint256 managementFee, uint256 performanceFeeSchedule);
}
