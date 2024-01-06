const SeiSniper = require("./snipe")

const LIVE_TRADING = false

const CONFIG = {
    live: LIVE_TRADING,
    rpc: "https://sei-rpc.brocha.in/",
    rest: "https://sei-rest.brocha.in/",
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

    seiSniper.allPairs.forEach((pair) => {
        console.log(`${pair.token0Meta.symbol} / ${pair.token1Meta.symbol} liquidity: $${pair.liquidity}, ${pair.coinhallLink}`)
    })

    seiSniper.startMonitoringBasePair(2)
    seiSniper.setMonitorNewPairs(true)
};

main();
