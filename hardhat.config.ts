import "dotenv/config";
import { configVariable, defineConfig } from "hardhat/config";
import type { HardhatPlugin } from "hardhat/types/plugins";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";

const ufarmChainId = process.env.UFARM_CHAIN_ID === undefined ? undefined : Number(process.env.UFARM_CHAIN_ID);
const suppressUnusedParamWarningsPlugin: HardhatPlugin = {
  id: "ufarm:suppress-unused-param-warnings",
  hookHandlers: {
    solidity: () => import("./hardhat/solidity-warning-filter.js"),
  },
};

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers, suppressUnusedParamWarningsPlugin],
  networks: {
    ufarm: {
      type: "http",
      chainType: "l1",
      url: configVariable("UFARM_RPC_URL"),
      accounts: [configVariable("UFARM_PRIVATE_KEY")],
      chainId: ufarmChainId,
    },
  },
  verify: {
    etherscan: {
      apiKey: configVariable("ETHERSCAN_API_KEY"),
    },
    blockscout: {
      enabled: false,
    },
    sourcify: {
      enabled: false,
    },
  },
  solidity: {
    npmFilesToBuild: [
      "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol",
      "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol",
      "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol",
      "@openzeppelin/contracts/governance/TimelockController.sol",
    ],
    profiles: {
      default: {
        version: "0.8.35",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          evmVersion: "cancun",
        },
      },
    },
  },
  paths: {
    sources: "contracts",
    tests: "test",
  },
});
