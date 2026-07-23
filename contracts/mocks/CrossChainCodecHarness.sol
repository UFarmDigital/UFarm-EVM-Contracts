// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {CrossChainCodec} from "../libraries/CrossChainCodec.sol";
import {CrossChainTypes} from "../libraries/CrossChainTypes.sol";

contract CrossChainCodecHarness {
    function encode(CrossChainTypes.CrossChainMessage memory message) external pure returns (bytes memory) {
        return CrossChainCodec.encode(message);
    }

    function decode(bytes memory raw)
        external
        pure
        returns (bool ok, CrossChainTypes.CrossChainMessage memory message)
    {
        return CrossChainCodec.decode(raw);
    }
}
