// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IUFarmCore} from "../../interfaces/IUFarmCore.sol";
import {IUFarmEscrow} from "../../interfaces/IUFarmEscrow.sol";
import {IUFarmOracle} from "../../interfaces/IUFarmOracle.sol";
import {IUFarmOracleConsumer} from "../../interfaces/IUFarmOracleConsumer.sol";
import {IUFarmVaultRequests} from "../../interfaces/IUFarmVaultRequests.sol";
import {ErrorCodes} from "../../libraries/ErrorCodes.sol";
import {FeeMath} from "../../libraries/FeeMath.sol";
import {PauseMask} from "../../libraries/PauseMask.sol";
import {Permissions} from "../../libraries/Permissions.sol";
import {SettlementAction} from "../../libraries/SettlementAction.sol";
import {VaultBaseStorage} from "../../libraries/VaultBaseStorage.sol";
import {VaultConfigStorage} from "../../libraries/VaultConfigStorage.sol";
import {VaultGuards} from "../../libraries/VaultGuards.sol";
import {VaultLifecycleStorage} from "../../libraries/VaultLifecycleStorage.sol";
import {VaultPermissionStorage} from "../../libraries/VaultPermissionStorage.sol";
import {VaultShareAccounting} from "../../libraries/VaultShareAccounting.sol";
import {VaultTypes} from "../../libraries/VaultTypes.sol";
import {IUFarmVaultErrors} from "../UFarmVaultErrors.sol";
import {IUFarmVaultOracleEvents, IUFarmVaultRequestsEvents} from "../UFarmVaultEvents.sol";

