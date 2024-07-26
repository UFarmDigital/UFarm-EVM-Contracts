// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

import '../../contracts/main/contracts/pool/PoolAdmin.sol';
import './Block.sol';

contract MockPoolAdmin is PoolAdmin, Block {}
