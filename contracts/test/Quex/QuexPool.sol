// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.0;
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IQuexOracleReceiver} from '../../main/contracts/oracle/IQuexOracleReceiver.sol';
import {HTTPRequest} from '../../main/contracts/oracle/IRequestOraclePool.sol';

import {IUFarmPool} from '../../main/contracts/pool/IUFarmPool.sol';

contract QuexPool {
    function addRequest(HTTPRequest memory request) external returns (bytes32 requestId) {
        return keccak256(abi.encode(request));
    }

    function addActionByParts(
        bytes32 requestId,
        bytes32 patchId,
        bytes32 schemaId,
        bytes32 filterId
    ) external returns (uint256 actionId) {
        return uint256(keccak256(abi.encode(requestId, patchId, schemaId, filterId)));
    }
}
