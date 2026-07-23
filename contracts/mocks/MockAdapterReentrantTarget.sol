// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

contract MockAdapterReentrantTarget {
    event VaultCallResult(uint256 indexed index, bool success, bytes result);

    uint256 public callCount;
    uint256 public successCount;
    uint256 public failureCount;
    bool public lastSuccess;
    bytes public lastResult;

    function callVault(address vault, bytes calldata data) external returns (bool success, bytes memory result) {
        _clearLastResult();
        (success, result) = vault.call(data);
        _recordResult(0, success, result);
    }

    function callVaultSequence(address vault, bytes[] calldata calls) external returns (uint256 successes) {
        _clearLastResult();
        for (uint256 i = 0; i < calls.length; i += 1) {
            (bool success, bytes memory result) = vault.call(calls[i]);
            if (success) successes += 1;
            _recordResult(i, success, result);
        }
    }

    function callVaultPair(address vault, bytes calldata first, bytes calldata second)
        external
        returns (uint256 successes)
    {
        _clearLastResult();
        (bool firstSuccess, bytes memory firstResult) = vault.call(first);
        if (firstSuccess) successes += 1;
        _recordResult(0, firstSuccess, firstResult);

        (bool secondSuccess, bytes memory secondResult) = vault.call(second);
        if (secondSuccess) successes += 1;
        _recordResult(1, secondSuccess, secondResult);
    }

    function callVaultTriple(address vault, bytes calldata first, bytes calldata second, bytes calldata third)
        external
        returns (uint256 successes)
    {
        _clearLastResult();
        (bool firstSuccess, bytes memory firstResult) = vault.call(first);
        if (firstSuccess) successes += 1;
        _recordResult(0, firstSuccess, firstResult);

        (bool secondSuccess, bytes memory secondResult) = vault.call(second);
        if (secondSuccess) successes += 1;
        _recordResult(1, secondSuccess, secondResult);

        (bool thirdSuccess, bytes memory thirdResult) = vault.call(third);
        if (thirdSuccess) successes += 1;
        _recordResult(2, thirdSuccess, thirdResult);
    }

    function callClaims(address vault, address depositOwner, address redeemOwner) external returns (uint256 successes) {
        _clearLastResult();
        (bool depositSuccess, bytes memory depositResult) =
            vault.call(abi.encodeWithSignature("deposit(uint256,address,address)", 0, depositOwner, depositOwner));
        if (depositSuccess) successes += 1;
        _recordResult(0, depositSuccess, depositResult);

        (bool redeemSuccess, bytes memory redeemResult) =
            vault.call(abi.encodeWithSignature("redeem(uint256,address,address)", 0, redeemOwner, redeemOwner));
        if (redeemSuccess) successes += 1;
        _recordResult(1, redeemSuccess, redeemResult);
    }

    function callDepositSettleExecute(
        address vault,
        uint256 assets,
        address owner,
        bytes32 adapterId,
        bytes calldata adapterData
    ) external returns (uint256 successes) {
        _clearLastResult();
        (bool depositSuccess, bytes memory depositResult) =
            vault.call(abi.encodeWithSignature("requestDeposit(uint256,address,address)", assets, owner, owner));
        if (depositSuccess) successes += 1;
        _recordResult(0, depositSuccess, depositResult);

        (bool settleSuccess, bytes memory settleResult) = vault.call(abi.encodeWithSignature("settleRequests()"));
        if (settleSuccess) successes += 1;
        _recordResult(1, settleSuccess, settleResult);

        (bool executeSuccess, bytes memory executeResult) =
            vault.call(abi.encodeWithSignature("executeAdapter(bytes32,bytes)", adapterId, adapterData));
        if (executeSuccess) successes += 1;
        _recordResult(2, executeSuccess, executeResult);
    }

    function reset() external {
        callCount = 0;
        successCount = 0;
        failureCount = 0;
        lastSuccess = false;
        _clearLastResult();
    }

    function _recordResult(uint256 index, bool success, bytes memory result) internal {
        callCount += 1;
        if (success) {
            successCount += 1;
        } else {
            failureCount += 1;
        }
        lastSuccess = success;
        lastResult = result;
        emit VaultCallResult(index, success, result);
    }

    function _clearLastResult() internal {
        delete lastResult;
    }
}
