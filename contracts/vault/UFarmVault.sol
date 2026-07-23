// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CCIPClient} from "../interfaces/ccip/ICCIPRouter.sol";
import {IUFarmCore} from "../interfaces/IUFarmCore.sol";
import {IUFarmVault} from "../interfaces/IUFarmVault.sol";
import {IUFarmVaultRequests} from "../interfaces/IUFarmVaultRequests.sol";
import {CrossChainStorage} from "../libraries/CrossChainStorage.sol";
import {CrossChainTypes} from "../libraries/CrossChainTypes.sol";
import {ErrorCodes} from "../libraries/ErrorCodes.sol";
import {Permissions} from "../libraries/Permissions.sol";
import {PauseMask} from "../libraries/PauseMask.sol";
import {VaultBaseStorage} from "../libraries/VaultBaseStorage.sol";
import {VaultConfigStorage} from "../libraries/VaultConfigStorage.sol";
import {VaultGuards} from "../libraries/VaultGuards.sol";
import {VaultLifecycleStorage} from "../libraries/VaultLifecycleStorage.sol";
import {VaultModuleIds} from "../libraries/VaultModuleIds.sol";
import {VaultPermissionStorage} from "../libraries/VaultPermissionStorage.sol";
import {VaultTypes} from "../libraries/VaultTypes.sol";
import {IUFarmVaultErrors} from "./UFarmVaultErrors.sol";
import {IUFarmVaultBaseEvents, IUFarmVaultOracleEvents} from "./UFarmVaultEvents.sol";

