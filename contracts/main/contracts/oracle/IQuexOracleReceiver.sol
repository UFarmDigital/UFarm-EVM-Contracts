// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.24;

import {DataItem} from "./IV1RequestRegistry.sol";

/**
 * @title IQuexOracleReceiver contract
 * @author https://ufarm.digital/
 * @notice Receives response from quex in callback
 */
interface IQuexOracleReceiver {
    event QuexFlowUpdated(uint256 indexed flowVersion, uint256 flowId);

    /**
     * @notice The callback which is receiving and processing the quex response
     * @param receivedRequestId - Quex request ID
     * @param response - Feed response data
     */
    function quexCallback(uint256 receivedRequestId, DataItem memory response) external;
}
