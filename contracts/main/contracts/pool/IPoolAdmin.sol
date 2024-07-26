// SPDX-License-Identifier: BUSL-1.1

import {IUFarmPool} from './IUFarmPool.sol';
import {Permissions} from '../permissions/Permissions.sol';

pragma solidity ^0.8.0;

interface IPoolAdmin {
	struct PoolConfig {
		uint256 managementCommission;
		uint256 packedPerformanceFee;
		uint256 minInvestment;
		uint256 maxInvestment;
		uint128 withdrawalLockupPeriod;
	}

	/**
	 * @notice Initializes the pool admin contract during the pool creation
	 * @param _settings - Pool parameters
	 * @param _poolAddr - Address of the pool
	 */
	function __init_PoolAdmin(
		IUFarmPool.CreationSettingsWithLinks memory _settings,
		address _poolAddr
	) external;

	/**
	 * @notice Returns pool configuration
	 * @return config - PoolConfig struct
	 */
	function getConfig() external view returns (PoolConfig memory config);

	/**
	 * @notice Returns `true` if the caller has enough permissions to manage the pool funds
	 * @param manager - Address of the fund manager
	 * @return isAble - `true` if the caller has enough permissions to manage the pool funds
	 */
	function isAbleToManageFunds(address manager) external view returns (bool isAble);

	/**
	 * @notice Changes pool status on the connected UFarmPool contract
	 * @param _newStatus - New pool status
	 */
	function changePoolStatus(IUFarmPool.PoolStatus _newStatus) external;

	/**
	 * @notice Reverts if the caller doesn't have pool permission or fund permission
	 * @param _account - address of the account to check permissions
	 * @param _poolPermission - permission in the pool
	 * @param _fundPermission - permission in the fund
	 */
	function checkPoolOrFundPermission(
		address _account,
		Permissions.Pool _poolPermission,
		Permissions.Fund _fundPermission
	) external view;
}
