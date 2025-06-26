// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.24;

/// CONTRACTS
import {ChainlinkedOracle} from "./ChainlinkedOracle.sol";
import {UFarmCoreLink} from "../../shared/UFarmCoreLink.sol";
import {UFarmOwnableUUPS} from "../../shared/UFarmOwnableUUPS.sol";
import {ReentrancyGuardUpgradeable as ReentrancyGuard} from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";

/// INTERFACES

/// LIBRARIES

/**
 * @title PriceOracleCore contract
 * @author https://ufarm.digital/
 * @notice Connects to Chainlink price feeds and calculates the cost of assets
 */
abstract contract PriceOracleCore is UFarmCoreLink, ChainlinkedOracle, ReentrancyGuard, UFarmOwnableUUPS {
    error InvalidPath();
    error InvalidMethod();
    error InvalidRecipient();
    error InvalidController();

    function __init__PriceOracleCore(address ufarmCoreLink) internal onlyInitializing {
        __init__UFarmOwnableUUPS();
        __init__UFarmCoreLink(ufarmCoreLink);
    }

    uint256[50] private __gap;
}
