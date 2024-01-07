const SeiSniper = require("./snipe")

const LIVE_TRADING = true

const CONFIG = {
    live: LIVE_TRADING,
    rpc: "https://rpc.sei-apis.com/",
    rest: "https://rest.sei-apis.com/",
    chainId: "pacific-1",
    tokenTypes: ['native', 'tokenFactory', 'cw20'],
    pairType: '{"xyk":{}}',
    maxSpread: 0.49,
    snipeAmount: 1, // SEI
    profitGoalPercent: 35, // %
    stopLoss: 50, // %
    tradeTimeLimit: 600, // mins
    lowLiquidityThreshold: 500, // USD
    highLiquidityThreshold: 100000, // USD
}

const main = async () => {

    const seiSniper = new SeiSniper(CONFIG);

    await seiSniper.initialize();
    // await seiSniper.updateLiquidityAllPairs()

    // seiSniper.allPairs.forEach((pair) => {
    //     console.log(`${pair.token0Meta.symbol} / ${pair.token1Meta.symbol} liquidity: $${pair.liquidity}, ${pair.coinhallLink}`)
    // })

    seiSniper.startMonitoringBasePair(2)
    seiSniper.setMonitorNewPairs(true)

    // let pair = await seiSniper.getPairInfo("sei17pcj9gjz29d3x5kh4tu5hkl988jfjmzk56rgxa0u84g5rwkcfqdqvp47gu")
    // seiSniper.monitorPairForPriceChange(pair, 5, 5, 5)
};

main();
