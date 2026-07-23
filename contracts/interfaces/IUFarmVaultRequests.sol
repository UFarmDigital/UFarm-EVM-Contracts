// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {IUFarmVaultRequestsEvents} from "../vault/UFarmVaultEvents.sol";

interface IUFarmVaultRequests is IUFarmVaultRequestsEvents {
    struct ClientVerification {
        bytes signature;
        uint64 validTill;
        uint8 tier;
    }

    struct RequestParams {
        address asset;
        uint256 amount;
        uint256 minOutputAmount;
        address controller;
        address owner;
    }

    struct SignedRequest {
        RequestParams request;
        uint256 nonce;
        uint256 deadline;
        bytes signature;
    }

    function initialize(
        address core,
        address curator,
        address owner,
        bytes32 vaultSalt,
        string calldata name,
        string calldata symbol,
        address asset
    ) external;

    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    function setOperator(address operator, bool approved) external returns (bool);
    function setOperatorBySig(
        address owner,
        address operator,
        bool approved,
        uint256 deadline,
        uint256 nonce,
        bytes calldata signature
    ) external returns (bool);
    function isOperator(address owner, address operator) external view returns (bool);
    function nonces(address owner) external view returns (uint256);
    function requestNonces(address owner) external view returns (uint256);

    function requestDeposit(uint256 assets, address controller, address owner) external returns (uint256 requestId);
    function requestDeposit(
        address asset,
        uint256 assets,
        address controller,
        address owner,
        ClientVerification calldata verification
    ) external returns (uint256 requestId);
    function settleRequests(SignedRequest[] calldata deposits, SignedRequest[] calldata redeems)
        external
        returns (uint256 oracleRequestId);
    function deposit(uint256 assets, address receiver, address controller) external returns (uint256 shares);
    function requestRedeem(uint256 shares, address controller, address owner) external returns (uint256 requestId);
    function redeem(uint256 shares, address receiver, address controller) external returns (uint256 assets);
    function cancelDeposit(address owner) external returns (uint256 assets);
    function cancelRedeem(address owner) external returns (uint256 shares);
    function pendingDepositRequest(uint256 requestId, address controller) external view returns (uint256 assets);
    function pendingRedeemRequest(uint256 requestId, address controller) external view returns (uint256 shares);
    function claimableDepositRequest(uint256 requestId, address controller) external view returns (uint256 assets);
    function claimableRedeemRequest(uint256 requestId, address controller) external view returns (uint256 shares);
}
