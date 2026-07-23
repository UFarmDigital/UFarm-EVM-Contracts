// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {SettlementAction} from "../libraries/SettlementAction.sol";

interface IArbitraryAdapterGuard {
    struct SignDirective {
        uint8[] directives;
        bytes dictionary;
    }

    event ArbitraryAdapterWhitelistUpdated(bytes32 indexed dapp, address indexed target, bytes4 method, bool allowed);
    event ArbitraryAdapterEIP712WhitelistUpdated(bytes32 indexed dapp, bytes32 indexed domain, bool allowed);

    error ArbitraryAdapterGuardUnauthorized(address caller);
    error ArbitraryAdapterGuardInvalidInput();
    error ArbitraryAdapterGuardInvalidSelector();
    error ArbitraryAdapterGuardIndexOutOfBounds();

    function whitelistProtocol(bytes32 dapp, address[] calldata targets, bytes[] calldata directivesArray) external;
    function unwhitelistProtocol(bytes32 dapp, address target, uint256[] calldata indexes) external;
    function whitelistEIP712(bytes32 dapp, bytes32 domainSeparator, SignDirective[] calldata directivesArray) external;
    function unwhitelistEIP712(bytes32 dapp, bytes32 domainSeparator, uint256[] calldata indexes) external;
    function isProtocolAllowed(bytes32 dapp, address dappAddress, bytes calldata payload) external view returns (bool);
    function extractSelector(bytes memory blob) external pure returns (bytes4);
    function eip712Hash(bytes32 dapp, bytes calldata ops) external view returns (bytes32 retHash);
}

interface IArbitraryAdapter {
    event ArbitraryActionExecuted(bytes32 indexed dapp, address indexed target);

    error ArbitraryAdapterDelegateCallOnly();
    error ArbitraryAdapterInvalidInput();
    error ArbitraryAdapterCallNotAllowed();
    error ArbitraryAdapterExternalCallFailed();

    function performAction(bytes32 dapp, address dappAddress, bytes calldata payload, uint256 value)
        external
        payable
        returns (SettlementAction settlementAction);
}

interface IArbitraryAdapterEIP712 {
    function eip712Hash(bytes32 dapp, bytes calldata message) external view returns (bytes32 retHash);
}
