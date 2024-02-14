const SeiSniper = require("./modules/Snipe")

const LIVE_TRADING = false

const seiyanRPC = "https://rpc.seiyan.tech"
const seiyanREST = "https://rest.seiyan.tech"

const rpc = "https://rpc.sei-apis.com/"
const rest = "https://rest.sei-apis.com/"

const CONFIG = {
    live: LIVE_TRADING,
    rpc: rpc,
    rest: rest,
    chainId: "pacific-1",
    tokenTypes: [
        'native',
        'tokenFactory',
        'cw20'
    ],
    pairType: '{"xyk":{}}',         // only basic 50 / 50 liquidity pairs
    maxSpread: 0.49,                // %
    snipeAmount: 5,                 // sei
    profitGoalPercent: 40,          // %
    moonBagPercent: 0.20,           // %
    stopLoss: 40,                   // %
    tradeTimeLimit: 30,             // minutes
    lowLiquidityThreshold: 4000,    // USD $
    highLiquidityThreshold: 100000, // USD $
    discordMessagesEnabled: true
}

const main = async () => {

    const seiSniper = new SeiSniper(CONFIG);

    await seiSniper.initialize();
    await seiSniper.getPortfolio()

    seiSniper.startMonitoringBasePair(10)
    seiSniper.setMonitorNewPairs(true)
    seiSniper.setMonitorRugs(true)

};

main();
