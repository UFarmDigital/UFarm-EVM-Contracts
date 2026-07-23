// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {IUFarmCore} from "../interfaces/IUFarmCore.sol";
import {ErrorCodes} from "./ErrorCodes.sol";
import {PauseMask} from "./PauseMask.sol";
import {SettlementAction} from "./SettlementAction.sol";
import {VaultBaseStorage} from "./VaultBaseStorage.sol";
import {VaultConfigStorage} from "./VaultConfigStorage.sol";
import {VaultLifecycleStorage} from "./VaultLifecycleStorage.sol";
import {VaultTypes} from "./VaultTypes.sol";
import {IUFarmVaultErrors} from "../vault/UFarmVaultErrors.sol";

library VaultGuards {
    function isPaused(uint256 specificBit) internal view returns (bool) {
        VaultBaseStorage.Layout storage base = VaultBaseStorage.data();
        IUFarmCore coreContract = IUFarmCore(base.core);
        uint256 globalMask = coreContract.globalPauseMask();
        return (PauseMask.isPaused(globalMask, PauseMask.FULL_PROTOCOL_PAUSE)
                || (specificBit != 0 && PauseMask.isPaused(globalMask, specificBit))
                || coreContract.curatorPauseMask(base.curator) != 0);
    }

    function checkNotPaused(uint256 specificBit) internal view {
        if (isPaused(specificBit)) revert IUFarmVaultErrors.FlowPaused();
    }

    function requireOracleInactive() internal view {
        if (VaultLifecycleStorage.data().activeOracleRequest.requestId != 0) {
            revert IUFarmVaultErrors.OracleFlowError(ErrorCodes.ORACLE_ACTIVE);
        }
    }

    function requireActive() internal view {
        if (VaultConfigStorage.data().status != VaultTypes.VaultStatus.Active) {
            revert IUFarmVaultErrors.VaultNotActive();
        }
    }

    function requireAccountingChain() internal view {
        uint64 accountingChainId = IUFarmCore(VaultBaseStorage.data().core).accountingChainId();
        if (accountingChainId == 0) {
            revert IUFarmVaultErrors.CrossChainFlowError(ErrorCodes.CROSS_CHAIN_NOT_CONFIGURED);
        }
        if (uint64(block.chainid) != accountingChainId) {
            revert IUFarmVaultErrors.CrossChainFlowError(ErrorCodes.CROSS_CHAIN_ACCOUNTING_CHAIN_ONLY);
        }
    }

    function requireFinanceActive() internal view {
        requireAccountingChain();
        VaultLifecycleStorage.Layout storage lifecycle = VaultLifecycleStorage.data();
        if (lifecycle.isInvalidPrice) {
            revert IUFarmVaultErrors.OracleFlowError(ErrorCodes.ORACLE_INVALID_PRICE);
        }
        if (block.timestamp < lifecycle.settlementAllowedAt) {
            revert IUFarmVaultErrors.OracleFlowError(ErrorCodes.ORACLE_COOLDOWN_ACTIVE);
        }
    }

    function applySettlementAction(SettlementAction action) internal {
        if (action == SettlementAction.None) return;
        VaultLifecycleStorage.Layout storage lifecycle = VaultLifecycleStorage.data();
        if (action == SettlementAction.Lock) {
            lifecycle.settlementAllowedAt = type(uint256).max;
            return;
        }

        if (action == SettlementAction.Unlock || lifecycle.settlementAllowedAt != type(uint256).max) {
            lifecycle.settlementAllowedAt =
                block.timestamp + IUFarmCore(VaultBaseStorage.data().core).navRequestCooldown();
        }
    }
}
