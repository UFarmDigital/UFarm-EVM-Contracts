// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {UFarmOwnableUUPS} from "../../../shared/UFarmOwnableUUPS.sol";
import {UFarmPermissionsModel} from "../../permissions/UFarmPermissionsModel.sol";
import {Permissions} from "../../permissions/Permissions.sol";
import {UFarmCoreLink} from "../../../shared/UFarmCoreLink.sol";

contract Guard2 is UFarmOwnableUUPS, UFarmCoreLink {
    error InvalidInput();
    error InvalidSelector();
    error IndexOutOfBounds();

    struct Directive {
        uint256 payloadLength; // total bytes expected (or type(uint256).max for TYPE_ANY)
        bytes directives; // encoded directives stream
    }

    // dapp => dappAddress => directives
    mapping(bytes32 => mapping(address => Directive[])) public whitelist;

    /**
     * @notice Emitted on whitelisting the dapp
     * @param dapp - dapp id (hash of dapp's domain)
     * @param target - target address of the contract
     * @param method - selector of the modified method
     * @param isAllowed - flag of whitelisting: allow/deny
     */
    event WhitelistUpdated(bytes32 indexed dapp, address indexed target, bytes4 method, bool isAllowed);

    // 3-bit directive types
    uint8 private constant TYPE_WILDCARD_WORDS = 0; // skip N words (32-byte words)
    uint8 private constant TYPE_ANY = 1; // match remaining payload (any length)
    uint8 private constant TYPE_SELF = 2; // compare to msg.sender; length in bytes (20 or 32)
    uint8 private constant TYPE_FROM_LIST = 3; // compare to whitelisted address; length in bytes (20 or 32)
    uint8 private constant TYPE_EXACT = 4; // exact bytes follow; length in bytes
    uint8 private constant TYPE_WILDCARD_BYTES = 5; // NEW: skip N bytes (byte-granular)

    uint256 constant MAX_DIRECTIVES_PER_ADDRESS = 25;

    /**
     * @notice Ensures the caller is either the owner or has two specific permissions.
     * @param permission1 The first required permission.
     * @param permission2 The second required permission.
     */
    modifier ownerOrHaveTwoPermissions(uint8 permission1, uint8 permission2) {
        UFarmPermissionsModel core = UFarmPermissionsModel(UFarmCoreLink(address(this)).ufarmCore());
        if (!core.hasPermission(msg.sender, uint8(Permissions.UFarm.Owner))) {
            core.checkForPermissionsMask(msg.sender, core.twoPermissionsToMask(permission1, permission2));
        }
        _;
    }

    /**
     * @notice Initializes the Guard contract.
     * @dev Can only be called once by the deployer.
     * @param ufarmCore The address of the UFarmCore contract.
     */
    function __init__Guard(address ufarmCore) external initializer onlyDeployer {
        __init__UFarmOwnableUUPS();
        __init__UFarmCoreLink(ufarmCore);
    }

    function whitelistProtocol(
        bytes32 dapp,
        address[] calldata targets,
        bytes[] calldata directivesArray
    ) external ownerOrHaveTwoPermissions(uint8(Permissions.UFarm.Member), uint8(Permissions.UFarm.ManageWhitelist)) {
        if (targets.length == 0 || directivesArray.length == 0) revert InvalidInput();
        _whitelistProtocol(dapp, targets, directivesArray);
    }

    function _whitelistProtocol(bytes32 dapp, address[] calldata targets, bytes[] calldata directivesArray) private {
        for (uint256 i = 0; i < directivesArray.length; i++) {
            bytes calldata blob = directivesArray[i];
            // Compute expected payloadLength from directives
            uint256 ptr = 0;
            uint256 total = 0;

            while (ptr < blob.length) {
                uint8 header = uint8(blob[ptr++]);
                uint8 typ = header >> 5;
                uint256 span = (header & 0x1F) + 1;

                if (typ == TYPE_WILDCARD_WORDS) {
                    total += span * 32; // words → bytes
                } else if (typ == TYPE_ANY) {
                    if (ptr != blob.length) revert InvalidInput();
                    total = type(uint256).max;
                } else if (typ == TYPE_SELF || typ == TYPE_FROM_LIST) {
                    if (span != 20 && span != 32) revert InvalidInput();
                    total += span; // bytes (20 or 32)
                } else if (typ == TYPE_EXACT) {
                    total += span; // bytes
                    ptr += span; // skip embedded exact bytes
                } else if (typ == TYPE_WILDCARD_BYTES) {
                    total += span; // bytes
                } else {
                    revert InvalidInput();
                }
            }

            bytes4 method = extractSelector(blob);
            if (method == bytes4(0)) revert InvalidSelector();

            for (uint256 j = 0; j < targets.length; j++) {
                address target = targets[j];
                whitelist[dapp][target].push(Directive({payloadLength: total, directives: blob}));

                if (whitelist[dapp][target].length > MAX_DIRECTIVES_PER_ADDRESS) revert InvalidInput();
                emit WhitelistUpdated(dapp, target, method, true);
            }
        }
    }

    function unwhitelistProtocol(
        bytes32 dapp,
        address target,
        uint256 idx
    ) external ownerOrHaveTwoPermissions(uint8(Permissions.UFarm.Member), uint8(Permissions.UFarm.ManageWhitelist)) {
        Directive[] storage dirs = whitelist[dapp][target];
        if (idx >= dirs.length) revert IndexOutOfBounds();

        bytes4 method = extractSelector(dirs[idx].directives);
        dirs[idx] = dirs[dirs.length - 1];
        dirs.pop();

        emit WhitelistUpdated(dapp, target, method, false);
    }

    /**
     * @notice Checks if a specific method is allowed for a given dApp & dApp pool (dappAddress).
     * @param dapp The identifier of the dApp.
     * @param dappAddress The address of the dApp.
     * @param payload The calldata containing the method selector.
     * @return True if the method is allowed, false otherwise.
     */
    function isProtocolAllowed(bytes32 dapp, address dappAddress, bytes calldata payload) external view returns (bool) {
        Directive[] storage dirs = whitelist[dapp][dappAddress];
        if (dirs.length == 0) return false;

        for (uint256 i = 0; i < dirs.length; i++) {
            Directive storage dir = dirs[i];
            if (dir.payloadLength != type(uint256).max && dir.payloadLength != payload.length) continue;
            if (_matchDirective(dir.directives, payload, dapp)) return true;
        }

        return false;
    }

    function _matchDirective(bytes storage blob, bytes calldata payload, bytes32 dapp) internal view returns (bool) {
        uint256 blobPtr = 0;
        uint256 payloadPtr = 0;
        bool matched = true;

        while (matched && blobPtr < blob.length) {
            uint8 header = uint8(blob[blobPtr++]);
            uint8 typ = header >> 5;
            uint256 span = (header & 0x1F) + 1;

            if (typ == TYPE_WILDCARD_WORDS) {
                payloadPtr += span * 32;
            } else if (typ == TYPE_ANY) {
                return true;
            } else if (typ == TYPE_WILDCARD_BYTES) {
                payloadPtr += span;
            } else if (typ == TYPE_EXACT) {
                for (uint256 k = 0; k < span; k++) {
                    if (blob[blobPtr + k] != payload[payloadPtr + k]) {
                        matched = false;
                        break;
                    }
                }
                blobPtr += span;
                payloadPtr += span;
            } else if (typ == TYPE_SELF || typ == TYPE_FROM_LIST) {
                if (span != 20 && span != 32) {
                    matched = false;
                } else {
                    uint256 innerOffset = span - 20;
                    bytes20 got;
                    assembly {
                        let scratch := mload(0x40)
                        mstore(scratch, 0)
                        calldatacopy(scratch, add(add(payload.offset, payloadPtr), innerOffset), 20)
                        got := mload(scratch)
                    }

                    if (typ == TYPE_SELF) {
                        matched = (bytes20(msg.sender) == got);
                    } else {
                        Directive[] storage wlDirs = whitelist[dapp][address(got)];
                        matched = wlDirs.length > 0 && extractSelector(wlDirs[0].directives) == bytes4(0x11111111);
                    }

                    payloadPtr += span;
                }
            } else {
                // Unknown directive
                matched = false;
            }

            if (payloadPtr > payload.length) {
                return false;
            }
        }

        return matched && payloadPtr == payload.length && blobPtr == blob.length;
    }

    function extractSelector(bytes memory blob) public pure returns (bytes4) {
        if (blob.length > 4) {
            uint8 hdr = uint8(blob[0]);
            uint8 typ = hdr >> 5;
            uint256 len = (hdr & 0x1F) + 1;

            if (typ == TYPE_EXACT && len == 4) {
                return
                    bytes4(
                        (uint32(uint8(blob[1])) << 24) |
                            (uint32(uint8(blob[2])) << 16) |
                            (uint32(uint8(blob[3])) << 8) |
                            uint32(uint8(blob[4]))
                    );
            }
        }
        return bytes4(0);
    }

    uint256[50] private __gap;
}
