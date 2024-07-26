// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

/// INTERFACES
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IUFarmCore} from '../core/IUFarmCore.sol';
import {IUFarmFund} from './IUFarmFund.sol';
import {IUFarmPool} from '../pool/IUFarmPool.sol';
import {IPoolFactory} from '../pool/PoolFactory.sol';
import {Permissions} from '../permissions/Permissions.sol';

/// CONTRACTS
import {ECDSARecover} from '../../shared/ECDSARecover.sol';
import {NZGuard} from '../../shared/NZGuard.sol';
import {ReentrancyGuardUpgradeable as ReentrancyGuard} from '@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol';
import {UFarmErrors} from '../../shared/UFarmErrors.sol';
import {UFarmPermissionsModel} from '../permissions/UFarmPermissionsModel.sol';
import {UFarmOwnableUUPSBeacon} from '../../shared/UFarmOwnableUUPSBeacon.sol';

/// LIBRARIES
import {EnumerableSet} from '@openzeppelin/contracts/utils/structs/EnumerableSet.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {SafeOPS} from '../../shared/SafeOPS.sol';

/**
 * @title UFarmFund contract
 * @author https://ufarm.digital/
 * @notice Fund contract for the UFarm protocol for managing pools and fund employees permissions
 */
contract UFarmFund is
	IUFarmFund,
	UFarmPermissionsModel,
	Permissions,
	ReentrancyGuard,
	NZGuard,
	UFarmErrors,
	ECDSARecover,
	UFarmOwnableUUPSBeacon
{
	using SafeERC20 for IERC20;
	using EnumerableSet for EnumerableSet.AddressSet;

	/// @notice Struct for the pool and pool admin address
	struct PoolContracts {
		address poolAddr;
		address poolAdmin;
	}

	/**
	 * @notice Native asset address constant
	 */
	address public constant NATIVE_ASSET = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

	/**
	 * @inheritdoc IUFarmFund
	 */
	FundStatus public status;

	/**
	 * @inheritdoc IUFarmFund
	 */
	address public ufarmCore;

	/**
	 * @notice Check if the pool is in the fund
	 *
	 * @return _isPool True if the pool is in the fund
	 */
	mapping(address => bool) public isPool;

	PoolContracts[] private __poolContracts;

	mapping(bytes32 => bool) private __acceptedInvites;

	/// EVENTS
	/**
	 * @notice Emitted when the pool is created
	 * @param name - pool name
	 * @param symbol - pool symbol
	 * @param minInvestment - minimum investment in the pool
	 * @param maxInvestment - maximum investment in the pool
	 * @param managementCommission - management commission
	 * @param packedPerformanceComission - packed performance commission [(step:uint16, fee:uint16)...]
	 * @param withdrawalLockupPeriod - withdrawal lockup period
	 * @param poolId - pool id in the fund
	 * @param pool - pool address
	 * @param poolAdmin - pool admin address
	 */
	event PoolCreated(
		string name,
		string symbol,
		uint256 minInvestment,
		uint256 maxInvestment,
		uint256 managementCommission,
		uint256 packedPerformanceComission,
		uint256 withdrawalLockupPeriod,
		uint256 poolId,
		address pool,
		address poolAdmin
	);

	/**
	 * @notice Emitted when the fund status is changed
	 * @param status - new status of the fund
	 */
	event FundStatusChanged(FundStatus indexed status);

	/**
	 * @notice Emitted when the invitation is accepted
	 * @param inviter - inviter fund employee
	 * @param invitee - invitee fund employee
	 * @param msgHash - hash of the invitation that was accepted
	 */
	event InvitationAccepted(
		address indexed inviter,
		address indexed invitee,
		bytes32 indexed msgHash
	);

	/// ERRORS
	error StatusAlreadySet(FundStatus status);
	error NotAPool(address pool);
	error WrongAsset();
	error InvitationExpired(uint256 deadline, uint256 timeNow);
	error AlreadyMember();
	error EmptyPermissions();

	/// MODIFIERS
	/**
	 * @notice Reverts if the fund is not in the required status
	 * @param _status - required status of the fund
	 */
	modifier requiredStatus(FundStatus _status) {
		_requiredStatus(_status);
		_;
	}

	/**
	 * @notice Reverts if the fund can't manage pools
	 */
	modifier poolManagementAllowed() {
		_poolManagementAllowed();
		_;
	}

	/**
	 * @notice Reverts if the UFarm platform is paused
	 */
	modifier ufarmIsNotPaused() {
		_ufarmIsNotPaused();
		_;
	}

	/**
	 * @notice Reverts if the caller is not the fund owner or have two permissions
	 * @param permission1 - first permission (often membership)
	 * @param permission2 - second permission (often some kind of editor)
	 */
	modifier ownerOrHaveTwoPermissions(uint8 permission1, uint8 permission2) {
		if (!_hasPermission(msg.sender, uint8(Permissions.Fund.Owner))) {
			_checkForPermissions(msg.sender, _twoPermissionsToMask(permission1, permission2));
		}
		_;
	}

	function version() public pure override returns (string memory) {
		return '1.0';
	}

	function name() public pure override(ECDSARecover) returns (string memory) {
		return 'UFarmFund';
	}

	/**
	 * @notice Get the pool address by the pool id
	 *
	 * @return poolContracts struct {poolAddr: address, poolAdmin: address}
	 */
	function getPool(uint256 index) external view returns (PoolContracts memory) {
		return __poolContracts[index];
	}

	/**
	 * @notice Get the list of the pools
	 *
	 * @return _pools List of the pools
	 */
	function getPools() external view returns (PoolContracts[] memory) {
		return __poolContracts;
	}

	/**
	 * @notice Get the count of the pools
	 *
	 * @return _pools Count of the pools
	 */
	function poolsCount() external view returns (uint256) {
		return __poolContracts.length;
	}

	/**
	 * @notice Verifies the invitation to the fund
	 * @param invitation - invitation struct
	 * @param signature - signature of the invitation
	 * @return inviter - address of the inviter or reverts if check failed
	 */
	function verifyInvitation(
		FundMemberInvitation memory invitation,
		bytes memory signature
	) public view returns (address inviter, bytes32 msgHash) {
		msgHash = ECDSARecover.toEIP712MessageHash(DOMAIN_SEPARATOR(), _hashInvitation(invitation));
		inviter = ECDSARecover.recoverAddress(msgHash, signature);

		if (inviter == address(0)) revert ECDSARecover.WrongSignature();

		if (__acceptedInvites[msgHash]) revert UFarmErrors.ActionAlreadyDone();

		if (_hasPermission(invitation.invitee, uint8(Permissions.Fund.Member))) revert AlreadyMember();

		if (invitation.deadline < block.timestamp)
			revert InvitationExpired(invitation.deadline, block.timestamp);

		if (invitation.permissionsMask > 0) {
			_canUpdatePermissions(inviter, invitation.invitee, invitation.permissionsMask);
			// returns inviter with hash
		} else revert EmptyPermissions();
	}

	/**
	 * @notice Accepts the invitation
	 * @param invitation - invitation struct
	 * @param signature - signature of the invitation
	 */
	function acceptInvitation(
		FundMemberInvitation memory invitation,
		bytes memory signature
	) external ufarmIsNotPaused {
		(address inviter, bytes32 msgHash) = verifyInvitation(invitation, signature);
		if (invitation.invitee == msg.sender) {
			__acceptedInvites[msgHash] = true;
			emit InvitationAccepted(inviter, msg.sender, msgHash);
			_updatePermissions(msg.sender, invitation.permissionsMask);
		} else revert NonAuthorized();
	}

	/**
	 * @notice Updates the permissions as mask for the user, replaces the old mask
	 *
	 * @param _user - user address
	 *
	 * @param _newPermissionsMask - new permissions mask
	 */
	function updatePermissions(address _user, uint256 _newPermissionsMask) external ufarmIsNotPaused {
		_canUpdatePermissions(msg.sender, _user, _newPermissionsMask);
		_updatePermissions(_user, _newPermissionsMask);
	}

	/**
	 * @notice Creates a new pool in the fund
	 *
	 * @param _settings - pool creation settings
	 * @param salt - salt for the pool
	 *
	 * @return pool - Pool address
	 */
	function createPool(
		IUFarmPool.CreationSettings memory _settings,
		bytes32 salt
	)
		external
		ufarmIsNotPaused
		ownerOrHaveTwoPermissions(uint8(Permissions.Fund.Member), uint8(Permissions.Fund.CreatePool))
		poolManagementAllowed
		returns (address pool, address poolAdmin)
	{
		(_settings.name, _settings.symbol) = (
			string(abi.encodePacked('UFarm-', _settings.name)),
			string(abi.encodePacked('UF-', _settings.symbol))
		);
		IUFarmPool.CreationSettingsWithLinks memory fullSettings = IUFarmPool
			.CreationSettingsWithLinks({
				params: _settings,
				ufarmCore: ufarmCore,
				ufarmFund: address(this)
			});
		(pool, poolAdmin) = IPoolFactory(IUFarmCore(ufarmCore).poolFactory()).createPool(
			fullSettings,
			salt
		);

		uint256 poolId = __poolContracts.length;
		__poolContracts.push(PoolContracts({poolAddr: pool, poolAdmin: poolAdmin}));
		isPool[pool] = true;

		emit PoolCreated(
			_settings.name,
			_settings.symbol,
			_settings.minInvestment,
			_settings.maxInvestment,
			_settings.managementCommission,
			_settings.packedPerformanceCommission,
			_settings.withdrawalLockupPeriod,
			poolId,
			pool,
			poolAdmin
		);
	}

	/**
	 * @notice Changes the status of the fund
	 * @param newStatus New status of the fund
	 */
	function changeStatus(FundStatus newStatus) external ufarmIsNotPaused {
		if (
			msg.sender == address(ufarmCore) ||
			((newStatus == FundStatus.Active || newStatus == FundStatus.Terminated) &&
				_hasPermission(msg.sender, uint8(Permissions.Fund.Owner)))
		) {
			_changeStatus(newStatus);
		} else revert UFarmErrors.NonAuthorized();
	}

	/**
	 * @notice Deposits to the pool
	 *
	 * @param _pool - pool address
	 * @param _amount - amount of the deposit token that will be deposited
	 */
	function depositToPool(
		address _pool,
		uint256 _amount
	)
		external
		ufarmIsNotPaused
		ownerOrHaveTwoPermissions(uint8(Permissions.Fund.Member), uint8(Permissions.Fund.ManageFund))
		poolManagementAllowed
	{
		_checkPool(_pool);
		SafeOPS._forceApprove(IUFarmPool(_pool).valueToken(), _pool, _amount);
		IUFarmPool(_pool).deposit(_amount);
	}

	/**
	 * @notice Withdraws from the pool
	 *
	 * @param _request - withdrawal request
	 */
	function withdrawFromPool(
		IUFarmPool.SignedWithdrawalRequest calldata _request
	)
		external
		ufarmIsNotPaused
		ownerOrHaveTwoPermissions(uint8(Permissions.Fund.Member), uint8(Permissions.Fund.ManageFund))
		poolManagementAllowed
	{
		_checkPool(_request.body.poolAddr);
		IUFarmPool(_request.body.poolAddr).withdraw(_request);
	}

	//// ASSETS CONTROL
	/**
	 * @notice Withdraws assets from the fund
	 *
	 * @param _token - address of the asset to withdraw
	 * @param _to - address of the recipient
	 * @param _amount - amount of the asset to withdraw
	 */
	function withdrawAsset(
		address _token,
		address _to,
		uint256 _amount
	)
		external
		ufarmIsNotPaused
		ownerOrHaveTwoPermissions(uint8(Permissions.Fund.Member), uint8(Permissions.Fund.ManageFund))
	{
		if (_token == address(0) || isPool[_token]) revert WrongAsset();
		IERC20(_token).safeTransfer(_to, _amount);
	}

	/**
	 * @notice Approves assets to the recipient
	 *
	 * @param _token - address of the asset to approve
	 * @param _recipient - allowed recipient
	 * @param _amount - new allowance
	 */
	function approveAssetTo(
		address _token,
		address _recipient,
		uint256 _amount
	)
		external
		ufarmIsNotPaused
		ownerOrHaveTwoPermissions(uint8(Permissions.Fund.Member), uint8(Permissions.Fund.ManageFund))
	{
		if (_token == NATIVE_ASSET || _token == address(0) || isPool[_token]) revert WrongAsset();
		SafeOPS._forceApprove(_token, _recipient, _amount);
	}

	/**
	 * @inheritdoc IUFarmFund
	 */
	function __init_UFarmFund(address _owner, address _ufarmCore) external checkDelegateCall initializer {
		__UUPSUpgradeable_init();
		__ReentrancyGuard_init();
		__init_UFarmFund_unchained(_owner, _ufarmCore);
	}

	function __init_UFarmFund_unchained(address _owner, address _ufarmCore) internal {
		ufarmCore = _ufarmCore;

		_nonZeroAddress(_owner);
		_updatePermissions(_owner, _FULL_PERMISSIONS_MASK);
	}

	function _changeStatus(FundStatus _status) private {
		if (status == _status) {
			revert StatusAlreadySet(status);
		}

		status = _status;
		emit FundStatusChanged(status);
	}

	function _requiredStatus(FundStatus _status) private view {
		if (status != _status) {
			revert WrongFundStatus(_status, status);
		}
	}

	function _checkPool(address _pool) private view {
		if (!isPool[_pool]) revert NotAPool(_pool);
	}

	function _poolManagementAllowed() private view {
		if (status != FundStatus.Approved && status != FundStatus.Active)
			revert WrongFundStatus(FundStatus.Approved, status);
	}

	function _ufarmIsNotPaused() private view {
		if (IUFarmCore(ufarmCore).isPaused()) revert UFarmIsPaused();
	}

	function _canUpdatePermissions(
		address _updater,
		address _updatee,
		uint256 _newPermissionsMask
	) private view {
		uint256 currentUpdateeMask = _accountMask[_updatee];
		// if update owner permissions
		if (_isPermissionDiff(uint8(Permissions.Fund.Owner), currentUpdateeMask, _newPermissionsMask)) {
			// only owner can grant or revoke owner permissions
			_checkForPermissions(_updater, _permissionToMask(uint8(Permissions.Fund.Owner))); // reverts if caller is not owner
			// owner cant update his own permissions
			if (_updater == _updatee) revert NonAuthorized();
		} else {
			// if not owner
			if (!_hasPermission(_updater, uint8(Permissions.Fund.Owner))) {
				// should be able to grant or revoke permissions
				_checkForPermissions(
					_updater,
					_twoPermissionsToMask(
						uint8(Permissions.Fund.Member),
						uint8(Permissions.Fund.UpdateFundPermissions)
					)
				);
				// revert if want to grant UpdateFundPermissions
				if (
					_isPermissionDiff(
						uint8(Permissions.Fund.UpdateFundPermissions),
						currentUpdateeMask,
						_newPermissionsMask
					)
				) revert NonAuthorized();

				// revert if want to grant permissions that caller doesn't have
				uint256 currentUpdaterMask = _accountMask[_updater];
				uint256 hasBitsNotInCommon = _newPermissionsMask & (~currentUpdaterMask);

				if (hasBitsNotInCommon > 0) {
					revert NonAuthorized();
				}
			}
		}
	}

	function _hashInvitation(FundMemberInvitation memory invitation) private pure returns (bytes32) {
		return
			keccak256(
				abi.encode(
					keccak256(
						bytes('FundMemberInvitation(address invitee,uint256 permissionsMask,uint256 deadline)')
					),
					invitation.invitee,
					invitation.permissionsMask,
					invitation.deadline
				)
			);
	}

	uint256[50] private __gap;
}
