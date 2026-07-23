// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {VaultBaseStorage} from "./VaultBaseStorage.sol";
import {IUFarmVaultErrors} from "../vault/UFarmVaultErrors.sol";
import {IUFarmVaultBaseEvents} from "../vault/UFarmVaultEvents.sol";

library VaultShareAccounting {
    function transferShares(address from, address to, uint256 shares) internal {
        if (from == address(0) || to == address(0)) revert IUFarmVaultErrors.InvalidAddress();
        VaultBaseStorage.Layout storage base = VaultBaseStorage.data();
        if (base.balances[from] < shares) revert IUFarmVaultErrors.InvalidAmount();
        moveShares(from, to, shares);
    }

    function approveShares(address owner, address spender, uint256 amount) internal {
        VaultBaseStorage.data().allowances[owner][spender] = amount;
        emit IUFarmVaultBaseEvents.Approval(owner, spender, amount);
    }

    function moveShares(address from, address to, uint256 shares) internal {
        VaultBaseStorage.Layout storage base = VaultBaseStorage.data();
        base.balances[from] -= shares;
        base.balances[to] += shares;
        emit IUFarmVaultBaseEvents.Transfer(from, to, shares);
    }

    function mintShares(address to, uint256 shares) internal {
        VaultBaseStorage.Layout storage base = VaultBaseStorage.data();
        base.totalSupply += shares;
        base.balances[to] += shares;
        emit IUFarmVaultBaseEvents.Transfer(address(0), to, shares);
    }

    function burnShares(address from, uint256 shares) internal {
        VaultBaseStorage.Layout storage base = VaultBaseStorage.data();
        base.balances[from] -= shares;
        base.totalSupply -= shares;
        emit IUFarmVaultBaseEvents.Transfer(from, address(0), shares);
    }
}
