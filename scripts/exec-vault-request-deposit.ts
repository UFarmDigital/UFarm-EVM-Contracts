import { Contract } from "ethers";
import {
  argumentValue,
  connectWithRole,
  optionalAddressArgument,
  optionalBytesArgument,
  optionalUintArgument,
  parseTokenAmountArgument,
  requiredAddressArgument,
  waitAndLog,
} from "./helpers/exec-helpers.js";

const vaultAddress = requiredAddressArgument("--vault");
const customAsset = argumentValue("--asset");
const assets = parseTokenAmountArgument("--assets");

const { ethers } = await connectWithRole("PK_INVESTOR");
const [investor] = await ethers.getSigners();
const investorAddress = await investor.getAddress();
const controller = optionalAddressArgument("--controller", investorAddress);
const owner = optionalAddressArgument("--owner", investorAddress);
const vault = await ethers.getContractAt("IUFarmVault", vaultAddress);
const escrowAddress = await vault.escrow();
const assetAddress = customAsset === undefined ? await vault.asset() : requiredAddressArgument("--asset");
const token = new Contract(assetAddress, ["function approve(address spender, uint256 value) returns (bool)"], investor);

console.log(`approving asset: ${assetAddress}`);
console.log(`spender: ${escrowAddress}`);
console.log(`amount: ${assets}`);
await waitAndLog(await token.approve(escrowAddress, assets));

if (customAsset === undefined) {
  const requestId = await vault["requestDeposit(uint256,address,address)"].staticCall(assets, controller, owner);
  const tx = await vault["requestDeposit(uint256,address,address)"](assets, controller, owner);

  console.log(`requestId: ${requestId}`);
  await waitAndLog(tx);
} else {
  const verification = {
    signature: optionalBytesArgument("--verification-signature"),
    validTill: optionalUintArgument("--verification-valid-till", 0n),
    tier: Number(optionalUintArgument("--verification-tier", 0n)),
  };
  const requestId = await vault["requestDeposit(address,uint256,address,address,(bytes,uint64,uint8))"].staticCall(
    assetAddress,
    assets,
    controller,
    owner,
    verification,
  );
  const tx = await vault["requestDeposit(address,uint256,address,address,(bytes,uint64,uint8))"](
    assetAddress,
    assets,
    controller,
    owner,
    verification,
  );

  console.log(`requestId: ${requestId}`);
  await waitAndLog(tx);
}
