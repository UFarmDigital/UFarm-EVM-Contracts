// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

interface Permissions {
	enum Fund {
		Member,
		Owner,
		UpdateFund,
		InviteFundMember,
		BlockFundMember,
		UpdateFundPermissions,
		CreatePool,
		UpdatePoolDescription,
		UpdatePoolPermissions,
		PoolStatusControl,
		UpdatePoolFees,
		UpdatePoolTopUpAmount,
		UpdateLockupPeriods,
		ManageFund,
		ApprovePoolTopup,
		ApprovePoolWithdrawals,
		ManagePoolFunds
	}

	enum Pool {
		Member,
		UpdatePoolDescription,
		UpdatePoolPermissions,
		PoolStatusControl,
		UpdatePoolFees,
		UpdatePoolTopUpAmount,
		UpdateLockupPeriods,
		ApprovePoolTopup,
		ApprovePoolWithdrawals,
		ManagePoolFunds
	}

	enum UFarm {
		Member,
		Owner,
		UpdatePermissions,
		UpdateUFarmMember,
		DeleteUFarmMember,
		ApproveFundCreation,
		BlockFund,
		BlockInvestor,
		ManageFees,
		ManageFundDeposit,
		ManageWhitelist,
		ManageAssets,
		TurnPauseOn
	}
}
