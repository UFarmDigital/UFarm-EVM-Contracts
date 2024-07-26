// SPDX-License-Identifier: Apache-2.0
pragma solidity =0.6.6;

contract MockedWETH9 {
	string public name = 'Wrapped Ether';
	string public symbol = 'WETH';
	uint8 public decimals = 18;

	event Approval(address indexed src, address indexed guy, uint wad);
	event Transfer(address indexed src, address indexed dst, uint wad);
	event Deposit(address indexed dst, uint wad);
	event Withdrawal(address indexed src, uint wad);

	mapping(address => uint) public balanceOf;
	mapping(address => mapping(address => uint)) public allowance;

	function deposit() public payable {
		uint256 toDeposit = msg.value * 1 ether;
		balanceOf[msg.sender] += toDeposit;
		emit Deposit(msg.sender, toDeposit);
	}

	function withdraw(uint wad) public {
		require(balanceOf[msg.sender] >= wad, '');
		balanceOf[msg.sender] -= wad;
		uint256 toWithdraw = wad / 1 ether;
		if (toWithdraw > 0) {
			msg.sender.transfer(toWithdraw);
		}
		emit Withdrawal(msg.sender, wad);
	}

	function totalSupply() public view returns (uint) {
		return address(this).balance;
	}

	function approve(address guy, uint wad) public returns (bool) {
		allowance[msg.sender][guy] = wad;
		emit Approval(msg.sender, guy, wad);
		return true;
	}

	function transfer(address dst, uint wad) public returns (bool) {
		return transferFrom(msg.sender, dst, wad);
	}

	function transferFrom(address src, address dst, uint wad) public returns (bool) {
		require(balanceOf[src] >= wad, '');

		if (src != msg.sender && allowance[src][msg.sender] != uint(-1)) {
			require(allowance[src][msg.sender] >= wad, '');
			allowance[src][msg.sender] -= wad;
		}

		balanceOf[src] -= wad;
		balanceOf[dst] += wad;

		emit Transfer(src, dst, wad);

		return true;
	}

	function mintWeth(address guy, uint wad) public {
		balanceOf[guy] += wad;
		emit Deposit(guy, wad);
	}

	function burnWeth(address guy, uint wad) public {
		balanceOf[guy] -= wad;
		emit Withdrawal(guy, wad);
	}
}
