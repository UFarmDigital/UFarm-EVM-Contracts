# Another tests of Fees

## Test Case: All Fees are Calculated Correctly During Withdrawal, Final HWM is zero

1. Bob deposits 2000 USDT to the pool.
2. Manager exchanges 1000 USDT to ETH.
3. 30 days passed.
4. The exchange rate of ETH bumps by 1/3.
5. The pool calculates fees as:
   1. Total cost should be equal to 1000 USDT + UniswapCostOfETHinPool() = 1000 USDT + 1000 USDT \* 4/3 = 2333.33 USDT
   2. Initial HWM should be equal to 2000 USDT
   3. Performance fee = Profit \* Performance commission rate
      (~2300 - 2000) \* 10% = 30 USDT at the time of withdrawal.
   4. Management fee = Annual Fee Period \* Management Commission \* Assets Under Management = (30 days / 365 days) \* 2% \* 2000 USDT = 12 USDT
   5. Protocol fee = Annual Fee Period \* Protocol Commission \* Assets Under Management = (30 days / 365 days) \* 3% \* 2000 USDT = 18 USDT
   6. HWM should be equal to 0 

## Test Case: All Fees are Calculated Correctly During Deposit and HWM Decreases after Fee Calculation

1. Bob deposits 2000 USDT to the pool.
2. Manager exchanges 1000 USDT to ETH.
3. The exchange rate of ETH bumps by 1/3.
4. 12 hours passed.
4. The pool calculates fees as:
   1. Management Fee = Total cost after changing rate * Management Commission * Fee Period
   2. Protocol Fee = Total cost after changing rate * Protocol Commission * Fee Period
   3. Performance Fee = Profit * Performance commission rate

## Test Case: All Fees are Calculated Correctly During Pool Initialization

1. Fund deposits 4000 USDT to the pool.
2. Manager exchanges 2000 USDT to ETH.
3. The exchange rate of ETH bumps by 100%.
4. 1 min passed.
5. The pool calculates fees as:
   1. Management Fee = Total cost after changing rate \* Management Commission \* Fee Period
   2. Protocol Fee = Total cost after changing rate \* Protocol Commission \* Fee Period
   3. Performance Fee = Profit \* Performance commission rate

## Test Case: Total Fee is Distributed Correctly Between the Fund and the UFarm

1. Bob deposits 2000 USDT to the pool.
2. Manager exchanges 1000 USDT to ETH.
3. The exchange rate of ETH bumps by 1/3, 30 days passed.
4. The pool calculates the total fees as:
   1. Protocol Fee = Fee Period \* Protocol Commission \* Assets Under Management
   2. Management Fee = Fee Period \* Management Commission \* Assets Under Management
   3. Performance Fee = Management Commission \* Profit Above HWM
5. UFarm Fee should be equal to the sum of the Protocol Fee and 20% of the sum of the Management Fee and Performance Fee:
   1. Total UFarm Fee = Protocol Fee + 20% \* (Management Fee + Performance Fee)
6. Fund Fee should be equal to 80% of the sum of the Management Fee and Performance Fee:
   1. Total Fund Fee = 80% \* (Management Fee + Performance Fee)

## Test Case: Performance Fee is Not Calculated When There is No Profit

1. Bob deposits 10000 USDT to the pool.
2. Manager exchanges 5000 USDT to ETH.
3. The exchange rate of ETH dumps to 1/2.
4. Alice deposits 2500 USDT to the pool and no performance fee is calculated.

## Test Case: Protocol Fee and Management Fee are Calculated When There is No Change in the Pool Exchange Rate

1. Bob deposits 1000 USDT to the pool.
2. The exchange rate of ETH does not change. 180 days passed.
3. The pool calculates the protocol fee as:
   1. Protocol Fee = Fee Period \* Protocol Commission \* Assets Under Management
   2. 180/365 \* 0.03 \* 1000 ~= 14.79 USDT
4. The pool calculates the management fee as:
   1. Management Fee = Fee Period \* Management Commission \* Assets Under Management
   2. 180/365 \* 0.02 \* 1000 ~= 10.96 USDT

## Test Case: Management and Protocol Fees Can't Be More Than Pool Balance

1. Bob deposits 1000 USDT to the pool.
2. Manager exchanges 500 USDT to ETH.
3. The exchange rate of ETH changes to x10.
4. Protocol fee is always 0.3% of the pool balance per year. Management fee is 4.7% of the pool balance per year. Performance fee is 10% of the profit.
5. 21 years passed. Total annual rate is 5%, so it is 100% for 20 years.
   1. Total cost ~= 500 + 500 \* 10 = 5500 USDT
   2. Performance fee ~= 5500 \* 10% = 550 USDT
6. The pool calculates the management fee as:
   1. Management Fee = Fee Period _ Management Commission _ Assets Under Management
   2. 21 _ 0.047 _ 5500 = 5428.5 USDT
7. The pool calculates the protocol fee as:
   1. Protocol Fee = Fee Period _ Protocol Commission _ Assets Under Management
   2. 21 _ 0.003 _ 5500 = 346.5 USDT

## Test Case: Full Withdrawal After 1 Year of Pool's Existence

1. Bob deposits 1000 USDT to the pool.
2. Manager exchanges 500 USDT to ETH.
3. 1 year passed.
4. Bob withdraws all his funds. Fees are calculated as:
   1. Protocol Fee = Fee Period _ Protocol Commission _ Assets Under Management
   2. Management Fee = Fee Period _ Management Commission _ Assets Under Management
   3. Performance Fee = Management Commission \* Profit Above HWM
   4. Total UFarm Fee = Protocol Fee + 20% \* (Management Fee + Performance Fee)
   5. Total Fund Fee = 80% \* (Management Fee + Performance Fee)
   6. Total Fee = Total UFarm Fee + Total Fund Fee
   7. Bob receives 1000 - feesValue USDT

## Test Case: Performance Fee is Calculated Correctly During Deposit

1. Bob deposits 1000 USDT to the pool that splits 50% to ETH and 50% to USDT.
2. Manager exchanges 500 USDT to ETH.
3. The exchange rate of ETH bumps by 1/3.
4. The pool calculates the performance fee as:
   1. Performance fee = Profit \* Performance commission rate
   2. (1300 - 1000) \* 10% = 30 USDT at the time of deposit.
