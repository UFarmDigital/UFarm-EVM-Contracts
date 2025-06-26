// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.24;

interface ICoreWhitelist {
    struct FeedWithDecimal {
        address feedAddr;
        uint8 feedDec;
    }
    struct AssetWithPriceFeed {
        address assetAddr;
        uint8 assetDec;
        FeedWithDecimal priceFeed;
    }

    /**
     * @notice Returns contoller address for the protocol
     * @param protocol - protocol to check
     * @return controller - controller address
     */
    function controllers(bytes32 protocol) external view returns (address);

    /**
     * @notice Returns array of whitelisted protocols
     * @return protocols - array of whitelisted protocols
     */
    function getWhitelistedProtocols() external view returns (bytes32[] memory protocols);

    /**
     * @notice Checks if contracts can use token
     * @param token - token to check
     * @return bool - `true` if token is whitelisted, `false` otherwise
     */
    function isTokenWhitelisted(address token) external view returns (bool);

    /**
     * @notice Returns token info
     * @param token - token to check
     * @return info - token info
     */
    function tokenInfo(address token) external view returns (AssetWithPriceFeed memory info);

    /**
     * @notice Checks if protocol is whitelisted and controller is allowed to use it
     * @param protocol - protocol to check
     * @return bool - `true` if protocol is whitelisted, `false` otherwise
     */
    function isProtocolWhitelisted(bytes32 protocol) external view returns (bool);

    /**
     * @notice Whitelists tokens for the system
     * @dev Emits `TokenAdded` event for each token
     *
     * @param tokens - array of tokens to whitelist
     */

    function whitelistTokens(AssetWithPriceFeed[] calldata tokens) external;

    /**
     * @notice Blacklists tokens from the system
     * @dev Emits TokenRemoved event for each token
     *
     * @param tokens Array of tokens to blacklist
     */
    function blacklistTokens(address[] memory tokens) external;

    /**
     * @notice Whitelists protocols for the system and sets their controllers
     * @param _protocolNames Array of protocols names
     * @param _protocolControllers Array of new protocols controllers addresses
     */
    function whitelistProtocolsWithControllers(
        bytes32[] memory _protocolNames,
        address[] memory _protocolControllers
    ) external;

    /**
     * @notice Updates the existing protocols controllers addresses
     * @param _protocolNames Array of protocols names
     * @param _protocolControllers Array of new protocols controllers addresses
     */
    function updateProtocolsControllers(
        bytes32[] memory _protocolNames,
        address[] memory _protocolControllers
    ) external;

    /**
     * @notice Removes protocols addresses from the controllers mapping
     * @param _protocols Array of protocols names
     */
    function blacklistProtocols(bytes32[] memory _protocols) external;

    /**
     * @notice Checks if token is whitelisted as a value token
     * @param token - token to check
     * @return bool - `true` if token is whitelisted as a value token, `false` otherwise
     */
    function isValueTokenWhitelisted(address token) external view returns (bool);

    /**
     * @notice Whitelists value tokens for the system
     * @dev Emits `ValueTokenAdded` event for each token
     *
     * @param tokens - array of tokens to whitelist as value tokens
     */
    function whitelistValueTokens(address[] calldata tokens) external;

    /**
     * @notice Blacklists value tokens from the system
     * @dev Emits ValueTokenRemoved event for each token
     *
     * @param tokens Array of value tokens to blacklist
     */
    function blacklistValueTokens(address[] memory tokens) external;

    /**
     * @notice Returns array of whitelisted value tokens
     * @return valueTokens - array of whitelisted value tokens
     */
    function getWhitelistedValueTokens() external view returns (address[] memory valueTokens);
}
