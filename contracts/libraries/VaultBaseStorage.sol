// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

library VaultBaseStorage {
    bytes32 internal constant STORAGE_SLOT = 0x8bf66377a3c03f1ef283556f65e60a3b93b776548852f90a532eda1bd5617834;

    struct Layout {
        address core;
        address curator;
        bytes32 vaultSalt;
        string name;
        string symbol;
        address asset;
        uint256 totalSupply;
        mapping(address account => uint256 balance) balances;
        mapping(address owner => mapping(address spender => uint256 allowance)) allowances;
    }

    function data() internal pure returns (Layout storage s) {
        bytes32 slot = STORAGE_SLOT;
        // slither-disable-next-line assembly
        assembly ("memory-safe") {
            s.slot := slot
        }
    }
}
