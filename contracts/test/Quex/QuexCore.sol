// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.0;
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IQuexOracleReceiver} from '../../main/contracts/oracle/IQuexOracleReceiver.sol';
import {DataItem} from '../../main/contracts/oracle/IV1RequestRegistry.sol';
import {IFlowRegistry} from "../../main/contracts/oracle/IFlowRegistry.sol";
import {IQuexActionRegistry} from "../../main/contracts/oracle/IQuexActionRegistry.sol";

import {Flow} from '../../main/contracts/oracle/IFlowRegistry.sol';
import {IUFarmPool} from '../../main/contracts/pool/IUFarmPool.sol';

contract QuexCore is IFlowRegistry, IQuexActionRegistry {
    uint256 public lastRequestId;
    Flow public lastFlow;

    function sendResponse(address to, uint256 amount) external {
        require(to != address(0), "Invalid address");

        DataItem memory response = DataItem({
            timestamp: block.timestamp,
            feedId: bytes32(0),
            value: abi.encode(amount)
        });

        IQuexOracleReceiver(to).quexCallback(lastRequestId, response);
        lastRequestId = 0;
    }

    function createFlow(Flow memory flow) external returns (uint256 flowId) {
        lastFlow = flow;
        return uint256(keccak256(abi.encode(flow)));
    }

    function getFlow(uint256 flowId) external view returns (Flow memory) {
        return lastFlow;
    }

    function sendMockResponse(address to) external {
        require(to != address(0), "Invalid address");
        address valueToken = IUFarmPool(to).valueToken();

        DataItem memory response = DataItem({
            timestamp: block.timestamp,
            feedId: bytes32(0),
            value: abi.encode(IERC20(valueToken).balanceOf(to))
        });

        IQuexOracleReceiver(to).quexCallback(0, response);
    }

    function getRequestFee(uint256 flowId) external view returns (uint256 fee) {
        return 1000000000;
    }

    function createRequest(uint256 flowId, uint256 subscriptionId) external returns (uint256 requestId) {
        lastRequestId = uint256(keccak256(abi.encode(flowId)));
        return lastRequestId;
    }
}
