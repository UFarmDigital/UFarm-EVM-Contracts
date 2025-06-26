// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.24;

import {IQuexActionRegistry} from "./IQuexActionRegistry.sol";
import {IQuexOracleReceiver} from "./IQuexOracleReceiver.sol";
import {IRequestOraclePool, HTTPRequest, QueryParameter} from "./IRequestOraclePool.sol";
import {IFlowRegistry, Flow} from "./IFlowRegistry.sol";
import {Permissions} from "../permissions/Permissions.sol";
import {IQuexOracle, QuexActionData} from "./IQuexOracle.sol";
import {PriceOracleCore} from "./PriceOracleCore.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {UFarmCoreLink} from "../../shared/UFarmCoreLink.sol";
import {UFarmPermissionsModel} from "../permissions/UFarmPermissionsModel.sol";
import {NZGuard} from "../../shared/NZGuard.sol";
import {UFarmErrors} from "../../shared/UFarmErrors.sol";
import {IUFarmCore} from "../core/IUFarmCore.sol";
import {IUFarmFund} from "../fund/IUFarmFund.sol";
import {IUFarmPool} from "../pool/IUFarmPool.sol";

/**
 * @title PriceOracle contract
 * @author https://ufarm.digital/
 * @notice Makes requests to quex
 */
contract PriceOracle is PriceOracleCore, IQuexOracle {
    /// @custom:oz-renamed-from sequencerUptimeFeed
    address private unusedSequencer;
    address public quexCore;

    uint256 internal constant QUEX_GAS_LIMIT = 1_000_000;

    /**
     * @inheritdoc IQuexOracle
     */
    uint256 public quexFlowVersion;

    QuexActionData private quexActionData;

    uint256 public quexSubscriptionId;

    function __init__PriceOracle(address ufarmCoreLink, address _quexCore) external virtual onlyDeployer initializer {
        __init__PriceOracle_unchained(_quexCore);
        __init__PriceOracleCore(ufarmCoreLink);
    }

    function __init__PriceOracle_unchained(address _quexCore) internal virtual onlyInitializing {
        quexCore = _quexCore;

        emit QuexCoreUpdated(_quexCore);
    }

    function setQuexCore(address _quexCore) external onlyDeployer {
        if (quexCore != address(0)) revert UFarmErrors.ActionAlreadyDone();
        if (_quexCore == address(0)) revert NZGuard.ZeroAddress();

        quexCore = _quexCore;
        emit QuexCoreUpdated(_quexCore);
    }

    /// MODIFIERS
    /**
     * @notice Reverts if the caller doesn't have two permissions or is not the owner
     */
    modifier ownerOrHaveTwoPermissions(uint8 permission1, uint8 permission2) {
        UFarmPermissionsModel core = UFarmPermissionsModel(UFarmCoreLink(address(this)).ufarmCore());
        if (!core.hasPermission(msg.sender, uint8(Permissions.UFarm.Owner))) {
            core.checkForPermissionsMask(msg.sender, core.twoPermissionsToMask(permission1, permission2));
        }
        _;
    }

    function setQuexSubscriptionId(
        uint256 subscriptionId
    ) external ownerOrHaveTwoPermissions(uint8(Permissions.UFarm.Member), uint8(Permissions.UFarm.ManageQuexFeed)) {
        quexSubscriptionId = subscriptionId;
    }

    /**
     * @inheritdoc IQuexOracle
     */
    function quexRequest(uint256 flowId) public returns (uint256 requestId) {
        address fund = IUFarmPool(msg.sender).ufarmFund();
        if (IUFarmCore(ufarmCore()).isFund(fund) == false || IUFarmFund(fund).isPool(msg.sender) == false) {
            revert UFarmErrors.NonAuthorized();
        }
        requestId = IQuexActionRegistry(quexCore).createRequest(flowId, quexSubscriptionId);
    }

    /**
     * @inheritdoc IQuexOracle
     */
    function getQuexCore() external view returns (address) {
        return quexCore;
    }

    /**
     * @inheritdoc IQuexOracle
     */
    function getRequestFee(uint256 flowId) external view returns (uint256 fee) {
        return IQuexActionRegistry(quexCore).getRequestFee(flowId);
    }

    /**
     * @inheritdoc IQuexOracle
     */
    function setQuexFlow(
        address requestOraclePool,
        HTTPRequest calldata request,
        bytes32 patchId,
        bytes32 schemaId,
        bytes32 filterId
    )
        external
        override
        ownerOrHaveTwoPermissions(uint8(Permissions.UFarm.Member), uint8(Permissions.UFarm.ManageQuexFeed))
        nonReentrant
    {
        quexActionData.requestOraclePool = requestOraclePool;
        quexActionData.patchId = patchId;
        quexActionData.schemaId = schemaId;
        quexActionData.filterId = filterId;

        quexActionData.request.method = request.method;
        quexActionData.request.host = request.host;
        quexActionData.request.path = request.path;
        quexActionData.request.body = request.body;

        delete quexActionData.request.headers;
        for (uint256 i = 0; i < request.headers.length; i++) {
            quexActionData.request.headers.push(request.headers[i]);
        }

        delete quexActionData.request.parameters;
        for (uint256 i = 0; i < request.parameters.length; i++) {
            quexActionData.request.parameters.push(request.parameters[i]);
        }

        quexFlowVersion = quexFlowVersion + 1;
    }

    /**
     * @inheritdoc IQuexOracle
     */
    function createFlow() external override nonReentrant returns (uint256, uint256) {
        address quexCoreAddress = quexCore;
        QuexActionData memory newActionData = quexActionData;

        QueryParameter[] memory params = new QueryParameter[](newActionData.request.parameters.length + 1);
        for (uint256 i = 0; i < newActionData.request.parameters.length; i++) {
            params[i] = newActionData.request.parameters[i];
        }
        params[params.length - 1] = QueryParameter("id", Strings.toHexString(uint160(msg.sender), 20));

        newActionData.request.parameters = params;

        IRequestOraclePool requestOraclePool = IRequestOraclePool(newActionData.requestOraclePool);
        IFlowRegistry flowRegistry = IFlowRegistry(quexCoreAddress);

        bytes32 requestId = requestOraclePool.addRequest(newActionData.request);
        uint256 actionId = requestOraclePool.addActionByParts(
            requestId,
            newActionData.patchId,
            newActionData.schemaId,
            newActionData.filterId
        );

        Flow memory flow = Flow(
            QUEX_GAS_LIMIT,
            actionId,
            newActionData.requestOraclePool,
            msg.sender,
            IQuexOracleReceiver.quexCallback.selector
        );
        uint256 flowId = flowRegistry.createFlow(flow);

        return (flowId, quexFlowVersion);
    }

    uint256[49] private __gap;
}
