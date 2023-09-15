import BN from 'bn.js'
import { BlazeSwapRouterInstance } from '../../typechain-truffle/blazeswap/contracts/periphery/BlazeSwapRouter'
import { ERC20MockInstance } from '../../typechain-truffle/contracts/mock/ERC20Mock'
import { AssetInfo } from './interface'
import { ZERO_ADDRESS, MAX_INT } from './constants'


////////////////////////////////////////////////////////////////////////////
// blaze swap

// calculates the amount of tokenB received
// when swapping amountA of tokenA
export async function swapOutput(
  router: BlazeSwapRouterInstance,
  tokenIn: ERC20MockInstance,
  tokenOut: ERC20MockInstance,
  amountIn: BNish
): Promise<BN> {
  const { 0: reserveA, 1: reserveB } = await router.getReserves(tokenIn.address, tokenOut.address)
  const amountInWithFee = toBN(amountIn).muln(997)
  const numerator = amountInWithFee.mul(reserveB)
  const denominator = reserveA.muln(1000).add(amountInWithFee)
  return numerator.div(denominator)
}

// calculates the amount of tokenB needed
// to swap to obtain amountA of tokenIn
export async function swapInput(
  router: BlazeSwapRouterInstance,
  tokenIn: ERC20MockInstance,
  tokenOut: ERC20MockInstance,
  amountOut: BNish
): Promise<BN> {
  const { 0: reserveA, 1: reserveB } = await router.getReserves(tokenIn.address, tokenOut.address)
  const numerator = reserveA.mul(toBN(amountOut)).muln(1000)
  const denominator = reserveB.sub(toBN(amountOut)).muln(997)
  return numerator.div(denominator).addn(1)
}

export async function addLiquidity(
  router: BlazeSwapRouterInstance,
  tokenA: ERC20MockInstance,
  tokenB: ERC20MockInstance,
  amountA: BNish,
  amountB: BNish,
  liquidityProvider: string
): Promise<void> {
  await tokenA.mint(liquidityProvider, amountA)
  await tokenB.mint(liquidityProvider, amountB)
  await tokenA.approve(router.address, amountA)
  await tokenB.approve(router.address, amountB)
  await router.addLiquidity(
    tokenA.address, tokenB.address,
    amountA, amountB, 0, 0, 0, 0,
    ZERO_ADDRESS, MAX_INT
  )
}

// set price of tokenIn in tokenOut
// both prices in the same currency,
// e.g. FLR/$, XRP/$
export async function setDexPairPrice(
  router: BlazeSwapRouterInstance,
  tokenA: ERC20MockInstance,
  tokenB: ERC20MockInstance,
  priceA: BNish,
  priceB: BNish,
  reserveA: BNish,
  liquidityProvider: string
): Promise<void> {
  const decimalsA = await tokenA.decimals()
  const decimalsB = await tokenB.decimals()
  // reserveA / reserveB = priceA / priceB
  const reserveB = toBN(reserveA)
    .mul(toBN(priceB))
    .div(toBN(priceA))
    .mul(expBN(decimalsB))
    .div(expBN(decimalsA))
  await addLiquidity(
    router, tokenA, tokenB,
    reserveA, reserveB,
    liquidityProvider
  )
}

////////////////////////////////////////////////////////////////////////////
// f-asset conversions

export function lotSizeAmg(fAsset: AssetInfo): BN {
  return lotSizeUba(fAsset).div(amgSizeUba(fAsset))
}

export function lotSizeUba(fAsset: AssetInfo): BN {
  return toBN(fAsset.lotSize).mul(toBN(10).pow(toBN(fAsset.decimals)))
}

export function amgSizeUba(fAsset: AssetInfo): BN {
  return toBN(10).pow(toBN(fAsset.decimals - fAsset.amgDecimals))
}

export function roundDownToAmg(fAsset: AssetInfo, amount: BNish): BN {
  return toBN(amount).div(amgSizeUba(fAsset)).mul(amgSizeUba(fAsset))
}

////////////////////////////////////////////////////////////////////////////
// bn extensions

export type BNish = number | string | BN

export const toBN = (x: BNish) => new BN(x)

export const minBN = (a: BN, b: BN) => a.lt(b) ? a : b

export const expBN = (y: BNish) => toBN(10).pow(toBN(y))

function getrandbit(): BN {
  return toBN(Number(Math.random() > 0.5))
}

export function randBn(min: BNish, max: BNish): any {
  const ret = toBN(min)
  const diff = toBN(max).sub(ret)
  const bitlen = diff.bitLength()
  let boundbit = true
  for (let i = bitlen-1; i >= 0; i--) {
    const randbit = getrandbit()
    if (boundbit) {
      if (diff.testn(i)) {
        ret.iadd(randbit.shln(i))
        boundbit = randbit.eqn(1)
      }
    }
    else {
      ret.iadd(toBN(randbit).shln(i))
    }
  }
  return ret
}

export function assertBnEqual(
  actual: BNish,
  expected: BNish,
  error: BNish = 0
) {
  const actualBN = toBN(actual)
  const expectedBN = toBN(expected)
  const errorBN = toBN(error)
  const diff = actualBN.sub(expectedBN).abs()
  if (diff.gt(errorBN)) {
    throw new Error(`Expected ${actualBN} to be within ${errorBN} of ${expectedBN}`)
  }
}

////////////////////////////////////////////////////////////////////////////
// implicit ecosystem setters

// get tokenA/tokenB reserve, based on
// the prices that they should have and
// tokenB/tokenA reserve
// prices should be in the same currency,
// e.g. FLR/$, XRP/$
export function getPriceBasedDexReserve(
  priceA: BNish,
  priceB: BNish,
  decimalsA: BNish,
  decimalsB: BNish,
  reserveA: BNish,
): BN {
  // reserveA / reserveB = priceA / priceB
  return toBN(reserveA)
    .mul(toBN(priceB))
    .div(toBN(priceA))
    .mul(expBN(decimalsB))
    .div(expBN(decimalsA))
}

// how many f-assets have to be minted
// for the collateral ratio to be crBips
export function mintedUbaForCr(
  crBips: BNish,
  totalCollateral: BNish,
  priceFAsset: BNish,
  priceCollateral: BNish,
  decimalsFAsset: BNish,
  decimalsCollateral: BNish
): void {
  // not implemented
}

export function collateralForCr(
  crBips: BNish,
  totalMintedUBA: BNish,
  priceFAsset: BNish,
  priceCollateral: BNish,
  decimalsFAsset: BNish,
  decimalsCollateral: BNish
): BN {
  return toBN(totalMintedUBA)
    .mul(toBN(priceFAsset))
    .mul(expBN(decimalsCollateral))
    .mul(toBN(crBips))
    .div(toBN(priceCollateral))
    .div(expBN(decimalsFAsset))
    .divn(10_000)
}