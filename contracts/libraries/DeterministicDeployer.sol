// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {DeterministicDeploymentFailed} from "./DeterministicDeployerErrors.sol";
import {ICreateX} from "../interfaces/ICreateX.sol";
import {DeterministicSalts} from "./DeterministicSalts.sol";

library DeterministicDeployer {
    function deployCreate3(address createX, bytes32 logicalSalt, bytes memory initCode)
        internal
        returns (address deployed)
    {
        bytes32 salt = DeterministicSalts.createXSalt(address(this), logicalSalt);
        deployed = ICreateX(createX).deployCreate3(salt, initCode);
        if (deployed == address(0) || deployed.code.length == 0) revert DeterministicDeploymentFailed();
    }

    function guardedSalt(bytes32 logicalSalt) internal view returns (bytes32) {
        return DeterministicSalts.createXSalt(address(this), logicalSalt);
    }
}
