// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.24;

import {UFarmOwnableUUPS} from "./UFarmOwnableUUPS.sol";

// import {IBeaconUpgradeable} from '@openzeppelin/contracts-upgradeable/proxy/beacon/IBeaconUpgradeable.sol';

/**
 * @title UFarmOwnableUUPSBeacon contract
 * @author https://ufarm.digital/
 * @notice Prohibits implementation upgrades from proxy, only external called upgrades are allowed
 */
abstract contract UFarmOwnableUUPSBeacon is UFarmOwnableUUPS {
    /**
     * @dev Upgrade the implementation of the proxy to `newImplementation`.
     * Upgrades only the implementation, not the beacon proxy
     * @custom:oz-upgrades-unsafe-allow-reachable delegatecall
     */
    function upgradeTo(address newImplementation) public virtual override onlyProxy notDelegated {
        _authorizeUpgrade(newImplementation);
        _upgradeToAndCallUUPS(newImplementation, new bytes(0), false);
    }

    function __init_UFarmOwnableUUPSBeacon() internal virtual onlyInitializing {
        __init__UFarmOwnableUUPS();
        __init_UFarmOwnableUUPSBeacon_unchained();
    }

    function __init_UFarmOwnableUUPSBeacon_unchained() internal virtual onlyInitializing {
        _transferOwnership(address(0)); // Implementation is UFarmOwnableUUPS, so Beacon should not have an owner
    }

    uint256[50] private __gap;
}
