// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {IUFarmVaultBase} from "./IUFarmVaultBase.sol";
import {IUFarmVaultAdmin} from "./IUFarmVaultAdmin.sol";
import {IUFarmVaultRequests} from "./IUFarmVaultRequests.sol";
import {IUFarmVaultOracle} from "./IUFarmVaultOracle.sol";
import {IUFarmVaultAdapters} from "./IUFarmVaultAdapters.sol";
import {IUFarmVaultSignatures} from "./IUFarmVaultSignatures.sol";
import {IUFarmVaultCrossChain} from "./IUFarmVaultCrossChain.sol";
import {IUFarmVaultErrors} from "../vault/UFarmVaultErrors.sol";

interface IUFarmVault is
    IUFarmVaultBase,
    IUFarmVaultAdmin,
    IUFarmVaultRequests,
    IUFarmVaultOracle,
    IUFarmVaultAdapters,
    IUFarmVaultSignatures,
    IUFarmVaultCrossChain,
    IUFarmVaultErrors
{
    function settlementAllowedAt() external view override(IUFarmVaultOracle, IUFarmVaultCrossChain) returns (uint256);
}
