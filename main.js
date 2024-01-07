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
    profitGoalPercent: 40, // %
    stopLoss: 20, // %
    tradeTimeLimit: 1, // mins
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

    // let pair = await seiSniper.getPairInfo("sei1g6a4eplx6j73cvcm22ulv5vvqpahatlhgu90azlvjvzhslnld8mql4lak3")
    // seiSniper.monitorPairToSell(pair, 5)
};

main();
