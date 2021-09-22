const { expect, use } = require("chai")
const { solidity } = require("ethereum-waffle")
const { deployContract } = require("../shared/fixtures")
const { expandDecimals, getBlockTime, increaseTime, mineBlock, reportGasUsed } = require("../shared/utilities")
const { toChainlinkPrice } = require("../shared/chainlink")
const { toUsd, toNormalizedPrice } = require("../shared/units")
const { initVault } = require("../core/Vault/helpers")

use(solidity)

describe("Timelock", function () {
  const provider = waffle.provider
  const [wallet, user0, user1, user2, user3, tokenManager] = provider.getWallets()
  let vault
  let vaultPriceFeed
  let usdg
  let router
  let bnb
  let bnbPriceFeed
  let btc
  let btcPriceFeed
  let dai
  let daiPriceFeed
  let distributor0
  let yieldTracker0
  let timelock

  beforeEach(async () => {
    bnb = await deployContract("Token", [])
    bnbPriceFeed = await deployContract("PriceFeed", [])

    btc = await deployContract("Token", [])
    btcPriceFeed = await deployContract("PriceFeed", [])

    dai = await deployContract("Token", [])
    daiPriceFeed = await deployContract("PriceFeed", [])

    vault = await deployContract("Vault", [])
    usdg = await deployContract("USDG", [vault.address])
    router = await deployContract("Router", [vault.address, usdg.address, bnb.address])
    vaultPriceFeed = await deployContract("VaultPriceFeed", [])

    await initVault(vault, router, usdg, vaultPriceFeed)

    distributor0 = await deployContract("TimeDistributor", [])
    yieldTracker0 = await deployContract("YieldTracker", [usdg.address])

    await yieldTracker0.setDistributor(distributor0.address)
    await distributor0.setDistribution([yieldTracker0.address], [1000], [bnb.address])

    await bnb.mint(distributor0.address, 5000)
    await usdg.setYieldTrackers([yieldTracker0.address])

    await vault.setPriceFeed(user3.address)

    timelock = await deployContract("Timelock", [5 * 24 * 60 * 60, tokenManager.address, 1000])
    await vault.setGov(timelock.address)

    await vaultPriceFeed.setTokenConfig(bnb.address, bnbPriceFeed.address, 8, false)
    await vaultPriceFeed.setTokenConfig(btc.address, btcPriceFeed.address, 8, false)
    await vaultPriceFeed.setTokenConfig(dai.address, daiPriceFeed.address, 8, false)

    await vaultPriceFeed.setGov(timelock.address)
    await router.setGov(timelock.address)
  })

  it("inits", async () => {
    expect(await usdg.gov()).eq(wallet.address)
    expect(await usdg.vaults(vault.address)).eq(true)
    expect(await usdg.vaults(user0.address)).eq(false)

    expect(await vault.gov()).eq(timelock.address)
    expect(await vault.isInitialized()).eq(true)
    expect(await vault.router()).eq(router.address)
    expect(await vault.usdg()).eq(usdg.address)
    expect(await vault.liquidationFeeUsd()).eq(toUsd(5))
    expect(await vault.fundingRateFactor()).eq(600)

    expect(await timelock.admin()).eq(wallet.address)
    expect(await timelock.buffer()).eq(5 * 24 * 60 * 60)
    expect(await timelock.tokenManager()).eq(tokenManager.address)
    expect(await timelock.maxTokenSupply()).eq(1000)

    await expect(deployContract("Timelock", [5 * 24 * 60 * 60 + 1, tokenManager.address, 1000]))
      .to.be.revertedWith("Timelock: invalid _buffer")
  })

  it("setTokenConfig", async () => {
    await timelock.connect(wallet).signalSetPriceFeed(vault.address, vaultPriceFeed.address)
    await increaseTime(provider, 5 * 24 * 60 * 60 + 10)
    await mineBlock(provider)
    await timelock.connect(wallet).setPriceFeed(vault.address, vaultPriceFeed.address)

    await bnbPriceFeed.setLatestAnswer(500)

    await expect(timelock.connect(user0).setTokenConfig(
      vault.address,
      bnb.address,
      100,
      200,
      1000
    )).to.be.revertedWith("Timelock: forbidden")

    await expect(timelock.connect(wallet).setTokenConfig(
      vault.address,
      bnb.address,
      100,
      200,
      1000
    )).to.be.revertedWith("Timelock: token not yet whitelisted")

    await timelock.connect(wallet).signalVaultSetTokenConfig(
      vault.address,
      bnb.address, // _token
      12, // _tokenDecimals
      7000, // _tokenWeight
      300, // _minProfitBps
      5000, // _maxUsdgAmount
      false, // _isStable
      true // isShortable
    )

    await increaseTime(provider, 5 * 24 * 60 *60)
    await mineBlock(provider)

    await timelock.connect(wallet).vaultSetTokenConfig(
      vault.address,
      bnb.address, // _token
      12, // _tokenDecimals
      7000, // _tokenWeight
      300, // _minProfitBps
      5000, // _maxUsdgAmount
      false, // _isStable
      true // isShortable
    )

    expect(await vault.whitelistedTokenCount()).eq(1)
    expect(await vault.totalTokenWeights()).eq(7000)
    expect(await vault.whitelistedTokens(bnb.address)).eq(true)
    expect(await vault.tokenDecimals(bnb.address)).eq(12)
    expect(await vault.tokenWeights(bnb.address)).eq(7000)
    expect(await vault.minProfitBasisPoints(bnb.address)).eq(300)
    expect(await vault.maxUsdgAmounts(bnb.address)).eq(5000)
    expect(await vault.stableTokens(bnb.address)).eq(false)
    expect(await vault.shortableTokens(bnb.address)).eq(true)

    await timelock.connect(wallet).setTokenConfig(
      vault.address,
      bnb.address,
      100, // _tokenWeight
      200, // _minProfitBps
      1000 // _maxUsdgAmount
    )

    expect(await vault.whitelistedTokenCount()).eq(1)
    expect(await vault.totalTokenWeights()).eq(100)
    expect(await vault.whitelistedTokens(bnb.address)).eq(true)
    expect(await vault.tokenDecimals(bnb.address)).eq(12)
    expect(await vault.tokenWeights(bnb.address)).eq(100)
    expect(await vault.minProfitBasisPoints(bnb.address)).eq(200)
    expect(await vault.maxUsdgAmounts(bnb.address)).eq(1000)
    expect(await vault.stableTokens(bnb.address)).eq(false)
    expect(await vault.shortableTokens(bnb.address)).eq(true)
  })

  it("setBuffer", async () => {
    const timelock0 = await deployContract("Timelock", [3 * 24 * 60 * 60, tokenManager.address, 1000])
    await expect(timelock0.connect(user0).setBuffer(3 * 24 * 60 * 60 - 10))
      .to.be.revertedWith("Timelock: forbidden")

    await expect(timelock0.connect(wallet).setBuffer(5 * 24 * 60 * 60 + 10))
      .to.be.revertedWith("Timelock: invalid _buffer")

    await expect(timelock0.connect(wallet).setBuffer(3 * 24 * 60 * 60 - 10))
      .to.be.revertedWith("Timelock: buffer cannot be decreased")

    expect(await timelock0.buffer()).eq(3 * 24 * 60 * 60)
    await timelock0.connect(wallet).setBuffer(3 * 24 * 60 * 60 + 10)
    expect(await timelock0.buffer()).eq(3 * 24 * 60 * 60 + 10)
  })

  it("mint", async () => {
    const gmx = await deployContract("GMX", [])
    await expect(timelock.connect(user0).mint(gmx.address, 900))
      .to.be.revertedWith("Timelock: forbidden")

    await expect(timelock.connect(wallet).mint(gmx.address, 900))
      .to.be.revertedWith("BaseToken: forbidden")

    await gmx.setGov(timelock.address)

    expect(await gmx.isMinter(timelock.address)).eq(false)
    expect(await gmx.balanceOf(tokenManager.address)).eq(0)

    await timelock.connect(wallet).mint(gmx.address, 900)

    expect(await gmx.isMinter(timelock.address)).eq(true)
    expect(await gmx.balanceOf(tokenManager.address)).eq(900)

    await expect(timelock.connect(wallet).mint(gmx.address, 101))
      .to.be.revertedWith("Timelock: maxTokenSupply exceeded")
  })

  it("setIsAmmEnabled", async () => {
    await expect(timelock.connect(user0).setIsAmmEnabled(vaultPriceFeed.address, false))
      .to.be.revertedWith("Timelock: forbidden")

    expect(await vaultPriceFeed.isAmmEnabled()).eq(true)
    await timelock.connect(wallet).setIsAmmEnabled(vaultPriceFeed.address, false)
    expect(await vaultPriceFeed.isAmmEnabled()).eq(false)
  })

  it("setMaxStrictPriceDeviation", async () => {
    await expect(timelock.connect(user0).setMaxStrictPriceDeviation(vaultPriceFeed.address, 100))
      .to.be.revertedWith("Timelock: forbidden")

    expect(await vaultPriceFeed.maxStrictPriceDeviation()).eq(0)
    await timelock.connect(wallet).setMaxStrictPriceDeviation(vaultPriceFeed.address, 100)
    expect(await vaultPriceFeed.maxStrictPriceDeviation()).eq(100)
  })

  it("setPriceSampleSpace", async () => {
    await expect(timelock.connect(user0).setPriceSampleSpace(vaultPriceFeed.address, 0))
      .to.be.revertedWith("Timelock: forbidden")

    expect(await vaultPriceFeed.priceSampleSpace()).eq(3)
    await timelock.connect(wallet).setPriceSampleSpace(vaultPriceFeed.address, 1)
    expect(await vaultPriceFeed.priceSampleSpace()).eq(1)
  })

  it("setIsSwapEnabled", async () => {
    await expect(timelock.connect(user0).setIsSwapEnabled(vault.address, false))
      .to.be.revertedWith("Timelock: forbidden")

    expect(await vault.isSwapEnabled()).eq(true)
    await timelock.connect(wallet).setIsSwapEnabled(vault.address, false)
    expect(await vault.isSwapEnabled()).eq(false)
  })

  it("setIsLeverageEnabled", async () => {
    await expect(timelock.connect(user0).setIsLeverageEnabled(vault.address, false))
      .to.be.revertedWith("Timelock: forbidden")

    expect(await vault.isLeverageEnabled()).eq(true)
    await timelock.connect(wallet).setIsLeverageEnabled(vault.address, false)
    expect(await vault.isLeverageEnabled()).eq(false)
  })

  it("setBufferAmount", async () => {
    await expect(timelock.connect(user0).setBufferAmount(vault.address, bnb.address, 100))
      .to.be.revertedWith("Timelock: forbidden")

    expect(await vault.bufferAmounts(bnb.address)).eq(0)
    await timelock.connect(wallet).setBufferAmount(vault.address, bnb.address, 100)
    expect(await vault.bufferAmounts(bnb.address)).eq(100)
  })

  it("setMaxGasPrice", async () => {
    await expect(timelock.connect(user0).setMaxGasPrice(vault.address, 7000000000))
      .to.be.revertedWith("Timelock: forbidden")

    expect(await vault.maxGasPrice()).eq(0)
    await timelock.connect(wallet).setMaxGasPrice(vault.address, 7000000000)
    expect(await vault.maxGasPrice()).eq(7000000000)
  })

  it("transferIn", async () => {
    await bnb.mint(user1.address, 1000)
    await expect(timelock.connect(user0).transferIn(user1.address, bnb.address, 1000))
      .to.be.revertedWith("Timelock: forbidden")

    await expect(timelock.connect(wallet).transferIn(user1.address, bnb.address, 1000))
      .to.be.revertedWith("ERC20: transfer amount exceeds allowance")

    await bnb.connect(user1).approve(timelock.address, 1000)

    expect(await bnb.balanceOf(user1.address)).eq(1000)
    expect(await bnb.balanceOf(timelock.address)).eq(0)
    await timelock.connect(wallet).transferIn(user1.address, bnb.address, 1000)
    expect(await bnb.balanceOf(user1.address)).eq(0)
    expect(await bnb.balanceOf(timelock.address)).eq(1000)
  })

  it("approve", async () => {
    await expect(timelock.connect(user0).approve(dai.address, user1.address, expandDecimals(100, 18)))
      .to.be.revertedWith("Timelock: forbidden")

    await expect(timelock.connect(wallet).approve(dai.address, user1.address, expandDecimals(100, 18)))
      .to.be.revertedWith("Timelock: action not signalled")

    await expect(timelock.connect(user0).signalApprove(dai.address, user1.address, expandDecimals(100, 18)))
      .to.be.revertedWith("Timelock: forbidden")

    await timelock.connect(wallet).signalApprove(dai.address, user1.address, expandDecimals(100, 18))

    await expect(timelock.connect(wallet).approve(dai.address, user1.address, expandDecimals(100, 18)))
      .to.be.revertedWith("Timelock: action time not yet passed")

    await increaseTime(provider, 4 * 24 * 60 * 60)
    await mineBlock(provider)

    await expect(timelock.connect(wallet).approve(dai.address, user1.address, expandDecimals(100, 18)))
      .to.be.revertedWith("Timelock: action time not yet passed")

    await increaseTime(provider, 1 * 24 * 60 * 60 + 10)
    await mineBlock(provider)

    await expect(timelock.connect(wallet).approve(bnb.address, user1.address, expandDecimals(100, 18)))
      .to.be.revertedWith("Timelock: action not signalled")

    await expect(timelock.connect(wallet).approve(dai.address, user2.address, expandDecimals(100, 18)))
      .to.be.revertedWith("Timelock: action not signalled")

    await expect(timelock.connect(wallet).approve(dai.address, user1.address, expandDecimals(101, 18)))
      .to.be.revertedWith("Timelock: action not signalled")

    await dai.mint(timelock.address, expandDecimals(150, 18))

    expect(await dai.balanceOf(timelock.address)).eq(expandDecimals(150, 18))
    expect(await dai.balanceOf(user1.address)).eq(0)

    await expect(dai.connect(user1).transferFrom(timelock.address, user1.address, expandDecimals(100, 18)))
      .to.be.revertedWith("ERC20: transfer amount exceeds allowance")

    await timelock.connect(wallet).approve(dai.address, user1.address, expandDecimals(100, 18))
    await expect(dai.connect(user2).transferFrom(timelock.address, user2.address, expandDecimals(100, 18)))
      .to.be.revertedWith("ERC20: transfer amount exceeds allowance")
    await dai.connect(user1).transferFrom(timelock.address, user1.address, expandDecimals(100, 18))

    expect(await dai.balanceOf(timelock.address)).eq(expandDecimals(50, 18))
    expect(await dai.balanceOf(user1.address)).eq(expandDecimals(100, 18))

    await expect(dai.connect(user1).transferFrom(timelock.address, user1.address, expandDecimals(1, 18)))
      .to.be.revertedWith("ERC20: transfer amount exceeds allowance")

    await expect(timelock.connect(wallet).approve(dai.address, user1.address, expandDecimals(100, 18)))
      .to.be.revertedWith("Timelock: action not signalled")

    await timelock.connect(wallet).signalApprove(dai.address, user1.address, expandDecimals(100, 18))

    await expect(timelock.connect(wallet).approve(dai.address, user1.address, expandDecimals(100, 18)))
      .to.be.revertedWith("Timelock: action time not yet passed")

    const action0 = ethers.utils.solidityKeccak256(["string", "address", "address", "uint256"], ["approve", bnb.address, user1.address, expandDecimals(100, 18)])
    const action1 = ethers.utils.solidityKeccak256(["string", "address", "address", "uint256"], ["approve", dai.address, user1.address, expandDecimals(100, 18)])

    await expect(timelock.connect(user0).cancelAction(action0))
      .to.be.revertedWith("Timelock: forbidden")

    await expect(timelock.connect(wallet).cancelAction(action0))
      .to.be.revertedWith("Timelock: invalid _action")

    await timelock.connect(wallet).cancelAction(action1)

    await expect(timelock.connect(wallet).approve(dai.address, user1.address, expandDecimals(100, 18)))
      .to.be.revertedWith("Timelock: action not signalled")
  })

  it("setGov", async () => {
    await expect(timelock.connect(user0).setGov(vault.address, user1.address))
      .to.be.revertedWith("Timelock: forbidden")

    await expect(timelock.connect(wallet).setGov(vault.address, user1.address))
      .to.be.revertedWith("Timelock: action not signalled")

    await expect(timelock.connect(user0).signalSetGov(vault.address, user1.address))
      .to.be.revertedWith("Timelock: forbidden")

    await timelock.connect(wallet).signalSetGov(vault.address, user1.address)

    await expect(timelock.connect(wallet).setGov(vault.address, user1.address))
      .to.be.revertedWith("Timelock: action time not yet passed")

    await increaseTime(provider, 4 * 24 * 60 * 60)
    await mineBlock(provider)

    await expect(timelock.connect(wallet).setGov(vault.address, user1.address))
      .to.be.revertedWith("Timelock: action time not yet passed")

    await increaseTime(provider, 1 * 24 * 60 * 60 + 10)
    await mineBlock(provider)

    await expect(timelock.connect(wallet).setGov(user2.address, user1.address))
      .to.be.revertedWith("Timelock: action not signalled")

    await expect(timelock.connect(wallet).setGov(vault.address, user2.address))
      .to.be.revertedWith("Timelock: action not signalled")

    expect(await vault.gov()).eq(timelock.address)
    await timelock.connect(wallet).setGov(vault.address, user1.address)
    expect(await vault.gov()).eq(user1.address)

    await timelock.connect(wallet).signalSetGov(vault.address, user2.address)

    await expect(timelock.connect(wallet).setGov(vault.address, user2.address))
      .to.be.revertedWith("Timelock: action time not yet passed")

    const action0 = ethers.utils.solidityKeccak256(["string", "address", "address"], ["setGov", user1.address, user2.address])
    const action1 = ethers.utils.solidityKeccak256(["string", "address", "address"], ["setGov", vault.address, user2.address])

    await expect(timelock.connect(wallet).cancelAction(action0))
      .to.be.revertedWith("Timelock: invalid _action")

    await timelock.connect(wallet).cancelAction(action1)

    await expect(timelock.connect(wallet).setGov(vault.address, user2.address))
      .to.be.revertedWith("Timelock: action not signalled")
  })

  it("setPriceFeed", async () => {
    await expect(timelock.connect(user0).setPriceFeed(vault.address, user1.address))
      .to.be.revertedWith("Timelock: forbidden")

    await expect(timelock.connect(wallet).setPriceFeed(vault.address, user1.address))
      .to.be.revertedWith("Timelock: action not signalled")

    await expect(timelock.connect(user0).signalSetPriceFeed(vault.address, user1.address))
      .to.be.revertedWith("Timelock: forbidden")

    await timelock.connect(wallet).signalSetPriceFeed(vault.address, user1.address)

    await expect(timelock.connect(wallet).setPriceFeed(vault.address, user1.address))
      .to.be.revertedWith("Timelock: action time not yet passed")

    await increaseTime(provider, 4 * 24 * 60 * 60)
    await mineBlock(provider)

    await expect(timelock.connect(wallet).setPriceFeed(vault.address, user1.address))
      .to.be.revertedWith("Timelock: action time not yet passed")

    await increaseTime(provider, 1 * 24 * 60 * 60 + 10)
    await mineBlock(provider)

    await expect(timelock.connect(wallet).setPriceFeed(user2.address, user1.address))
      .to.be.revertedWith("Timelock: action not signalled")

    await expect(timelock.connect(wallet).setPriceFeed(vault.address, user2.address))
      .to.be.revertedWith("Timelock: action not signalled")

    expect(await vault.priceFeed()).eq(user3.address)
    await timelock.connect(wallet).setPriceFeed(vault.address, user1.address)
    expect(await vault.priceFeed()).eq(user1.address)

    await timelock.connect(wallet).signalSetPriceFeed(vault.address, user2.address)

    await expect(timelock.connect(wallet).setPriceFeed(vault.address, user2.address))
      .to.be.revertedWith("Timelock: action time not yet passed")

    const action0 = ethers.utils.solidityKeccak256(["string", "address", "address"], ["setPriceFeed", user1.address, user2.address])
    const action1 = ethers.utils.solidityKeccak256(["string", "address", "address"], ["setPriceFeed", vault.address, user2.address])

    await expect(timelock.connect(wallet).cancelAction(action0))
      .to.be.revertedWith("Timelock: invalid _action")

    await timelock.connect(wallet).cancelAction(action1)

    await expect(timelock.connect(wallet).setPriceFeed(vault.address, user2.address))
      .to.be.revertedWith("Timelock: action not signalled")
  })

  it("vaultSetTokenConfig", async () => {
    await timelock.connect(wallet).signalSetPriceFeed(vault.address, vaultPriceFeed.address)
    await increaseTime(provider, 5 * 24 * 60 * 60 + 10)
    await mineBlock(provider)
    await timelock.connect(wallet).setPriceFeed(vault.address, vaultPriceFeed.address)

    await daiPriceFeed.setLatestAnswer(1)

    await expect(timelock.connect(user0).vaultSetTokenConfig(
      vault.address,
      dai.address, // _token
      12, // _tokenDecimals
      7000, // _tokenWeight
      120, // _minProfitBps
      5000, // _maxUsdgAmount
      true, // _isStable
      false // isShortable
    )).to.be.revertedWith("Timelock: forbidden")

    await expect(timelock.connect(wallet).vaultSetTokenConfig(
      vault.address,
      dai.address, // _token
      12, // _tokenDecimals
      7000, // _tokenWeight
      120, // _minProfitBps
      5000, // _maxUsdgAmount
      true, // _isStable
      false // isShortable
    )).to.be.revertedWith("Timelock: action not signalled")

    await expect(timelock.connect(user0).signalVaultSetTokenConfig(
      vault.address,
      dai.address, // _token
      12, // _tokenDecimals
      7000, // _tokenWeight
      120, // _minProfitBps
      5000, // _maxUsdgAmount
      true, // _isStable
      false // isShortable
    )).to.be.revertedWith("Timelock: forbidden")

    await timelock.connect(wallet).signalVaultSetTokenConfig(
      vault.address,
      dai.address, // _token
      12, // _tokenDecimals
      7000, // _tokenWeight
      120, // _minProfitBps
      5000, // _maxUsdgAmount
      true, // _isStable
      false // isShortable
    )

    await expect(timelock.connect(wallet).vaultSetTokenConfig(
      vault.address,
      dai.address, // _token
      12, // _tokenDecimals
      7000, // _tokenWeight
      120, // _minProfitBps
      5000, // _maxUsdgAmount
      true, // _isStable
      false // isShortable
    )).to.be.revertedWith("Timelock: action time not yet passed")

    await increaseTime(provider, 4 * 24 * 60 * 60)
    await mineBlock(provider)

    await expect(timelock.connect(wallet).vaultSetTokenConfig(
      vault.address,
      dai.address, // _token
      12, // _tokenDecimals
      7000, // _tokenWeight
      120, // _minProfitBps
      5000, // _maxUsdgAmount
      true, // _isStable
      false // isShortable
    )).to.be.revertedWith("Timelock: action time not yet passed")

    await increaseTime(provider, 1 * 24 * 60 * 60 + 10)
    await mineBlock(provider)

    await expect(timelock.connect(wallet).vaultSetTokenConfig(
      vault.address,
      dai.address, // _token
      15, // _tokenDecimals
      7000, // _tokenWeight
      120, // _minProfitBps
      5000, // _maxUsdgAmount
      true, // _isStable
      false // isShortable
    )).to.be.revertedWith("Timelock: action not signalled")

    expect(await vault.totalTokenWeights()).eq(0)
    expect(await vault.whitelistedTokens(dai.address)).eq(false)
    expect(await vault.tokenDecimals(dai.address)).eq(0)
    expect(await vault.tokenWeights(dai.address)).eq(0)
    expect(await vault.minProfitBasisPoints(dai.address)).eq(0)
    expect(await vault.maxUsdgAmounts(dai.address)).eq(0)
    expect(await vault.stableTokens(dai.address)).eq(false)
    expect(await vault.shortableTokens(dai.address)).eq(false)

    await timelock.connect(wallet).vaultSetTokenConfig(
      vault.address,
      dai.address, // _token
      12, // _tokenDecimals
      7000, // _tokenWeight
      120, // _minProfitBps
      5000, // _maxUsdgAmount
      true, // _isStable
      false // isShortable
    )

    expect(await vault.totalTokenWeights()).eq(7000)
    expect(await vault.whitelistedTokens(dai.address)).eq(true)
    expect(await vault.tokenDecimals(dai.address)).eq(12)
    expect(await vault.tokenWeights(dai.address)).eq(7000)
    expect(await vault.minProfitBasisPoints(dai.address)).eq(120)
    expect(await vault.maxUsdgAmounts(dai.address)).eq(5000)
    expect(await vault.stableTokens(dai.address)).eq(true)
    expect(await vault.shortableTokens(dai.address)).eq(false)
  })

  it("addPlugin", async () => {
    await expect(timelock.connect(user0).addPlugin(router.address, user1.address))
      .to.be.revertedWith("Timelock: forbidden")

    await expect(timelock.connect(wallet).addPlugin(router.address, user1.address))
      .to.be.revertedWith("Timelock: action not signalled")

    await expect(timelock.connect(user0).signalAddPlugin(router.address, user1.address))
      .to.be.revertedWith("Timelock: forbidden")

    await timelock.connect(wallet).signalAddPlugin(router.address, user1.address)

    await expect(timelock.connect(wallet).addPlugin(router.address, user1.address))
      .to.be.revertedWith("Timelock: action time not yet passed")

    await increaseTime(provider, 4 * 24 * 60 * 60)
    await mineBlock(provider)

    await expect(timelock.connect(wallet).addPlugin(router.address, user1.address))
      .to.be.revertedWith("Timelock: action time not yet passed")

    await increaseTime(provider, 1 * 24 * 60 * 60 + 10)
    await mineBlock(provider)

    await expect(timelock.connect(wallet).addPlugin(user2.address, user1.address))
      .to.be.revertedWith("Timelock: action not signalled")

    await expect(timelock.connect(wallet).addPlugin(router.address, user2.address))
      .to.be.revertedWith("Timelock: action not signalled")

    expect(await router.plugins(user1.address)).eq(false)
    await timelock.connect(wallet).addPlugin(router.address, user1.address)
    expect(await router.plugins(user1.address)).eq(true)

    await timelock.connect(wallet).signalAddPlugin(router.address, user2.address)

    await expect(timelock.connect(wallet).addPlugin(router.address, user2.address))
      .to.be.revertedWith("Timelock: action time not yet passed")

    const action0 = ethers.utils.solidityKeccak256(["string", "address", "address"], ["addPlugin", user1.address, user2.address])
    const action1 = ethers.utils.solidityKeccak256(["string", "address", "address"], ["addPlugin", router.address, user2.address])

    await expect(timelock.connect(wallet).cancelAction(action0))
      .to.be.revertedWith("Timelock: invalid _action")

    await timelock.connect(wallet).cancelAction(action1)

    await expect(timelock.connect(wallet).addPlugin(router.address, user2.address))
      .to.be.revertedWith("Timelock: action not signalled")
  })

  it("addExcludedToken", async () => {
    const gmx = await deployContract("GMX", [])
    await expect(timelock.connect(user0).addExcludedToken(gmx.address))
      .to.be.revertedWith("Timelock: forbidden")

    expect(await timelock.excludedTokens(gmx.address)).eq(false)
    await timelock.connect(wallet).addExcludedToken(gmx.address)
    expect(await timelock.excludedTokens(gmx.address)).eq(true)
  })

  it("setInPrivateTransferMode", async () => {
    const gmx = await deployContract("GMX", [])
    await gmx.setMinter(wallet.address, true)
    await gmx.mint(user0.address, 100)
    await expect(timelock.connect(user0).setInPrivateTransferMode(gmx.address, true))
      .to.be.revertedWith("Timelock: forbidden")

    await expect(timelock.connect(wallet).setInPrivateTransferMode(gmx.address, true))
      .to.be.revertedWith("BaseToken: forbidden")

    await gmx.setGov(timelock.address)

    expect(await gmx.inPrivateTransferMode()).eq(false)
    await timelock.connect(wallet).setInPrivateTransferMode(gmx.address, true)
    expect(await gmx.inPrivateTransferMode()).eq(true)

    await timelock.connect(wallet).setInPrivateTransferMode(gmx.address, false)
    expect(await gmx.inPrivateTransferMode()).eq(false)

    await timelock.connect(wallet).setInPrivateTransferMode(gmx.address, true)
    expect(await gmx.inPrivateTransferMode()).eq(true)

    await expect(gmx.connect(user0).transfer(user1.address, 100))
      .to.be.revertedWith("BaseToken: msg.sender not whitelisted")

    await timelock.addExcludedToken(gmx.address)
    await expect(timelock.connect(wallet).setInPrivateTransferMode(gmx.address, true))
      .to.be.revertedWith("Timelock: invalid _inPrivateTransferMode")

    await timelock.connect(wallet).setInPrivateTransferMode(gmx.address, false)
    expect(await gmx.inPrivateTransferMode()).eq(false)

    await gmx.connect(user0).transfer(user1.address, 100)
  })

  it("testBridge", async () => {
    const gmx = await deployContract("GMX", [])
    const wgmx = await deployContract("GMX", [])
    const bridge = await deployContract("Bridge", [gmx.address, wgmx.address])

    await gmx.setMinter(wallet.address, true)
    await gmx.mint(wallet.address, 100)

    await wgmx.setMinter(wallet.address, true)
    await wgmx.mint(bridge.address, 100)

    await expect(timelock.connect(user0).setInPrivateTransferMode(gmx.address, true))
      .to.be.revertedWith("Timelock: forbidden")

    await expect(timelock.connect(wallet).setInPrivateTransferMode(gmx.address, true))
      .to.be.revertedWith("BaseToken: forbidden")

    await gmx.setGov(timelock.address)

    expect(await gmx.inPrivateTransferMode()).eq(false)
    await timelock.connect(wallet).setInPrivateTransferMode(gmx.address, true)
    expect(await gmx.inPrivateTransferMode()).eq(true)

    await expect(gmx.connect(user0).transfer(user1.address, 100))
      .to.be.revertedWith("BaseToken: msg.sender not whitelisted")

    await expect(timelock.connect(user0).testBridge(bridge.address, gmx.address, 100, user1.address))
      .to.be.revertedWith("Timelock: forbidden")

    await gmx.connect(wallet).approve(timelock.address, 100)

    expect(await gmx.balanceOf(wallet.address)).eq(100)
    expect(await gmx.balanceOf(bridge.address)).eq(0)
    expect(await wgmx.balanceOf(user1.address)).eq(0)
    expect(await wgmx.balanceOf(bridge.address)).eq(100)

    await timelock.testBridge(bridge.address, gmx.address, 100, user1.address)

    expect(await gmx.balanceOf(wallet.address)).eq(0)
    expect(await gmx.balanceOf(bridge.address)).eq(100)
    expect(await wgmx.balanceOf(user1.address)).eq(100)
    expect(await wgmx.balanceOf(bridge.address)).eq(0)

    await timelock.addExcludedToken(gmx.address)
    await expect(timelock.connect(wallet).testBridge(bridge.address, gmx.address, 100, user1.address))
      .to.be.revertedWith("Timelock: _token is excluded")
  })

  it("setAdmin", async () => {
    await expect(timelock.setAdmin(user1.address))
      .to.be.revertedWith("Timelock: forbidden")

    expect(await timelock.admin()).eq(wallet.address)
    await timelock.connect(tokenManager).setAdmin(user1.address)
    expect(await timelock.admin()).eq(user1.address)
  })
})
