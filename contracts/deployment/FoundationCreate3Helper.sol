// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract FoundationCreate3Helper {
    bytes32 internal constant CREATE3_PROXY_BYTECODE_HASH = keccak256(hex"67363d3d37363d34f03d5260086018f3");

    function create3Address(address createX, address deployer, bytes32 salt) external pure returns (address) {
        bytes32 guardedSalt = keccak256(abi.encode(deployer, salt));
        address proxy = address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xff), createX, guardedSalt, CREATE3_PROXY_BYTECODE_HASH)))
            )
        );

        return address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", proxy, hex"01")))));
    }

    function erc1967ProxyInitCode(address implementation, bytes calldata initData)
        external
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(implementation, initData));
    }
}
