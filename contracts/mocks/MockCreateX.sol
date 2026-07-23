// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

error InvalidSalt();
error AlreadyDeployed(address deployed);
error DeploymentFailed();

contract MockCreateX {
    bytes internal constant CREATE3_PROXY_BYTECODE = hex"67363d3d37363d34f03d5260086018f3";

    event Deployed(bytes32 indexed salt, address indexed deployed);

    mapping(bytes32 salt => address deployed) public deployedBySalt;

    function deployCreate3(bytes32 salt, bytes memory initCode) external payable returns (address deployed) {
        if (address(bytes20(salt)) != msg.sender) revert InvalidSalt();
        if (bytes1(salt << 160) > 0x01) revert InvalidSalt();
        if (deployedBySalt[salt] != address(0)) revert AlreadyDeployed(deployedBySalt[salt]);

        address proxy;
        bytes32 guardedSalt = keccak256(abi.encode(msg.sender, salt));
        bytes memory proxyBytecode = CREATE3_PROXY_BYTECODE;
        assembly {
            proxy := create2(0, add(proxyBytecode, 0x20), mload(proxyBytecode), guardedSalt)
        }
        if (proxy == address(0)) revert DeploymentFailed();

        deployed = address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", proxy, hex"01")))));
        (bool success,) = proxy.call{value: msg.value}(initCode);
        if (!success) revert DeploymentFailed();
        if (deployed == address(0)) revert DeploymentFailed();
        if (deployed.code.length == 0) revert DeploymentFailed();

        deployedBySalt[salt] = deployed;
        emit Deployed(salt, deployed);
    }
}
