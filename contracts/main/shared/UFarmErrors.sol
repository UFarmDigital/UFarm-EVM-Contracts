// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

/**
 * @title UFarmErrors contract
 * @author https://ufarm.digital/
 * @notice Stores shared errors for some UFarm contracts
 */
abstract contract UFarmErrors {
	error ActionAlreadyDone();
	error FETCHING_CONTROLLER_FAILED();
	error ArraysLengthMismatch();
	error UFarmIsPaused();
	error NonAuthorized();
}
