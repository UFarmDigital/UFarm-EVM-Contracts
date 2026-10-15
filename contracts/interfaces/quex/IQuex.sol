// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

enum RequestMethod {
    Get,
    Post,
    Put,
    Patch,
    Delete,
    Options,
    Trace
}

enum IdType {
    RequestId,
    FlowId
}

struct RequestHeader {
    string key;
    string value;
}

struct QueryParameter {
    string key;
    string value;
}

struct HTTPRequest {
    RequestMethod method;
    string host;
    string path;
    RequestHeader[] headers;
    QueryParameter[] parameters;
    bytes body;
}

struct DataItem {
    uint256 timestamp;
    uint256 errorCode;
    bytes value;
}

struct Flow {
    uint256 gasLimit;
    uint256 actionId;
    address pool;
    address consumer;
    bytes4 callback;
}

interface IRequestOraclePool {
    function addRequest(HTTPRequest memory request) external returns (bytes32 requestId);
    function addActionByParts(bytes32 requestId, bytes32 patchId, bytes32 schemaId, bytes32 filterId)
        external
        returns (uint256 actionId);
}

interface IFlowRegistry {
    function createFlow(Flow memory flowData) external returns (uint256 flowId);
}

interface IQuexActionRegistry {
    function createRequest(uint256 flowId, uint256 subscriptionId) external returns (uint256 requestId);
    function getRequestFee(uint256 flowId) external view returns (uint256 fee);
}
