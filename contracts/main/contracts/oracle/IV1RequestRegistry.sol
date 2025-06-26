// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

struct RequestResult {
    uint256 tdId;
    DataItem dataItem;
    ETHSignature signature;
}

struct ETHSignature {
    bytes32 r;
    bytes32 s;
    uint8 v;
}

struct DataItem {
    uint256 timestamp;
    bytes32 feedId;
    bytes value;
}

interface IV1RequestRegistry {
    function sendRequest(
        bytes32 feedId,
        address callbackAddress,
        bytes4 callbackMethod,
        uint32 callbackGasLimit
    ) external payable returns (bytes32 requestId, uint256 requestPrice);
}
