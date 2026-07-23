// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable _customDecimals;
    bool public transferReverts;
    bool public transferFromRevertsOnce;
    uint256 public transferFromRevertAmount;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _customDecimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _customDecimals;
    }

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    function setTransferReverts(bool reverts_) external {
        transferReverts = reverts_;
    }

    function setTransferFromRevertsOnce(bool reverts_) external {
        transferFromRevertsOnce = reverts_;
    }

    function setTransferFromRevertAmount(uint256 amount) external {
        transferFromRevertAmount = amount;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (transferReverts) revert("MockERC20: transfer failed");
        return super.transfer(to, value);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (transferFromRevertAmount != 0 && value == transferFromRevertAmount) {
            revert("MockERC20: transferFrom amount failed");
        }
        if (transferFromRevertsOnce) {
            transferFromRevertsOnce = false;
            revert("MockERC20: transferFrom failed");
        }
        return super.transferFrom(from, to, value);
    }
}
