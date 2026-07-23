// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

contract MockVaultModule {
    function ping() external pure returns (bytes4) {
        return this.ping.selector;
    }
}
