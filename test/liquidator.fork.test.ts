require('dotenv').config()
import { describe, beforeEach } from 'mocha'
import { ethers } from 'ethers'
import { EcosystemContracts, getContracts, getAgentContracts } from './helpers/contracts'
import { assetPriceForAgentCr, priceBasedDexReserve, addLiquidity, waitFinalize } from './helpers/contract-utils-ethers'
import { IERC20Metadata } from '../typechain-ethers'
import { reset } from '@nomicfoundation/hardhat-network-helpers'

// usdc balance of deployer (should basically be infinite)
const USDC_BALANCE = BigInt(100_000_000) * ethers.WeiPerEther

// agent to liquidate
const AGENT_ADDRESS = "0x40AAfBc78185c31154273A1F2bE783b5c48Dde40"
// actors (deployer is funded with FfakeXRP and CFLR, can mint USDC and set price reader prices)
const DEPLOYER_PVK = process.env.DEPLOYER_PRIVATE_KEY!
const USER_PVK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545/")

describe("Liquidator", () => {
  let contracts: EcosystemContracts
  let deployer: ethers.Wallet
  let liquidator: ethers.Wallet

  // obtains the f-assets's price that results
  // in agent having collateral ratio of crBips
  async function getCollateralForCr(
    collateralKind: "vault" | "pool",
    crBips: number
  ): Promise<bigint> {
    const agentInfo = await contracts.assetManager.getAgentInfo(await contracts.agent.getAddress())
    const totalMintedUBA = agentInfo.mintedUBA + agentInfo.redeemingUBA + agentInfo.reservedUBA
    let collateralWei
    let collateralToken
    let tokenSymbol
    if (collateralKind === "vault") {
      collateralWei = agentInfo.totalVaultCollateralWei
      collateralToken = contracts.usdc
      tokenSymbol = "testUSDC"
    } else {
      collateralWei = agentInfo.totalPoolCollateralNATWei
      collateralToken = contracts.wNat
      tokenSymbol = "CFLR"
    }
    const { 0: collateralFtsoPrice, 2: collateralFtsoDecimals } = await contracts.priceReader.getPrice(tokenSymbol)
    const { 2: fAssetFtsoDecimals } = await contracts.priceReader.getPrice("testXRP")
    return assetPriceForAgentCr(
      BigInt(crBips),
      totalMintedUBA,
      collateralWei,
      collateralFtsoPrice,
      collateralFtsoDecimals,
      await collateralToken.decimals(),
      fAssetFtsoDecimals,
      await contracts.fAsset.decimals()
    )
  }

  // set price of tokenA in tokenB
  // both prices in the same currency,
  // e.g. FLR/$, XRP/$
  async function setDexPairPrice(
    tokenA: IERC20Metadata,
    tokenB: IERC20Metadata,
    priceA: bigint,
    priceB: bigint,
    reserveA: bigint,
    liquidityProvider: ethers.Wallet,
    provider: ethers.JsonRpcProvider
  ): Promise<void> {
    const decimalsA = await tokenA.decimals()
    const decimalsB = await tokenB.decimals()
    const reserveB = priceBasedDexReserve(
      priceA,
      priceB,
      decimalsA,
      decimalsB,
      reserveA
    )
    await addLiquidity(
      contracts.blazeSwapRouter,
      tokenA,
      tokenB,
      reserveA,
      reserveB,
      liquidityProvider,
      provider
    )
  }

  beforeEach(async () => {
    await reset()
    const baseContracts = getContracts("coston", provider)
    const agentContracts = await getAgentContracts(AGENT_ADDRESS, provider)
    contracts = { ...baseContracts, ...agentContracts }
    // get relevant signers
    liquidator = new ethers.Wallet(USER_PVK, provider)
    deployer = new ethers.Wallet(DEPLOYER_PVK, provider)
    // mint USDC to deployer and wrap their CFLR (they will provide liquidity to dexes)
    await waitFinalize(provider, deployer, contracts.usdc.connect(deployer).mintAmount(deployer, USDC_BALANCE))
    const availableWNat = await provider.getBalance(deployer) - ethers.WeiPerEther
    await waitFinalize(provider, deployer, contracts.wNat.connect(deployer).deposit({ value: availableWNat })) // wrap CFLR
  })

  it("should liquidate an agent", async () => {
    // we have only those F-Assets and CFLR available
    const availableFAsset = await contracts.fAsset.balanceOf(deployer)
    const availableWNat = await contracts.wNat.balanceOf(deployer)
    // put agent in liquidation by raising xrp price and set cr slightly below ccb
    const assetPrice = await getCollateralForCr("vault", 11_000) // ccb = 13_000
    await waitFinalize(provider, deployer, contracts.priceReader.connect(deployer).setPrice("testXRP", assetPrice))
    // align dex reserve ratios with the ftso prices
    const { 0: usdcPrice } = await contracts.priceReader.getPrice("testUSDC")
    const { 0: wNatPrice } = await contracts.priceReader.getPrice("CFLR")
    await setDexPairPrice(contracts.fAsset, contracts.usdc, assetPrice, usdcPrice, availableFAsset, deployer, provider)
    await setDexPairPrice(contracts.wNat, contracts.usdc, wNatPrice, usdcPrice, availableWNat, deployer, provider)
    // call liquidator
    await waitFinalize(provider, liquidator, contracts.assetManager.connect(liquidator).startLiquidation(contracts.agent))

    const _agentInfo = await contracts.assetManager.getAgentInfo(contracts.agent)
    console.log("vault collateral ratio agent", _agentInfo.vaultCollateralRatioBIPS)
    console.log("total minted", _agentInfo.mintedUBA)
    console.log("total liquidated", _agentInfo.maxLiquidationAmountUBA)

    await waitFinalize(provider, liquidator, contracts.liquidator.connect(liquidator).runArbitrage(contracts.agent))
    // check that agent was fully liquidated and put out of liquidation
    const agentInfo = await contracts.assetManager.getAgentInfo(contracts.agent)
    console.log(agentInfo.status)
  })
})