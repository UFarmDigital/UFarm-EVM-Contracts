// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.24;

import {HTTPRequest} from "./IRequestOraclePool.sol";

struct QuexActionData {
    address requestOraclePool;
    HTTPRequest request;
    bytes32 patchId;
    bytes32 schemaId;
    bytes32 filterId;
}

/**
 * @title IQuexOracle interface
 * @author https://ufarm.digital/
 * @notice Interface for the QuexOracle
 */
interface IQuexOracle {
    event QuexCoreUpdated(address core);

    /**
     * @notice The method creates the request to be processed by Quex oracle
     * @param flowId - ID of created feed
     */
    function quexRequest(uint256 flowId) external returns (uint256);

    /**
     * @notice Returns quex request logic address
     */
    function getQuexCore() external view returns (address);

    /**
     * @notice Returns quex request fee
     */
    function getRequestFee(uint256 flowId) external view returns (uint256 fee);

    /**
     * @dev Checks whether the UFarm protocol is currently paused.
     */
    function quexFlowVersion() external view returns (uint256);

    /**
     * @dev Callable only by the UFarm member with `Moderator` permission
     * @param requestOraclePool - Request Oracle Pool address
     * @param request - quex http request
     * @param patchId - quex patchId
     * @param schemaId - quex schemaId
     * @param filterId - quex filterId
     */
    function setQuexFlow(
        address requestOraclePool,
        HTTPRequest calldata request,
        bytes32 patchId,
        bytes32 schemaId,
        bytes32 filterId
    ) external;

    /**
     * @dev Callable only by the UFarmPool
     */
    function createFlow() external returns (uint256 flowId, uint256 quexFlowVersion);
}
