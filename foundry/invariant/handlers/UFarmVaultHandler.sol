// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {UFarmVault} from "../../../contracts/vault/UFarmVault.sol";
import {UFarmCore} from "../../../contracts/core/UFarmCore.sol";
import {IUFarmEscrow} from "../../../contracts/interfaces/IUFarmEscrow.sol";
import {IUFarmVaultRequests} from "../../../contracts/interfaces/IUFarmVaultRequests.sol";
import {MockChainlinkAggregator} from "../../../contracts/mocks/MockChainlinkAggregator.sol";
import {MockERC20} from "../../../contracts/mocks/MockERC20.sol";
import {MockUFarmOracle} from "../../../contracts/mocks/MockUFarmOracle.sol";
import {MockVaultAdapter} from "../../../contracts/mocks/MockVaultAdapter.sol";
import {Permissions} from "../../../contracts/libraries/Permissions.sol";
import {SettlementAction} from "../../../contracts/libraries/SettlementAction.sol";
import {InvariantVm} from "../helpers/InvariantVm.sol";

contract UFarmVaultHandler is InvariantVm {
    uint256 private constant WAD = 1e18;
    uint256 private constant MAX_PERFORMANCE_THRESHOLD_BPS = type(uint16).max;
    uint256 private constant SIGNED_OWNER_PK = 0xA11CE;
    bytes32 private constant REQUEST_PARAMS_TYPEHASH = keccak256(
        "RequestParams(address asset,uint256 amount,uint256 minOutputAmount,address controller,address owner)"
    );
    bytes32 private constant SIGNED_DEPOSIT_REQUEST_TYPEHASH = keccak256(
        "SignedDepositRequest(RequestParams request,uint256 nonce,uint256 deadline)RequestParams(address asset,uint256 amount,uint256 minOutputAmount,address controller,address owner)"
    );
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    UFarmVault internal immutable vault;
    UFarmCore internal immutable core;
    IUFarmEscrow internal immutable escrow;
    MockERC20 internal immutable asset;
    MockERC20 internal immutable customAsset;
    MockChainlinkAggregator internal immutable assetFeed;
    MockChainlinkAggregator internal immutable customAssetFeed;
    MockUFarmOracle internal immutable oracle;
    address internal immutable signedOwner;

    address[] internal actors;

    uint256 public totalCalls;
    uint256 public failedCalls;
    bool public unexpectedShareTransferSucceeded;
    bool public unexpectedOracleGuardBypassSucceeded;
    bool public unexpectedOracleClaimBlocked;
    bool public unexpectedUnauthorizedOperationSucceeded;
    bool public unexpectedFeeUpdateAfterSupplySucceeded;
    bool public unexpectedSignedNonceChange;
    bool public unexpectedSignedReplaySucceeded;
    bool public unexpectedDoubleClaimSucceeded;
    bool public unexpectedOracleIdentityMutation;
    bool public unexpectedOracleResetMutation;
    bool public unexpectedOracleResendMutation;
    bool public unexpectedInvalidPriceSettlement;
    bool public unexpectedEscrowAllowance;

    mapping(address actor => uint256 amount) public modeledPendingDeposit;
    mapping(address actor => address asset) public modeledPendingDepositAsset;
    mapping(address actor => uint256 amount) public modeledPendingRedeem;
    mapping(address actor => uint256 amount) public modeledClaimableDepositAssets;
    mapping(address actor => uint256 amount) public modeledClaimableRedeemShares;

    constructor(
        UFarmVault vault_,
        IUFarmEscrow escrow_,
        MockERC20 asset_,
        MockERC20 customAsset_,
        MockChainlinkAggregator assetFeed_,
        MockChainlinkAggregator customAssetFeed_,
        MockUFarmOracle oracle_,
        address[] memory actors_
    ) {
        require(address(vault_) != address(0), "vault is zero");
        require(address(escrow_) != address(0), "escrow is zero");
        require(address(asset_) != address(0), "asset is zero");
        require(address(customAsset_) != address(0), "custom asset is zero");
        require(address(assetFeed_) != address(0), "asset feed is zero");
        require(address(customAssetFeed_) != address(0), "custom asset feed is zero");
        require(address(oracle_) != address(0), "oracle is zero");
        require(actors_.length != 0, "no actors");

        vault = vault_;
        core = UFarmCore(vault_.core());
        escrow = escrow_;
        asset = asset_;
        customAsset = customAsset_;
        assetFeed = assetFeed_;
        customAssetFeed = customAssetFeed_;
        oracle = oracle_;
        actors = actors_;
        signedOwner = vm.addr(SIGNED_OWNER_PK);
        actors.push(signedOwner);
        asset.mint(signedOwner, 1_000_000 ether);
        customAsset.mint(signedOwner, 1_000_000 * 1e6);
        vm.startPrank(signedOwner);
        asset.approve(address(escrow), type(uint256).max);
        customAsset.approve(address(escrow), type(uint256).max);
        vm.stopPrank();
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function actorAt(uint256 index) external view returns (address) {
        return _actorFromSeed(index);
    }

    function modeledTotalShares() external view returns (uint256 totalShares) {
        uint256 length = actors.length;
        for (uint256 i = 0; i < length; i += 1) {
            totalShares += vault.balanceOf(actors[i]);
        }

        totalShares += vault.balanceOf(address(vault));
        totalShares += vault.balanceOf(address(escrow));
    }

    function modeledEscrowDepositLiability() external view returns (uint256 totalPendingDepositAssets) {
        uint256 length = actors.length;
        for (uint256 i = 0; i < length; i += 1) {
            totalPendingDepositAssets += modeledPendingDeposit[actors[i]];
        }
    }

    function requestDeposit(uint256 actorSeed, uint256 amountSeed) external {
        totalCalls += 1;
        address actor = _actorFromSeed(actorSeed);
        _refreshActorState(actor);
        if (_hasActiveBucket(actor)) {
            failedCalls += 1;
            return;
        }

        uint256 amount = vm.bound(amountSeed, 1, 100_000 ether);
        vm.prank(actor);
        try vault.requestDeposit(amount, actor, actor) {
            modeledPendingDepositAsset[actor] = address(asset);
            _refreshActorState(actor);
        } catch {
            failedCalls += 1;
        }
    }

    function requestCustomDeposit(uint256 actorSeed, uint256 amountSeed) external {
        totalCalls += 1;
        address actor = _actorFromSeed(actorSeed);
        _refreshActorState(actor);
        if (_hasActiveBucket(actor)) {
            failedCalls += 1;
            return;
        }

        uint256 amount = vm.bound(amountSeed, 1, 100_000 * 1e6);
        IUFarmVaultRequests.ClientVerification memory verification;
        vm.prank(actor);
        try vault.requestDeposit(address(customAsset), amount, actor, actor, verification) {
            modeledPendingDepositAsset[actor] = address(customAsset);
            _refreshActorState(actor);
        } catch {
            failedCalls += 1;
        }
    }

    function cancelDeposit(uint256 actorSeed) external {
        totalCalls += 1;
        address actor = _actorFromSeed(actorSeed);
        _refreshActorState(actor);
        if (modeledPendingDeposit[actor] == 0) {
            failedCalls += 1;
            return;
        }

        vm.prank(actor);
        try vault.cancelDeposit(actor) {
            _refreshActorState(actor);
        } catch {
            failedCalls += 1;
        }
    }

    function claimDepositViaDeposit(uint256 actorSeed) external {
        totalCalls += 1;
        address actor = _actorFromSeed(actorSeed);
        _refreshActorState(actor);
        if (modeledClaimableDepositAssets[actor] == 0) {
            failedCalls += 1;
            return;
        }

        vm.prank(actor);
        try vault.deposit(0, actor, actor) {
            _refreshActorState(actor);
        } catch {
            failedCalls += 1;
        }
    }

    function requestRedeem(uint256 actorSeed, uint256 sharesSeed) external {
        totalCalls += 1;
        address actor = _actorFromSeed(actorSeed);
        _refreshActorState(actor);
        if (_hasActiveBucket(actor)) {
            failedCalls += 1;
            return;
        }

        uint256 balance = vault.balanceOf(actor);
        if (balance == 0) {
            failedCalls += 1;
            return;
        }

        uint256 shares = vm.bound(sharesSeed, 1, balance);
        vm.prank(actor);
        try vault.requestRedeem(shares, actor, actor) {
            _refreshActorState(actor);
        } catch {
            failedCalls += 1;
        }
    }

    function cancelRedeem(uint256 actorSeed) external {
        totalCalls += 1;
        address actor = _actorFromSeed(actorSeed);
        _refreshActorState(actor);
        if (modeledPendingRedeem[actor] == 0) {
            failedCalls += 1;
            return;
        }

        vm.prank(actor);
        try vault.cancelRedeem(actor) {
            _refreshActorState(actor);
        } catch {
            failedCalls += 1;
        }
    }

    function claimRedeemViaRedeem(uint256 actorSeed) external {
        totalCalls += 1;
        address actor = _actorFromSeed(actorSeed);
        _refreshActorState(actor);
        if (modeledClaimableRedeemShares[actor] == 0) {
            failedCalls += 1;
            return;
        }

        vm.prank(actor);
        try vault.redeem(0, actor, actor) {
            _refreshActorState(actor);
        } catch {
            failedCalls += 1;
        }
    }

    function attemptShareTransfer(uint256 actorSeed, uint256 receiverSeed, uint256 amountSeed) external {
        totalCalls += 1;
        address actor = _actorFromSeed(actorSeed);
        address receiver = receiverSeed % 2 == 0 ? _actorFromSeed(receiverSeed) : address(uint160(receiverSeed));
        if (receiver == address(0)) {
            receiver = address(0xDEAD);
        }
        uint256 balance = vault.balanceOf(actor);
        uint256 amount = balance == 0 ? 1 : vm.bound(amountSeed, 1, balance);

        vm.prank(actor);
        try vault.transfer(receiver, amount) {
            unexpectedShareTransferSucceeded = true;
        } catch {
            failedCalls += 1;
        }
    }

    function withdrawEscrow(uint256 actorSeed, uint256 assetSeed, uint256 amountSeed, uint256 receiverSeed) external {
        totalCalls += 1;
        address actor = _actorFromSeed(actorSeed);
        address receiver = _actorFromSeed(receiverSeed);
        address escrowAsset = assetSeed % 2 == 0 ? address(asset) : address(customAsset);
        (uint256 escrowAmount, uint64 lockedTill) = escrow.balanceOf(address(vault), escrowAsset, actor);
        if (escrowAmount == 0 || lockedTill > block.timestamp) {
            failedCalls += 1;
            return;
        }

        uint256 amount = vm.bound(amountSeed, 1, escrowAmount);
        vm.prank(actor);
        try escrow.withdraw(address(vault), escrowAsset, amount, receiver) {
            _refreshActorState(actor);
            if (receiver != actor) _refreshActorState(receiver);
        } catch {
            failedCalls += 1;
        }
    }

    function probeActiveOracleGuards(uint256 actorSeed, uint256 amountSeed) external {
        totalCalls += 1;
        if (vault.activeOracleRequestId() == 0) {
            failedCalls += 1;
            return;
        }

        address actor = _actorFromSeed(actorSeed);
        _refreshActorState(actor);

        uint256 amount = vm.bound(amountSeed, 1, 1_000 ether);
        vm.prank(actor);
        try vault.requestDeposit(amount, actor, actor) {
            unexpectedOracleGuardBypassSucceeded = true;
        } catch {
            failedCalls += 1;
        }

        uint256 balance = vault.balanceOf(actor);
        if (balance != 0) {
            uint256 shares = vm.bound(amountSeed, 1, balance);
            vm.prank(actor);
            try vault.requestRedeem(shares, actor, actor) {
                unexpectedOracleGuardBypassSucceeded = true;
            } catch {
                failedCalls += 1;
            }
        }

        if (modeledPendingDeposit[actor] != 0) {
            vm.prank(actor);
            try vault.cancelDeposit(actor) {
                unexpectedOracleGuardBypassSucceeded = true;
            } catch {
                failedCalls += 1;
            }
        }

        if (modeledPendingRedeem[actor] != 0) {
            vm.prank(actor);
            try vault.cancelRedeem(actor) {
                unexpectedOracleGuardBypassSucceeded = true;
            } catch {
                failedCalls += 1;
            }
        }

        if (modeledClaimableDepositAssets[actor] != 0) {
            vm.prank(actor);
            try vault.deposit(0, actor, actor) {
                _refreshActorState(actor);
            } catch {
                unexpectedOracleClaimBlocked = true;
            }
        }

        if (modeledClaimableRedeemShares[actor] != 0) {
            vm.prank(actor);
            try vault.redeem(0, actor, actor) {
                _refreshActorState(actor);
            } catch {
                unexpectedOracleClaimBlocked = true;
            }
        }
    }

    function probeInvalidRequestInputs(uint256 actorSeed, uint256 amountSeed) external {
        totalCalls += 1;
        address actor = _actorFromSeed(actorSeed);
        _refreshActorState(actor);
        uint256 beforeNonce = vault.requestNonces(actor);
        uint256 beforePendingDeposit = modeledPendingDeposit[actor];
        uint256 beforePendingRedeem = modeledPendingRedeem[actor];
        uint256 beforeClaimableDeposit = modeledClaimableDepositAssets[actor];
        uint256 beforeClaimableRedeem = modeledClaimableRedeemShares[actor];
        uint256 amount = vm.bound(amountSeed, 1, 1_000 ether);

        vm.startPrank(actor);
        try vault.requestDeposit(0, actor, actor) {
            unexpectedOracleGuardBypassSucceeded = true;
        } catch {}
        try vault.requestDeposit(amount, address(uint160(uint256(uint160(actor)) + 1)), actor) {
            unexpectedOracleGuardBypassSucceeded = true;
        } catch {}
        try vault.requestDeposit(amount, actor, address(0)) {
            unexpectedOracleGuardBypassSucceeded = true;
        } catch {}
        try vault.requestRedeem(0, actor, actor) {
            unexpectedOracleGuardBypassSucceeded = true;
        } catch {}
        vm.stopPrank();

        _refreshActorState(actor);
        if (
            vault.requestNonces(actor) != beforeNonce || modeledPendingDeposit[actor] != beforePendingDeposit
                || modeledPendingRedeem[actor] != beforePendingRedeem
                || modeledClaimableDepositAssets[actor] != beforeClaimableDeposit
                || modeledClaimableRedeemShares[actor] != beforeClaimableRedeem
        ) {
            unexpectedSignedNonceChange = true;
        }
    }

    function probeInvalidSignedRequests(uint256 amountSeed) external {
        totalCalls += 1;
        _refreshActorState(signedOwner);
        uint256 beforeNonce = vault.requestNonces(signedOwner);
        uint256 beforePendingDeposit = modeledPendingDeposit[signedOwner];
        uint256 beforePendingRedeem = modeledPendingRedeem[signedOwner];
        uint256 beforeClaimableDeposit = modeledClaimableDepositAssets[signedOwner];
        uint256 beforeClaimableRedeem = modeledClaimableRedeemShares[signedOwner];

        IUFarmVaultRequests.SignedRequest[] memory deposits = new IUFarmVaultRequests.SignedRequest[](1);
        deposits[0] = IUFarmVaultRequests.SignedRequest({
            request: IUFarmVaultRequests.RequestParams({
                asset: address(asset),
                amount: vm.bound(amountSeed, 1, 1_000 ether),
                minOutputAmount: 0,
                controller: signedOwner,
                owner: signedOwner
            }),
            nonce: beforeNonce + 1,
            deadline: block.timestamp + 1 days,
            signature: hex"01"
        });
        IUFarmVaultRequests.SignedRequest[] memory redeems = new IUFarmVaultRequests.SignedRequest[](0);

        try vault.settleRequests(deposits, redeems) {
            unexpectedSignedNonceChange = true;
        } catch {}

        _refreshActorState(signedOwner);
        if (
            vault.requestNonces(signedOwner) != beforeNonce
                || modeledPendingDeposit[signedOwner] != beforePendingDeposit
                || modeledPendingRedeem[signedOwner] != beforePendingRedeem
                || modeledClaimableDepositAssets[signedOwner] != beforeClaimableDeposit
                || modeledClaimableRedeemShares[signedOwner] != beforeClaimableRedeem
        ) {
            unexpectedSignedNonceChange = true;
        }
    }

    function submitValidSignedDeposit(uint256 amountSeed) external {
        totalCalls += 1;
        _refreshActorState(signedOwner);
        if (
            _hasActiveBucket(signedOwner) || vault.activeOracleRequestId() != 0
                || block.timestamp < vault.settlementAllowedAt()
        ) {
            failedCalls += 1;
            return;
        }

        uint256 beforeNonce = vault.requestNonces(signedOwner);
        uint256 amount = vm.bound(amountSeed, 1, 1_000 ether);
        IUFarmVaultRequests.SignedRequest memory request =
            _signedDepositRequest(signedOwner, address(asset), amount, beforeNonce, block.timestamp + 1 days);
        IUFarmVaultRequests.SignedRequest[] memory deposits = new IUFarmVaultRequests.SignedRequest[](1);
        deposits[0] = request;
        IUFarmVaultRequests.SignedRequest[] memory redeems = new IUFarmVaultRequests.SignedRequest[](0);

        try vault.settleRequests(deposits, redeems) {
            _refreshActorState(signedOwner);
            if (vault.requestNonces(signedOwner) != beforeNonce + 1) unexpectedSignedNonceChange = true;
            try vault.settleRequests(deposits, redeems) {
                unexpectedSignedReplaySucceeded = true;
            } catch {}
        } catch {
            failedCalls += 1;
        }
    }

    function probeDoubleClaim(uint256 actorSeed) external {
        totalCalls += 1;
        address actor = _actorFromSeed(actorSeed);
        _refreshActorState(actor);
        if (modeledClaimableDepositAssets[actor] != 0) {
            vm.prank(actor);
            try vault.deposit(0, actor, actor) {
                _refreshActorState(actor);
                vm.prank(actor);
                try vault.deposit(0, actor, actor) {
                    unexpectedDoubleClaimSucceeded = true;
                } catch {}
            } catch {
                failedCalls += 1;
            }
            return;
        }
        if (modeledClaimableRedeemShares[actor] != 0) {
            vm.prank(actor);
            try vault.redeem(0, actor, actor) {
                _refreshActorState(actor);
                vm.prank(actor);
                try vault.redeem(0, actor, actor) {
                    unexpectedDoubleClaimSucceeded = true;
                } catch {}
            } catch {
                failedCalls += 1;
            }
            return;
        }
        failedCalls += 1;
    }

    function probeWrongOracleCallbacks(uint256 navSeed) external {
        totalCalls += 1;
        uint256 requestId = vault.activeOracleRequestId();
        if (requestId == 0) {
            failedCalls += 1;
            return;
        }

        _refreshAllActorStates();
        uint256 beforeTotalSupply = vault.totalSupply();
        uint256 beforeSettlementAllowedAt = vault.settlementAllowedAt();
        uint256 nav = vm.bound(navSeed, 1, 10_000_000 ether);

        try vault.onOracleNav(requestId, nav, uint64(block.timestamp)) {
            unexpectedOracleIdentityMutation = true;
        } catch {}
        try oracle.submitNav(requestId + 1, nav, uint64(block.timestamp)) {
            unexpectedOracleIdentityMutation = true;
        } catch {}
        try oracle.submitNav(requestId, nav, uint64(block.timestamp - core.navRequestCooldown() - 1)) {
            unexpectedOracleIdentityMutation = true;
        } catch {}

        _refreshAllActorStates();
        if (
            vault.activeOracleRequestId() != requestId || vault.totalSupply() != beforeTotalSupply
                || vault.settlementAllowedAt() != beforeSettlementAllowedAt
        ) {
            unexpectedOracleIdentityMutation = true;
        }
    }

    function resetTimedOutOracleRequest() external {
        totalCalls += 1;
        uint256 requestId = vault.activeOracleRequestId();
        if (requestId == 0) {
            failedCalls += 1;
            return;
        }

        vm.warp(block.timestamp + core.oracleRequestTimeout());
        try vault.resetRequests() {
            _refreshAllActorStates();
            if (vault.activeOracleRequestId() != 0 || _hasPendingBatch()) unexpectedOracleResetMutation = true;
        } catch {
            failedCalls += 1;
        }
    }

    function resendTimedOutOracleRequest() external {
        totalCalls += 1;
        uint256 requestId = vault.activeOracleRequestId();
        if (requestId == 0) {
            failedCalls += 1;
            return;
        }

        uint256 pendingBefore = _pendingBucketSum();
        vm.warp(block.timestamp + core.oracleRequestTimeout());
        try vault.manualResendOracleRequest() returns (uint256 newRequestId) {
            _refreshAllActorStates();
            if (newRequestId == 0 || newRequestId == requestId || vault.activeOracleRequestId() != newRequestId) {
                unexpectedOracleResendMutation = true;
            }
            if (_pendingBucketSum() != pendingBefore) unexpectedOracleResendMutation = true;
        } catch {
            failedCalls += 1;
        }
    }

    function probeInvalidPrice(uint256 navSeed) external {
        totalCalls += 1;
        if (vault.totalSupply() == 0 || vault.lastTokenPrice() == 0 || vault.activeOracleRequestId() != 0) {
            failedCalls += 1;
            return;
        }
        if (block.timestamp < vault.settlementAllowedAt()) {
            failedCalls += 1;
            return;
        }

        _refreshAllActorStates();
        uint256 pendingBefore = _pendingBucketSum();
        core.setAllowedPriceFluctuation(0.01 ether);
        try vault.settleRequests() returns (uint256 requestId) {
            uint256 nav = vm.bound(navSeed, 1, 1_000);
            try oracle.submitNav(requestId, nav, uint64(block.timestamp)) {
                _refreshAllActorStates();
                if (!vault.isInvalidPrice()) unexpectedInvalidPriceSettlement = true;
                if (_pendingBucketSum() != pendingBefore) unexpectedInvalidPriceSettlement = true;
            } catch {
                failedCalls += 1;
            }
        } catch {
            failedCalls += 1;
        }
    }

    function resetInvalidPriceLatch() external {
        totalCalls += 1;
        if (!vault.isInvalidPrice()) {
            failedCalls += 1;
            return;
        }
        uint256 acceptedNav = (vault.lastTokenPrice() * vault.totalSupply()) / WAD;
        try vault.resetInvalidPrice(acceptedNav) {}
        catch {
            failedCalls += 1;
        }
    }

    function manualSettle(uint256 navSeed) external {
        totalCalls += 1;
        _refreshAllActorStates();
        if (!_hasPendingBatch()) {
            failedCalls += 1;
            return;
        }

        uint256 nav = vm.bound(navSeed, 1, 10_000_000 ether);
        try vault.settleRequests() returns (uint256 requestId) {
            try oracle.submitNav(requestId, nav, uint64(block.timestamp)) {
                _refreshAllActorStates();
                _checkEscrowAllowanceCleared();
            } catch {
                failedCalls += 1;
            }
        } catch {
            failedCalls += 1;
        }
    }

    function executeAdapterCooldown(uint256) external {
        totalCalls += 1;
        if (vault.activeOracleRequestId() != 0) {
            failedCalls += 1;
            return;
        }

        bytes memory callData = abi.encodeCall(MockVaultAdapter.echoUint256, (uint256(SettlementAction.Cooldown)));
        try vault.executeAdapter(keccak256("ufarm.adapter.arbitrary"), callData) {}
        catch {
            failedCalls += 1;
        }
    }

    function attemptUnauthorizedOperations(uint256 actorSeed, uint256) external {
        totalCalls += 1;
        address actor = _actorFromSeed(actorSeed);
        bytes memory callData = abi.encodeCall(MockVaultAdapter.echoUint256, (uint256(SettlementAction.None)));

        vm.startPrank(actor);
        try vault.settleRequests() {
            unexpectedUnauthorizedOperationSucceeded = true;
        } catch {}
        try vault.resetRequests() {
            unexpectedUnauthorizedOperationSucceeded = true;
        } catch {}
        try vault.executeAdapter(keccak256("ufarm.adapter.arbitrary"), callData) {
            unexpectedUnauthorizedOperationSucceeded = true;
        } catch {}
        try vault.setClientTier(1) {
            unexpectedUnauthorizedOperationSucceeded = true;
        } catch {}
        try vault.setFees(1, _performanceFeeSchedule(1)) {
            unexpectedUnauthorizedOperationSucceeded = true;
        } catch {}
        vm.stopPrank();
    }

    function attemptFeeUpdateAfterSupply(uint256 managementFeeSeed, uint256 performanceFeeSeed) external {
        totalCalls += 1;
        if (vault.totalSupply() == 0) {
            failedCalls += 1;
            return;
        }

        uint256 managementFee = vm.bound(managementFeeSeed, 0, 0.1 ether);
        uint256 performanceFee = vm.bound(performanceFeeSeed, 0, 5_000);
        try vault.setFees(managementFee, _performanceFeeSchedule(performanceFee)) {
            unexpectedFeeUpdateAfterSupplySucceeded = true;
        } catch {
            failedCalls += 1;
        }
    }

    function _performanceFeeSchedule(uint256 feeBps) internal pure returns (uint256) {
        return feeBps | (MAX_PERFORMANCE_THRESHOLD_BPS << 16);
    }

    function startOracleRequest() external {
        totalCalls += 1;
        _refreshAllActorStates();
        if (!_hasPendingBatch() || vault.activeOracleRequestId() != 0) {
            failedCalls += 1;
            return;
        }

        try vault.settleRequests() {
            _refreshAllActorStates();
        } catch {
            failedCalls += 1;
        }
    }

    function submitOracleNav(uint256 navSeed) external {
        totalCalls += 1;
        uint256 requestId = vault.activeOracleRequestId();
        if (requestId == 0) {
            failedCalls += 1;
            return;
        }

        uint256 nav = vm.bound(navSeed, 1, 10_000_000 ether);
        try oracle.submitNav(requestId, nav, uint64(block.timestamp)) {
            _refreshAllActorStates();
            _checkEscrowAllowanceCleared();
        } catch {
            failedCalls += 1;
        }
    }

    function warpForward(uint256 secondsSeed) external {
        totalCalls += 1;
        uint256 secondsForward = vm.bound(secondsSeed, 1, 7 days);
        vm.warp(block.timestamp + secondsForward);
        _refreshFeedTimestamp(assetFeed);
        _refreshFeedTimestamp(customAssetFeed);
    }

    function _actorFromSeed(uint256 actorSeed) internal view returns (address) {
        return actors[actorSeed % actors.length];
    }

    function _hasActiveBucket(address actor) internal view returns (bool) {
        return modeledPendingDeposit[actor] != 0 || modeledPendingRedeem[actor] != 0
            || modeledClaimableDepositAssets[actor] != 0 || modeledClaimableRedeemShares[actor] != 0;
    }

    function _hasPendingBatch() internal view returns (bool) {
        uint256 length = actors.length;
        for (uint256 i = 0; i < length; i += 1) {
            address actor = actors[i];
            if (modeledPendingDeposit[actor] != 0 || modeledPendingRedeem[actor] != 0) {
                return true;
            }
        }
        return false;
    }

    function _pendingBucketSum() internal view returns (uint256 sum) {
        uint256 length = actors.length;
        for (uint256 i = 0; i < length; i += 1) {
            address actor = actors[i];
            sum += vault.pendingDepositRequest(0, actor);
            sum += vault.pendingRedeemRequest(0, actor);
        }
    }

    function _refreshAllActorStates() internal {
        uint256 length = actors.length;
        for (uint256 i = 0; i < length; i += 1) {
            _refreshActorState(actors[i]);
        }
    }

    function _refreshActorState(address actor) internal {
        modeledPendingDeposit[actor] = vault.pendingDepositRequest(0, actor);
        if (modeledPendingDeposit[actor] == 0) {
            modeledPendingDepositAsset[actor] = address(0);
        }
        modeledPendingRedeem[actor] = vault.pendingRedeemRequest(0, actor);
        modeledClaimableDepositAssets[actor] = vault.claimableDepositRequest(0, actor);
        modeledClaimableRedeemShares[actor] = vault.claimableRedeemRequest(0, actor);
    }

    function _refreshFeedTimestamp(MockChainlinkAggregator feed) internal {
        (, int256 answer,,,) = feed.latestRoundData();
        feed.setRoundData(answer, block.timestamp);
    }

    function _signedDepositRequest(address owner, address requestAsset, uint256 amount, uint256 nonce, uint256 deadline)
        internal
        returns (IUFarmVaultRequests.SignedRequest memory request)
    {
        request = IUFarmVaultRequests.SignedRequest({
            request: IUFarmVaultRequests.RequestParams({
                asset: requestAsset, amount: amount, minOutputAmount: 0, controller: owner, owner: owner
            }),
            nonce: nonce,
            deadline: deadline,
            signature: ""
        });
        bytes32 requestHash = keccak256(abi.encode(REQUEST_PARAMS_TYPEHASH, requestAsset, amount, 0, owner, owner));
        bytes32 structHash = keccak256(abi.encode(SIGNED_DEPOSIT_REQUEST_TYPEHASH, requestHash, nonce, deadline));
        bytes32 domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("UFarmVault")),
                keccak256(bytes("2")),
                block.chainid,
                address(vault)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNED_OWNER_PK, digest);
        request.signature = abi.encodePacked(r, s, v);
    }

    function _checkEscrowAllowanceCleared() internal {
        if (asset.allowance(address(vault), address(escrow)) != 0) unexpectedEscrowAllowance = true;
        if (customAsset.allowance(address(vault), address(escrow)) != 0) unexpectedEscrowAllowance = true;
    }
}
