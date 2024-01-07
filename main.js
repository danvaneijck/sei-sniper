const SeiSniper = require("./snipe")

const LIVE_TRADING = true

const CONFIG = {
    live: LIVE_TRADING,
    rpc: "https://rpc.sei-apis.com/",
    rest: "https://rest.sei-apis.com/",
    chainId: "pacific-1",
    tokenTypes: [
        'native',
        'tokenFactory',
        'cw20'
    ],
    pairType: '{"xyk":{}}',         // only basic 50 / 50 liquidity pairs
    maxSpread: 0.49,                // %
    snipeAmount: 1,                 // sei
    profitGoalPercent: 10,          // %
    moonBagPercent: 0,              // %
    stopLoss: 20,                   // %
    tradeTimeLimit: 5,              // minutes
    lowLiquidityThreshold: 500,     // USD $
    highLiquidityThreshold: 100000, // USD $
}

const main = async () => {

    const seiSniper = new SeiSniper(CONFIG);

    await seiSniper.initialize();

    seiSniper.startMonitoringBasePair(2)
    seiSniper.setMonitorNewPairs(true)

};

main();
