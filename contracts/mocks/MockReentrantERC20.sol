// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockReentrantERC20 is ERC20 {
    enum HookPoint {
        None,
        BeforeTransfer,
        AfterTransfer,
        BeforeTransferFrom,
        AfterTransferFrom
    }

    event HookCall(bool success, bytes result);
    event ExternalCall(address indexed target, bool success, bytes result);

    uint8 private immutable _customDecimals;

    HookPoint public hookPoint;
    address public hookTarget;
    bytes public hookData;
    uint256 public remainingHookCalls;
    bool public lastHookSuccess;
    bytes public lastHookResult;
    bool public lastExternalCallSuccess;
    bytes public lastExternalCallResult;

    bool private _hookEntered;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _customDecimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _customDecimals;
    }

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    function setHook(HookPoint point, address target, bytes calldata data, uint256 times) external {
        hookPoint = point;
        hookTarget = target;
        hookData = data;
        remainingHookCalls = times;
        lastHookSuccess = false;
        delete lastHookResult;
    }

    function clearHook() external {
        hookPoint = HookPoint.None;
        hookTarget = address(0);
        delete hookData;
        remainingHookCalls = 0;
    }

    function callTarget(address target, bytes calldata data) external returns (bool success, bytes memory result) {
        (success, result) = target.call(data);
        lastExternalCallSuccess = success;
        lastExternalCallResult = result;
        emit ExternalCall(target, success, result);
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        _runHook(HookPoint.BeforeTransfer);
        bool success = super.transfer(to, value);
        _runHook(HookPoint.AfterTransfer);
        return success;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        _runHook(HookPoint.BeforeTransferFrom);
        bool success = super.transferFrom(from, to, value);
        _runHook(HookPoint.AfterTransferFrom);
        return success;
    }

    function _runHook(HookPoint point) internal {
        if (_hookEntered || hookPoint != point || remainingHookCalls == 0) return;
        remainingHookCalls -= 1;
        _hookEntered = true;

        (bool success, bytes memory result) = hookTarget.call(hookData);
        lastHookSuccess = success;
        lastHookResult = result;
        emit HookCall(success, result);

        _hookEntered = false;
    }
}
