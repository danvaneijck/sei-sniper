const SeiTokenGen = require("./modules/TokenGen")
require('dotenv').config();

const rpc = "https://rpc.sei-apis.com/"
const rest = "https://rest.sei-apis.com/"
const chainId = "pacific-1"
const astroFactory = process.env.FACTORY_CONTRACT
const astroRouter = process.env.ROUTER_CONTRACT

// const rpc = "https://rpc.atlantic-2.seinetwork.io/"
// const rest = "https://rest.atlantic-2.seinetwork.io/"
// const chainId = "atlantic-2"
// const astroFactory = "sei1cp0hjmhwn9mz8rd4t29zjx2sks5mlxsjzhch2ef3yr4q2ssqwuvst5lyc9"
// const astroRouter = "sei1n389228apfytkxgvjkwl3acakgl8evpx7z5nghwvluhwsjwq37gqjatsxy"

const CONFIG = {
    rpc: rpc,
    rest: rest,
    chainId: chainId,
    astroFactory: astroFactory,
    astroRouter: astroRouter,
    pairType: '{"xyk":{}}',
    discordMessagesEnabled: true
}

const main = async () => {

    const module = new SeiTokenGen(CONFIG);

    await module.initialize();

    // await module.createDenom("moonBOI")

    let tokens = await module.getDenomFromCreator(module.publicKey)

    let token = tokens[0]

    // let mintAmount = 69000000
    // let seiAmount = 5000000

    // await module.mint(token, mintAmount)
    // await module.createPair(token)
    // await new Promise(resolve => setTimeout(resolve, 2000));

    let address = await module.getPairAddress(token)

    // await module.provideLiquidity(address, token, mintAmount, seiAmount) // 100% of tokens 

    // await module.getPairInfo(address)

    await module.withdrawLiquidity(address, token)

};

main();
