// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

library ErrorCodes {
    uint8 internal constant REQUEST_ALREADY_ACTIVE = 1;
    uint8 internal constant REQUEST_NO_PENDING = 2;
    uint8 internal constant REQUEST_NO_CLAIMABLE = 3;
    uint8 internal constant REQUEST_NO_BATCH = 4;
    uint8 internal constant REQUEST_QUEUE_FULL = 5;
    uint8 internal constant REQUEST_PENDING = 6;

    uint8 internal constant ORACLE_INVALID = 1;
    uint8 internal constant ORACLE_INVALID_REQUEST = 2;
    uint8 internal constant ORACLE_ACTIVE = 3;
    uint8 internal constant ORACLE_NONE_ACTIVE = 4;
    uint8 internal constant ORACLE_NOT_TIMED_OUT = 5;
    uint8 internal constant ORACLE_COOLDOWN_ACTIVE = 6;
    uint8 internal constant ORACLE_INVALID_VALUATION_TIMESTAMP = 7;
    uint8 internal constant ORACLE_INVALID_PRICE = 8;

    uint8 internal constant CROSS_CHAIN_NOT_CONFIGURED = 1;
    uint8 internal constant CROSS_CHAIN_ACCOUNTING_CHAIN_ONLY = 2;
    uint8 internal constant CROSS_CHAIN_SATELLITE_CHAIN_ONLY = 3;
    uint8 internal constant CROSS_CHAIN_ACTIVE = 4;
    uint8 internal constant CROSS_CHAIN_NO_OUTBOX = 5;
    uint8 internal constant CROSS_CHAIN_INVALID_CHAIN = 6;
    uint8 internal constant CROSS_CHAIN_INVALID_SELECTOR = 7;
    uint8 internal constant CROSS_CHAIN_INVALID_ASSET = 8;
    uint8 internal constant CROSS_CHAIN_INVALID_MESSAGE = 9;
    uint8 internal constant CROSS_CHAIN_UNTRUSTED_SENDER = 10;

    uint8 internal constant CORE_INVALID_FEE = 1;
    uint8 internal constant CORE_FACTORY_NOT_CONFIGURED = 3;
    uint8 internal constant CORE_BEACON_NOT_CONFIGURED = 4;
    uint8 internal constant CORE_ESCROW_NOT_CONFIGURED = 5;
    uint8 internal constant CORE_INVALID_ACCOUNTING_CHAIN = 6;
    uint8 internal constant CORE_INVALID_CROSS_CHAIN_GAS_LIMIT = 7;
    uint8 internal constant CORE_INVALID_PRICE_FLUCTUATION = 8;
}
