// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

interface IUFarmVaultBaseEvents {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event OperatorSet(address indexed controller, address indexed operator, bool approved);
    event VaultPermissionUpdated(address indexed account, uint256 newMask);
    event VaultTerminated(address indexed account);
}

interface IUFarmVaultAdminEvents {
    event ClientTierUpdated(uint8 newTier);
    event TransferRestrictionUpdated(bool restricted);
    event VaultFeesUpdated(uint256 newManagementFee, uint256 newPerformanceFeeSchedule);
    event InvestmentRangeUpdated(uint256 minDeposit, uint256 maxDeposit);
}

interface IUFarmVaultRequestsEvents {
    event DepositRequest(
        address indexed controller, address indexed owner, uint256 indexed requestId, address sender, uint256 assets
    );
    event DepositCancelled(address indexed owner, address indexed asset, uint256 assets);
    event DepositSettled(address indexed owner, address indexed asset, uint256 assets, uint256 shares);
    event DepositClaimed(address indexed owner, uint256 shares);
    event RedeemRequest(
        address indexed controller, address indexed owner, uint256 indexed requestId, address sender, uint256 shares
    );
    event RedeemCancelled(address indexed owner, uint256 shares);
    event RedeemSettled(address indexed owner, address indexed asset, uint256 shares, uint256 assets);
    event RedeemClaimed(address indexed owner, address indexed asset, uint256 assets);
    event RequestFailed(address indexed owner, uint8 indexed kind, uint8 indexed reason);
}

interface IUFarmVaultOracleEvents {
    event FeesAccrued(
        uint256 protocolShares,
        uint256 curatorShares,
        uint256 protocolFeeShares,
        uint256 managementFeeShares,
        uint256 performanceFeeShares
    );
    event OracleRequestStarted(address indexed oracle, uint256 indexed oracleRequestId);
    event OracleNAVReceived(
        address indexed oracle, uint256 indexed oracleRequestId, uint256 nav, uint64 valuationTimestamp
    );
    event OracleRequestReset(uint256 indexed oracleRequestId);
    event OracleRequestResent(uint256 indexed newOracleRequestId);
    event InvalidPriceRaised(
        uint256 previousPrice, uint256 newPrice, uint256 allowedPriceFluctuation, uint256 actualPriceFluctuation
    );
    event InvalidPriceReset();
}

interface IUFarmVaultCrossChainEvents {
    event CrossChainTransferStarted(
        uint64 indexed sourceChainId, uint64 indexed destinationChainId, uint256 amount, uint64 nonce
    );
    event CrossChainTransferCompleted(
        uint64 indexed sourceChainId, uint64 indexed destinationChainId, uint256 amount, uint64 nonce
    );
    event CrossChainOutboxQueued(uint64 indexed targetChainId, uint8 indexed messageType, uint64 indexed nonce);
    event CrossChainDispatchSucceeded(uint64 indexed targetChainId, bytes32 indexed messageId, uint64 indexed nonce);
    event CrossChainDispatchFailed(uint64 indexed targetChainId, uint8 indexed messageType, uint64 indexed nonce);
    event CrossChainMessageIgnored(uint64 indexed sourceChainId, uint8 indexed messageType, uint8 indexed reason);
    event CrossChainSessionReset(uint64 indexed targetChainId, uint64 indexed nonce);
}
