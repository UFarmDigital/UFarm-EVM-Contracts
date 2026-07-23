// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {CrossChainAdapter} from "../../contracts/adapters/CrossChainAdapter.sol";
import {MockCCIPRouter} from "../../contracts/mocks/MockCCIPRouter.sol";
import {MockERC20} from "../../contracts/mocks/MockERC20.sol";
import {InvariantFixture} from "./helpers/InvariantFixture.sol";
import {CrossChainVaultHandler} from "./handlers/CrossChainVaultHandler.sol";

contract CrossChainVaultInvariant is InvariantFixture {
    uint64 internal constant ACCOUNTING_CHAIN_ID = 31_337;
    uint64 internal constant SATELLITE_CHAIN_ID = 42_161;
    uint64 internal constant OTHER_SATELLITE_CHAIN_ID = 10;
    uint64 internal constant ACCOUNTING_SELECTOR = 3_133_700;
    uint64 internal constant SATELLITE_SELECTOR = 4_216_100;
    uint64 internal constant OTHER_SATELLITE_SELECTOR = 1_000_000;
    bytes32 internal constant CROSS_CHAIN_ADAPTER_ID = keccak256("ufarm.adapter.cross-chain");

    MockCCIPRouter internal router;
    MockERC20 internal crossChainToken;
    MockERC20 internal feeToken;
    CrossChainAdapter internal crossChainAdapter;
    CrossChainVaultHandler internal handler;

    function setUp() external {
        vm.chainId(ACCOUNTING_CHAIN_ID);
        _setUpInvariantFixture();

        router = new MockCCIPRouter();
        crossChainToken = new MockERC20("CrossChain Token", "CCT", 18);
        feeToken = new MockERC20("CCIP Fee Token", "CFT", 18);
        crossChainAdapter = new CrossChainAdapter();

        core.initializeCrossChain(ACCOUNTING_CHAIN_ID);
        core.setCrossChainRouter(address(router));
        core.setCrossChainFeeToken(address(feeToken));
        core.setCrossChainToken(address(crossChainToken));
        core.setCrossChainGasLimit(500_000);
        core.setCCIPSelector(ACCOUNTING_CHAIN_ID, ACCOUNTING_SELECTOR);
        core.setCCIPSelector(SATELLITE_CHAIN_ID, SATELLITE_SELECTOR);
        core.setCCIPSelector(OTHER_SATELLITE_CHAIN_ID, OTHER_SATELLITE_SELECTOR);
        core.setVaultAdapter(CROSS_CHAIN_ADAPTER_ID, address(0), address(crossChainAdapter));

        crossChainToken.mint(address(vault), 1_000_000 ether);
        feeToken.mint(address(vault), 100_000 ether);

        handler = new CrossChainVaultHandler(
            core,
            vault,
            router,
            crossChainToken,
            feeToken,
            ACCOUNTING_CHAIN_ID,
            SATELLITE_CHAIN_ID,
            SATELLITE_SELECTOR,
            OTHER_SATELLITE_CHAIN_ID,
            OTHER_SATELLITE_SELECTOR
        );
        vault.setPermissionMask(address(handler), type(uint256).max);

        targetContract(address(handler));
    }

    function invariant_crossChainVaultSessionShape() external view {
        _assertTrue(!handler.unexpectedSessionState(), "cross-chain session state escaped enum");
        _assertTrue(!handler.unexpectedSettlementGate(), "unexpected settlement gate");
    }

    function invariant_crossChainTransitionModel() external view {
        _assertTrue(!handler.unexpectedTransitionResult(), "unexpected transition success or revert");
        _assertTrue(!handler.unexpectedTransitionMutation(), "unexpected transition mutation");
        _assertTrue(!handler.unexpectedNonceProgression(), "unexpected nonce progression");
    }

    function invariant_crossChainDispatchModel() external view {
        _assertTrue(!handler.unexpectedDispatchResult(), "unexpected dispatch result");
        _assertTrue(!handler.unexpectedDispatchPayload(), "unexpected dispatch payload");
    }

    function invariant_crossChainTokenAccounting() external view {
        _assertTrue(!handler.unexpectedTokenSupply(), "cross-chain token supply drift");
        _assertTrue(!handler.unexpectedRouterAllowance(), "router allowance leaked");
    }

    function invariant_crossChainConfigurationStable() external view {
        _assertEq(core.accountingChainId(), ACCOUNTING_CHAIN_ID, "accounting chain changed");
        _assertEq(core.crossChainRouter(), address(router), "router changed");
        _assertEq(core.crossChainFeeToken(), address(feeToken), "fee token changed");
        _assertEq(core.crossChainToken(), address(crossChainToken), "cross-chain token changed");
        _assertEq(
            core.adapterForVault(CROSS_CHAIN_ADAPTER_ID, address(vault)), address(crossChainAdapter), "adapter changed"
        );
    }
}
