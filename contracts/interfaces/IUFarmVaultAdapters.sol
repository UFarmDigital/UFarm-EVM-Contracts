// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

interface IUFarmVaultAdapters {
    event AdapterExecuted(bytes32 indexed adapterId);

    function executeAdapter(bytes32 adapterId, bytes calldata data) external;
}
