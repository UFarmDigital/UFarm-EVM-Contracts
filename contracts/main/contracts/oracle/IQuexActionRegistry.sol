// SPDX-License-Identifier: MIT

pragma solidity ^0.8.24;

enum IdType {
    RequestId,
    FlowId
}

struct DataItem {
    uint256 timestamp;
    uint256 error;
    bytes value;
}

struct OracleMessage {
    uint256 actionId;
    DataItem dataItem;
}

struct ETHSignature {
    bytes32 r;
    bytes32 s;
    uint8 v;
}

interface IQuexActionRegistry {
    error Flow_NotFound();
    error Request_NotFound();
    error Action_MismatchIds();
    error TrustDomain_NotValid();
    error TrustDomain_IsNotAllowedInOraclePool();
    error OracleMessage_SignatureIsInvalid();
    error InsufficientValue();

    event RequestCreated(uint256 requestId, uint256 flowId, address oraclePool);

    function createRequest(uint256 flowId, uint256 subscriptionId) external returns (uint256 requestId);
    function getRequestFee(uint256 flowId) external view returns (uint256 fee);
}