contract VaultLifecycleModule is
    EIP712Upgradeable,
    ReentrancyGuard,
    IUFarmOracleConsumer,
    IUFarmVaultRequestsEvents,
    IUFarmVaultOracleEvents
{
    using SafeERC20 for IERC20;

    bytes32 private constant REQUEST_PARAMS_TYPEHASH = keccak256(
        "RequestParams(address asset,uint256 amount,uint256 minOutputAmount,address controller,address owner)"
    );
    bytes32 private constant SIGNED_DEPOSIT_REQUEST_TYPEHASH = keccak256(
        "SignedDepositRequest(RequestParams request,uint256 nonce,uint256 deadline)RequestParams(address asset,uint256 amount,uint256 minOutputAmount,address controller,address owner)"
    );
    bytes32 private constant SIGNED_REDEEM_REQUEST_TYPEHASH = keccak256(
        "SignedRedeemRequest(RequestParams request,uint256 nonce,uint256 deadline)RequestParams(address asset,uint256 amount,uint256 minOutputAmount,address controller,address owner)"
    );
    bytes32 private constant CLIENT_VERIFICATION_TYPEHASH =
        keccak256("ClientVerification(address client,address vault,uint8 tier,uint64 validTill)");
    uint8 internal constant REQUEST_KIND_DEPOSIT = 1;
    uint8 internal constant REQUEST_KIND_REDEEM = 2;
    uint8 internal constant REQUEST_FAIL_ZERO_OUTPUT = 1;
    uint8 internal constant REQUEST_FAIL_INSUFFICIENT_LIQUIDITY = 2;
    uint8 internal constant REQUEST_FAIL_ESCROW_ACTION = 3;
    uint8 internal constant REQUEST_FAIL_SLIPPAGE = 4;
    uint64 internal constant DEPOSIT_LOCK_PERIOD = 7 days;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant ERC1271_VALIDATION_GAS_LIMIT = 100_000;
    uint256 internal constant PERFORMANCE_FEE_PERIOD_SHIFT = 128;
    uint256 internal constant PENDING_QUEUE_LIMIT = 10;
    uint256 internal constant MEMBER = Permissions.MEMBER;
    uint256 internal constant VAULT_SETTLE_MANAGER = Permissions.VAULT_SETTLE_MANAGER;
    uint256 internal constant VAULT_CUSTOMER_MANAGER = Permissions.VAULT_CUSTOMER_MANAGER;

    address private immutable _self;

    constructor() {
        _self = address(this);
    }

    modifier onlyDelegateCall() {
        if (address(this) == _self) revert IUFarmVaultErrors.ModuleDelegateCallOnly();
        _;
    }

    /// @notice Opens a pending deposit request for the vault default asset.
    /// @dev Runs through the vault by delegatecall and credits assets into escrow.
    /// @param assets Amount of the default asset to deposit.
    /// @param controller Address that controls the request. Must be the owner.
    /// @param owner_ Address that owns and funds the request.
    /// @return Request id. UFarm uses request id zero for the active bucket.
    function requestDeposit(uint256 assets, address controller, address owner_)
        external
        onlyDelegateCall
        nonReentrant
        returns (uint256)
    {
        VaultGuards.requireActive();
        if (VaultConfigStorage.data().clientTier != 0) revert IUFarmVaultErrors.InvalidSignature();
        _requireOwnerOrOperator(owner_);
        _checkDepositRange(VaultBaseStorage.data().asset, assets);
        _checkRequestReady(PauseMask.DEPOSIT_REQUESTS_PAUSED);
        if (!_requestDeposit(
                _unsignedRequest(VaultBaseStorage.data().asset, assets, controller, owner_), false, _escrow()
            )) {
            revert IUFarmVaultErrors.RequestStateError(ErrorCodes.REQUEST_NO_BATCH);
        }
        return 0;
    }

    /// @notice Opens a pending custom-asset deposit request.
    /// @dev Validates client tier proof, then credits assets into escrow.
    /// @param asset_ Asset to deposit.
    /// @param assets Amount of the asset to deposit.
    /// @param controller Address that controls the request. Must be the owner.
    /// @param owner_ Address that owns and funds the request.
    /// @param verification Signed client tier verification.
    /// @return Request id. UFarm uses request id zero for the active bucket.
    function requestDeposit(
        address asset_,
        uint256 assets,
        address controller,
        address owner_,
        IUFarmVaultRequests.ClientVerification calldata verification
    ) external onlyDelegateCall nonReentrant returns (uint256) {
        VaultGuards.requireActive();
        _validateClientVerification(owner_, verification);
        _requireOwnerOrOperator(owner_);
        _checkDepositRange(asset_, assets);
        _checkRequestReady(PauseMask.DEPOSIT_REQUESTS_PAUSED);
        if (!_requestDeposit(_unsignedRequest(asset_, assets, controller, owner_), false, _escrow())) {
            revert IUFarmVaultErrors.RequestStateError(ErrorCodes.REQUEST_NO_BATCH);
        }
        return 0;
    }

    /// @notice Claims a settled deposit as vault shares.
    /// @param assets Unused ERC-7540 compatibility argument.
    /// @param receiver Address that receives minted shares. Must equal controller.
    /// @param controller Address whose claimable deposit is claimed.
    /// @return Number of shares minted.
    function deposit(uint256 assets, address receiver, address controller) external onlyDelegateCall returns (uint256) {
        if (receiver != controller) revert IUFarmVaultErrors.InvalidAddress();
        return _claimDeposit(controller);
    }

    /// @notice Opens a pending redeem request.
    /// @dev Moves shares from the owner into the vault until settlement or cancellation.
    /// @param shares Number of shares to redeem.
    /// @param controller Address that controls the request. Must be the owner.
    /// @param owner_ Address that owns the shares.
    /// @return Request id. UFarm uses request id zero for the active bucket.
    function requestRedeem(uint256 shares, address controller, address owner_)
        external
        onlyDelegateCall
        nonReentrant
        returns (uint256)
    {
        _requireOwnerOrOperator(owner_);
        _checkRequestReady(PauseMask.REDEEM_REQUESTS_PAUSED);
        if (!_requestRedeem(_unsignedRequest(VaultBaseStorage.data().asset, shares, controller, owner_), false)) {
            revert IUFarmVaultErrors.RequestStateError(ErrorCodes.REQUEST_NO_BATCH);
        }
        return 0;
    }

    /// @notice Claims a settled redeem as assets.
    /// @param shares Unused ERC-7540 compatibility argument.
    /// @param receiver Address that receives the assets.
    /// @param controller Address whose claimable redeem is claimed.
    /// @return Number of assets released or made withdrawable.
    function redeem(uint256 shares, address receiver, address controller) external onlyDelegateCall returns (uint256) {
        if (receiver == address(0)) revert IUFarmVaultErrors.InvalidAddress();
        if (receiver != controller && msg.sender != controller) revert IUFarmVaultErrors.Unauthorized(msg.sender);
        _requireOwnerOrOperator(controller);
        return _claimRedeemAssets(controller, receiver);
    }

    /// @notice Cancels a pending deposit request.
    /// @param owner_ Owner whose pending deposit is cancelled.
    /// @return assets Amount released from escrow back to the owner.
    function cancelDeposit(address owner_) external onlyDelegateCall nonReentrant returns (uint256 assets) {
        VaultGuards.checkNotPaused(PauseMask.CANCELS_PAUSED);
        VaultGuards.requireAccountingChain();
        VaultGuards.requireOracleInactive();
        _requireOwnerOrOperator(owner_);
        VaultTypes.OwnerRequestState storage state = VaultLifecycleStorage.data().requestStates[owner_];
        VaultTypes.PendingRequest memory request = state.pendingDeposit;
        if (request.amount == 0) revert IUFarmVaultErrors.RequestStateError(ErrorCodes.REQUEST_NO_PENDING);

        delete state.pendingDeposit;
        _removePendingDepositOwner(owner_);
        uint256 releasedAssets = _releaseAvailableEscrow(request.asset, owner_, owner_, request.amount);

        emit DepositCancelled(owner_, request.asset, request.amount);
        return releasedAssets;
    }

    /// @notice Cancels a pending redeem request.
    /// @param owner_ Owner whose pending redeem is cancelled.
    /// @return Number of shares returned to the owner.
    function cancelRedeem(address owner_) external onlyDelegateCall nonReentrant returns (uint256) {
        VaultGuards.checkNotPaused(PauseMask.CANCELS_PAUSED);
        VaultGuards.requireAccountingChain();
        VaultGuards.requireOracleInactive();
        _requireOwnerOrOperator(owner_);
        VaultTypes.OwnerRequestState storage state = VaultLifecycleStorage.data().requestStates[owner_];
        VaultTypes.PendingRequest memory request = state.pendingRedeem;
        if (request.amount == 0) revert IUFarmVaultErrors.RequestStateError(ErrorCodes.REQUEST_NO_PENDING);

        delete state.pendingRedeem;
        _removePendingRedeemOwner(owner_);
        VaultShareAccounting.moveShares(address(this), owner_, request.amount);

        emit RedeemCancelled(owner_, request.amount);
        return request.amount;
    }

    /// @notice Starts oracle settlement for already queued requests.
    /// @return Oracle request id created for the settlement.
    function settleRequests() external onlyDelegateCall nonReentrant returns (uint256) {
        _checkPermission(VAULT_SETTLE_MANAGER);
        VaultGuards.checkNotPaused(PauseMask.ORACLE_REQUESTS_PAUSED);
        VaultGuards.requireFinanceActive();
        return _startOracleRequest(true);
    }

    /// @notice Adds signed requests and starts oracle settlement.
    /// @dev Invalid signed requests are skipped without reverting the whole batch.
    /// @param deposits Signed deposit requests to process before settlement.
    /// @param redeems Signed redeem requests to process before settlement.
    /// @return Oracle request id created for the settlement.
    function settleRequests(
        IUFarmVaultRequests.SignedRequest[] calldata deposits,
        IUFarmVaultRequests.SignedRequest[] calldata redeems
    ) external onlyDelegateCall nonReentrant returns (uint256) {
        _checkPermission(MEMBER | VAULT_SETTLE_MANAGER | VAULT_CUSTOMER_MANAGER);
        VaultGuards.checkNotPaused(PauseMask.ORACLE_REQUESTS_PAUSED);
        VaultGuards.requireFinanceActive();
        VaultGuards.requireOracleInactive();
        _requestDeposits(deposits, true);
        _requestRedeems(redeems, true);
        return _startOracleRequest(false);
    }

    /// @notice Receives NAV data from the active oracle request and settles queues.
    /// @param oracleRequestId Oracle request id being answered.
    /// @param nav Reported vault net asset value.
    /// @param valuationTimestamp Timestamp of the NAV valuation.
    function onOracleNav(uint256 oracleRequestId, uint256 nav, uint64 valuationTimestamp)
        external
        override
        onlyDelegateCall
        nonReentrant
    {
        // slither-disable-start reentrancy-no-eth
        VaultGuards.checkNotPaused(PauseMask.ORACLE_CALLBACKS_PAUSED);
        VaultGuards.requireFinanceActive();
        VaultTypes.ActiveOracleRequest memory activeRequest = VaultLifecycleStorage.data().activeOracleRequest;
        if (oracleRequestId == 0 || oracleRequestId != activeRequest.requestId) {
            revert IUFarmVaultErrors.OracleFlowError(ErrorCodes.ORACLE_INVALID_REQUEST);
        }
        if (msg.sender != activeRequest.oracle) revert IUFarmVaultErrors.Unauthorized(msg.sender);
        if (
            valuationTimestamp < activeRequest.requestedAt
                || IUFarmCore(VaultBaseStorage.data().core).navRequestCooldown() + valuationTimestamp < block.timestamp
        ) {
            revert IUFarmVaultErrors.OracleFlowError(ErrorCodes.ORACLE_INVALID_VALUATION_TIMESTAMP);
        }

        _settleRequests(nav);
        delete VaultLifecycleStorage.data().activeOracleRequest;
        emit OracleNAVReceived(msg.sender, oracleRequestId, nav, valuationTimestamp);
        // slither-disable-end reentrancy-no-eth
    }

    /// @notice Resets a timed-out oracle request and cancels pending queues.
    /// @dev Does not settle requests; it unwinds pending deposits and redeems.
    function resetRequests() external onlyDelegateCall nonReentrant {
        _checkPermission(MEMBER | VAULT_SETTLE_MANAGER);
        VaultGuards.checkNotPaused(PauseMask.ORACLE_REQUESTS_PAUSED);
        VaultGuards.requireFinanceActive();
        uint256 oracleRequestId = _requireActiveOracleRequestTimedOut();
        delete VaultLifecycleStorage.data().activeOracleRequest;
        _cancelPendingRedeems();
        _cancelPendingDeposits();
        emit OracleRequestReset(oracleRequestId);
    }

    /// @notice Resends the oracle request after the active request times out.
    /// @dev Keeps existing pending queues and replaces the oracle request id.
    /// @return newOracleRequestId New oracle request id.
    function manualResendOracleRequest() external onlyDelegateCall nonReentrant returns (uint256 newOracleRequestId) {
        _checkPermission(VAULT_SETTLE_MANAGER);
        VaultGuards.checkNotPaused(PauseMask.ORACLE_REQUESTS_PAUSED);
        VaultGuards.requireFinanceActive();
        _requireActiveOracleRequestTimedOut();
        delete VaultLifecycleStorage.data().activeOracleRequest;
        newOracleRequestId = _startOracleRequest(true);
        emit OracleRequestResent(newOracleRequestId);
    }

    function _requestDeposits(IUFarmVaultRequests.SignedRequest[] calldata requests, bool requireSignature)
        internal
        returns (uint256 accepted)
    {
        if (requests.length == 0) return 0;
        VaultGuards.requireActive();
        VaultGuards.checkNotPaused(PauseMask.DEPOSIT_REQUESTS_PAUSED);
        address escrow_ = _escrow();
        for (uint256 i = 0; i < requests.length; ++i) {
            if (_requestDeposit(requests[i], requireSignature, escrow_)) accepted++;
        }
    }

    function _requestRedeems(IUFarmVaultRequests.SignedRequest[] calldata requests, bool requireSignature)
        internal
        returns (uint256 accepted)
    {
        if (requests.length == 0) return 0;
        VaultGuards.checkNotPaused(PauseMask.REDEEM_REQUESTS_PAUSED);
        for (uint256 i = 0; i < requests.length; ++i) {
            if (_requestRedeem(requests[i], requireSignature)) accepted++;
        }
    }

    function _settleRequests(uint256 nav) internal returns (bool settled) {
        // slither-disable-start reentrancy-no-eth
        VaultBaseStorage.Layout storage base = VaultBaseStorage.data();
        VaultLifecycleStorage.Layout storage lifecycle = VaultLifecycleStorage.data();
        uint256 startingTotalSupply = base.totalSupply;
        uint256 pricingSupply = startingTotalSupply;
        if (startingTotalSupply != 0 && nav == 0) revert IUFarmVaultErrors.InvalidAmount();
        // slither-disable-next-line incorrect-equality
        if (startingTotalSupply == 0 && lifecycle.pendingRedeemOwners.length != 0) {
            revert IUFarmVaultErrors.InvalidAmount();
        }

        VaultTypes.VaultStatus status = VaultConfigStorage.data().status;
        if (status == VaultTypes.VaultStatus.Active) {
            VaultTypes.FeeAccrual memory feeAccrual = _previewFeeAccrual(nav, startingTotalSupply);
            pricingSupply = startingTotalSupply + feeAccrual.protocolShares + feeAccrual.curatorShares;

            if (!_validatePrice(nav, pricingSupply, lifecycle)) return false;
            _commitFeeAccrual(feeAccrual);
        } else {
            if (!_validatePrice(nav, pricingSupply, lifecycle)) return false;
        }

        VaultGuards.applySettlementAction(SettlementAction.Cooldown);

        address escrow_ = _escrow();
        if (status == VaultTypes.VaultStatus.Active) {
            _settlePendingDeposits(pricingSupply, nav, escrow_);
        }
        _settlePendingRedeems(pricingSupply, nav, escrow_);

        // slither-disable-next-line incorrect-equality
        if (startingTotalSupply == 0 && base.totalSupply != 0) {
            lifecycle.highWaterMark = WAD;
            lifecycle.lastTokenPrice = WAD;
        }
        // slither-disable-end reentrancy-no-eth
        return true;
    }

    function _validatePrice(uint256 nav, uint256 pricingSupply, VaultLifecycleStorage.Layout storage lifecycle)
        internal
        returns (bool)
    {
        // slither-disable-next-line incorrect-equality
        if (pricingSupply == 0) return true;

        uint256 previousPrice = lifecycle.lastTokenPrice;
        uint256 newPrice = Math.mulDiv(nav, WAD, pricingSupply);
        if (previousPrice == 0) {
            lifecycle.lastTokenPrice = newPrice;
            return true;
        }

        uint256 allowedPriceFluctuation = IUFarmCore(VaultBaseStorage.data().core).allowedPriceFluctuation();
        if (allowedPriceFluctuation == 0) {
            lifecycle.lastTokenPrice = newPrice;
            return true;
        }

        uint256 delta = newPrice > previousPrice ? newPrice - previousPrice : previousPrice - newPrice;
        uint256 actualPriceFluctuation = Math.mulDiv(delta, WAD, previousPrice);
        if (actualPriceFluctuation <= allowedPriceFluctuation) {
            lifecycle.lastTokenPrice = newPrice;
            return true;
        }

        lifecycle.isInvalidPrice = true;
        emit InvalidPriceRaised(previousPrice, newPrice, allowedPriceFluctuation, actualPriceFluctuation);
        return false;
    }

    function _startOracleRequest(bool allowEmptyQueues) internal returns (uint256 oracleRequestId) {
        // slither-disable-start reentrancy-no-eth
        VaultLifecycleStorage.Layout storage lifecycle = VaultLifecycleStorage.data();
        if (lifecycle.activeOracleRequest.requestId != 0) {
            revert IUFarmVaultErrors.OracleFlowError(ErrorCodes.ORACLE_ACTIVE);
        }
        if (!allowEmptyQueues && !_hasPendingBatch()) {
            revert IUFarmVaultErrors.RequestStateError(ErrorCodes.REQUEST_NO_BATCH);
        }

        uint256 packedPerformanceFeeSchedule = VaultConfigStorage.data().performanceFeeSchedule;
        uint32 performanceFeePeriod = uint32(packedPerformanceFeeSchedule >> PERFORMANCE_FEE_PERIOD_SHIFT);
        if (
            VaultBaseStorage.data().totalSupply != 0 && performanceFeePeriod != 0
                && block.timestamp < uint256(lifecycle.lastFeeAccrualAt) + performanceFeePeriod
        ) {
            revert IUFarmVaultErrors.OracleFlowError(ErrorCodes.ORACLE_COOLDOWN_ACTIVE);
        }

        if (block.timestamp < lifecycle.settlementAllowedAt) {
            revert IUFarmVaultErrors.OracleFlowError(ErrorCodes.ORACLE_COOLDOWN_ACTIVE);
        }

        address oracle = _oracleForVault();
        if (oracle == address(0)) revert IUFarmVaultErrors.OracleFlowError(ErrorCodes.ORACLE_INVALID);

        oracleRequestId = IUFarmOracle(oracle).requestNav(address(this));
        if (oracleRequestId == 0) revert IUFarmVaultErrors.OracleFlowError(ErrorCodes.ORACLE_INVALID_REQUEST);

        lifecycle.activeOracleRequest = VaultTypes.ActiveOracleRequest({
            requestId: oracleRequestId, requestedAt: uint64(block.timestamp), oracle: oracle
        });
        emit OracleRequestStarted(oracle, oracleRequestId);
        // slither-disable-end reentrancy-no-eth
    }

    function _escrow() internal view returns (address) {
        return IUFarmCore(VaultBaseStorage.data().core).escrow();
    }

    function _requireOwnerOrOperator(address owner_) internal view {
        if (owner_ == address(0)) revert IUFarmVaultErrors.InvalidAddress();
        if (msg.sender != owner_ && !VaultPermissionStorage.data().operatorStates[owner_].approvals[msg.sender]) {
            revert IUFarmVaultErrors.Unauthorized(msg.sender);
        }
    }

    function _checkRequestReady(uint256 pauseMask) internal view {
        VaultGuards.checkNotPaused(pauseMask);
        VaultGuards.requireAccountingChain();
        VaultGuards.requireOracleInactive();
    }

    function _checkDepositRange(address asset_, uint256 assets) internal view {
        uint256 minDeposit = VaultConfigStorage.data().minDeposit;
        uint256 maxDeposit = VaultConfigStorage.data().maxDeposit;
        if (minDeposit == 0 && maxDeposit == type(uint256).max) return;

        uint256 usdValue = IUFarmCore(VaultBaseStorage.data().core).valueTokenToUsd(asset_, assets);
        if (usdValue < minDeposit || usdValue > maxDeposit) {
            revert IUFarmVaultErrors.InvalidAmount();
        }
    }

    function _requestDeposit(
        IUFarmVaultRequests.SignedRequest memory signedRequest,
        bool requireSignature,
        address escrow_
    ) internal returns (bool) {
        // slither-disable-start reentrancy-no-eth,calls-loop
        IUFarmVaultRequests.RequestParams memory request = signedRequest.request;
        if (!_validateRequest(signedRequest, requireSignature, false)) return false;

        VaultTypes.OwnerRequestState storage state = VaultLifecycleStorage.data().requestStates[request.owner];
        state.pendingDeposit = VaultTypes.PendingRequest({
            asset: request.asset, amount: request.amount, minOutputAmount: request.minOutputAmount
        });
        _enqueueDeposit(request.owner);

        uint64 lockedTill = uint64(block.timestamp) + DEPOSIT_LOCK_PERIOD;
        try IUFarmEscrow(escrow_).creditFrom(request.asset, request.owner, request.owner, request.amount, lockedTill) {}
        catch {
            delete state.pendingDeposit;
            _removePendingDepositOwner(request.owner);
            return false;
        }

        _consumeRequestNonceIfSigned(signedRequest);
        emit DepositRequest(request.owner, request.owner, 0, msg.sender, request.amount);
        return true;
        // slither-disable-end reentrancy-no-eth,calls-loop
    }

    function _requestRedeem(IUFarmVaultRequests.SignedRequest memory signedRequest, bool requireSignature)
        internal
        returns (bool)
    {
        IUFarmVaultRequests.RequestParams memory request = signedRequest.request;
        if (!_validateRequest(signedRequest, requireSignature, true)) return false;

        VaultShareAccounting.moveShares(request.owner, address(this), request.amount);
        VaultTypes.OwnerRequestState storage state = VaultLifecycleStorage.data().requestStates[request.owner];
        state.pendingRedeem = VaultTypes.PendingRequest({
            asset: request.asset, amount: request.amount, minOutputAmount: request.minOutputAmount
        });
        _enqueueRedeem(request.owner);

        _consumeRequestNonceIfSigned(signedRequest);
        emit RedeemRequest(request.owner, request.owner, 0, msg.sender, request.amount);
        return true;
    }

    function _unsignedRequest(address asset_, uint256 amount, address controller, address owner_)
        internal
        pure
        returns (IUFarmVaultRequests.SignedRequest memory)
    {
        return IUFarmVaultRequests.SignedRequest({
            request: IUFarmVaultRequests.RequestParams({
                asset: asset_, amount: amount, minOutputAmount: 0, controller: controller, owner: owner_
            }),
            nonce: 0,
            deadline: 0,
            signature: ""
        });
    }

    function _validateRequest(
        IUFarmVaultRequests.SignedRequest memory signedRequest,
        bool requireSignature,
        bool isRedeem
    ) internal view returns (bool) {
        // slither-disable-start calls-loop
        IUFarmVaultRequests.RequestParams memory request = signedRequest.request;
        if (!_validateSignedRequest(signedRequest, requireSignature, isRedeem)) return false;
        if (request.amount == 0) return false;
        if (request.controller != request.owner || request.owner == address(0)) return false;
        if (_hasAnyActiveBucket(request.owner)) return false;
        IUFarmCore core = IUFarmCore(VaultBaseStorage.data().core);
        if (request.asset == address(0)) return false;
        if (isRedeem) {
            if (core.usdToValueToken(request.asset, WAD) == 0) return false;
        } else if (core.valueTokenToUsd(request.asset, request.amount) == 0) {
            return false;
        }
        if (isRedeem && VaultBaseStorage.data().balances[request.owner] < request.amount) return false;
        if (isRedeem ? !_canEnqueueRedeem(request.owner) : !_canEnqueueDeposit(request.owner)) return false;
        return true;
        // slither-disable-end calls-loop
    }

    function _validateSignedRequest(
        IUFarmVaultRequests.SignedRequest memory signedRequest,
        bool requireSignature,
        bool isRedeem
    ) internal view returns (bool) {
        IUFarmVaultRequests.RequestParams memory request = signedRequest.request;
        if (signedRequest.signature.length == 0) return !requireSignature;
        if (request.owner == address(0)) return false;
        if (block.timestamp > signedRequest.deadline) return false;
        if (VaultPermissionStorage.data().operatorStates[request.owner].requestNonce != signedRequest.nonce) {
            return false;
        }

        bytes32 requestHash = keccak256(
            abi.encode(
                REQUEST_PARAMS_TYPEHASH,
                request.asset,
                request.amount,
                request.minOutputAmount,
                request.controller,
                request.owner
            )
        );
        bytes32 signedRequestTypehash = isRedeem ? SIGNED_REDEEM_REQUEST_TYPEHASH : SIGNED_DEPOSIT_REQUEST_TYPEHASH;
        bytes32 structHash =
            keccak256(abi.encode(signedRequestTypehash, requestHash, signedRequest.nonce, signedRequest.deadline));
        bytes32 digest = _hashTypedDataV4(structHash);
        return _isValidOwnerSignature(request.owner, digest, signedRequest.signature);
    }

    function _isValidOwnerSignature(address owner_, bytes32 digest, bytes memory signature)
        internal
        view
        returns (bool)
    {
        // slither-disable-next-line unused-return
        (address recovered, ECDSA.RecoverError recoverError,) = ECDSA.tryRecover(digest, signature);
        if (recoverError == ECDSA.RecoverError.NoError && recovered == owner_) return true;
        if (owner_.code.length == 0) return false;

        // slither-disable-next-line calls-loop -- ERC-1271 owners are intentionally supported in bounded request batches.
        try IERC1271(owner_).isValidSignature{gas: ERC1271_VALIDATION_GAS_LIMIT}(digest, signature) returns (
            bytes4 magicValue
        ) {
            return magicValue == IERC1271.isValidSignature.selector;
        } catch {
            return false;
        }
    }

    function _consumeRequestNonceIfSigned(IUFarmVaultRequests.SignedRequest memory signedRequest) internal {
        if (signedRequest.signature.length != 0) {
            VaultPermissionStorage.data().operatorStates[signedRequest.request.owner].requestNonce =
                signedRequest.nonce + 1;
        }
    }

    function _validateClientVerification(address owner_, IUFarmVaultRequests.ClientVerification calldata verification)
        internal
        view
    {
        uint8 requiredTier = VaultConfigStorage.data().clientTier;
        if (requiredTier == 0) return;
        if (verification.validTill < block.timestamp) revert IUFarmVaultErrors.InvalidSignature();
        if (verification.tier < requiredTier) revert IUFarmVaultErrors.InvalidSignature();

        bytes32 structHash = keccak256(
            abi.encode(CLIENT_VERIFICATION_TYPEHASH, owner_, address(this), verification.tier, verification.validTill)
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        // slither-disable-next-line unused-return
        (address recovered, ECDSA.RecoverError recoverError,) = ECDSA.tryRecover(digest, verification.signature);
        if (recoverError != ECDSA.RecoverError.NoError) revert IUFarmVaultErrors.InvalidSignature();
        if (!_hasPermission(recovered, VAULT_CUSTOMER_MANAGER)) revert IUFarmVaultErrors.Unauthorized(recovered);
    }

    function _requireActiveOracleRequestTimedOut() internal view returns (uint256 oracleRequestId) {
        oracleRequestId = VaultLifecycleStorage.data().activeOracleRequest.requestId;
        // slither-disable-next-line incorrect-equality
        if (oracleRequestId == 0) revert IUFarmVaultErrors.OracleFlowError(ErrorCodes.ORACLE_NONE_ACTIVE);
        uint256 timeout = IUFarmCore(VaultBaseStorage.data().core).oracleRequestTimeout();
        if (block.timestamp < uint256(VaultLifecycleStorage.data().activeOracleRequest.requestedAt) + timeout) {
            revert IUFarmVaultErrors.OracleFlowError(ErrorCodes.ORACLE_NOT_TIMED_OUT);
        }
    }

    function _hasAnyActiveBucket(address owner_) internal view returns (bool) {
        VaultTypes.OwnerRequestState storage state = VaultLifecycleStorage.data().requestStates[owner_];
        return state.pendingDeposit.amount != 0 || state.claimableDeposit.assets != 0 || state.pendingRedeem.amount != 0
            || state.claimableRedeem.shares != 0;
    }

    function _hasPendingBatch() internal view returns (bool) {
        VaultLifecycleStorage.Layout storage lifecycle = VaultLifecycleStorage.data();
        return lifecycle.pendingDepositOwners.length != 0 || lifecycle.pendingRedeemOwners.length != 0;
    }

    function _oracleForVault() internal view returns (address) {
        return IUFarmCore(VaultBaseStorage.data().core).oracleForVault(address(this));
    }

    function _checkPermission(uint256 requiredMask) internal view {
        if (!_hasPermission(msg.sender, requiredMask)) revert IUFarmVaultErrors.Unauthorized(msg.sender);
    }

    function _hasPermission(address account, uint256 requiredMask) internal view returns (bool) {
        return Permissions.hasAll(VaultPermissionStorage.data().permissions[account], requiredMask);
    }

    function _enqueueDeposit(address owner_) internal {
        address[] storage pendingDepositOwners = VaultLifecycleStorage.data().pendingDepositOwners;
        if (!_contains(pendingDepositOwners, owner_)) {
            if (pendingDepositOwners.length >= PENDING_QUEUE_LIMIT) {
                revert IUFarmVaultErrors.RequestStateError(ErrorCodes.REQUEST_QUEUE_FULL);
            }
            pendingDepositOwners.push(owner_);
        }
    }

    function _removePendingDepositOwner(address owner_) internal {
        _removePendingOwner(VaultLifecycleStorage.data().pendingDepositOwners, owner_);
    }

    function _canEnqueueDeposit(address owner_) internal view returns (bool) {
        address[] storage pendingDepositOwners = VaultLifecycleStorage.data().pendingDepositOwners;
        return _contains(pendingDepositOwners, owner_) || pendingDepositOwners.length < PENDING_QUEUE_LIMIT;
    }

    function _enqueueRedeem(address owner_) internal {
        address[] storage pendingRedeemOwners = VaultLifecycleStorage.data().pendingRedeemOwners;
        if (!_contains(pendingRedeemOwners, owner_)) {
            if (pendingRedeemOwners.length >= PENDING_QUEUE_LIMIT) {
                revert IUFarmVaultErrors.RequestStateError(ErrorCodes.REQUEST_QUEUE_FULL);
            }
            pendingRedeemOwners.push(owner_);
        }
    }

    function _removePendingRedeemOwner(address owner_) internal {
        _removePendingOwner(VaultLifecycleStorage.data().pendingRedeemOwners, owner_);
    }

    function _canEnqueueRedeem(address owner_) internal view returns (bool) {
        address[] storage pendingRedeemOwners = VaultLifecycleStorage.data().pendingRedeemOwners;
        return _contains(pendingRedeemOwners, owner_) || pendingRedeemOwners.length < PENDING_QUEUE_LIMIT;
    }

    function _contains(address[] storage owners, address owner_) internal view returns (bool) {
        for (uint256 i = 0; i < owners.length; ++i) {
            if (owners[i] == owner_) return true;
        }
        return false;
    }

    function _removePendingOwner(address[] storage owners, address owner_) internal {
        uint256 ownersLength = owners.length;
        for (uint256 i = 0; i < ownersLength; ++i) {
            if (owners[i] != owner_) continue;
            for (uint256 j = i + 1; j < ownersLength; ++j) {
                owners[j - 1] = owners[j];
            }
            owners.pop();
            return;
        }
    }

    function _cancelPendingDeposits() internal {
        VaultLifecycleStorage.Layout storage lifecycle = VaultLifecycleStorage.data();
        uint256 ownersLength = lifecycle.pendingDepositOwners.length;
        address escrow_ = _escrow();
        for (uint256 i = 0; i < ownersLength; ++i) {
            address owner_ = lifecycle.pendingDepositOwners[i];
            VaultTypes.OwnerRequestState storage state = lifecycle.requestStates[owner_];
            VaultTypes.PendingRequest memory request = state.pendingDeposit;
            if (request.amount == 0) continue;

            delete state.pendingDeposit;
            _tryUnlock(escrow_, request.asset, owner_);
            emit DepositCancelled(owner_, request.asset, request.amount);
        }

        delete lifecycle.pendingDepositOwners;
    }

    function _cancelPendingRedeems() internal {
        VaultLifecycleStorage.Layout storage lifecycle = VaultLifecycleStorage.data();
        uint256 ownersLength = lifecycle.pendingRedeemOwners.length;
        for (uint256 i = 0; i < ownersLength; ++i) {
            address owner_ = lifecycle.pendingRedeemOwners[i];
            VaultTypes.OwnerRequestState storage state = lifecycle.requestStates[owner_];
            VaultTypes.PendingRequest memory request = state.pendingRedeem;
            if (request.amount == 0) continue;

            delete state.pendingRedeem;
            VaultShareAccounting.moveShares(address(this), owner_, request.amount);
            emit RedeemCancelled(owner_, request.amount);
        }

        delete lifecycle.pendingRedeemOwners;
    }

    function _claimDeposit(address owner_) internal returns (uint256) {
        VaultGuards.checkNotPaused(PauseMask.CLAIMS_PAUSED);
        VaultGuards.requireAccountingChain();
        _requireOwnerOrOperator(owner_);

        VaultTypes.OwnerRequestState storage state = VaultLifecycleStorage.data().requestStates[owner_];
        uint256 shares = state.claimableDeposit.shares;
        if (shares == 0) revert IUFarmVaultErrors.RequestStateError(ErrorCodes.REQUEST_NO_CLAIMABLE);

        delete state.claimableDeposit;
        VaultShareAccounting.moveShares(address(this), owner_, shares);
        emit DepositClaimed(owner_, shares);
        return shares;
    }

    function _claimRedeemAssets(address owner_, address receiver) internal returns (uint256) {
        VaultGuards.checkNotPaused(PauseMask.CLAIMS_PAUSED);
        VaultGuards.requireAccountingChain();

        VaultTypes.OwnerRequestState storage state = VaultLifecycleStorage.data().requestStates[owner_];
        VaultTypes.ClaimableRequest memory request = state.claimableRedeem;
        uint256 assets = request.assets;
        if (assets == 0) revert IUFarmVaultErrors.RequestStateError(ErrorCodes.REQUEST_NO_CLAIMABLE);

        delete state.claimableRedeem;
        uint256 releasableAssets = _releaseAvailableEscrow(request.asset, owner_, receiver, assets);
        emit RedeemClaimed(owner_, request.asset, releasableAssets);
        return releasableAssets;
    }

    function _previewFeeAccrual(uint256 nav, uint256 startingSupply)
        internal
        view
        returns (VaultTypes.FeeAccrual memory accrual)
    {
        // slither-disable-next-line incorrect-equality
        if (startingSupply == 0) return accrual;

        VaultBaseStorage.Layout storage base = VaultBaseStorage.data();
        VaultConfigStorage.Layout storage config = VaultConfigStorage.data();
        VaultLifecycleStorage.Layout storage lifecycle = VaultLifecycleStorage.data();
        uint256 elapsed = block.timestamp - uint256(lifecycle.lastFeeAccrualAt);

        (uint256 protocolFee_, bool zeroUFarmFee) = IUFarmCore(base.core).protocolFee(address(this));
        accrual.protocolFeeShares = FeeMath.aumFeeShares(startingSupply, protocolFee_, elapsed);
        uint256 supplyAfterProtocol = startingSupply + accrual.protocolFeeShares;

        accrual.managementFeeShares = FeeMath.aumFeeShares(supplyAfterProtocol, config.managementFee, elapsed);
        (uint256 managementProtocolCut, uint256 managementCuratorCut) =
            FeeMath.splitCuratorFee(accrual.managementFeeShares, zeroUFarmFee);

        uint256 supplyAfterAum = supplyAfterProtocol + accrual.managementFeeShares;
        (accrual.performanceFeeShares, accrual.grossSharePrice) = FeeMath.performanceFeeShares(
            nav, supplyAfterAum, lifecycle.highWaterMark, uint256(uint128(config.performanceFeeSchedule))
        );
        (uint256 performanceProtocolCut, uint256 performanceCuratorCut) =
            FeeMath.splitCuratorFee(accrual.performanceFeeShares, zeroUFarmFee);

        accrual.protocolShares = accrual.protocolFeeShares + managementProtocolCut + performanceProtocolCut;
        accrual.curatorShares = managementCuratorCut + performanceCuratorCut;
    }

    function _commitFeeAccrual(VaultTypes.FeeAccrual memory accrual) internal {
        VaultBaseStorage.Layout storage base = VaultBaseStorage.data();
        VaultLifecycleStorage.Layout storage lifecycle = VaultLifecycleStorage.data();
        lifecycle.lastFeeAccrualAt = uint64(block.timestamp);
        if (accrual.protocolShares != 0) {
            VaultShareAccounting.mintShares(base.core, accrual.protocolShares);
        }
        if (accrual.curatorShares != 0) {
            VaultShareAccounting.mintShares(base.curator, accrual.curatorShares);
        }
        if (accrual.protocolShares != 0 || accrual.curatorShares != 0) {
            emit FeesAccrued(
                accrual.protocolShares,
                accrual.curatorShares,
                accrual.protocolFeeShares,
                accrual.managementFeeShares,
                accrual.performanceFeeShares
            );
        }
        if (lifecycle.lastTokenPrice > lifecycle.highWaterMark) {
            lifecycle.highWaterMark = lifecycle.lastTokenPrice;
        }
    }

    function _settlePendingDeposits(uint256 startingTotalSupply, uint256 nav, address escrow_) internal {
        // slither-disable-start reentrancy-no-eth
        VaultLifecycleStorage.Layout storage lifecycle = VaultLifecycleStorage.data();
        uint256 ownersLength = lifecycle.pendingDepositOwners.length;
        IUFarmCore core = IUFarmCore(VaultBaseStorage.data().core);
        for (uint256 i = 0; i < ownersLength; ++i) {
            address owner_ = lifecycle.pendingDepositOwners[i];
            VaultTypes.OwnerRequestState storage state = lifecycle.requestStates[owner_];
            VaultTypes.PendingRequest memory request = state.pendingDeposit;
            if (request.amount == 0) continue;

            delete state.pendingDeposit;

            // slither-disable-next-line calls-loop -- pending deposit settlement is bounded and must re-check current pricing.
            uint256 usdValue = core.valueTokenToUsd(request.asset, request.amount);
            // slither-disable-next-line incorrect-equality
            if (usdValue == 0) {
                _tryUnlock(escrow_, request.asset, owner_);
                emit RequestFailed(owner_, REQUEST_KIND_DEPOSIT, REQUEST_FAIL_ZERO_OUTPUT);
                continue;
            }

            // slither-disable-next-line incorrect-equality
            uint256 shares = startingTotalSupply == 0 ? usdValue : Math.mulDiv(usdValue, startingTotalSupply, nav);
            // slither-disable-next-line incorrect-equality
            if (shares == 0) {
                _tryUnlock(escrow_, request.asset, owner_);
                emit RequestFailed(owner_, REQUEST_KIND_DEPOSIT, REQUEST_FAIL_ZERO_OUTPUT);
                continue;
            }

            if (shares < request.minOutputAmount) {
                _tryUnlock(escrow_, request.asset, owner_);
                emit RequestFailed(owner_, REQUEST_KIND_DEPOSIT, REQUEST_FAIL_SLIPPAGE);
                continue;
            }

            if (!_tryReleaseToVault(escrow_, request.asset, owner_, request.amount)) {
                _tryUnlock(escrow_, request.asset, owner_);
                emit RequestFailed(owner_, REQUEST_KIND_DEPOSIT, REQUEST_FAIL_ESCROW_ACTION);
                continue;
            }

            VaultShareAccounting.mintShares(address(this), shares);
            state.claimableDeposit.asset = request.asset;
            state.claimableDeposit.assets += request.amount;
            state.claimableDeposit.shares += shares;
            emit DepositSettled(owner_, request.asset, request.amount, shares);
        }

        delete lifecycle.pendingDepositOwners;
        // slither-disable-end reentrancy-no-eth
    }

    function _settlePendingRedeems(uint256 startingTotalSupply, uint256 nav, address escrow_) internal {
        // slither-disable-start reentrancy-no-eth
        VaultLifecycleStorage.Layout storage lifecycle = VaultLifecycleStorage.data();
        uint256 ownersLength = lifecycle.pendingRedeemOwners.length;
        IUFarmCore core = IUFarmCore(VaultBaseStorage.data().core);
        for (uint256 i = 0; i < ownersLength; ++i) {
            address owner_ = lifecycle.pendingRedeemOwners[i];
            VaultTypes.OwnerRequestState storage state = lifecycle.requestStates[owner_];
            VaultTypes.PendingRequest memory request = state.pendingRedeem;
            if (request.amount == 0) continue;

            uint256 usdValue = Math.mulDiv(request.amount, nav, startingTotalSupply);
            // slither-disable-next-line calls-loop -- pending redeem settlement is bounded and must re-check current pricing.
            uint256 assets = core.usdToValueToken(request.asset, usdValue);
            uint8 errorCode = 0;

            // slither-disable-next-line incorrect-equality
            if (assets == 0) {
                errorCode = REQUEST_FAIL_ZERO_OUTPUT;
            } else if (assets < request.minOutputAmount) {
                errorCode = REQUEST_FAIL_SLIPPAGE;
                // slither-disable-next-line calls-loop
            } else if (IERC20(request.asset).balanceOf(address(this)) < assets) {
                errorCode = REQUEST_FAIL_INSUFFICIENT_LIQUIDITY;
            } else if (!_tryCreditRedeemToEscrow(escrow_, request.asset, owner_, assets)) {
                errorCode = REQUEST_FAIL_ESCROW_ACTION;
            }

            delete state.pendingRedeem;
            if (errorCode != 0) {
                VaultShareAccounting.moveShares(address(this), owner_, request.amount);
                emit RequestFailed(owner_, REQUEST_KIND_REDEEM, errorCode);
            } else {
                VaultShareAccounting.burnShares(address(this), request.amount);
                state.claimableRedeem =
                    VaultTypes.ClaimableRequest({asset: request.asset, assets: assets, shares: request.amount});
                emit RedeemSettled(owner_, request.asset, request.amount, assets);
            }
        }

        delete lifecycle.pendingRedeemOwners;
        // slither-disable-end reentrancy-no-eth
    }

    function _tryUnlock(address escrow_, address asset_, address owner_) internal {
        // slither-disable-next-line calls-loop
        try IUFarmEscrow(escrow_).unlock(asset_, owner_) {} catch {}
    }

    function _releaseAvailableEscrow(address asset_, address owner_, address receiver, uint256 assets)
        internal
        returns (uint256 releasedAssets)
    {
        address escrow_ = _escrow();
        // slither-disable-next-line unused-return
        (uint256 escrowAssets,) = IUFarmEscrow(escrow_).balanceOf(address(this), asset_, owner_);
        releasedAssets = escrowAssets < assets ? escrowAssets : assets;
        if (releasedAssets == 0) return 0;

        // slither-disable-next-line calls-loop
        try IUFarmEscrow(escrow_).releaseTo(asset_, owner_, receiver, releasedAssets) {
            return releasedAssets;
        } catch {
            _tryUnlock(escrow_, asset_, owner_);
            return 0;
        }
    }

    function _tryReleaseToVault(address escrow_, address asset_, address owner_, uint256 assets)
        internal
        returns (bool)
    {
        // slither-disable-next-line calls-loop
        try IUFarmEscrow(escrow_).releaseToVault(asset_, owner_, assets) {
            return true;
        } catch {
            return false;
        }
    }

    function _tryCreditRedeemToEscrow(address escrow_, address asset_, address owner_, uint256 assets)
        internal
        returns (bool success)
    {
        IERC20(asset_).forceApprove(escrow_, assets);
        // slither-disable-next-line calls-loop
        try IUFarmEscrow(escrow_).creditFrom(asset_, address(this), owner_, assets, 0) {
            success = true;
        } catch {
            success = false;
        }
        IERC20(asset_).forceApprove(escrow_, 0);
    }
}
