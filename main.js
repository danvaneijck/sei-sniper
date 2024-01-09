const SeiSniper = require("./modules/snipe")

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
    snipeAmount: 5,                 // sei
    profitGoalPercent: 20,          // %
    moonBagPercent: 0.10,           // %
    stopLoss: 20,                   // %
    tradeTimeLimit: 5,              // minutes
    lowLiquidityThreshold: 2500,    // USD $
    highLiquidityThreshold: 100000, // USD $
    discordMessagesEnabled: true
}

const main = async () => {

    const seiSniper = new SeiSniper(CONFIG);

    await seiSniper.initialize();
    await seiSniper.getPortfolio()

    seiSniper.startMonitoringBasePair(2)
    seiSniper.setMonitorNewPairs(true)
    seiSniper.setMonitorRugs(true)

};

main();
