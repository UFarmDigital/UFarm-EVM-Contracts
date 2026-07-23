// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {InvariantFixture} from "./helpers/InvariantFixture.sol";
import {UFarmVaultHandler} from "./handlers/UFarmVaultHandler.sol";
import {IUFarmEscrow} from "../../contracts/interfaces/IUFarmEscrow.sol";
import {MockERC20} from "../../contracts/mocks/MockERC20.sol";

contract UFarmVaultInvariantTest is InvariantFixture {
    uint256 internal constant PENDING_QUEUE_LIMIT = 10;

    UFarmVaultHandler internal handler;

    function setUp() external {
        _setUpInvariantFixture();

        uint256 actorCount = invariantActors.length;
        address[] memory actors = new address[](actorCount);
        for (uint256 i = 0; i < actorCount; i += 1) {
            actors[i] = invariantActors[i];
        }

        handler = new UFarmVaultHandler(
            vault, IUFarmEscrow(address(escrow)), asset, customAsset, assetFeed, customAssetFeed, oracle, actors
        );
        vault.setPermissionMask(address(handler), type(uint256).max);
        core.setPermissionMask(address(handler), type(uint256).max);
        targetContract(address(handler));
    }

    function invariant_handlerModelMirrorsVaultState() external view {
        uint256 actorCount = handler.actorCount();
        for (uint256 i = 0; i < actorCount; i += 1) {
            address actor = handler.actorAt(i);
            _assertEq(
                handler.modeledPendingDeposit(actor),
                vault.pendingDepositRequest(0, actor),
                "pending deposit model drift"
            );
            _assertEq(
                handler.modeledPendingRedeem(actor), vault.pendingRedeemRequest(0, actor), "pending redeem model drift"
            );
            _assertEq(
                handler.modeledClaimableDepositAssets(actor),
                vault.claimableDepositRequest(0, actor),
                "claimable deposit model drift"
            );
            _assertEq(
                handler.modeledClaimableRedeemShares(actor),
                vault.claimableRedeemRequest(0, actor),
                "claimable redeem model drift"
            );
        }
    }

    function invariant_smoke_wiring() external view {
        _assertEq(vault.core(), address(core), "vault core mismatch");
        _assertEq(vault.curator(), address(curator), "vault curator mismatch");
        _assertEq(vault.asset(), address(asset), "vault asset mismatch");

        _assertEq(core.escrow(), address(escrow), "core escrow mismatch");
        _assertEq(core.oracleForVault(address(vault)), address(oracle), "oracle resolution mismatch");
        _assertEq(core.adapterForVault(ADAPTER_ID, address(vault)), address(adapter), "adapter resolution mismatch");

        _assertTrue(core.valueTokenToUsd(address(asset), 1e18) != 0, "asset should be value token");
        _assertTrue(core.valueTokenToUsd(address(customAsset), 1e6) != 0, "custom asset should be value token");
    }

    function invariant_requestBucketsAreMutuallyExclusive() external view {
        uint256 actorCount = handler.actorCount();
        uint256 pendingDepositCount = 0;
        uint256 pendingRedeemCount = 0;

        for (uint256 i = 0; i < actorCount; i += 1) {
            address actor = handler.actorAt(i);
            uint256 nonZeroBuckets = 0;

            if (handler.modeledPendingDeposit(actor) != 0) {
                nonZeroBuckets += 1;
                pendingDepositCount += 1;
            }
            if (handler.modeledClaimableDepositAssets(actor) != 0) nonZeroBuckets += 1;
            if (handler.modeledPendingRedeem(actor) != 0) {
                nonZeroBuckets += 1;
                pendingRedeemCount += 1;
            }
            if (handler.modeledClaimableRedeemShares(actor) != 0) nonZeroBuckets += 1;

            _assertTrue(nonZeroBuckets <= 1, "actor has multiple active request buckets");
        }

        _assertTrue(pendingDepositCount <= PENDING_QUEUE_LIMIT, "pending deposit queue exceeds limit");
        _assertTrue(pendingRedeemCount <= PENDING_QUEUE_LIMIT, "pending redeem queue exceeds limit");
    }

    function invariant_escrowLiabilityShapeIsConsistent() external view {
        uint256 actorCount = handler.actorCount();
        for (uint256 i = 0; i < actorCount; i += 1) {
            address actor = handler.actorAt(i);
            uint256 pendingDeposit = handler.modeledPendingDeposit(actor);
            uint256 claimableRedeemShares = handler.modeledClaimableRedeemShares(actor);
            address pendingDepositAsset = handler.modeledPendingDepositAsset(actor);
            (uint256 baseEscrowAmount, uint64 baseLockedTill) =
                IUFarmEscrow(address(escrow)).balanceOf(address(vault), address(asset), actor);
            (uint256 customEscrowAmount, uint64 customLockedTill) =
                IUFarmEscrow(address(escrow)).balanceOf(address(vault), address(customAsset), actor);

            if (pendingDeposit != 0) {
                if (pendingDepositAsset == address(asset)) {
                    if (baseEscrowAmount >= pendingDeposit) {
                        _assertTrue(baseLockedTill != 0, "base deposit escrow must carry a lock");
                    } else {
                        _assertTrue(baseLockedTill <= block.timestamp, "under-backed base deposit must be withdrawable");
                    }
                } else {
                    _assertEq(pendingDepositAsset, address(customAsset), "unexpected pending deposit asset");
                    if (customEscrowAmount >= pendingDeposit) {
                        _assertTrue(customLockedTill != 0, "custom deposit escrow must carry a lock");
                    } else {
                        _assertTrue(
                            customLockedTill <= block.timestamp, "under-backed custom deposit must be withdrawable"
                        );
                    }
                }
            } else if (claimableRedeemShares != 0) {
                _assertEq(uint256(baseLockedTill), 0, "claimable redeem escrow must be withdrawable");
            } else {
                _assertTrue(
                    baseLockedTill <= block.timestamp, "base escrow without vault liability must be withdrawable"
                );
                _assertTrue(
                    customLockedTill <= block.timestamp, "custom escrow without vault liability must be withdrawable"
                );
            }
        }
    }

    function invariant_knownShareSupplyIsConserved() external view {
        uint256 knownShares =
            vault.balanceOf(address(vault)) + vault.balanceOf(address(core)) + vault.balanceOf(address(curator));
        uint256 actorCount = handler.actorCount();
        for (uint256 i = 0; i < actorCount; i += 1) {
            knownShares += vault.balanceOf(handler.actorAt(i));
        }

        _assertEq(knownShares, vault.totalSupply(), "known share balances do not equal total supply");
    }

    function invariant_vaultHeldSharesCoverRequestLiabilities() external view {
        uint256 pendingRedeemShares = 0;
        uint256 actorCount = handler.actorCount();
        for (uint256 i = 0; i < actorCount; i += 1) {
            address actor = handler.actorAt(i);
            pendingRedeemShares += handler.modeledPendingRedeem(actor);
        }

        _assertTrue(vault.balanceOf(address(vault)) >= pendingRedeemShares, "vault-held shares do not cover redeems");
    }

    function invariant_valueTokenSupplyIsConserved() external view {
        _assertEq(_knownTokenBalanceSum(asset), asset.totalSupply(), "base asset supply leaked from known holders");
        _assertEq(
            _knownTokenBalanceSum(customAsset),
            customAsset.totalSupply(),
            "custom asset supply leaked from known holders"
        );
    }

    function invariant_noUserShareTransfersThroughErc20() external view {
        _assertTrue(!handler.unexpectedShareTransferSucceeded(), "vault share transfer unexpectedly succeeded");

        uint256 actorCount = handler.actorCount();
        uint256 supply = vault.totalSupply();
        uint256 trackedVisibleShares = 0;
        uint256 trackedVaultHeldClaims = 0;

        for (uint256 i = 0; i < actorCount; i += 1) {
            address actor = handler.actorAt(i);
            uint256 visibleBalance = vault.balanceOf(actor);
            uint256 pendingRedeem = handler.modeledPendingRedeem(actor);

            trackedVisibleShares += visibleBalance;
            trackedVaultHeldClaims += pendingRedeem;
            _assertTrue(visibleBalance + pendingRedeem <= supply, "actor share ownership exceeds total supply");
        }

        uint256 vaultHeldShares = vault.balanceOf(address(vault));
        _assertTrue(trackedVaultHeldClaims <= vaultHeldShares, "vault-held request shares are under-collateralized");
        _assertTrue(trackedVisibleShares + vaultHeldShares <= supply, "tracked share custody exceeds total supply");
    }

    function invariant_activeOracleStateIsConsistent() external view {
        _assertTrue(!handler.unexpectedOracleGuardBypassSucceeded(), "active oracle guard was bypassed");
        _assertTrue(!handler.unexpectedOracleClaimBlocked(), "active oracle blocked claim path");

        uint256 activeRequestId = vault.activeOracleRequestId();

        if (activeRequestId == 0) {
            _assertEq(oracle.vaultByRequestId(activeRequestId), address(0), "inactive oracle request must not map");
        } else {
            address activeOracle = core.oracleForVault(address(vault));
            _assertTrue(activeOracle != address(0), "oracle should be set for active request");
            _assertEq(oracle.vaultByRequestId(activeRequestId), address(vault), "oracle request must map to vault");
        }
    }

    function invariant_settlementAllowedTimestampIsMonotonicEnough() external view {
        uint256 settlementAllowedAt = vault.settlementAllowedAt();
        uint256 activeRequestId = vault.activeOracleRequestId();

        if (activeRequestId != 0 && settlementAllowedAt != 0) {
            _assertTrue(block.timestamp >= settlementAllowedAt, "oracle request started before settlement gate");
        }
    }

    function invariant_feeRecipientsCannotExceedTotalSupply() external view {
        uint256 protocolShares = vault.balanceOf(address(core));
        uint256 curatorShares = vault.balanceOf(vault.curator());
        uint256 totalSupply = vault.totalSupply();

        _assertTrue(protocolShares + curatorShares <= totalSupply, "fee recipient shares exceed total supply");
    }

    function invariant_authorizationAndFeeLockProbesHold() external view {
        _assertTrue(
            !handler.unexpectedUnauthorizedOperationSucceeded(), "unauthorized operation unexpectedly succeeded"
        );
        _assertTrue(
            !handler.unexpectedFeeUpdateAfterSupplySucceeded(), "fee update after supply unexpectedly succeeded"
        );
    }

    function invariant_signedRequestAndClaimProbesHold() external view {
        _assertTrue(!handler.unexpectedSignedNonceChange(), "signed request nonce changed unexpectedly");
        _assertTrue(!handler.unexpectedSignedReplaySucceeded(), "signed request replay unexpectedly succeeded");
        _assertTrue(!handler.unexpectedDoubleClaimSucceeded(), "claim unexpectedly succeeded twice");
    }

    function invariant_oracleMutationProbesHold() external view {
        _assertTrue(!handler.unexpectedOracleIdentityMutation(), "invalid oracle callback mutated state");
        _assertTrue(!handler.unexpectedOracleResetMutation(), "oracle reset did not clear pending state");
        _assertTrue(!handler.unexpectedOracleResendMutation(), "oracle resend did not preserve pending state");
        _assertTrue(!handler.unexpectedInvalidPriceSettlement(), "invalid price settlement mutated requests");
    }

    function invariant_temporaryAllowancesAreCleared() external view {
        _assertTrue(!handler.unexpectedEscrowAllowance(), "temporary escrow allowance leaked");
    }

    function _knownTokenBalanceSum(MockERC20 token) internal view returns (uint256 totalBalance) {
        uint256 actorCount = handler.actorCount();
        for (uint256 i = 0; i < actorCount; i += 1) {
            totalBalance += token.balanceOf(handler.actorAt(i));
        }

        totalBalance += token.balanceOf(address(vault));
        totalBalance += token.balanceOf(address(escrow));
    }
}