contract UFarmVault is Initializable, EIP712Upgradeable, IUFarmVault {
    uint256 private constant WAD = 1e18;
    bytes32 private constant SET_OPERATOR_TYPEHASH =
        keccak256("SetOperator(address owner,address operator,bool approved,uint256 nonce,uint256 deadline)");
    bytes4 private constant ERC165_INTERFACE_ID = 0x01ffc9a7;
    bytes4 private constant ERC7540_OPERATOR_INTERFACE_ID = 0xe3bc4e65;
    bytes4 private constant ERC7575_INTERFACE_ID = 0xa8d5fd65;
    bytes4 private constant ERC7540_ASYNC_DEPOSIT_INTERFACE_ID = 0x14020db7;
    bytes4 private constant ERC7540_ASYNC_REDEEM_INTERFACE_ID = 0xd8069eb6;
    bytes4 private constant CCIP_RECEIVER_INTERFACE_ID = 0x85572ffb;
    bytes4 private constant ERC1271_INVALID_SIGNATURE = 0xffffffff;
    uint256 internal constant OWNER = Permissions.OWNER;
    uint256 internal constant ADMIN = Permissions.ADMIN;
    uint256 internal constant MEMBER = Permissions.MEMBER;
    uint256 internal constant CORE_PRICE_GUARD_MANAGER = Permissions.CORE_PRICE_GUARD_MANAGER;
    uint256 internal constant VAULT_ASSET_MANAGER = Permissions.VAULT_ASSET_MANAGER;

    constructor() {
        _disableInitializers();
    }

    // --- Initialization ---

    /// @notice Initializes a new vault proxy.
    /// @dev Sets the immutable-like vault metadata, accounting asset, and initial owner permissions.
    /// @param core_ Address of the UFarm core contract.
    /// @param curator_ Address of the curator that owns this vault.
    /// @param owner_ Address that receives the initial full vault permission mask.
    /// @param vaultSalt_ Salt used to derive and identify this vault.
    /// @param name_ ERC-20 share token name.
    /// @param symbol_ ERC-20 share token symbol.
    /// @param asset_ Default value token used for public deposit requests.
    function initialize(
        address core_,
        address curator_,
        address owner_,
        bytes32 vaultSalt_,
        string calldata name_,
        string calldata symbol_,
        address asset_
    ) external initializer {
        if (core_ == address(0) || curator_ == address(0) || owner_ == address(0) || asset_ == address(0)) {
            revert IUFarmVaultErrors.InvalidAddress();
        }
        if (bytes(name_).length == 0 || bytes(symbol_).length == 0) revert IUFarmVaultErrors.InvalidMetadata();
        if (IUFarmCore(core_).valueTokenToUsd(asset_, WAD) == 0) revert IUFarmVaultErrors.InvalidAsset();
        __EIP712_init("UFarmVault", "2");
        VaultBaseStorage.Layout storage base = VaultBaseStorage.data();
        base.core = core_;
        base.curator = curator_;
        base.vaultSalt = vaultSalt_;
        base.name = name_;
        base.symbol = symbol_;
        base.asset = asset_;
        VaultConfigStorage.data().maxDeposit = type(uint256).max;
        VaultConfigStorage.data().status = VaultTypes.VaultStatus.Active;
        VaultPermissionStorage.data().permissions[owner_] = type(uint256).max;
        emit IUFarmVaultBaseEvents.VaultPermissionUpdated(owner_, type(uint256).max);
    }

    // --- IUFarmVaultBase: Core Identity and Metadata ---

    /// @notice Reports whether the vault supports an interface.
    /// @dev Covers ERC-165, ERC-7540, ERC-7575, and CCIP receiver interfaces.
    /// @param interfaceId Interface id to check.
    /// @return True when the interface is supported.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == ERC165_INTERFACE_ID || interfaceId == ERC7540_OPERATOR_INTERFACE_ID
            || interfaceId == ERC7575_INTERFACE_ID || interfaceId == ERC7540_ASYNC_DEPOSIT_INTERFACE_ID
            || interfaceId == ERC7540_ASYNC_REDEEM_INTERFACE_ID || interfaceId == CCIP_RECEIVER_INTERFACE_ID;
    }

    /// @notice Returns the current irreversible vault lifecycle status.
    /// @return Current vault status.
    function status() external view returns (VaultTypes.VaultStatus) {
        return VaultConfigStorage.data().status;
    }

    /// @notice Irreversibly terminates the vault and prevents further deposit ingestion.
    /// @dev Delegates to the admin config module. Redeem flows and deposit exits remain available.
    function terminate() external {
        _delegateToVaultModule(VaultModuleIds.ADMIN_CONFIG);
    }

    /// @notice Returns the UFarm core contract address.
    /// @return Core contract address.
    function core() external view returns (address) {
        return VaultBaseStorage.data().core;
    }

    /// @notice Returns the curator that owns this vault.
    /// @return Curator contract address.
    function curator() external view returns (address) {
        return VaultBaseStorage.data().curator;
    }

    /// @notice Returns the vault salt used during deterministic deployment.
    /// @return Vault deployment salt.
    function vaultSalt() external view returns (bytes32) {
        return VaultBaseStorage.data().vaultSalt;
    }

    /// @notice Returns the escrow contract used by the vault.
    /// @return Escrow contract address from the core.
    function escrow() external view returns (address) {
        return IUFarmCore(VaultBaseStorage.data().core).escrow();
    }

    /// @notice Returns the default value token for the vault.
    /// @return Default asset address.
    function asset() external view returns (address) {
        return VaultBaseStorage.data().asset;
    }

    /// @notice Returns the share token address.
    /// @dev The vault itself is the share token.
    /// @return Vault share token address.
    function share() external view returns (address) {
        return address(this);
    }

    /// @notice Returns the share token name.
    /// @return ERC-20 share token name.
    function name() external view returns (string memory) {
        return VaultBaseStorage.data().name;
    }

    /// @notice Returns the share token symbol.
    /// @return ERC-20 share token symbol.
    function symbol() external view returns (string memory) {
        return VaultBaseStorage.data().symbol;
    }

    /// @notice Returns the share token decimals.
    /// @return Number of decimals used by vault shares.
    function decimals() external pure returns (uint8) {
        return 18;
    }

    // --- IUFarmVaultBase: ERC-20 Views and Disabled Transfers ---

    /// @notice Returns the total issued vault shares.
    /// @return Total share supply.
    function totalSupply() external view returns (uint256) {
        return VaultBaseStorage.data().totalSupply;
    }

    /// @notice Returns a holder's share balance.
    /// @param account Address to inspect.
    /// @return Share balance of the account.
    function balanceOf(address account) external view returns (uint256) {
        return VaultBaseStorage.data().balances[account];
    }

    /// @notice Returns the share allowance from one account to another.
    /// @param owner Address that granted the allowance.
    /// @param spender Address that may spend the allowance.
    /// @return Remaining share allowance.
    function allowance(address owner, address spender) external view returns (uint256) {
        return VaultBaseStorage.data().allowances[owner][spender];
    }

    /// @notice Transfers vault shares to another address.
    /// @param to Address that receives the shares.
    /// @param amount Number of shares to transfer.
    /// @return True when the transfer succeeds.
    function transfer(address to, uint256 amount) external returns (bool) {
        _transferShares(msg.sender, to, amount);
        return true;
    }

    /// @notice Approves another address to spend vault shares.
    /// @param spender Address that may spend the caller's shares.
    /// @param amount Number of shares to approve.
    /// @return True when the approval succeeds.
    function approve(address spender, uint256 amount) external returns (bool) {
        _approveShares(msg.sender, spender, amount);
        return true;
    }

    /// @notice Transfers shares using an allowance.
    /// @param from Address whose shares are transferred.
    /// @param to Address that receives the shares.
    /// @param amount Number of shares to transfer.
    /// @return True when the transfer succeeds.
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 currentAllowance = VaultBaseStorage.data().allowances[from][msg.sender];
        if (currentAllowance != type(uint256).max) {
            if (currentAllowance < amount) revert IUFarmVaultErrors.InvalidAmount();
            unchecked {
                _approveShares(from, msg.sender, currentAllowance - amount);
            }
        }
        _transferShares(from, to, amount);
        return true;
    }

    // --- IUFarmVaultBase: Operators ---

    /// @notice Approves or revokes an operator for the caller.
    /// @param operator Address to approve or revoke.
    /// @param approved True to approve the operator, false to revoke it.
    /// @return True when the operator setting is updated.
    function setOperator(address operator, bool approved) external returns (bool) {
        if (operator == address(0)) revert IUFarmVaultErrors.InvalidAddress();
        VaultPermissionStorage.data().operatorStates[msg.sender].approvals[operator] = approved;
        emit IUFarmVaultBaseEvents.OperatorSet(msg.sender, operator, approved);
        return true;
    }

    /// @notice Approves or revokes an operator using an EIP-712 signature.
    /// @param owner_ Address that signs the operator approval.
    /// @param operator Address to approve or revoke.
    /// @param approved True to approve the operator, false to revoke it.
    /// @param deadline Last timestamp when the signature is valid.
    /// @param nonce Expected owner operator nonce.
    /// @param signature Owner signature over the operator approval.
    /// @return True when the operator setting is updated.
    function setOperatorBySig(
        address owner_,
        address operator,
        bool approved,
        uint256 deadline,
        uint256 nonce,
        bytes calldata signature
    ) external returns (bool) {
        if (owner_ == address(0) || operator == address(0)) revert IUFarmVaultErrors.InvalidAddress();
        if (block.timestamp > deadline) revert IUFarmVaultErrors.InvalidSignature();
        VaultTypes.OperatorState storage state = VaultPermissionStorage.data().operatorStates[owner_];
        if (state.nonce != nonce) revert IUFarmVaultErrors.InvalidSignature();

        bytes32 structHash = keccak256(abi.encode(SET_OPERATOR_TYPEHASH, owner_, operator, approved, nonce, deadline));
        bytes32 digest = _hashTypedDataV4(structHash);
        // slither-disable-next-line unused-return
        (address recovered, ECDSA.RecoverError recoverError,) = ECDSA.tryRecover(digest, signature);
        if (recoverError != ECDSA.RecoverError.NoError || recovered != owner_) {
            revert IUFarmVaultErrors.InvalidSignature();
        }

        state.nonce = nonce + 1;
        state.approvals[operator] = approved;
        emit IUFarmVaultBaseEvents.OperatorSet(owner_, operator, approved);
        return true;
    }

    /// @notice Checks whether an operator is approved for an owner.
    /// @param owner_ Address that owns the request or shares.
    /// @param operator Address to check.
    /// @return True when the operator is approved.
    function isOperator(address owner_, address operator) external view returns (bool) {
        return VaultPermissionStorage.data().operatorStates[owner_].approvals[operator];
    }

    /// @notice Returns the EIP-712 operator nonce for an owner.
    /// @param owner_ Address to inspect.
    /// @return Current operator nonce.
    function nonces(address owner_) external view returns (uint256) {
        return VaultPermissionStorage.data().operatorStates[owner_].nonce;
    }

    /// @notice Returns the signed request nonce for an owner.
    /// @param owner_ Address to inspect.
    /// @return Current signed request nonce.
    function requestNonces(address owner_) external view returns (uint256) {
        return VaultPermissionStorage.data().operatorStates[owner_].requestNonce;
    }

    // --- IUFarmPermissions and IUFarmVaultAdmin ---

    /// @notice Sets a vault permission mask for an account.
    /// @dev Permission changes are applied in one transaction. Granting or revoking OWNER is not a two-step transfer, so
    ///      operators should use controlled addresses such as multisigs or timelocks and verify recipients before changing
    ///      ownership permissions.
    /// @param account Address whose permissions are updated.
    /// @param newMask New permission bit mask.
    function setPermissionMask(address account, uint256 newMask) external {
        if (account == address(0)) revert IUFarmVaultErrors.InvalidAddress();
        uint256 previous = VaultPermissionStorage.data().permissions[account];
        _checkCanSetPermissionMask(previous, newMask);
        VaultPermissionStorage.data().permissions[account] = newMask;
        emit IUFarmVaultBaseEvents.VaultPermissionUpdated(account, newMask);
    }

    /// @notice Updates vault fee configuration.
    /// @dev Delegates to the admin config module.
    /// @param managementFee New annual management fee in WAD units.
    /// @param performanceFeeSchedule Packed performance fee schedule.
    function setFees(uint256 managementFee, uint256 performanceFeeSchedule) external {
        _delegateToVaultModule(VaultModuleIds.ADMIN_CONFIG);
    }

    /// @notice Updates the public deposit investment range.
    /// @dev Delegates to the admin config module.
    /// @param minDeposit Minimum allowed public deposit value in USD WAD.
    /// @param maxDeposit Maximum allowed public deposit value in USD WAD.
    function setInvestmentRange(uint256 minDeposit, uint256 maxDeposit) external {
        _delegateToVaultModule(VaultModuleIds.ADMIN_CONFIG);
    }

    /// @notice Sets the client tier required for custom deposit requests.
    /// @dev Delegates to the admin config module.
    /// @param newTier New required client tier. Zero disables tier checks.
    function setClientTier(uint8 newTier) external {
        _delegateToVaultModule(VaultModuleIds.ADMIN_CONFIG);
    }

    /// @notice Returns the configured client tier requirement.
    /// @return Current required client tier.
    function clientTier() external view returns (uint8) {
        return VaultConfigStorage.data().clientTier;
    }

    /// @notice Enables or disables direct ERC-20 share transfers.
    /// @dev Delegates to the admin config module.
    function setTransferRestricted(bool restricted) external {
        _delegateToVaultModule(VaultModuleIds.ADMIN_CONFIG);
    }

    /// @notice Returns whether direct ERC-20 share transfers are restricted.
    function transferRestricted() external view returns (bool) {
        return VaultConfigStorage.data().transferRestricted;
    }

    /// @notice Returns an account's vault permission mask.
    /// @param account Address to inspect.
    /// @return Current permission bit mask.
    function permissionMask(address account) external view returns (uint256) {
        return VaultPermissionStorage.data().permissions[account];
    }

    /// @notice Checks whether an account has all required permissions.
    /// @param account Address to inspect.
    /// @param requiredMask Permission bits that must all be present.
    /// @return True when the account has every required permission.
    function accountHasPermission(address account, uint256 requiredMask) external view returns (bool) {
        return Permissions.hasAll(VaultPermissionStorage.data().permissions[account], requiredMask);
    }

    /// @notice Checks whether an account has any required permission.
    /// @param account Address to inspect.
    /// @param requiredMask Permission bits where at least one must be present.
    /// @return True when the account has at least one required permission.
    function accountHasAnyPermission(address account, uint256 requiredMask) external view returns (bool) {
        return Permissions.hasAny(VaultPermissionStorage.data().permissions[account], requiredMask);
    }

    // --- IUFarmVaultRequests: Deposits and Redeems ---

    /// @notice Opens a pending deposit request for the default asset.
    /// @dev Delegates to the lifecycle module.
    /// @param assets Amount of the default asset to deposit.
    /// @param controller Address that controls the request. Must equal the owner.
    /// @param owner_ Address that owns the request and funds it.
    /// @return Request id. UFarm uses request id zero for the active request bucket.
    function requestDeposit(uint256 assets, address controller, address owner_) external returns (uint256) {
        return abi.decode(_delegateToVaultModule(VaultModuleIds.LIFECYCLE), (uint256));
    }

    /// @notice Opens a pending custom-asset deposit request.
    /// @dev Delegates to the lifecycle module and validates client verification there. Client verification is a reusable
    ///      time-bounded credential, not a one-time authorization, and cannot be selectively revoked on-chain before
    ///      validTill unless the required tier or signer permissions are changed.
    /// @param asset_ Asset to deposit.
    /// @param assets Amount of the asset to deposit.
    /// @param controller Address that controls the request. Must equal the owner.
    /// @param owner_ Address that owns the request and funds it.
    /// @param verification Signed client tier verification data.
    /// @return Request id. UFarm uses request id zero for the active request bucket.
    function requestDeposit(
        address asset_,
        uint256 assets,
        address controller,
        address owner_,
        IUFarmVaultRequests.ClientVerification calldata verification
    ) external returns (uint256) {
        return abi.decode(_delegateToVaultModule(VaultModuleIds.LIFECYCLE), (uint256));
    }

    /// @notice Claims a settled deposit request as shares.
    /// @dev Delegates to the lifecycle module.
    /// @param assets Unused ERC-7540 compatibility argument.
    /// @param receiver Address that receives the shares. Must equal controller.
    /// @param controller Address whose claimable deposit is claimed.
    /// @return Number of shares minted to the receiver.
    function deposit(uint256 assets, address receiver, address controller) external returns (uint256) {
        return abi.decode(_delegateToVaultModule(VaultModuleIds.LIFECYCLE), (uint256));
    }

    /// @notice Opens a pending redeem request.
    /// @dev Delegates to the lifecycle module.
    /// @param shares Number of shares to redeem.
    /// @param controller Address that controls the request. Must equal the owner.
    /// @param owner_ Address that owns the shares.
    /// @return Request id. UFarm uses request id zero for the active request bucket.
    function requestRedeem(uint256 shares, address controller, address owner_) external returns (uint256) {
        return abi.decode(_delegateToVaultModule(VaultModuleIds.LIFECYCLE), (uint256));
    }

    /// @notice Claims a settled redeem request as assets.
    /// @dev Delegates to the lifecycle module.
    /// @param shares Unused ERC-7540 compatibility argument.
    /// @param receiver Address that receives the assets.
    /// @param controller Address whose claimable redeem is claimed.
    /// @return Number of assets released or made withdrawable.
    function redeem(uint256 shares, address receiver, address controller) external returns (uint256) {
        return abi.decode(_delegateToVaultModule(VaultModuleIds.LIFECYCLE), (uint256));
    }

    /// @notice Cancels an active pending deposit.
    /// @dev Delegates to the lifecycle module. Cancellation releases the pending request state but may leave unlocked
    ///      assets in escrow for the owner to withdraw. Owners should withdraw unlocked escrow balances before opening a
    ///      new deposit for the same vault and asset, otherwise the new deposit lock can apply to the combined balance.
    /// @param owner_ Owner whose pending deposit is cancelled.
    /// @return assets Amount returned from escrow.
    function cancelDeposit(address owner_) external returns (uint256 assets) {
        return abi.decode(_delegateToVaultModule(VaultModuleIds.LIFECYCLE), (uint256));
    }

    /// @notice Cancels an active pending redeem.
    /// @dev Delegates to the lifecycle module.
    /// @param owner_ Owner whose pending redeem is cancelled.
    /// @return Number of shares returned to the owner.
    function cancelRedeem(address owner_) external returns (uint256) {
        return abi.decode(_delegateToVaultModule(VaultModuleIds.LIFECYCLE), (uint256));
    }

    // --- IUFarmVaultOracle ---

    /// @notice Starts oracle settlement and fee accrual for the vault.
    /// @dev Delegates to the lifecycle module and asks the configured oracle for NAV. This permissioned overload may be
    ///      called even when no user requests are queued, allowing operational NAV updates and fee accrual.
    /// @return Oracle request id created for this settlement.
    function settleRequests() external returns (uint256) {
        return abi.decode(_delegateToVaultModule(VaultModuleIds.LIFECYCLE), (uint256));
    }

    /// @notice Adds signed deposit and redeem requests, then starts settlement.
    /// @dev Delegates to the lifecycle module. Invalid signed requests are skipped by the module.
    /// @param deposits Signed deposit requests to add before settlement.
    /// @param redeems Signed redeem requests to add before settlement.
    /// @return Oracle request id created for this settlement.
    function settleRequests(
        IUFarmVaultRequests.SignedRequest[] calldata deposits,
        IUFarmVaultRequests.SignedRequest[] calldata redeems
    ) external returns (uint256) {
        return abi.decode(_delegateToVaultModule(VaultModuleIds.LIFECYCLE), (uint256));
    }

    /// @notice Receives NAV data from the active oracle request.
    /// @dev Delegates to the lifecycle module, which validates the oracle and settles requests.
    /// @param oracleRequestId Oracle request id being answered.
    /// @param nav Reported vault net asset value.
    /// @param valuationTimestamp Timestamp of the NAV valuation.
    function onOracleNav(uint256 oracleRequestId, uint256 nav, uint64 valuationTimestamp) external {
        _delegateToVaultModule(VaultModuleIds.LIFECYCLE);
    }

    /// @notice Resets a timed-out oracle settlement request.
    /// @dev Delegates to the lifecycle module and cancels pending request queues.
    function resetRequests() external {
        _delegateToVaultModule(VaultModuleIds.LIFECYCLE);
    }

    /// @notice Sends a new oracle request after the active request times out.
    /// @dev Delegates to the lifecycle module and preserves pending request queues.
    /// @return newOracleRequestId New oracle request id.
    function manualResendOracleRequest() external returns (uint256 newOracleRequestId) {
        return abi.decode(_delegateToVaultModule(VaultModuleIds.LIFECYCLE), (uint256));
    }

    /// @notice Clears the invalid price latch and accepts a reviewed NAV as the new reference price.
    /// @dev Requires core price guard manager permission.
    /// @param acceptedNav Reviewed total vault NAV in USD WAD.
    function resetInvalidPrice(uint256 acceptedNav) external {
        _checkCorePriceGuardManager();
        VaultLifecycleStorage.Layout storage lifecycle = VaultLifecycleStorage.data();
        if (!lifecycle.isInvalidPrice) revert IUFarmVaultErrors.OracleFlowError(ErrorCodes.ORACLE_INVALID_PRICE);

        uint256 supply = VaultBaseStorage.data().totalSupply;
        if (acceptedNav == 0 || supply == 0) revert IUFarmVaultErrors.InvalidAmount();

        lifecycle.lastTokenPrice = Math.mulDiv(acceptedNav, WAD, supply);
        lifecycle.isInvalidPrice = false;
        emit IUFarmVaultOracleEvents.InvalidPriceReset();
    }

    // --- IUFarmVaultAdapters ---

    /// @notice Executes a configured vault adapter.
    /// @dev Delegates to the adapter gateway module.
    /// @param adapterId Identifier of the adapter to execute.
    /// @param data Calldata passed to the adapter by delegatecall.
    function executeAdapter(bytes32 adapterId, bytes calldata data) external {
        _delegateToVaultModule(VaultModuleIds.ADAPTER_GATEWAY);
    }

    /// @notice Receives a Chainlink CCIP message.
    /// @dev Delegates to the adapter gateway module, which checks the configured router.
    /// @param message CCIP message delivered by the router.
    function ccipReceive(CCIPClient.Any2EVMMessage calldata message) external {
        _delegateToVaultModule(VaultModuleIds.ADAPTER_GATEWAY);
    }

    // --- IUFarmVaultSignatures ---

    /// @notice Signs an adapter-authorized message for ERC-1271 validation.
    /// @dev Delegates to the adapter gateway module and stores the authorized digest.
    /// @param dapp Dapp identifier used by the arbitrary adapter guard.
    /// @param message Encoded message checked by the arbitrary adapter guard.
    function signMessage(bytes32 dapp, bytes calldata message) external {
        _delegateToVaultModule(VaultModuleIds.ADAPTER_GATEWAY);
    }

    /// @notice Checks whether a digest has been signed through the vault.
    /// @param digest Digest to check.
    /// @return True when the digest is currently approved.
    function signedMessages(bytes32 digest) external view returns (bool) {
        return VaultPermissionStorage.data().signedMessages[digest];
    }

    /// @notice Revokes a digest signed through the vault.
    /// @dev Delegates to the adapter gateway module.
    /// @param digest Digest to revoke.
    function revokeSignedMessage(bytes32 digest) external {
        _delegateToVaultModule(VaultModuleIds.ADAPTER_GATEWAY);
    }

    /// @notice Validates an ERC-1271 signature for a digest signed by the vault.
    /// @dev Returns the ERC-1271 failure value while adapter execution is paused or an oracle request is active, even for
    ///      a digest previously authorized through signMessage. Integrations should retry after the blocked flow clears.
    /// @param hash Digest being validated.
    /// @param signature ECDSA signature from a current asset manager.
    /// @return magicValue ERC-1271 magic value for a valid signature, or failure value.
    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4 magicValue) {
        if (VaultGuards.isPaused(PauseMask.ADAPTER_EXECUTION_PAUSED)) return ERC1271_INVALID_SIGNATURE;
        if (VaultLifecycleStorage.data().activeOracleRequest.requestId != 0) return ERC1271_INVALID_SIGNATURE;
        if (!VaultPermissionStorage.data().signedMessages[hash]) return ERC1271_INVALID_SIGNATURE;

        // slither-disable-next-line unused-return
        (address signer, ECDSA.RecoverError recoverError,) = ECDSA.tryRecover(hash, signature);
        if (recoverError != ECDSA.RecoverError.NoError) return ERC1271_INVALID_SIGNATURE;
        if (!_hasPermission(signer, MEMBER | VAULT_ASSET_MANAGER)) return ERC1271_INVALID_SIGNATURE;

        return IERC1271.isValidSignature.selector;
    }

    // --- Request Views ---

    // UFarm keeps ERC-7540 controller and owner equal by design, so controller indexes the owner request bucket.
    /// @notice Returns the active pending deposit amount for a controller.
    /// @param requestId ERC-7540 request id. UFarm only uses request id zero.
    /// @param controller Address whose pending deposit bucket is read.
    /// @return assets Pending deposit asset amount.
    function pendingDepositRequest(uint256 requestId, address controller) external view returns (uint256 assets) {
        return VaultLifecycleStorage.data().requestStates[controller].pendingDeposit.amount;
    }

    /// @notice Returns the active pending redeem amount for a controller.
    /// @param requestId ERC-7540 request id. UFarm only uses request id zero.
    /// @param controller Address whose pending redeem bucket is read.
    /// @return shares Pending redeem share amount.
    function pendingRedeemRequest(uint256 requestId, address controller) external view returns (uint256 shares) {
        return VaultLifecycleStorage.data().requestStates[controller].pendingRedeem.amount;
    }

    /// @notice Returns the settled deposit assets claimable by a controller.
    /// @param requestId ERC-7540 request id. UFarm only uses request id zero.
    /// @param controller Address whose claimable deposit bucket is read.
    /// @return Claimable deposit asset amount.
    function claimableDepositRequest(uint256 requestId, address controller) external view returns (uint256) {
        return VaultLifecycleStorage.data().requestStates[controller].claimableDeposit.assets;
    }

    /// @notice Returns the settled redeem shares claimable by a controller.
    /// @param requestId ERC-7540 request id. UFarm only uses request id zero.
    /// @param controller Address whose claimable redeem bucket is read.
    /// @return Claimable redeem share amount.
    function claimableRedeemRequest(uint256 requestId, address controller) external view returns (uint256) {
        return VaultLifecycleStorage.data().requestStates[controller].claimableRedeem.shares;
    }

    /// @notice Returns the active oracle request id.
    /// @return Current oracle request id, or zero when no request is active.
    function activeOracleRequestId() external view returns (uint256) {
        return VaultLifecycleStorage.data().activeOracleRequest.requestId;
    }

    /// @notice Returns the timestamp when settlement is allowed again.
    /// @return Timestamp when settlement can run, or max uint while hard-locked.
    function settlementAllowedAt() external view override returns (uint256) {
        return VaultLifecycleStorage.data().settlementAllowedAt;
    }

    /// @notice Returns the last accepted value token price.
    /// @return Last token price in WAD units.
    function lastTokenPrice() external view returns (uint256) {
        return VaultLifecycleStorage.data().lastTokenPrice;
    }

    /// @notice Returns whether the invalid price guard is latched.
    /// @return True when settlement is blocked by invalid price movement.
    function isInvalidPrice() external view returns (bool) {
        return VaultLifecycleStorage.data().isInvalidPrice;
    }

    /// @notice Returns the current cross-chain session state and outbox presence.
    /// @return state Current cross-chain session state enum value.
    /// @return outboxExists True when a cross-chain message remains queued for dispatch.
    function crossChainState() external view returns (CrossChainTypes.CrossChainSessionState state, bool outboxExists) {
        CrossChainTypes.CrossChainState storage crossChain = CrossChainStorage.state();
        return (crossChain.state, crossChain.outbox.exists);
    }

    /// @notice Returns configured vault fees.
    /// @return managementFee Annual management fee in WAD units.
    /// @return performanceFeeSchedule Packed performance fee schedule.
    function fees() external view returns (uint256 managementFee, uint256 performanceFeeSchedule) {
        return (VaultConfigStorage.data().managementFee, VaultConfigStorage.data().performanceFeeSchedule);
    }

    /// @notice Returns the public deposit investment range.
    /// @return minDeposit Minimum allowed public deposit value in USD WAD.
    /// @return maxDeposit Maximum allowed public deposit value in USD WAD.
    function investmentRange() external view returns (uint256 minDeposit, uint256 maxDeposit) {
        return (VaultConfigStorage.data().minDeposit, VaultConfigStorage.data().maxDeposit);
    }

    // --- Shared Guards and Lookups ---

    function _delegateToVaultModule(bytes32 moduleId) internal returns (bytes memory returnData) {
        address module = IUFarmCore(VaultBaseStorage.data().core).vaultModule(moduleId);
        if (module == address(0)) revert IUFarmVaultErrors.InvalidModule();

        // slither-disable-next-line controlled-delegatecall,low-level-calls
        (bool success, bytes memory result) = module.delegatecall(msg.data);
        if (!success) {
            // slither-disable-next-line assembly
            assembly ("memory-safe") {
                revert(add(result, 0x20), mload(result))
            }
        }
        return result;
    }

    function _hasPermission(address account, uint256 requiredMask) internal view returns (bool) {
        return Permissions.hasAll(VaultPermissionStorage.data().permissions[account], requiredMask);
    }

    function _checkCanSetPermissionMask(uint256 previousMask, uint256 newMask) internal view {
        if (_hasPermission(msg.sender, OWNER)) return;
        if (!_hasPermission(msg.sender, ADMIN)) revert IUFarmVaultErrors.Unauthorized(msg.sender);
        if (((previousMask ^ newMask) & OWNER) != 0) revert IUFarmVaultErrors.Unauthorized(msg.sender);
    }

    function _checkCorePriceGuardManager() internal view {
        if (!IUFarmCore(VaultBaseStorage.data().core)
                .accountHasPermission(msg.sender, MEMBER | CORE_PRICE_GUARD_MANAGER)) {
            revert IUFarmVaultErrors.Unauthorized(msg.sender);
        }
    }

    // --- Share Accounting Internals ---

    function _transferShares(address from, address to, uint256 shares) internal {
        if (VaultConfigStorage.data().transferRestricted) revert IUFarmVaultErrors.TransferDisabled();
        VaultGuards.checkNotPaused(PauseMask.SHARE_TRANSFERS_PAUSED);
        if (from == address(0) || to == address(0)) revert IUFarmVaultErrors.InvalidAddress();
        if (VaultBaseStorage.data().balances[from] < shares) revert IUFarmVaultErrors.InvalidAmount();
        _moveShares(from, to, shares);
    }

    function _approveShares(address owner_, address spender, uint256 amount) internal {
        VaultBaseStorage.data().allowances[owner_][spender] = amount;
        emit IUFarmVaultBaseEvents.Approval(owner_, spender, amount);
    }

    function _moveShares(address from, address to, uint256 shares) internal {
        VaultBaseStorage.Layout storage base = VaultBaseStorage.data();
        base.balances[from] -= shares;
        base.balances[to] += shares;
        emit IUFarmVaultBaseEvents.Transfer(from, to, shares);
    }

    receive() external payable {}
}
