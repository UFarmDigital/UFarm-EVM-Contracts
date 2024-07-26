// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

/// INTERFACES
import {IUFarmCore} from '../core/IUFarmCore.sol';
import {IUFarmPool} from '../pool/IUFarmPool.sol';
import {IPoolAdmin} from '../pool/IPoolAdmin.sol';

/// CONTRACTS
import {UFarmCoreLink} from '../../shared/UFarmCoreLink.sol';

/// LIBRARIES
import {SafeOPS} from '../../shared/SafeOPS.sol';

/**
 * @title IPoolFactory interface
 * @author https://ufarm.digital/
 * @notice Interface for the PoolFactory contract, that creates new pools
 */
interface IPoolFactory {
	/**
	 * @notice Creates a new pool
	 * @param _settings - settings for the pool
	 * @param salt - salt for the pool
	 * @return pool - address of the created pool
	 */
	function createPool(
		IUFarmPool.CreationSettingsWithLinks calldata _settings,
		bytes32 salt
	) external returns (address pool, address poolAdmin);
}

/**
 * @title PoolFactory contract
 * @author https://ufarm.digital/
 * @notice Deployer of new pools for UFarm Funds. Creates new beacon proxies from the UUPS upgradeable proxy.
 * @notice All proxies are linked to the one implementation contract.
 */
contract PoolFactory is IPoolFactory, UFarmCoreLink {
	// Beacon is UUPS upgradeable proxy address, implementation can be upgraded if needed
	address public immutable poolImplementationBeacon;
	address public immutable poolAdminImplBeacon;

	/**
	 * @dev Reverts if caller is not a fund
	 */
	error CallerIsNotFund();

	constructor(address _ufarmCore, address _poolImpl, address _poolAdminImplBeacon) {
		__init__UFarmCoreLink(_ufarmCore);
		poolImplementationBeacon = _poolImpl;
		poolAdminImplBeacon = _poolAdminImplBeacon;
	}

	/// @inheritdoc IPoolFactory
	function createPool(
		IUFarmPool.CreationSettingsWithLinks calldata _settings,
		bytes32 _salt
	) public onlyLinked returns (address pool, address poolAdmin) {
		if (!IUFarmCore(ufarmCore()).isFund(msg.sender)) revert CallerIsNotFund();

		poolAdmin = SafeOPS._safeBeaconCreate2Deploy(poolAdminImplBeacon, _salt, hex'');
		pool = SafeOPS._safeBeaconCreate2Deploy(poolImplementationBeacon, _salt, hex'');

		IPoolAdmin(poolAdmin).__init_PoolAdmin(_settings, pool);
		IUFarmPool(pool).__init_UFarmPool(_settings, poolAdmin);
	}

	function getPoolBySalt(bytes32 _salt) public view returns (address pool, address poolAdmin) {
		poolAdmin = SafeOPS.computeBeaconProxyAddress(poolAdminImplBeacon, _salt, hex'');
		pool = SafeOPS.computeBeaconProxyAddress(poolImplementationBeacon, _salt, hex'');
	}
}
