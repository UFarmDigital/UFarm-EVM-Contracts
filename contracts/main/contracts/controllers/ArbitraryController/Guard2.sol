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

    struct SignDirective {
        uint8[] directives;
        bytes dictionary;
    }

    // dapp => dappAddress => directives
    mapping(bytes32 => mapping(address => Directive[])) public whitelist;
    // dapp => domainSeparator => directives
    mapping(bytes32 => mapping(bytes32 => SignDirective[])) public eip712Whitelist;

    /**
     * @notice Emitted on whitelisting the dapp
     * @param dapp - dapp id (hash of dapp's domain)
     * @param target - target address of the contract
     * @param method - selector of the modified method
     * @param isAllowed - flag of whitelisting: allow/deny
     */
    event WhitelistUpdated(bytes32 indexed dapp, address indexed target, bytes4 method, bool isAllowed);
    event EIP712WhitelistUpdated(bytes32 indexed dapp, bytes32 indexed domain, bool isAllowed);

    // 3-bit directive types
    uint8 private constant TYPE_WILDCARD_WORDS = 0; // skip N words (32-byte words)
    uint8 private constant TYPE_ANY = 1; // match remaining payload (any length)
    uint8 private constant TYPE_SELF = 2; // compare to msg.sender; length in bytes (20 or 32)
    uint8 private constant TYPE_FROM_LIST = 3; // compare to whitelisted address; length in bytes (20 or 32)
    uint8 private constant TYPE_EXACT = 4; // exact bytes follow; length in bytes
    uint8 private constant TYPE_WILDCARD_BYTES = 5; // skip N bytes (byte-granular)

    uint256 constant MAX_DIRECTIVES_PER_ADDRESS = 32;

    uint8 constant EIP712_DOMAIN = 0; // data: 32 bytes domainSeparator
    uint8 constant EIP712_BEGIN_STRUCT = 1; // data: 32 bytes typehash/seed
    uint8 constant EIP712_FIELD = 2; // data: 32 bytes value
    uint8 constant EIP712_END_STRUCT = 3; // data: none
    uint8 constant EIP712_BEGIN_ARRAY = 4; // data: none
    uint8 constant EIP712_END_ARRAY = 5; // data: none

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

    function whitelistEIP712(
        bytes32 dapp,
        bytes32 domainSeparator,
        SignDirective[] calldata directivesArray
    ) external ownerOrHaveTwoPermissions(uint8(Permissions.UFarm.Member), uint8(Permissions.UFarm.ManageWhitelist)) {
        if (directivesArray.length == 0) revert InvalidInput();

        SignDirective[] storage dirs = eip712Whitelist[dapp][domainSeparator];
        if (dirs.length + directivesArray.length > MAX_DIRECTIVES_PER_ADDRESS) revert InvalidInput();

        for (uint256 i = 0; i < directivesArray.length; i++) {
            SignDirective calldata directive = directivesArray[i];
            _validateSignDirective(directive);

            SignDirective storage newDir = dirs.push();
            newDir.directives = directive.directives;
            newDir.dictionary = directive.dictionary;
        }

        emit EIP712WhitelistUpdated(dapp, domainSeparator, true);
    }

    function unwhitelistEIP712(
        bytes32 dapp,
        bytes32 domainSeparator,
        uint256 idx
    ) external ownerOrHaveTwoPermissions(uint8(Permissions.UFarm.Member), uint8(Permissions.UFarm.ManageWhitelist)) {
        SignDirective[] storage dirs = eip712Whitelist[dapp][domainSeparator];
        if (idx >= dirs.length) revert IndexOutOfBounds();

        dirs[idx] = dirs[dirs.length - 1];
        dirs.pop();

        emit EIP712WhitelistUpdated(dapp, domainSeparator, false);
    }

    function _validateSignDirective(SignDirective calldata directive) private pure {
        uint8[] calldata headers = directive.directives;
        bytes calldata dict = directive.dictionary;
        uint256 dictLen = dict.length;

        if (directive.directives.length == 0) revert InvalidInput();

        for (uint256 i = 0; i < headers.length; i++) {
            uint8 header = headers[i];
            uint8 typ = header >> 5;
            uint256 offset = header & 0x1F;

            if (typ != TYPE_ANY && typ != TYPE_SELF && typ != TYPE_FROM_LIST && typ != TYPE_EXACT)
                revert InvalidInput();

            if (typ == TYPE_EXACT) {
                uint256 required = (offset + 1) * 32;
                if (dictLen < required) revert InvalidInput();
            } else if (offset != 0) {
                revert InvalidInput();
            }
        }
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

    /**
     * @notice Returns full EIP-712 typed-data digest if it's whitelisted
     * @param dapp The identifier of the dApp.
     * @param ops Encoded EIP-712 stack-machine operations that describe the message.
     * @return retHash The EIP-712 hash if allowed, zero otherwise.
     */
    function eip712Hash(bytes32 dapp, bytes calldata ops) external view returns (bytes32 retHash) {
        uint256 len = ops.length;
        // Minimum: 1 byte opcode + 32 bytes domain
        if (len < 33) revert InvalidInput();

        uint256 idx = 0;

        // ---------- DOMAIN ----------
        if (uint8(ops[idx]) != EIP712_DOMAIN) revert InvalidInput();
        idx++;

        bytes32 domainSeparator;
        assembly {
            domainSeparator := calldataload(add(ops.offset, idx))
        }
        idx += 32;

        // ---------- MESSAGE ----------
        uint256[] memory stack = new uint256[](len + 1); // Packed frame: hi128 = start, lo128 = count
        bool[] memory isArrayFrame = new bool[](len + 1);
        bytes32[] memory buf = new bytes32[](len / 17 + 2); // 2 bytes per frame in the worst case

        uint256 matchedDirectives = type(uint256).max;
        uint256 fieldCount = 0;
        uint256 bufLen = 0;
        uint256 depth = 0;

        SignDirective[] storage signDirs = eip712Whitelist[dapp][domainSeparator];
        if (signDirs.length == 0) return bytes32(0x0);

        while (idx < len) {
            uint8 opcode = uint8(ops[idx]);
            idx++;

            if (opcode == EIP712_BEGIN_STRUCT) {
                // BEGIN_STRUCT: 32 bytes typehash/seed
                if (idx + 32 > len) revert IndexOutOfBounds();
                if (depth > len) revert IndexOutOfBounds();

                // Open a new frame: start = bufLen, count = 0
                stack[depth] = uint256(bufLen) << 128;
                isArrayFrame[depth] = false;
                depth++;

                bytes32 word;
                assembly {
                    word := calldataload(add(ops.offset, idx))
                }
                idx += 32;

                buf[bufLen] = word;
                bufLen++;
                // increment count (low 128 bits)
                stack[depth - 1] += 1;
            } else if (opcode == EIP712_BEGIN_ARRAY) {
                // BEGIN_ARRAY: no additional data
                if (depth > len) revert IndexOutOfBounds();

                stack[depth] = uint256(bufLen) << 128;
                isArrayFrame[depth] = true;
                depth++;
            } else if (opcode == EIP712_FIELD) {
                // FIELD: 32 bytes value
                if (depth == 0) revert InvalidInput();
                if (idx + 32 > len) revert IndexOutOfBounds();

                bytes32 word;
                assembly {
                    word := calldataload(add(ops.offset, idx))
                }
                idx += 32;

                // Check the field value agains the whitelist
                matchedDirectives &= _matchDirective(signDirs, word, fieldCount, dapp);
                fieldCount++;

                buf[bufLen] = word;
                bufLen++;
                // increment count in current frame
                stack[depth - 1] += 1;
            } else if (opcode == EIP712_END_STRUCT || opcode == EIP712_END_ARRAY) {
                // END_STRUCT/END_ARRAY: no additional data
                if (depth == 0) revert InvalidInput();

                bool arrayFrame = isArrayFrame[depth - 1];
                if (arrayFrame && opcode != EIP712_END_ARRAY) revert InvalidInput();
                if (!arrayFrame && opcode != EIP712_END_STRUCT) revert InvalidInput();

                uint256 frame = stack[depth - 1];
                depth--;

                uint256 start = frame >> 128;
                uint256 count = uint128(frame); // low 128 bits

                if (!arrayFrame && count == 0) revert InvalidInput();
                if (start + count > bufLen) revert IndexOutOfBounds();

                bytes32 h = _hashFrame(buf, start, count);

                if (depth == 0) {
                    // This is the root message struct
                    if (retHash != bytes32(0)) revert InvalidInput();
                    retHash = h;
                    bufLen = start + 1;
                } else {
                    // Nested struct: push its hash as a field into parent frame
                    buf[start] = h;
                    bufLen = start + 1;
                    // increment parent count
                    stack[depth - 1] += 1;
                }
            } else {
                revert InvalidInput();
            }
        }

        if (len != idx) revert InvalidInput();
        if (depth != 0) revert InvalidInput();
        if (retHash == bytes32(0)) revert InvalidInput();
        if (matchedDirectives == 0) return bytes32(0x0);

        // ---------- final EIP-712 digest ----------
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, retHash));
    }

    function _hashFrame(bytes32[] memory buf, uint256 start, uint256 count) private pure returns (bytes32 result) {
        // keccak256(concat(buf[start], ..., buf[start+count-1]))
        assembly {
            let ptr := add(add(buf, 0x20), mul(start, 0x20))
            result := keccak256(ptr, mul(count, 0x20))
        }
    }

    function _matchDirective(
        SignDirective[] storage dirs,
        bytes32 value,
        uint256 fieldIdx,
        bytes32 dapp
    ) internal view returns (uint256) {
        uint256 matched = 0;
        for (uint256 idx = 0; idx < dirs.length; idx++) {
            if (fieldIdx >= dirs[idx].directives.length) continue;

            uint8 header = dirs[idx].directives[fieldIdx];
            uint8 typ = header >> 5;
            bool isAllowed = false;

            if (typ == TYPE_SELF) {
                isAllowed = value == bytes32(uint256(uint160(msg.sender)));
            } else if (typ == TYPE_FROM_LIST) {
                uint256 raw = uint256(value);
                if (raw >> 160 == 0) {
                    Directive[] storage wlDirs = whitelist[dapp][address(uint160(raw))];
                    isAllowed = wlDirs.length > 0 && extractSelector(wlDirs[0].directives) == bytes4(0x11111111);
                }
            } else if (typ == TYPE_EXACT) {
                bytes storage dict = dirs[idx].dictionary;
                uint256 offset = (uint256(header) & 0x1F);
                if (dict.length >= (offset + 1) * 32) {
                    bytes32 dictWord;
                    assembly {
                        let slot := dict.slot
                        mstore(0x0, slot)
                        let dataSlot := keccak256(0x0, 0x20)
                        dictWord := sload(add(dataSlot, offset))
                    }
                    isAllowed = value == dictWord;
                }
            } else if (typ == TYPE_ANY) {
                isAllowed = true;
            }

            if (isAllowed) matched |= (1 << idx);
        }
        return matched;
    }

    uint256[49] private __gap;
}
