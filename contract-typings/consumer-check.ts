import type {
  IUFarmVaultErrors,
  UFarmVaultTypes,
} from "@ufarm/evm-v2-types";
import { IUFarmVaultErrors__factory } from "@ufarm/evm-v2-types";

type DepositRequestLog = UFarmVaultTypes.DepositRequestEvent.Log;

declare const errorsContract: IUFarmVaultErrors;
declare const depositRequestLog: DepositRequestLog;

errorsContract.interface.parseError("0x");
IUFarmVaultErrors__factory.createInterface().parseError("0x");
depositRequestLog.args.assets;
