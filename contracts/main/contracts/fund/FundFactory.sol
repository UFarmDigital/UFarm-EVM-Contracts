// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.24;

/// INTERFACES
import {IUFarmFund} from "./IUFarmFund.sol";

/// CONTRACTS
import {UFarmCoreLink} from "../../shared/UFarmCoreLink.sol";

/// LIBRARIES
import {SafeOPS} from "../../shared/SafeOPS.sol";

/**
 * @title IFundFactory interface
 * @author https://ufarm.digital/
 * @notice Interface for the FundFactory contract
 */
interface IFundFactory {
    /**
     * @notice Creates a new fund
     * @param _manager The manager of the fund
     * @param _salt The salt for the fund
     * @return fund The address of the new fund
     */
    function createFund(address _manager, bytes32 _salt) external returns (address fund);
}

/**
 * @title FundFactory contract
 * @author https://ufarm.digital/
 * @notice Deployer of new funds
 * @dev Needs to be initialized with UFarmCore address
 */
contract FundFactory is IFundFactory, UFarmCoreLink {
    /**
     * @dev Reverts if caller is not the Core
     */
    error CallerIsNotCore();

    // Beacon is UUPS upgradeable proxy address, implementation can be upgraded if needed
    address public immutable fundImplBeacon;

    constructor(address _ufarmCore, address _fundImplBeacon) {
        __init__UFarmCoreLink(_ufarmCore);
        fundImplBeacon = _fundImplBeacon;
    }

    /**
     * @inheritdoc IFundFactory
     */
    function createFund(address _manager, bytes32 _salt) external onlyLinked returns (address fund) {
        if (ufarmCore() != msg.sender) revert CallerIsNotCore();
        return SafeOPS._safeBeaconCreate2Deploy(fundImplBeacon, _salt, _getInitFundCall(_manager));
    }

    function getFundBySalt(address _manager, bytes32 _salt) public view returns (address fund) {
        return SafeOPS.computeBeaconProxyAddress(fundImplBeacon, _salt, _getInitFundCall(_manager));
    }

    function _getInitFundCall(address _manager) internal view returns (bytes memory) {
        return abi.encodeCall(IUFarmFund.__init_UFarmFund, (_manager, ufarmCore()));
    }
}
