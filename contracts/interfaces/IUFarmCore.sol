// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {IUFarmPermissions} from "./IUFarmPermissions.sol";

interface IUFarmCore is IUFarmPermissions {
    struct ValueTokenConfig {
        address feed;
        uint64 tokenUnit;
        uint32 maxPriceAge;
        uint64 feedUnit;
        uint96 minPrice;
        uint96 maxPrice;
    }

    /// @notice Returns the value-token pricing configuration for an asset.
    /// @param asset Value-token address.
    /// @return config Stored pricing configuration, or an empty configuration if the asset is not configured.
    function valueTokenConfig(address asset) external view returns (ValueTokenConfig memory config);

    /// @notice Configures an asset as a value token using a Chainlink-compatible USD price feed.
    /// @param asset Value-token address.
    /// @param feed Chainlink-compatible USD price feed.
    /// @param maxPriceAge Maximum accepted age of the latest feed answer, in seconds.
    /// @param minPrice Minimum accepted token price in USD WAD.
    /// @param maxPrice Maximum accepted token price in USD WAD.
    function setValueTokenConfig(address asset, address feed, uint32 maxPriceAge, uint96 minPrice, uint96 maxPrice)
        external;

    /// @notice Removes the value-token pricing configuration for an asset.
    /// @param asset Value-token address.
    function clearValueTokenConfig(address asset) external;

    /// @notice Converts a value-token amount into USD WAD using the current validated price.
    /// @dev Returns zero when the asset, feed answer, or conversion result is invalid.
    /// @param asset Value-token address.
    /// @param valueTokenAmount Amount in the value token's native decimals.
    /// @return usdAmount Converted value in USD WAD, or zero if pricing is invalid.
    function valueTokenToUsd(address asset, uint256 valueTokenAmount) external view returns (uint256 usdAmount);

    /// @notice Converts a USD WAD amount into value-token units using the current validated price.
    /// @dev Returns zero when the asset, feed answer, or conversion result is invalid.
    /// @param asset Value-token address.
    /// @param usdAmount Value in USD WAD.
    /// @return valueTokenAmount Converted amount in the value token's native decimals, or zero if pricing is invalid.
    function usdToValueToken(address asset, uint256 usdAmount) external view returns (uint256 valueTokenAmount);
    function oracleForVault(address vaultAddress) external view returns (address);
    function adapterForVault(bytes32 adapterId, address vaultAddress) external view returns (address);
    function vaultModule(bytes32 moduleId) external view returns (address module);
    function globalPauseMask() external view returns (uint256);
    function curatorPauseMask(address curator) external view returns (uint256);
    function navRequestCooldown() external view returns (uint256);
    function oracleRequestTimeout() external view returns (uint256);
    // slither-disable-next-line shadowing-local -- ABI name is intentionally aligned with the protocolFee getter.
    function setProtocolFee(address vaultAddress, uint256 protocolFee, bool zeroUFarmFee) external;
    // slither-disable-next-line shadowing-local -- ABI return name is part of the requested protocolFee API.
    function protocolFee(address vaultAddress) external view returns (uint256 protocolFee, bool zeroUFarmFee);
    function clearProtocolFee(address vaultAddress) external;
    function allowedPriceFluctuation() external view returns (uint256);
    function accountingChainId() external view returns (uint64);
    function crossChainRouter() external view returns (address);
    function crossChainFeeToken() external view returns (address);
    function crossChainToken() external view returns (address);
    function crossChainGasLimit() external view returns (uint256);
    function ccipSelectorForChain(uint64 chainId) external view returns (uint64);
    function escrow() external view returns (address);
    function deterministicDeployer() external view returns (address);
    function curatorBeacon() external view returns (address);
    function vaultBeacon() external view returns (address);
    function isCurator(address curator) external view returns (bool);
    function createCurator(address curatorOwner, bytes32 userSalt) external returns (address curator);
    function setVaultOperator(address vault, address operator, bool approved) external returns (bool);
    function requestVaultRedeem(address vault, uint256 shares) external returns (uint256 requestId);
    function claimVaultRedeem(address vault, address receiver) external returns (uint256 assets);
}
