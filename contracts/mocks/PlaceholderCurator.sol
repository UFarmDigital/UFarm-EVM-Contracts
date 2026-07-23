// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

contract PlaceholderCurator {
    function placeholderKind() external pure returns (bytes32) {
        return keccak256("UFARM_PLACEHOLDER_CURATOR");
    }
}
