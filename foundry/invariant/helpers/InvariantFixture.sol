// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {Permissions} from "../../../contracts/libraries/Permissions.sol";
import {UFarmCore} from "../../../contracts/core/UFarmCore.sol";
import {UFarmEscrow} from "../../../contracts/escrow/UFarmEscrow.sol";
import {UFarmCurator} from "../../../contracts/curator/UFarmCurator.sol";
import {UFarmVault} from "../../../contracts/vault/UFarmVault.sol";
import {VaultAdapterGatewayModule} from "../../../contracts/vault/modules/VaultAdapterGatewayModule.sol";
import {VaultAdminConfigModule} from "../../../contracts/vault/modules/VaultAdminConfigModule.sol";
import {VaultLifecycleModule} from "../../../contracts/vault/modules/VaultLifecycleModule.sol";
import {MockCreateX} from "../../../contracts/mocks/MockCreateX.sol";
import {MockChainlinkAggregator} from "../../../contracts/mocks/MockChainlinkAggregator.sol";
import {MockERC20} from "../../../contracts/mocks/MockERC20.sol";
import {MockUFarmOracle} from "../../../contracts/mocks/MockUFarmOracle.sol";
import {MockVaultAdapter} from "../../../contracts/mocks/MockVaultAdapter.sol";
import {InvariantVm} from "./InvariantVm.sol";

abstract contract InvariantFixture is InvariantVm {
    UFarmCore internal core;
    UFarmEscrow internal escrow;
    UFarmCurator internal curator;
    UFarmVault internal vault;
    MockCreateX internal createX;
    MockERC20 internal asset;
    MockERC20 internal customAsset;
    MockChainlinkAggregator internal assetFeed;
    MockChainlinkAggregator internal customAssetFeed;
    MockUFarmOracle internal oracle;
    MockVaultAdapter internal adapter;
    UpgradeableBeacon internal curatorBeacon;
    UpgradeableBeacon internal vaultBeacon;

    address internal alice;
    address internal bob;
    address internal carol;
    address[] internal invariantActors;

    bytes32 internal constant ADAPTER_ID = keccak256("ufarm.adapter.arbitrary");
    bytes32 internal constant ADAPTER_GATEWAY_MODULE_ID = keccak256("ufarm.vault.module.adapter-gateway");
    bytes32 internal constant ADMIN_CONFIG_MODULE_ID = keccak256("ufarm.vault.module.admin-config");
    bytes32 internal constant LIFECYCLE_MODULE_ID = keccak256("ufarm.vault.module.lifecycle");

    function _setUpInvariantFixture() internal {
        UFarmCore coreImpl = new UFarmCore();
        bytes memory coreInitData = abi.encodeCall(UFarmCore.initialize, (address(this)));
        core = UFarmCore(address(new ERC1967Proxy(address(coreImpl), coreInitData)));

        UFarmEscrow escrowImpl = new UFarmEscrow();
        bytes memory escrowInitData = abi.encodeCall(UFarmEscrow.initialize, (address(core)));
        escrow = UFarmEscrow(address(new ERC1967Proxy(address(escrowImpl), escrowInitData)));

        createX = new MockCreateX();
        UFarmCurator curatorImpl = new UFarmCurator();
        UFarmVault vaultImpl = new UFarmVault();
        curatorBeacon = new UpgradeableBeacon(address(curatorImpl), address(this));
        vaultBeacon = new UpgradeableBeacon(address(vaultImpl), address(this));

        core.initializeFactory(address(escrow), address(createX), address(curatorBeacon), address(vaultBeacon));
        core.setVaultModule(ADAPTER_GATEWAY_MODULE_ID, address(new VaultAdapterGatewayModule()));
        core.setVaultModule(ADMIN_CONFIG_MODULE_ID, address(new VaultAdminConfigModule()));
        core.setVaultModule(LIFECYCLE_MODULE_ID, address(new VaultLifecycleModule()));

        asset = new MockERC20("Asset", "AST", 18);
        customAsset = new MockERC20("CustomAsset", "CST", 6);
        assetFeed = new MockChainlinkAggregator(8, 1e8);
        customAssetFeed = new MockChainlinkAggregator(8, 1e8);
        oracle = new MockUFarmOracle();
        adapter = new MockVaultAdapter(ADAPTER_ID);

        core.setValueTokenConfig(address(asset), address(assetFeed), 1 days, 0.95e18, 1.05e18);
        core.setValueTokenConfig(address(customAsset), address(customAssetFeed), 1 days, 0.95e18, 1.05e18);
        core.setVaultOracle(address(0), address(oracle));
        core.setVaultAdapter(ADAPTER_ID, address(0), address(adapter));
        core.setOracleRequestTimeout(1 days);
        core.setNavRequestCooldown(1 hours);

        address curatorAddress = core.createCurator(address(this), bytes32("curator-smoke"));
        curator = UFarmCurator(curatorAddress);

        address vaultAddress =
            curator.createVault(bytes32("vault-smoke"), address(this), "UFarm Invariant Vault", "UIV", address(asset));
        vault = UFarmVault(payable(vaultAddress));

        uint256 vaultMask = Permissions.OWNER | Permissions.ADMIN | Permissions.VAULT_ASSET_MANAGER
            | Permissions.VAULT_SETTLE_MANAGER | Permissions.VAULT_CONFIG_MANAGER | Permissions.VAULT_CUSTOMER_MANAGER;
        vault.setPermissionMask(address(this), vaultMask);

        for (uint256 i = 0; i < 12; i += 1) {
            address actor = address(uint160(0xA1100 + i));
            invariantActors.push(actor);
            _fundAndApprove(actor);
        }

        alice = invariantActors[0];
        bob = invariantActors[1];
        carol = invariantActors[2];
    }

    function _fundAndApprove(address actor) private {
        asset.mint(actor, 1_000_000 ether);
        customAsset.mint(actor, 1_000_000 * 1e6);
        vm.startPrank(actor);
        asset.approve(address(escrow), type(uint256).max);
        customAsset.approve(address(escrow), type(uint256).max);
        vm.stopPrank();
    }
}
