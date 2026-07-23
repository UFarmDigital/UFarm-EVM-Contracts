// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

interface ICreateX {
    function deployCreate3(bytes32 salt, bytes memory initCode) external payable returns (address newContract);
}
