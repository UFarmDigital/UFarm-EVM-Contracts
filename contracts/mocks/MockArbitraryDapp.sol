// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

contract MockArbitraryDapp {
    error MockArbitraryDappFailed(uint256 code);

    event TargetCalled(address indexed caller, uint256 value, uint256 amount);

    uint256 private _storedValue;

    function setValue(uint256 value_) external payable returns (uint256) {
        _storedValue = value_;
        emit TargetCalled(msg.sender, msg.value, value_);
        return value_;
    }

    function storedValue() external view returns (uint256) {
        return _storedValue;
    }

    function fail(uint256 code) external pure {
        revert MockArbitraryDappFailed(code);
    }
}
