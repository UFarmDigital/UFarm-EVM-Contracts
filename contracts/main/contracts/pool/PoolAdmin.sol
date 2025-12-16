// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.24;

/// INTERFACES
import {IUFarmCore} from "../core/IUFarmCore.sol";
import {IUFarmFund} from "../fund/IUFarmFund.sol";
import {IUFarmPool} from "./IUFarmPool.sol";
import {IPoolAdmin} from "./IPoolAdmin.sol";

/// CONTRACTS
import {NZGuard} from "../../shared/NZGuard.sol";
import {Permissions} from "../permissions/Permissions.sol";
import {UFarmErrors} from "../../shared/UFarmErrors.sol";
import {UFarmPermissionsModel} from "../permissions/UFarmPermissionsModel.sol";
import {UFarmOwnableUUPSBeacon} from "../../shared/UFarmOwnableUUPSBeacon.sol";

/// LIBRARIES
import {PerformanceFeeLib} from "./PerformanceFeeLib.sol";
import {UFarmPool} from "./UFarmPool.sol";

/**
 * @title PoolAdmin contract
 * @author https://ufarm.digital/
 * @notice Contract that implements admin functionality for UFarm pools
 */
contract PoolAdmin is IPoolAdmin, UFarmPermissionsModel, UFarmOwnableUUPSBeacon, NZGuard {
    uint256 private constant ONE = 1e18;
    uint256 private constant TEN_PERCENTS = 1e17;
    uint256 private constant YEAR = 365 days;

    uint256 public constant MAX_PERFORMANCE_FEE = PerformanceFeeLib.ONE_HUNDRED_PERCENT / 2; // 50%

    /// @notice Pool configuration
    PoolConfig public poolConfig;

    address public ufarmCore;
    address public ufarmFund;
    address public ufarmPool;

    /**
     * @notice Emitted when the pool commission is changed
     * @param managementCommission - management commission
     * @param performanceCommission - performance commission
     */
    event CommissionChanged(uint256 managementCommission, uint256 performanceCommission);

    /**
     * @notice Emitted when the investment range is changed
     * @param minInvestment - new minimum investment boundary
     * @param maxInvestment - new maximum investment boundary
     */
    event InvestmentRangeChanged(uint256 minInvestment, uint256 maxInvestment);

    /**
     * @notice Emitted when the withdrawal lockup period is changed
     * @param withdrawalLockupPeriod - new withdrawal lockup period
     */
    event LockupPeriodChanged(uint256 withdrawalLockupPeriod);

    /**
     * @notice Reverts if `_newStatus` can't be set as a new status
     */
    error WrongNewPoolStatus(IUFarmPool.PoolStatus _currentStatus, IUFarmPool.PoolStatus _newStatus);

    /**
     * @notice Reverts if the UFarm platform is paused
     */
    modifier ufarmIsNotPaused() {
        _ufarmIsNotPaused();
        _;
    }

    /**
     * @notice Reverts if the Fund is not active
     */
    modifier onlyActiveFund() {
        _checkActiveFund();
        _;
    }

    modifier onlyStatus(IUFarmPool.PoolStatus _onlyStatus) {
        _statusIs(_onlyStatus);
        _;
    }

    /**
     * @notice Initializes the PoolAdmin contract
     * @param _settings - initial pool settings
     * @param _poolAddr - address of the pool
     */
    function __init_PoolAdmin(
        IUFarmPool.CreationSettingsWithLinks memory _settings,
        address _poolAddr
    ) external checkDelegateCall initializer {
        // Set permissions
        {
            uint256 staffCount = _settings.params.staff.length;
            IUFarmPool.Staff memory staff;
            for (uint256 i; i < staffCount; ++i) {
                staff = _settings.params.staff[i];
                _nonZeroAddress(staff.addr);
                _updatePermissions(staff.addr, staff.permissionsMask);
            }
        }

        // Set addresses
        (ufarmFund, ufarmCore, ufarmPool) = (_settings.ufarmFund, _settings.ufarmCore, _poolAddr);

        // Set pool config
        {
            _valueInRange(_settings.params.managementCommission, 0, TEN_PERCENTS);
            _checkInvestmentBorders(_settings.params.minInvestment, _settings.params.maxInvestment);

            poolConfig = PoolConfig({
                managementCommission: _settings.params.managementCommission,
                withdrawalLockupPeriod: _settings.params.withdrawalLockupPeriod,
                packedPerformanceFee: packPerformanceCommission(
                    unpackPerformanceCommission(_settings.params.packedPerformanceCommission)
                ),
                minInvestment: _settings.params.minInvestment,
                maxInvestment: _settings.params.maxInvestment
            });
        }
    }

    function getConfig() external view override returns (PoolConfig memory) {
        return poolConfig;
    }

    function changePoolStatus(IUFarmPool.PoolStatus _newStatus) external override {
        _checkActiveFund();

        checkPoolOrFundPermission(msg.sender, Permissions.Pool.PoolStatusControl, Permissions.Fund.PoolStatusControl);
        IUFarmPool.PoolStatus currentPoolState = IUFarmPool(ufarmPool).status();

        // New status can't be the same as the current one
        if (currentPoolState == _newStatus) revert UFarmErrors.ActionAlreadyDone();

        // Terminated is the final state, it can't be changed
        if (currentPoolState == IUFarmPool.PoolStatus.Terminated)
            revert WrongNewPoolStatus(currentPoolState, _newStatus);

        // Active is the initial status transition
        if (_newStatus < IUFarmPool.PoolStatus.Active) revert WrongNewPoolStatus(currentPoolState, _newStatus);

        // Active status can be changed from Created
        if (_newStatus == IUFarmPool.PoolStatus.Active) {
            (uint256 _totalCost, uint256 minimumFundDeposit) = (
                IUFarmPool(ufarmPool).getTotalCost(),
                IUFarmCore(ufarmCore).minimumFundDeposit()
            );

            if (currentPoolState == IUFarmPool.PoolStatus.Created) {
                if (_totalCost < minimumFundDeposit) {
                    revert IUFarmPool.InsufficientDepositAmount(_totalCost, minimumFundDeposit);
                }
            } else if (currentPoolState == IUFarmPool.PoolStatus.Deactivating) {
                if (IUFarmPool(ufarmPool).getUnprocessedWithdraw() != bytes32(0)) {
                    revert WrongNewPoolStatus(currentPoolState, _newStatus);
                }
            } else {
                revert WrongNewPoolStatus(currentPoolState, _newStatus);
            }
        }

        // Deactivating status can be changed from Active
        if (_newStatus == IUFarmPool.PoolStatus.Deactivating && currentPoolState != IUFarmPool.PoolStatus.Active)
            revert WrongNewPoolStatus(currentPoolState, _newStatus);

        // Set lockup period to 0 if pool is Terminated
        if (_newStatus == IUFarmPool.PoolStatus.Terminated) {
            _setLockupPeriod(0);
        }

        // Terminated status can be changed from Created, Active or Deactivating
        IUFarmPool(ufarmPool).changeStatus(_newStatus);
    }

    /**
     * @notice Updates Pool permissions for the given account
     * @param _account - address of the account to update permissions
     * @param _permissions - new permissions mask
     */
    function updatePermissions(address _account, uint256 _permissions) external ufarmIsNotPaused {
        // if user is pool member and fund member, then he can update permissions
        checkPoolOrFundPermission(
            msg.sender,
            Permissions.Pool.UpdatePoolPermissions,
            Permissions.Fund.UpdatePoolPermissions
        );
        _updatePermissions(_account, _permissions);
    }

    /**
     * @notice Changes the pool commission
     * @dev Reverts if the new commission is the same as the old one
     * @param _managementCommission - new management commission
     * @param _packedPerformanceFee - new performance commission
     */
    function setCommissions(
        uint256 _managementCommission,
        uint256 _packedPerformanceFee
    )
        external
        ufarmIsNotPaused
        onlyActiveFund
        onlyStatus(IUFarmPool.PoolStatus.Created)
        valueInRange(_managementCommission, 0, TEN_PERCENTS)
    {
        checkPoolOrFundPermission(msg.sender, Permissions.Pool.UpdatePoolFees, Permissions.Fund.UpdatePoolFees);

        bool managementCommissionChanged = _managementCommission != poolConfig.managementCommission;
        bool performanceCommissionStepsChanged = _packedPerformanceFee != poolConfig.packedPerformanceFee;

        if (!managementCommissionChanged && !performanceCommissionStepsChanged) revert UFarmErrors.ActionAlreadyDone();

        if (performanceCommissionStepsChanged) {
            poolConfig.packedPerformanceFee = packPerformanceCommission(
                unpackPerformanceCommission(_packedPerformanceFee)
            );
        }
        if (managementCommissionChanged) {
            poolConfig.managementCommission = _managementCommission;
        }

        emit CommissionChanged(_managementCommission, _packedPerformanceFee);
    }

    /**
     * @notice Changes the withdrawal lockup period
     * @dev Reverts if the new withdrawal lockup period is the same as the old one
     * @param _withdrawalLockupPeriod - new withdrawal lockup period
     */
    function setLockupPeriod(uint128 _withdrawalLockupPeriod) external onlyStatus(IUFarmPool.PoolStatus.Created) {
        checkPoolOrFundPermission(
            msg.sender,
            Permissions.Pool.UpdateLockupPeriods,
            Permissions.Fund.UpdateLockupPeriods
        );

        if (_withdrawalLockupPeriod == poolConfig.withdrawalLockupPeriod) revert UFarmErrors.ActionAlreadyDone();

        _setLockupPeriod(_withdrawalLockupPeriod);
    }

    /**
     * @notice Changes the investment range
     * @dev Reverts if the new investment range is the same as the old one
     * @param _minInvestment - new minimum investment boundary
     * @param _maxInvestment - new maximum investment boundary
     */
    function setInvestmentRange(uint256 _minInvestment, uint256 _maxInvestment) external onlyActiveFund {
        IUFarmPool.PoolStatus currentState = IUFarmPool(ufarmPool).status();
        if (currentState > IUFarmPool.PoolStatus.Active) {
            revert IUFarmPool.InvalidPoolStatus(IUFarmPool.PoolStatus.Active, currentState);
        }
        checkPoolOrFundPermission(
            msg.sender,
            Permissions.Pool.UpdatePoolTopUpAmount,
            Permissions.Fund.UpdatePoolTopUpAmount
        );

        if ((_minInvestment == poolConfig.minInvestment) && (_maxInvestment == poolConfig.maxInvestment))
            revert UFarmErrors.ActionAlreadyDone();

        _setInvestmentRange(_minInvestment, _maxInvestment);
    }

    /**
     * @notice Encodes PerformanceCommissionSteps into a single uint256 value with validation
     * @param steps - PerformanceCommissionSteps array
     * @return packedPerformanceFee - encoded PerformanceCommissionSteps
     */
    function packPerformanceCommission(
        IUFarmPool.PerformanceCommissionStep[] memory steps
    ) public pure returns (uint256 packedPerformanceFee) {
        uint256 stepsCount = steps.length;
        if (stepsCount > 8) revert PerformanceFeeLib.InvalidPerformanceCommissionStepsCount();

        uint16 previousStep;
        IUFarmPool.PerformanceCommissionStep memory thisStep;
        for (uint256 i; i < stepsCount; ++i) {
            thisStep = steps[i];
            if (thisStep.step > previousStep || i == 0) {
                _valueInRange(thisStep.commission, 0, MAX_PERFORMANCE_FEE);
                previousStep = thisStep.step;
            } else {
                revert PerformanceFeeLib.InvalidPerformanceCommissionStep(thisStep.step, thisStep.commission);
            }

            packedPerformanceFee |= uint256(thisStep.step) << (i * 32); // Shift 'step' by 32 bits
            packedPerformanceFee |= uint256(thisStep.commission) << (i * 32 + 16); // Shift 'commission' by 16 bits
        }
        return packedPerformanceFee;
    }

    /**
     * @notice Decodes PerformanceCommissionSteps from a single uint256 value
     * @param packedPerformanceFee - encoded PerformanceCommissionSteps
     * @return steps - PerformanceCommissionSteps array
     */
    function unpackPerformanceCommission(
        uint256 packedPerformanceFee
    ) public pure returns (IUFarmPool.PerformanceCommissionStep[] memory steps) {
        uint8 filledLength = PerformanceFeeLib._getPerformanceCommissionStepsCount(packedPerformanceFee);
        steps = new IUFarmPool.PerformanceCommissionStep[](filledLength);
        for (uint8 i; i < filledLength; ++i) {
            steps[i] = PerformanceFeeLib._getPerformanceCommissionStep(packedPerformanceFee, i);
        }
    }

    /**
     * @inheritdoc IPoolAdmin
     */
    function isAbleToManageFunds(address manager) public view override returns (bool) {
        _checkActiveFund();
        _isFundMember(manager);

        bool poolFinanceManager = _hasPermissionMask(
            manager,
            _twoPermissionsToMask(uint8(Permissions.Pool.Member), uint8(Permissions.Pool.ManagePoolFunds))
        );
        if (!poolFinanceManager) {
            bool allPoolsManager = UFarmPermissionsModel(ufarmFund).hasPermission(
                manager,
                uint8(Permissions.Fund.ManagePoolFunds)
            );
            if (!allPoolsManager) revert UFarmErrors.NonAuthorized();
        }
        return true;
    }

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
    ) public view {
        _isFundMember(_account);
        if (
            !_hasPermissionMask(
                _account,
                _twoPermissionsToMask(uint8(Permissions.Pool.Member), uint8(_poolPermission))
            ) && !UFarmPermissionsModel(ufarmFund).hasPermission(_account, uint8(_fundPermission))
        ) revert UFarmErrors.NonAuthorized();
    }

    function _setLockupPeriod(uint128 _withdrawalLockupPeriod) private {
        poolConfig.withdrawalLockupPeriod = _withdrawalLockupPeriod;
        emit LockupPeriodChanged(_withdrawalLockupPeriod);
    }

    function _checkActiveFund() private view {
        IUFarmFund.FundStatus fundStatus = IUFarmFund(ufarmFund).status();
        if (fundStatus != IUFarmFund.FundStatus.Active) {
            revert IUFarmFund.WrongFundStatus(IUFarmFund.FundStatus.Active, fundStatus);
        }
    }

    function _setInvestmentRange(uint256 _minInvestment, uint256 _maxInvestment) private {
        _checkInvestmentBorders(_minInvestment, _maxInvestment);
        (poolConfig.minInvestment, poolConfig.maxInvestment) = (_minInvestment, _maxInvestment);
        emit InvestmentRangeChanged(_minInvestment, _maxInvestment);
    }

    function _ufarmIsNotPaused() private view {
        if (IUFarmCore(ufarmCore).isPaused()) revert UFarmErrors.UFarmIsPaused();
    }

    function _isFundMember(address member) private view {
        if (!UFarmPermissionsModel(address(ufarmFund)).hasPermission(member, uint8(Permissions.Fund.Member)))
            revert UFarmErrors.NonAuthorized();
    }

    function _statusIs(IUFarmPool.PoolStatus _requiredStatus) private view {
        IUFarmPool.PoolStatus currentState = IUFarmPool(ufarmPool).status();
        if (currentState != _requiredStatus) revert IUFarmPool.InvalidPoolStatus(_requiredStatus, currentState);
    }

    function _checkInvestmentBorders(uint256 minInvestment, uint256 maxInvestment) private pure {
        if (minInvestment > maxInvestment) revert ValueNotInRange(minInvestment, 0, maxInvestment);
    }

    function calculateFee(
        uint256 totalCost,
        uint256 highWaterMark,
        uint256 lastAccrual,
        uint256 totalSupply
    )
        external
        view
        returns (
            uint256 protocolFee,
            uint256 managementFee,
            uint256 performanceFee,
            uint256 sharesToUFarm,
            uint256 sharesToFund
        )
    {
        uint256 accrualTime = block.timestamp - lastAccrual;

        if (lastAccrual == 0 || accrualTime == 0) {
            return (0, 0, 0, 0, 0);
        }

        {
            uint256 protocolCommission = IUFarmCore(ufarmCore).protocolCommission();
            uint256 costInTime = (totalCost * accrualTime) / YEAR;

            (protocolFee, managementFee) = (
                (costInTime * protocolCommission) / ONE,
                (costInTime * poolConfig.managementCommission) / ONE
            );
        }

        if (totalCost - protocolFee - managementFee > highWaterMark) {
            uint256 profit = totalCost - protocolFee - managementFee - highWaterMark;

            performanceFee = (profit * PerformanceFeeLib.ONE_HUNDRED_PERCENT) / highWaterMark;
            uint16 performanceCommission = performanceFee > PerformanceFeeLib.MAX_COMMISSION_STEP
                ? PerformanceFeeLib.MAX_COMMISSION_STEP
                : uint16(performanceFee);

            performanceCommission = PerformanceFeeLib._getPerformanceCommission(
                poolConfig.packedPerformanceFee,
                performanceCommission
            );

            performanceFee = (profit * performanceCommission) / PerformanceFeeLib.ONE_HUNDRED_PERCENT;
        }
        uint256 totalFundFee = (4 * (performanceFee + managementFee)) / 5;
        uint256 totalUFarmFee = totalFundFee / 4 + protocolFee;

        sharesToUFarm = _sharesByQuote(totalUFarmFee, totalSupply, totalCost);
        sharesToFund = _sharesByQuote(totalFundFee, totalSupply + sharesToUFarm, totalCost);
    }

    function _sharesByQuote(
        uint256 quoteAmount,
        uint256 totalSupply,
        uint256 totalCost
    ) internal pure returns (uint256 shares) {
        shares = (totalCost > 0 && totalSupply > 0) ? ((quoteAmount * totalSupply) / totalCost) : quoteAmount;
    }

    uint256[50] private __gap;
}
