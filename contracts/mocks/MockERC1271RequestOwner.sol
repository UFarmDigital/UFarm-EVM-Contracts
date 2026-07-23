// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockERC1271RequestOwner is IERC1271 {
    bytes4 private constant INVALID_SIGNATURE = 0xffffffff;

    mapping(bytes32 digest => bool valid) public validDigests;
    bool public consumeAllGas;

    function setValidDigest(bytes32 digest, bool valid) external {
        validDigests[digest] = valid;
    }

    function setConsumeAllGas(bool enabled) external {
        consumeAllGas = enabled;
    }

    function approveToken(address token, address spender, uint256 amount) external {
        IERC20(token).approve(spender, amount);
    }

    function isValidSignature(bytes32 hash, bytes memory) external view returns (bytes4) {
        if (consumeAllGas) {
            while (gasleft() > 0) {}
        }
        return validDigests[hash] ? IERC1271.isValidSignature.selector : INVALID_SIGNATURE;
    }
}
