// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.24;

/**
 * @title IUFarmFund interface
 * @author https://ufarm.digital/
 * @notice Fund interface for the UFarm protocol
 */
interface IUFarmFund {
    /**
     * Possible statuses of the fund
     */
    enum FundStatus {
        Approved,
        Active,
        Terminated,
        Blocked
    }

    /**
     * @notice Struct for storing the fund member invitation
     * @param invitee - address of the invitee
     * @param permissionsMask - masked permissions of the invitee
     * @param deadline - deadline for the invitee to accept the invitation
     */
    struct FundMemberInvitation {
        address invitee;
        uint256 permissionsMask;
        uint256 deadline;
    }

    /**
     * @notice Reverts if the fund is not in the required status
     * @param requiredStatus - required status of the fund
     * @param currentStatus - current status of the fund
     */
    error WrongFundStatus(FundStatus requiredStatus, FundStatus currentStatus);

    /**
     * @notice Returns the current status of the fund
     */
    function status() external view returns (FundStatus);

    /**
     * @notice Returns the address of the UFarmCore contract
     */
    function ufarmCore() external view returns (address);

    /**
     * @notice Changes the status of the fund
     * @param newStatus New status of the fund
     */
    function changeStatus(FundStatus newStatus) external;

    /**
     * @notice Returns `true` if the pool is been managed by the fund
     * @param _pool - address of the pool to be checked
     */
    function isPool(address _pool) external view returns (bool);

    /**
     * @notice Initializes the fund, gives full permissions to the owner
     * @param _owner - fund owner
     * @param _ufarmCore - address of the UFarmCore contract
     */
    function __init_UFarmFund(address _owner, address _ufarmCore) external;
}
