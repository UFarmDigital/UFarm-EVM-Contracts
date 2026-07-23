// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

interface Vm {
    function prank(address msgSender) external;
    function startPrank(address msgSender) external;
    function stopPrank() external;
    function bound(uint256 x, uint256 min, uint256 max) external pure returns (uint256 result);
    function warp(uint256) external;
    function chainId(uint256 newChainId) external;
    function load(address account, bytes32 slot) external view returns (bytes32 value);
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

abstract contract InvariantVm {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    struct FuzzArtifactSelector {
        string artifact;
        bytes4[] selectors;
    }

    struct FuzzInterface {
        address addr;
        string[] artifacts;
    }

    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address[] private _targetedContracts;
    address[] private _excludedContracts;
    address[] private _targetedSenders;
    address[] private _excludedSenders;
    string[] private _targetedArtifacts;
    string[] private _excludedArtifacts;
    FuzzSelector[] private _targetedSelectors;
    FuzzSelector[] private _excludedSelectors;
    FuzzArtifactSelector[] private _targetedArtifactSelectors;
    FuzzInterface[] private _targetedInterfaces;

    function targetContract(address newTargetedContract) internal {
        _targetedContracts.push(newTargetedContract);
    }

    function targetContracts() external view returns (address[] memory) {
        return _targetedContracts;
    }

    function excludeContracts() external view returns (address[] memory) {
        return _excludedContracts;
    }

    function targetSenders() external view returns (address[] memory) {
        return _targetedSenders;
    }

    function excludeSenders() external view returns (address[] memory) {
        return _excludedSenders;
    }

    function targetArtifacts() external view returns (string[] memory) {
        return _targetedArtifacts;
    }

    function excludeArtifacts() external view returns (string[] memory) {
        return _excludedArtifacts;
    }

    function targetSelectors() external view returns (FuzzSelector[] memory) {
        return _targetedSelectors;
    }

    function excludeSelectors() external view returns (FuzzSelector[] memory) {
        return _excludedSelectors;
    }

    function targetArtifactSelectors() external view returns (FuzzArtifactSelector[] memory) {
        return _targetedArtifactSelectors;
    }

    function targetInterfaces() external view returns (FuzzInterface[] memory) {
        return _targetedInterfaces;
    }

    function _assertEq(address left, address right, string memory message) internal pure {
        require(left == right, message);
    }

    function _assertEq(uint256 left, uint256 right, string memory message) internal pure {
        require(left == right, message);
    }

    function _assertTrue(bool condition, string memory message) internal pure {
        require(condition, message);
    }
}
