// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {DataItem, Flow, IFlowRegistry, IQuexActionRegistry} from "../interfaces/quex/IQuex.sol";

interface IQuexCallbackReceiver {
    function quexCallback(uint256 requestId, DataItem calldata response) external;
}

contract MockQuexCore is IFlowRegistry, IQuexActionRegistry {
    uint256 private _nextFlowId = 1;
    uint256 private _nextRequestId = 1;
    uint256 private _forcedRequestId;
    bool private _hasForcedRequestId;

    mapping(uint256 flowId => Flow flow) private _flows;
    mapping(uint256 requestId => uint256 flowId) public flowByRequestId;
    mapping(uint256 requestId => uint256 subscriptionId) public subscriptionByRequestId;

    function createFlow(Flow memory flowData) external returns (uint256 flowId) {
        flowId = _nextFlowId;
        _nextFlowId += 1;
        _flows[flowId] = flowData;
    }

    function flow(uint256 flowId) external view returns (Flow memory) {
        return _flows[flowId];
    }

    function createRequest(uint256 flowId, uint256 subscriptionId) external returns (uint256 requestId) {
        if (_hasForcedRequestId) {
            requestId = _forcedRequestId;
            _forcedRequestId = 0;
            _hasForcedRequestId = false;
        } else {
            requestId = _nextRequestId;
            _nextRequestId += 1;
        }
        flowByRequestId[requestId] = flowId;
        subscriptionByRequestId[requestId] = subscriptionId;
    }

    function getRequestFee(uint256) external pure returns (uint256) {
        return 0;
    }

    function setNextRequestId(uint256 requestId) external {
        _forcedRequestId = requestId;
        _hasForcedRequestId = true;
    }

    function submitResponse(address receiver, uint256 requestId, DataItem calldata response) external {
        IQuexCallbackReceiver(receiver).quexCallback(requestId, response);
    }
}
