// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {IUFarmOracle} from "../interfaces/IUFarmOracle.sol";
import {IUFarmVault} from "../interfaces/IUFarmVault.sol";

contract MockUFarmOracle is IUFarmOracle {
    error UnknownRequest(uint256 requestId);

    uint256 private _nextRequestId = 1;
    uint256 private _forcedRequestId;
    bool private _hasForcedRequestId;

    mapping(uint256 requestId => address vault) private _vaultByRequestId;

    function requestNav(address vault) external returns (uint256 oracleRequestId) {
        if (_hasForcedRequestId) {
            oracleRequestId = _forcedRequestId;
            _forcedRequestId = 0;
            _hasForcedRequestId = false;
        } else {
            oracleRequestId = _nextRequestId;
            _nextRequestId += 1;
        }
        _vaultByRequestId[oracleRequestId] = vault;
    }

    function setNextRequestId(uint256 requestId) external {
        _forcedRequestId = requestId;
        _hasForcedRequestId = true;
    }

    function vaultByRequestId(uint256 requestId) external view returns (address) {
        return _vaultByRequestId[requestId];
    }

    function submitNav(uint256 requestId, uint256 nav, uint64 valuationTimestamp) external {
        address vault = _vaultByRequestId[requestId];
        if (vault == address(0)) {
            revert UnknownRequest(requestId);
        }

        IUFarmVault(vault).onOracleNav(requestId, nav, valuationTimestamp);
    }
}
