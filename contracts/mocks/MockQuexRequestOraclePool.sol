// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {HTTPRequest, QueryParameter, RequestHeader, IRequestOraclePool} from "../interfaces/quex/IQuex.sol";

contract MockQuexRequestOraclePool is IRequestOraclePool {
    struct StoredRequest {
        uint8 method;
        string host;
        string path;
        bytes body;
        RequestHeader[] headers;
        QueryParameter[] parameters;
    }

    uint256 private _nextRequestId = 1;
    uint256 private _nextActionId = 1;
    mapping(bytes32 requestId => StoredRequest request) private _requests;

    bytes32 public lastRequestId;
    uint256 public lastActionId;
    bytes32 public lastActionRequestId;
    bytes32 public lastPatchId;
    bytes32 public lastSchemaId;
    bytes32 public lastFilterId;

    function addRequest(HTTPRequest memory request) external returns (bytes32 requestId) {
        requestId = bytes32(_nextRequestId);
        _nextRequestId += 1;
        lastRequestId = requestId;

        StoredRequest storage stored = _requests[requestId];
        stored.method = uint8(request.method);
        stored.host = request.host;
        stored.path = request.path;
        stored.body = request.body;

        for (uint256 i = 0; i < request.headers.length; ++i) {
            stored.headers.push(request.headers[i]);
        }
        for (uint256 i = 0; i < request.parameters.length; ++i) {
            stored.parameters.push(request.parameters[i]);
        }
    }

    function addActionByParts(bytes32 requestId, bytes32 patchId, bytes32 schemaId, bytes32 filterId)
        external
        returns (uint256 actionId)
    {
        actionId = _nextActionId;
        _nextActionId += 1;
        lastActionId = actionId;
        lastActionRequestId = requestId;
        lastPatchId = patchId;
        lastSchemaId = schemaId;
        lastFilterId = filterId;
    }

    function requestParameterCount(bytes32 requestId) external view returns (uint256) {
        return _requests[requestId].parameters.length;
    }

    function requestParameter(bytes32 requestId, uint256 index)
        external
        view
        returns (string memory key, string memory value)
    {
        QueryParameter storage parameter = _requests[requestId].parameters[index];
        return (parameter.key, parameter.value);
    }
}
