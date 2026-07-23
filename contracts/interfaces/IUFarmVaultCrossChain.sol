// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {CCIPClient} from "./ccip/ICCIPRouter.sol";
import {CrossChainTypes} from "../libraries/CrossChainTypes.sol";
import {IUFarmVaultCrossChainEvents} from "../vault/UFarmVaultEvents.sol";

interface IUFarmVaultCrossChain is IUFarmVaultCrossChainEvents {
    function ccipReceive(CCIPClient.Any2EVMMessage calldata message) external;
    function settlementAllowedAt() external view returns (uint256);
    function crossChainState() external view returns (CrossChainTypes.CrossChainSessionState state, bool outboxExists);
}
