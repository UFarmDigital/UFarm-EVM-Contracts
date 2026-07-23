// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

library VaultTypes {
    enum VaultStatus {
        Active,
        Terminated
    }

    struct PendingRequest {
        address asset;
        uint256 amount;
        uint256 minOutputAmount;
    }

    struct ClaimableRequest {
        address asset;
        uint256 assets;
        uint256 shares;
    }

    struct OwnerRequestState {
        PendingRequest pendingDeposit;
        ClaimableRequest claimableDeposit;
        PendingRequest pendingRedeem;
        ClaimableRequest claimableRedeem;
    }

    struct ActiveOracleRequest {
        uint256 requestId;
        address oracle;
        uint64 requestedAt;
    }

    struct OperatorState {
        mapping(address operator => bool approved) approvals;
        uint256 nonce;
        uint256 requestNonce;
    }

    struct FeeAccrual {
        uint256 protocolShares;
        uint256 curatorShares;
        uint256 protocolFeeShares;
        uint256 managementFeeShares;
        uint256 performanceFeeShares;
        uint256 grossSharePrice;
    }
}
