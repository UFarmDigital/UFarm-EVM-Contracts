export const LOW_OPTIMIZER_COMPILER_SETTINGS = {
    version: '0.8.15',
    settings: {
        optimizer: {
            enabled: true,
            runs: 2000,
        },
        metadata: {
            bytecodeHash: 'none',
        },
    },
}

export const LOWEST_OPTIMIZER_COMPILER_SETTINGS = {
    version: '0.8.15',
    settings: {
        viaIR: true,
        optimizer: {
            enabled: true,
            runs: 10,
        },
        metadata: {
            bytecodeHash: 'none',
        },
    },
}

export const DEFAULT_COMPILER_SETTINGS_16 = {
    version: '0.8.16',
    settings: {
        optimizer: {
            enabled: true,
            runs: 1,
        },
    },
}

export const DEFAULT_COMPILER_SETTINGS_20 = {
    version: '0.8.20',
    settings: {
        outputSelection: {
            '*': {
               '*': ['storageLayout'],
            },
        },
        optimizer: {
            enabled: true,
            runs: 100000,
        },
        metadata: {
            bytecodeHash: 'none',
        },
    },
}

export const DEFAULT_COMPILER_SETTINGS_24 = {
    ...DEFAULT_COMPILER_SETTINGS_20,
    version: '0.8.24',
}

export const DEFAULT_COMPILER_SETTINGS_15 = {
    version: '0.8.15',
    settings: {
        optimizer: {
            enabled: true,
            runs: 1000000,
        },
        metadata: {
            bytecodeHash: 'none',
        },
    },
}

export const DEFAULT_COMPILER_SETTINGS_12 = {
    version: '0.8.12',
    settings: {
        optimizer: {
            enabled: true,
            runs: 625,
        },
        metadata: {
            bytecodeHash: 'none',
        },
    },
}

export const UFARM_POOL_COMPILER_SETTINGS = {
    ...DEFAULT_COMPILER_SETTINGS_24,
    settings: {
        ...DEFAULT_COMPILER_SETTINGS_24.settings,
        viaIR: true,
        optimizer: {
            enabled: true,
            runs: 55,
        },
    },
}

export const UFARM_UNOSWAPV3_CONTROLLER_COMPILER_SETTINGS = {
    ...DEFAULT_COMPILER_SETTINGS_24,
    settings: {
        ...DEFAULT_COMPILER_SETTINGS_24.settings,
        viaIR: false,
        optimizer: {
            enabled: true,
            runs: 500,
        },
    },
}

export const UNOSWAP_V2_CONTROLLER_COMPILER_SETTINGS = {
    ...DEFAULT_COMPILER_SETTINGS_24,
    settings: {
        ...DEFAULT_COMPILER_SETTINGS_24.settings,
        viaIR: true,
    },
}

export const QUEX_CORE_COMPILER_SETTINGS = {
    ...DEFAULT_COMPILER_SETTINGS_24,
    settings: {
        ...DEFAULT_COMPILER_SETTINGS_24.settings,
        viaIR: true,
    },
}