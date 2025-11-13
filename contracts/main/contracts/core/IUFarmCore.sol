// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.24;

import {IFundFactory} from "../fund/FundFactory.sol";
import {IPoolFactory} from "../pool/PoolFactory.sol";
import {ICoreWhitelist} from "./ICoreWhitelist.sol";

interface IUFarmCore is ICoreWhitelist {
    /**
     * @dev Returns the total number of funds in the UFarm ecosystem.
     */
    function fundsCount() external view returns (uint256);

    /**
     * @dev Retrieves the address of a specific fund by its index.
     */
    function getFund(uint256) external view returns (address);

    /**
     * @dev Checks if a given address is a recognized fund in the UFarm ecosystem.
     */
    function isFund(address) external view returns (bool);

    /**
     * @dev Returns the address of the price oracle used in the UFarm ecosystem.
     */
    function priceOracle() external view returns (address);

    /**
     * @dev Returns the instance of the FundFactory contract used by UFarm.
     */
    function fundFactory() external view returns (IFundFactory);

    /**
     * @dev Returns the instance of the PoolFactory contract used by UFarm.
     */
    function poolFactory() external view returns (IPoolFactory);

    /**
     * @dev Checks whether the UFarm protocol is currently paused.
     */
    function isPaused() external view returns (bool);

    /**
     * @dev Returns the required cooldown period after pool actions.
     */
    function postActionDelay() external view returns (uint256);

    /**
     * @dev Toggles the paused state of the UFarm protocol.
     */
    function switchPause() external;

    /**
     * @dev Retrieves the current protocol commission rate, expressed as a mantissa.
     */
    function protocolCommission() external view returns (uint256);

    /**
     * @dev Returns the minimum deposit amount required for a fund to be active.
     */
    function minimumFundDeposit() external view returns (uint256);

    /**
     * @dev Returns permission flag for using ArbitraryController in the pools of a given fund
     */
    function isAllowedArbitraryController(address fund) external view returns (bool);

    /// GETTERS

    /**
     * @dev Callable only by the UFarm member with `Moderator` permission
     * @param _fundManager - address of the fund manager
     * @param _applicationId - internal id of the application
     */
    function createFund(address _fundManager, bytes32 _applicationId) external returns (address fund);

    /**
     * @dev Sets the minimum fund deposit amount required for activating a Pool.
     * @param _minimumFundDeposit The minimum deposit amount in USDT.
     */
    function setMinimumFundDeposit(uint256 _minimumFundDeposit) external;

    /**
     * @dev Sets the protocol commission rate.
     * @param _protocolCommission The commission rate, expressed as a mantissa.
     */
    function setProtocolCommission(uint256 _protocolCommission) external;

    /**
     * @dev Sets the required cooldown period after pool actions.
     * @param _postActionDelay The cooldown duration in seconds.
     */
    function setPostActionDelay(uint256 _postActionDelay) external;

    /**
     * @dev Updates the permissions for a specified UFarm member.
     * @param _member The address of the member whose permissions are to be updated.
     * @param _newPermissionsMask The new permissions mask to be applied.
     */
    function updatePermissions(address _member, uint256 _newPermissionsMask) external;

    /**
     * @notice Allows managers to withdraw assets from the contract
     * @dev Used to withdraw protocol commission. Arrays length should be equal
     * @param _tokens - array of tokens to withdraw
     * @param _amounts - array of amounts to withdraw
     */
    function withdrawAssets(address[] calldata _tokens, uint256[] calldata _amounts) external;
}
