// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.24;

/**
 * @title UFarmCoreLink interface
 * @author https://ufarm.digital/
 * @notice Interface for the UFarmCoreLink contract
 */
interface IUFarmCoreLink {
	function coreCallback() external;
}

/**
 * @title UFarmCoreLink contract
 * @author https://ufarm.digital/
 * @notice Sets ufarmCore link for contracts that deployed before than UFarmCore
 */
abstract contract UFarmCoreLink is IUFarmCoreLink {
	/**
	 * @notice Address of the UFarmCore contract
	 */
	function ufarmCore() public view returns (address) {
		return _ufarmCore;
	}

	address private _ufarmCore;
	/// @dev Keeps track of UFarmCore link approval
	bool private linkApproved;

	/**
	 * @notice Emitted when UFarmCore address is set
	 * @param ufarmCore Address of the UFarmCore contract
	 */
	event UFarmCoreLinkSet(address ufarmCore);

	/**
	 * @notice Reverts if UFarmCore address is not set
	 */
	error UFarmCoreLinkNotSet();
	/**
	 * @notice Reverts if UFarmCore address is not approved
	 */
	error UFarmCoreLinkNotApproved();

	/**
	 * @notice Reverts if UFarmCore address is not set
	 */
	modifier onlyLinked() {
		if (!linkApproved) revert UFarmCoreLinkNotApproved();
		_;
	}

	function __init__UFarmCoreLink(address ufarmCoreLink) internal  {
		_setLink(ufarmCoreLink);
	}

	/**
	 * @notice Callback function for UFarmCore contract
	 * @dev UFarmCore contract calls this function during initialization to approve UFarmCore link
	 */
	function coreCallback() external override(IUFarmCoreLink) {
		if (!linkApproved && msg.sender == _ufarmCore) {
			linkApproved = true;
			_coreCallbackHook();
		} else revert UFarmCoreLinkNotApproved();
	}

	/// @dev override this function to add custom logic on UFarmCore callback
	function _coreCallbackHook() internal virtual {}

	/**
	 * @notice Initializes UFarmCore link
	 * @param ufarmCoreLink Address of the UFarmCore contract
	 */
	function _setLink(address ufarmCoreLink) internal {
		_ufarmCore = ufarmCoreLink;

		emit UFarmCoreLinkSet(ufarmCoreLink);
	}

	uint256[50] private __gap;
}
