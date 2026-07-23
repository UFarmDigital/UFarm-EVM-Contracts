# @ufarm/evm-v2-types

Generated TypeChain typings and ethers factories for UFarm EVM contracts.

This package is built from the compiled contracts in `ufarm-evm-contracts-v2`.
The package version always matches the root `package.json` version.

## Usage

ES modules:

```ts
import { UFarmVault__factory } from "@ufarm/evm-v2-types";

const vault = UFarmVault__factory.connect(vaultAddress, runner);
```

CommonJS:

```js
const { UFarmVault__factory } = require("@ufarm/evm-v2-types");

const vault = UFarmVault__factory.connect(vaultAddress, runner);
```

The package exports production contract types, interfaces, OpenZeppelin deployment helper contracts compiled by the project, and their ethers factories. Test mocks are not exported from the package entrypoint.
