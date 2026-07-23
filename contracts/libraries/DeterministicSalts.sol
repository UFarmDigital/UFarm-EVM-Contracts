// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

library DeterministicSalts {
    function curatorSalt(address curatorOwner, bytes32 userSalt) internal pure returns (bytes32) {
        return keccak256(abi.encode("UFARM_CURATOR", curatorOwner, userSalt));
    }

    function vaultSalt(address curatorProxyAddress, bytes32 userSalt) internal pure returns (bytes32) {
        return keccak256(abi.encode("UFARM_VAULT", curatorProxyAddress, userSalt));
    }

    function createXSalt(address deployer, bytes32 logicalSalt) internal pure returns (bytes32) {
        // CreateX guarded salts use: 20-byte msg.sender, 1-byte chain flag, 11-byte entropy.
        return bytes32((uint256(uint160(deployer)) << 96) | (uint256(logicalSalt) & type(uint88).max));
    }
}
