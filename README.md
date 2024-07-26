# UFarm EVM Contracts

[UFarm Digital](https://ufarm.digital) — Efficient digital asset management for everyone.

This repository contains the smart contracts of UFarm Digital Protocol.

## Development

Hardhat is used for smart-contracts development, testing and deploying.

### Prerequisites

- NodeJS v20.9.0 or newer

### Installation

```shell
git submodule update --init --recursive
npm install
```

### Compilation

To compile smart-contracts and typechain types use the command:

```shell
npm run compile
```

It places aftifacts into the directories according to the template:

```
artifacts/contracts/<ContractName>.sol/
```

and typescript types into the directory:

```
typechain-types/
```

### Testing

Tests are launched by the command:

```
npm test
```

### Launching a node for the DApp

As the first step the ethereum node should be launched by the command:

```shell
npm run start-no-deploy
```

It prints the URL of the JSON-RPC server, which might be used by the DApp.

Now in the second terminal the command deploying the contracts should be run:

```shell
npm run deploy-local-all
```

It deploys contracts into the local blockchain. Since that moment the DApp is able to use JSON-RPC API.

## Tasks

Create fund

```shell
npx hardhat createFund --name 'Fund Name' --appid '09fe49b3-4d2b-471c-ac04-36c9e706b85f' --network localhost
```

Popup user balance

```shell
npx hardhat mint-tokens --token '0xA37Fc726C2acc26a5807F32a40f7D2Fe7540F4cb' --user '0x024171cCcf21091B58Afe043146893381432225D' --amount '123654321' --isweth true --network localhost
# use --isweth true if token is WETH, false or not specified otherwise
```

Create pool

```shell
npx hardhat run scripts/createPool.ts --network localhost
```

Activate pool

```shell
npx hardhat run scripts/activatePool.ts  --network localhost
```


UniV2 Swap

```shell
# Please, configure the script before running it
npx hardhat run scripts/swapUniswapV2.ts  --network localhost
```

UniV3 Swap

```shell
# Please, configure the script before running it
npx hardhat run scripts/swapUniswapV3.ts  --network localhost
```

OneInch Swap

```shell
# Please, configure the script before running it
npx hardhat run scripts/swapOneInchV5.ts  --network localhost
```

Increase pool exchange rate in testnet

```shell
npx hardhat --network ufarm boostPool --pool 0x5253F189632bf2EFFA7D89820Cbf4b854c823989
```

Decrease pool exchange rate in testnet

```shell
npx hardhat --network ufarm deboostPool --pool 0x59ef217d6f783362eAB14180140Ee5367B5109Ff
```

## License

The UFarm EMV Contracts are primarily licensed under the Business Source License 1.1 (BUSL-1.1). Unless explicitly stated otherwise, all files fall under this license. You can review the terms of the BUSL-1.1 [here](./LICENSE.MD). Some files, as indicated by their SPDX headers, are licensed under the GNU General Public License v2.0 or later. If an SPDX header specifies UNLICENSED, then that file is not licensed. Please refer to the individual file headers for detailed licensing information.

## Copyright

(c) VENT AI Limited, 2024