// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IArbitraryAdapterGuard} from "../interfaces/IArbitraryAdapter.sol";
import {IUFarmPermissions} from "../interfaces/IUFarmPermissions.sol";
import {Permissions} from "../libraries/Permissions.sol";

contract ArbitraryAdapterGuard is Initializable, UUPSUpgradeable, IArbitraryAdapterGuard {
    struct Directive {
        uint256 payloadLength;
        bytes directives;
    }

    struct EIP712HashState {
        uint256[] stack;
        bool[] isArrayFrame;
        bytes32[] buf;
        uint256 matchedDirectives;
        uint256 fieldCount;
        uint256 bufLen;
        uint256 depth;
        bytes32 rootHash;
    }

    uint8 private constant TYPE_WILDCARD_WORDS = 0;
    uint8 private constant TYPE_ANY = 1;
    uint8 private constant TYPE_SELF = 2;
    uint8 private constant TYPE_FROM_LIST = 3;
    uint8 private constant TYPE_EXACT = 4;
    uint8 private constant TYPE_WILDCARD_BYTES = 5;

    uint256 private constant MAX_DIRECTIVES_PER_ADDRESS = 32;

    uint8 private constant EIP712_DOMAIN = 0;
    uint8 private constant EIP712_BEGIN_STRUCT = 1;
    uint8 private constant EIP712_FIELD = 2;
    uint8 private constant EIP712_END_STRUCT = 3;
    uint8 private constant EIP712_BEGIN_ARRAY = 4;
    uint8 private constant EIP712_END_ARRAY = 5;

    address public immutable core;

    // slither-disable-next-line uninitialized-state
    mapping(bytes32 dapp => mapping(address target => Directive[] directives)) public whitelist;
    // slither-disable-next-line uninitialized-state
    mapping(bytes32 dapp => mapping(bytes32 domain => SignDirective[] directives)) public eip712Whitelist;

    /**
     * @notice Deploys a guard implementation bound to a specific UFarm core.
     * @dev The core address is immutable and is embedded in implementation bytecode rather than proxy storage. Upgrade
     *      procedures must verify that each replacement implementation was constructed with the intended core address.
     * @param core_ UFarm core contract used for adapter-manager and owner authorization checks.
     */
    constructor(address core_) {
        if (core_ == address(0) || core_.code.length == 0) revert ArbitraryAdapterGuardInvalidInput();
        core = core_;
        _disableInitializers();
    }

    /**
     * @notice Initializes the guard proxy.
     * @dev The guard uses immutable core configuration, so this initializer only marks the proxy initialized. The proxy's
     *      effective core is the immutable core address embedded in the current implementation.
     */
    function initialize() external initializer {}

    modifier onlyCoreAdapterManager() {
        if (!IUFarmPermissions(core)
                .accountHasPermission(msg.sender, Permissions.MEMBER | Permissions.CORE_ADAPTER_MANAGER)) {
            revert ArbitraryAdapterGuardUnauthorized(msg.sender);
        }
        _;
    }

    function _authorizeUpgrade(address) internal view override {
        if (!IUFarmPermissions(core).accountHasPermission(msg.sender, Permissions.OWNER)) {
            revert ArbitraryAdapterGuardUnauthorized(msg.sender);
        }
    }

    /**
     * @notice Allows one or more external protocol calls for a dapp.
     * @dev Directives validate calldata structure only. They do not enforce economic constraints such as minAmountOut,
     *      price limits, balance deltas, or slippage. Adapter managers should avoid wildcarding economically critical
     *      fields unless accepting arbitrary values is intentional. The same whitelist storage is also used by
     *      TYPE_FROM_LIST address checks, so listed addresses should be reviewed as part of protocol-call allowlisting.
     * @param dapp Protocol identifier used by vault adapter calls.
     * @param targets Target contract addresses that may be called.
     * @param directivesArray Calldata matching directives that describe allowed payloads.
     */
    function whitelistProtocol(bytes32 dapp, address[] calldata targets, bytes[] calldata directivesArray)
        external
        onlyCoreAdapterManager
    {
        if (dapp == bytes32(0) || targets.length == 0 || directivesArray.length == 0) {
            revert ArbitraryAdapterGuardInvalidInput();
        }
        _whitelistProtocol(dapp, targets, directivesArray);
    }

    /**
     * @notice Removes allowed protocol call directives.
     * @dev Removes entries with swap-and-pop. When removing multiple entries, pass unique indexes in descending order so
     *      earlier removals do not invalidate later indexes. Duplicate indexes can remove entries different from the
     *      caller's intended original positions.
     * @param dapp Protocol identifier used by vault adapter calls.
     * @param target Target contract address whose directives should be removed.
     * @param indexes Positions of the directives to remove from the target whitelist.
     */
    function unwhitelistProtocol(bytes32 dapp, address target, uint256[] calldata indexes)
        external
        onlyCoreAdapterManager
    {
        Directive[] storage dirs = whitelist[dapp][target];
        if (indexes.length == 0) revert ArbitraryAdapterGuardInvalidInput();

        for (uint256 i = 0; i < indexes.length; ++i) {
            uint256 idx = indexes[i];
            if (idx >= dirs.length) revert ArbitraryAdapterGuardIndexOutOfBounds();

            bytes4 method = _extractSelector(dirs[idx].directives);
            dirs[idx] = dirs[dirs.length - 1];
            dirs.pop();

            emit ArbitraryAdapterWhitelistUpdated(dapp, target, method, false);
        }
    }

    /**
     * @notice Allows EIP-712 signing directives for a dapp and domain.
     * @param dapp Protocol identifier used by vault signing requests.
     * @param domainSeparator EIP-712 domain separator that the directives apply to.
     * @param directivesArray Rules that describe allowed typed-data fields and values.
     */
    function whitelistEIP712(bytes32 dapp, bytes32 domainSeparator, SignDirective[] calldata directivesArray)
        external
        onlyCoreAdapterManager
    {
        if (dapp == bytes32(0) || domainSeparator == bytes32(0) || directivesArray.length == 0) {
            revert ArbitraryAdapterGuardInvalidInput();
        }

        SignDirective[] storage dirs = eip712Whitelist[dapp][domainSeparator];
        if (dirs.length + directivesArray.length > MAX_DIRECTIVES_PER_ADDRESS) {
            revert ArbitraryAdapterGuardInvalidInput();
        }

        for (uint256 i = 0; i < directivesArray.length; i++) {
            SignDirective calldata directive = directivesArray[i];
            _validateSignDirective(directive);

            SignDirective storage newDir = dirs.push();
            newDir.directives = directive.directives;
            newDir.dictionary = directive.dictionary;
        }

        emit ArbitraryAdapterEIP712WhitelistUpdated(dapp, domainSeparator, true);
    }

    /**
     * @notice Removes EIP-712 signing directives.
     * @dev Removes entries with swap-and-pop. When removing multiple entries, pass unique indexes in descending order so
     *      earlier removals do not invalidate later indexes. Duplicate indexes can remove entries different from the
     *      caller's intended original positions.
     * @param dapp Protocol identifier used by vault signing requests.
     * @param domainSeparator EIP-712 domain separator whose directives should be removed.
     * @param indexes Positions of the directives to remove from the EIP-712 whitelist.
     */
    function unwhitelistEIP712(bytes32 dapp, bytes32 domainSeparator, uint256[] calldata indexes)
        external
        onlyCoreAdapterManager
    {
        SignDirective[] storage dirs = eip712Whitelist[dapp][domainSeparator];
        if (indexes.length == 0) revert ArbitraryAdapterGuardInvalidInput();

        for (uint256 i = 0; i < indexes.length; ++i) {
            uint256 idx = indexes[i];
            if (idx >= dirs.length) revert ArbitraryAdapterGuardIndexOutOfBounds();

            dirs[idx] = dirs[dirs.length - 1];
            dirs.pop();
        }

        emit ArbitraryAdapterEIP712WhitelistUpdated(dapp, domainSeparator, false);
    }

    /**
     * @notice Checks whether a protocol call is allowed.
     * @param dapp Protocol identifier used by vault adapter calls.
     * @param dappAddress Target contract address that would be called.
     * @param payload Calldata that would be sent to the target.
     * @return True when one stored directive allows the call.
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

    /**
     * @notice Extracts the function selector represented by a calldata directive.
     * @param blob Encoded calldata matching directive.
     * @return Function selector described by the directive.
     */
    function extractSelector(bytes memory blob) external pure returns (bytes4) {
        return _extractSelector(blob);
    }

    /**
     * @notice Builds an EIP-712 digest if the operation stream matches an allowed directive.
     * @param dapp Protocol identifier used by vault signing requests.
     * @param ops Encoded operation stream containing the domain and typed-data structure.
     * @return retHash EIP-712 digest when allowed, or zero when no directive matches.
     */
    function eip712Hash(bytes32 dapp, bytes calldata ops) external view returns (bytes32 retHash) {
        uint256 len = ops.length;
        if (len < 33) revert ArbitraryAdapterGuardInvalidInput();

        uint256 idx = 0;
        if (uint8(ops[idx]) != EIP712_DOMAIN) revert ArbitraryAdapterGuardInvalidInput();
        idx++;

        bytes32 domainSeparator;
        // slither-disable-next-line assembly
        assembly ("memory-safe") {
            domainSeparator := calldataload(add(ops.offset, idx))
        }
        idx += 32;

        SignDirective[] storage signDirs = eip712Whitelist[dapp][domainSeparator];
        if (signDirs.length == 0) return bytes32(0);

        EIP712HashState memory state = EIP712HashState({
            stack: new uint256[](len + 1),
            isArrayFrame: new bool[](len + 1),
            buf: new bytes32[](len / 17 + 2),
            matchedDirectives: type(uint256).max,
            fieldCount: 0,
            bufLen: 0,
            depth: 0,
            rootHash: bytes32(0)
        });

        idx = _processEIP712Ops(ops, idx, signDirs, dapp, state);

        if (len != idx || state.depth != 0 || state.rootHash == bytes32(0)) {
            revert ArbitraryAdapterGuardInvalidInput();
        }
        if (state.matchedDirectives == 0) return bytes32(0);

        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, state.rootHash));
    }

    function _whitelistProtocol(bytes32 dapp, address[] calldata targets, bytes[] calldata directivesArray) private {
        for (uint256 i = 0; i < directivesArray.length; i++) {
            bytes calldata blob = directivesArray[i];
            uint256 payloadLength = _payloadLength(blob);
            bytes4 method = _extractSelector(blob);
            if (method == bytes4(0)) revert ArbitraryAdapterGuardInvalidSelector();

            for (uint256 j = 0; j < targets.length; j++) {
                if (targets[j] == address(0)) revert ArbitraryAdapterGuardInvalidInput();
                Directive[] storage dirs = whitelist[dapp][targets[j]];
                if (dirs.length + 1 > MAX_DIRECTIVES_PER_ADDRESS) revert ArbitraryAdapterGuardInvalidInput();
                dirs.push(Directive({payloadLength: payloadLength, directives: blob}));
                emit ArbitraryAdapterWhitelistUpdated(dapp, targets[j], method, true);
            }
        }
    }

    function _payloadLength(bytes calldata blob) private pure returns (uint256 total) {
        uint256 ptr = 0;

        while (ptr < blob.length) {
            uint8 header = uint8(blob[ptr]);
            ptr++;
            uint8 typ = header >> 5;
            uint256 span = (header & 0x1F) + 1;

            if (typ == TYPE_WILDCARD_WORDS) {
                total += span * 32;
            } else if (typ == TYPE_ANY) {
                if (ptr != blob.length) revert ArbitraryAdapterGuardInvalidInput();
                return type(uint256).max;
            } else if (typ == TYPE_SELF || typ == TYPE_FROM_LIST) {
                if (span != 20 && span != 32) revert ArbitraryAdapterGuardInvalidInput();
                total += span;
            } else if (typ == TYPE_EXACT) {
                if (ptr + span > blob.length) revert ArbitraryAdapterGuardInvalidInput();
                total += span;
                ptr += span;
            } else if (typ == TYPE_WILDCARD_BYTES) {
                total += span;
            } else {
                revert ArbitraryAdapterGuardInvalidInput();
            }
        }
    }

    function _validateSignDirective(SignDirective calldata directive) private pure {
        uint8[] calldata headers = directive.directives;
        bytes calldata dict = directive.dictionary;
        if (headers.length == 0) revert ArbitraryAdapterGuardInvalidInput();

        for (uint256 i = 0; i < headers.length; i++) {
            uint8 header = headers[i];
            uint8 typ = header >> 5;
            uint256 offset = header & 0x1F;

            if (typ != TYPE_ANY && typ != TYPE_SELF && typ != TYPE_FROM_LIST && typ != TYPE_EXACT) {
                revert ArbitraryAdapterGuardInvalidInput();
            }

            if (typ == TYPE_EXACT) {
                uint256 required = (offset + 1) * 32;
                if (dict.length < required) revert ArbitraryAdapterGuardInvalidInput();
            } else if (offset != 0) {
                revert ArbitraryAdapterGuardInvalidInput();
            }
        }
    }

    function _matchDirective(bytes storage blob, bytes calldata payload, bytes32 dapp) private view returns (bool) {
        uint256 blobPtr = 0;
        uint256 payloadPtr = 0;

        while (blobPtr < blob.length) {
            uint8 header = uint8(blob[blobPtr]);
            blobPtr++;
            uint8 typ = header >> 5;
            uint256 span = (header & 0x1F) + 1;

            if (typ == TYPE_WILDCARD_WORDS) {
                payloadPtr += span * 32;
            } else if (typ == TYPE_ANY) {
                return true;
            } else if (typ == TYPE_WILDCARD_BYTES) {
                payloadPtr += span;
            } else if (typ == TYPE_EXACT) {
                if (blobPtr + span > blob.length || payloadPtr + span > payload.length) return false;
                for (uint256 k = 0; k < span; k++) {
                    if (blob[blobPtr + k] != payload[payloadPtr + k]) return false;
                }
                blobPtr += span;
                payloadPtr += span;
            } else if (typ == TYPE_SELF || typ == TYPE_FROM_LIST) {
                if ((span != 20 && span != 32) || payloadPtr + span > payload.length) return false;
                address got = _payloadAddress(payload, payloadPtr + span - 20);
                if (typ == TYPE_SELF) {
                    if (msg.sender != got) return false;
                } else if (!_isListedAddress(dapp, got)) {
                    return false;
                }
                payloadPtr += span;
            } else {
                return false;
            }

            if (payloadPtr > payload.length) return false;
        }

        return payloadPtr == payload.length && blobPtr == blob.length;
    }

    function _matchSignDirective(SignDirective[] storage dirs, bytes32 value, uint256 fieldIdx, bytes32 dapp)
        private
        view
        returns (uint256 matched)
    {
        for (uint256 idx = 0; idx < dirs.length; idx++) {
            if (fieldIdx >= dirs[idx].directives.length) continue;

            uint8 header = dirs[idx].directives[fieldIdx];
            uint8 typ = header >> 5;
            bool isAllowed = false;

            if (typ == TYPE_SELF) {
                isAllowed = value == bytes32(uint256(uint160(msg.sender)));
            } else if (typ == TYPE_FROM_LIST) {
                uint256 raw = uint256(value);
                if (raw >> 160 == 0) isAllowed = _isListedAddress(dapp, address(uint160(raw)));
            } else if (typ == TYPE_EXACT) {
                uint256 offset = uint256(header) & 0x1F;
                isAllowed = value == _dictionaryWord(dirs[idx].dictionary, offset);
            } else if (typ == TYPE_ANY) {
                isAllowed = true;
            }

            if (isAllowed) matched |= (1 << idx);
        }
    }

    function _processEIP712Ops(
        bytes calldata ops,
        uint256 idx,
        SignDirective[] storage signDirs,
        bytes32 dapp,
        EIP712HashState memory state
    ) private view returns (uint256) {
        while (idx < ops.length) {
            uint8 opcode = uint8(ops[idx]);
            idx++;

            if (opcode == EIP712_BEGIN_STRUCT) {
                idx = _eip712BeginStruct(ops, idx, signDirs, dapp, state);
            } else if (opcode == EIP712_BEGIN_ARRAY) {
                _eip712BeginArray(ops.length, state);
            } else if (opcode == EIP712_FIELD) {
                idx = _eip712Field(ops, idx, signDirs, dapp, state);
            } else if (opcode == EIP712_END_STRUCT || opcode == EIP712_END_ARRAY) {
                _eip712EndFrame(opcode, state);
            } else {
                revert ArbitraryAdapterGuardInvalidInput();
            }
        }

        return idx;
    }

    function _eip712BeginStruct(
        bytes calldata ops,
        uint256 idx,
        SignDirective[] storage signDirs,
        bytes32 dapp,
        EIP712HashState memory state
    ) private view returns (uint256) {
        if (idx + 32 > ops.length || state.depth > ops.length) {
            revert ArbitraryAdapterGuardIndexOutOfBounds();
        }
        state.stack[state.depth] = uint256(state.bufLen) << 128;
        state.isArrayFrame[state.depth] = false;
        state.depth++;

        bytes32 word;
        // slither-disable-next-line assembly
        assembly ("memory-safe") {
            word := calldataload(add(ops.offset, idx))
        }
        idx += 32;

        state.matchedDirectives &= _matchSignDirective(signDirs, word, state.fieldCount, dapp);
        state.fieldCount++;
        state.buf[state.bufLen] = word;
        state.bufLen++;
        state.stack[state.depth - 1] += 1;
        return idx;
    }

    function _eip712BeginArray(uint256 opsLength, EIP712HashState memory state) private pure {
        if (state.depth > opsLength) revert ArbitraryAdapterGuardIndexOutOfBounds();
        state.stack[state.depth] = uint256(state.bufLen) << 128;
        state.isArrayFrame[state.depth] = true;
        state.depth++;
    }

    function _eip712Field(
        bytes calldata ops,
        uint256 idx,
        SignDirective[] storage signDirs,
        bytes32 dapp,
        EIP712HashState memory state
    ) private view returns (uint256) {
        if (state.depth == 0) revert ArbitraryAdapterGuardInvalidInput();
        if (idx + 32 > ops.length) revert ArbitraryAdapterGuardIndexOutOfBounds();

        bytes32 word;
        // slither-disable-next-line assembly
        assembly ("memory-safe") {
            word := calldataload(add(ops.offset, idx))
        }
        idx += 32;

        state.matchedDirectives &= _matchSignDirective(signDirs, word, state.fieldCount, dapp);
        state.fieldCount++;
        state.buf[state.bufLen] = word;
        state.bufLen++;
        state.stack[state.depth - 1] += 1;
        return idx;
    }

    function _eip712EndFrame(uint8 opcode, EIP712HashState memory state) private pure {
        if (state.depth == 0) revert ArbitraryAdapterGuardInvalidInput();

        bool arrayFrame = state.isArrayFrame[state.depth - 1];
        if (arrayFrame && opcode != EIP712_END_ARRAY) revert ArbitraryAdapterGuardInvalidInput();
        if (!arrayFrame && opcode != EIP712_END_STRUCT) revert ArbitraryAdapterGuardInvalidInput();

        uint256 frame = state.stack[state.depth - 1];
        state.depth--;

        uint256 start = frame >> 128;
        uint256 count = uint128(frame);
        if (!arrayFrame && count == 0) revert ArbitraryAdapterGuardInvalidInput();
        if (start + count > state.bufLen) revert ArbitraryAdapterGuardIndexOutOfBounds();

        bytes32 h = _hashFrame(state.buf, start, count);

        if (state.depth == 0) {
            if (state.rootHash != bytes32(0)) revert ArbitraryAdapterGuardInvalidInput();
            state.rootHash = h;
            state.bufLen = start + 1;
        } else {
            state.buf[start] = h;
            state.bufLen = start + 1;
            state.stack[state.depth - 1] += 1;
        }
    }

    function _isListedAddress(bytes32 dapp, address account) private view returns (bool) {
        Directive[] storage dirs = whitelist[dapp][account];
        return dirs.length > 0 && _extractSelector(dirs[0].directives) == bytes4(0x11111111);
    }

    function _payloadAddress(bytes calldata payload, uint256 offset) private pure returns (address got) {
        bytes20 raw;
        // slither-disable-next-line assembly
        assembly ("memory-safe") {
            let scratch := mload(0x40)
            mstore(scratch, 0)
            calldatacopy(scratch, add(payload.offset, offset), 20)
            raw := mload(scratch)
        }
        got = address(raw);
    }

    function _dictionaryWord(bytes storage dictionary, uint256 offset) private view returns (bytes32 word) {
        // slither-disable-next-line assembly
        assembly ("memory-safe") {
            mstore(0x0, dictionary.slot)
            let dataSlot := keccak256(0x0, 0x20)
            word := sload(add(dataSlot, offset))
        }
    }

    function _hashFrame(bytes32[] memory buf, uint256 start, uint256 count) private pure returns (bytes32 result) {
        // slither-disable-next-line assembly
        assembly ("memory-safe") {
            let ptr := add(add(buf, 0x20), mul(start, 0x20))
            result := keccak256(ptr, mul(count, 0x20))
        }
    }

    function _extractSelector(bytes memory blob) private pure returns (bytes4) {
        if (blob.length > 4) {
            uint8 hdr = uint8(blob[0]);
            uint8 typ = hdr >> 5;
            uint256 len = (hdr & 0x1F) + 1;

            if (typ == TYPE_EXACT && len == 4) {
                return bytes4(
                    (uint32(uint8(blob[1])) << 24) | (uint32(uint8(blob[2])) << 16) | (uint32(uint8(blob[3])) << 8)
                        | uint32(uint8(blob[4]))
                );
            }
        }
        return bytes4(0);
    }

    // slither-disable-next-line naming-convention,unused-state
    uint256[50] private __gap;
}
