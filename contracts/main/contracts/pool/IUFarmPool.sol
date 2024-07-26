// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

import {AssetsStructs} from '../../shared/AssetController.sol';

interface IUFarmPool {
	enum PoolStatus {
		Draft,
		Created,
		Active,
		Deactivating,
		Terminated
	}

	// Struct to avoid stack too deep error:
	struct CreationSettingsWithLinks {
		CreationSettings params;
		address ufarmCore;
		address ufarmFund;
	}

	struct CreationSettings {
		uint256 minInvestment;
		uint256 maxInvestment;
		uint256 managementCommission;
		uint256 packedPerformanceCommission;
		uint128 withdrawalLockupPeriod;
		address valueToken;
		Staff[] staff;
		string name;
		string symbol;
	}

	struct PerformanceCommissionStep {
		uint16 step;
		uint16 commission;
	}
	struct Staff {
		address addr;
		uint256 permissionsMask;
	}

	struct DepositRequest {
		uint256 amountToInvest;
		bytes32 salt;
		address poolAddr;
		uint96 deadline;
	}

	struct WithdrawRequest {
		uint256 sharesToBurn;
		bytes32 salt;
		address poolAddr;
	}

	struct SignedDepositRequest {
		DepositRequest body;
		bytes signature;
	}

	struct SignedWithdrawalRequest {
		WithdrawRequest body;
		bytes signature;
	}

	/**
	 * @notice Emitted when a deposit is made
	 * @param investor - investor address
	 * @param tokenIn - token address deposited
	 * @param valueIn - amount of tokens deposited
	 * @param sharesOut - amount of shares minted
	 */
	event Deposit(
		address indexed investor,
		address indexed tokenIn,
		uint256 valueIn,
		uint256 sharesOut
	);

	/**
	 * @notice Emitted when a deposit request is executed
	 * @param investor - investor that made the deposit
	 * @param depositRequestHash - hash of the deposit request
	 */
	event DepositRequestExecuted(address indexed investor, bytes32 indexed depositRequestHash);

	/**
	 * @notice Emitted when a withdrawal request is received
	 * @param investor - investor that made the withdrawal request
	 * @param withdrawRequestHash - hash of the withdrawal request
	 * @param timestamp - timestamp of the withdrawal request received
	 */
	event WithdrawRequestReceived(
		address indexed investor,
		bytes32 indexed withdrawRequestHash,
		uint256 timestamp
	);

	/**
	 * @notice Emitted when a withdrawal request is executed
	 * @param investor - investor that made the withdrawal request
	 * @param sharesBurned - amount of the Pool shares burned
	 * @param withdrawRequestHash - hash of the withdrawal request
	 */
	event WithdrawRequestExecuted(
		address indexed investor,
		uint256 sharesBurned,
		bytes32 indexed withdrawRequestHash
	);

	/**
	 * @notice Emitted when a withdrawal is made. Emits more than one event if the withdrawal is partial.
	 * @param investor - investor address
	 * @param tokenOut - token address withdrawn
	 * @param amountOut - amount of tokens withdrawn
	 * @param requestHash - hash of the withdrawal request
	 */
	event Withdraw(
		address indexed investor,
		address indexed tokenOut,
		uint256 amountOut,
		bytes32 indexed requestHash
	);

	/**
	 * @notice Emitted when fees are accrued
	 * @param protocolFee - protocol fee paid in ValueToken
	 * @param managementFee - management fee paid in ValueToken
	 * @param performanceFee - performance fee paid in ValueToken
	 * @param sharesToUFarm - shares minted to UFarmCore
	 * @param sharesToFund - shares minted to UFarmFund
	 */
	event FeeAccrued(
		uint256 protocolFee,
		uint256 managementFee,
		uint256 performanceFee,
		uint256 sharesToUFarm,
		uint256 sharesToFund
	);

	/**
	 * @notice Emitted when pool status is changed
	 * @param newStatus - new pool status
	 */
	event PoolStatusChanged(PoolStatus newStatus);

	/**
	 * @notice Emitted when a controller function is called
	 * @param controllerHashedName - controller name
	 */
	event SuccessfullControllerCall(bytes32 controllerHashedName);

	error InvalidInvestmentAmount(uint256 amount, uint256 min, uint256 max);
	error InvalidWithdrawalAmount(uint256 amount, uint256 balance);
	error LockupPeriodNotPassed(uint256 unlockTimestamp);
	error AssetsWeightAboveMax(uint256 weight);
	error AnotherPoolExpected(address _expectedPool, address _gotPool);
	error DeadlineExpired(uint256 _deadline, uint256 _now);
	error InvalidPoolStatus(PoolStatus requiredStatus, PoolStatus currentStatus);
	error InsufficientDepositAmount(uint256 amount, uint256 minFundDeposit);

