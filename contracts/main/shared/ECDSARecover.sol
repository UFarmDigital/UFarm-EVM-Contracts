// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.24;
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title ECDSARecover
 * @author https://ufarm.digital/
 * @notice Contract that provides ECDSA signature recovery based on EIP712 standard
 */
abstract contract ECDSARecover {
	struct EIP712Domain {
		string name;
		string version;
		uint256 chainId;
		address verifyingContract;
	}

	// Safe to use, because it is constant
	/// @custom:oz-upgrades-unsafe-allow state-variable-assignment state-variable-immutable
	bytes32 private immutable DOMAIN_STRUCTURE_HASH =
		keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

	/**
	 * @notice EIP712 Domain Separator
	 */
	function DOMAIN_SEPARATOR() public view returns (bytes32) {
		return
			hashDomain(
				EIP712Domain({
					name: name(),
					version: version(),
					chainId: block.chainid,
					verifyingContract: address(this)
				})
			);
	}

	/**
	 * @notice Reverts if the provided signature was incorrectly formatted.
	 */
	error WrongSignature();

	/**
	 * @notice Returns the current version of the contract
	 */
	function version() public pure virtual returns (string memory);

	/**
	 * @notice Returns the name of the contract
	 */
	function name() public view virtual returns (string memory);

	/**
	 * @notice Computes EIP712 DOMAIN_SEPARATOR hash
	 * @param domain - EIP712 domain struct
	 */
	function hashDomain(ECDSARecover.EIP712Domain memory domain) internal view returns (bytes32) {
		return
			keccak256(
				abi.encode(
					DOMAIN_STRUCTURE_HASH,
					keccak256(bytes(domain.name)),
					keccak256(bytes(domain.version)),
					domain.chainId,
					domain.verifyingContract
				)
			);
	}

	/**
	 * @notice Recovers signer address from a message by using their signature
	 * @param domainHash - hash of the EIP712 domain
	 * @param msgHash - hash of the message
	 */
	function toEIP712MessageHash(
		bytes32 domainHash,
		bytes32 msgHash
	) internal pure returns (bytes32) {
		return keccak256(abi.encodePacked("\x19\x01", domainHash, msgHash));
	}

	/**
	 * @notice Recovers signer address from a message by using their signature
	 * @param digest - hash of the message
	 * @param signature - signature of the hash
	 */
	function recoverAddress(bytes32 digest, bytes memory signature) internal pure returns (address) {
		return ECDSA.recover(digest, signature);
	}
}