	/**
	 * @notice Used by controller to add new ERC20 asset to the pool
	 * @param _asset - Address of the ERC20 asset
	 * @param _controllerOrZero - Controller hashed name or zero if asset is not controlled
	 */
	function addERC20(address _asset, bytes32 _controllerOrZero) external;

	/**
	 * @notice Used by controller to remove ERC20 asset from the pool
	 * @param _asset - Address of the ERC20 asset
	 */
	function removeERC20(address _asset) external;

	/**
	 * @notice Used by controller to add new ERC721 asset to the pool
	 * @param _asset - Address of the ERC721 asset
	 * @param _ids - List of ERC721 asset ids
	 */
	function addERC721(address _asset, uint256[] memory _ids) external;

	/**
	 * @notice Used by controller to remove ERC721 asset from the pool
	 * @param _asset - Address of the ERC721 asset
	 * @param _ids - List of ERC721 asset ids
	 */
	function removeERC721(address _asset, uint256[] memory _ids) external;

	/**
	 * @notice Returns the pool state as PoolStatus enum
	 */
	function status() external view returns (PoolStatus);

	/**
	 * @notice Returns UFarmCore contract address
	 */
	function ufarmCore() external view returns (address);

	/**
	 * @notice Returns UFarmFund contract address
	 */
	function ufarmFund() external view returns (address);

	/**
	 * @notice Returns value token contract address
	 */
	function valueToken() external view returns (address);

	/**
	 * @notice Returns high water mark in value token
	 */
	function highWaterMark() external view returns (uint256);

	/**
	 * @notice Returns last accrual timestamp
	 */
	function lastAccrual() external view returns (uint256);

	/**
	 * @notice Returns number of decimals of the pool shares
	 */
	function decimals() external view returns (uint8);

	/**
	 * @notice Returns exchange rate of the pool
	 * @dev Exchange rate is the amount of value token required to buy one share of the pool
	 * @return exchangeRate - exchange rate of the pool
	 */
	function getExchangeRate() external view returns (uint256 exchangeRate);

	/**
	 * @notice Total cost of the pool in terms of value token
	 *
	 * @return totalCost Amount of value token required to buy all assets
	 */
	function getTotalCost() external view returns (uint256 totalCost);

	/**
	 * @notice Returns list of common assets in the pool
	 * @dev Common assets are assets that can be used for trading, lending, doesn't include LPs, staking tokens, etc.
	 * @return tokenAssets - list of token addresses
	 */
	function erc20CommonAssets() external view returns (address[] memory tokenAssets);

	/**
	 * @notice Returns list of ERC20 assets with controllers in the pool
	 * @return liquidityAssets - list of controlled ERC20 assets
	 */
	function erc20ControlledAssets()
		external
		view
		returns (AssetsStructs.ControlledERC20[] memory liquidityAssets);

	/**
	 * @notice Returns list of ERC721 assets in the pool
	 * @return liquidityAssetsERC721 - list of controlled ERC721 assets
	 */
	function erc721ControlledAssets()
		external
		view
		returns (AssetsStructs.ControlledERC721[] memory liquidityAssetsERC721);

	function __init_UFarmPool(
		CreationSettingsWithLinks memory _settings,
		address _poolAdmin
	) external;

	/**
	 * @notice Invests into the pool
	 * @dev Checks if investment amount is within the limits
	 * @dev Emits `Deposit` event
	 * @param _amountToInvest Amount of investment tokens to invest
	 */
	function deposit(uint256 _amountToInvest) external returns (uint256 toMint);

	/**
	 * @notice Withdraws from the pool in exchange for value token (if Pool has enough) or every token partially
	 * @dev Emits `Withdraw` event
	 * @param _withdrawalRequest - Withdrawal request
	 */
	function withdraw(
		SignedWithdrawalRequest calldata _withdrawalRequest
	) external returns (uint256 burnedAssetsCost);

	/**
	 * @notice Changes pool status
	 * @dev Callable by the Pool Admin contract only
	 * @param _newStatus - New pool status
	 */
	function changeStatus(IUFarmPool.PoolStatus _newStatus) external;

	/**
	 * @notice Returns current protocol target during the delegatecall
	 * @dev Callable by the protocol contract only
	 */
	function _protocolTarget() external view returns (address);

	/**
	 * @notice Returns current withdrawal hash during withdrawal
	 * @dev Callable by the protocol contract only
	 */
	function _withdrawalHash() external view returns (bytes32);
}
