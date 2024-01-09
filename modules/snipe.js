
const { getCosmWasmClient,
    getQueryClient,
    restoreWallet,
    getSigningCosmWasmClient,
} = require("@sei-js/core");
const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const { SlashCommandBuilder } = require('@discordjs/builders');
const moment = require('moment');
const fs = require('fs/promises');
const path = require('path')
const TransactionManager = require("./transactions")
var colors = require("colors");
colors.enable();
require('dotenv').config();

class SeiSniper {
    constructor(config) {
        this.rpc = config.rpc
        this.rest = config.rest
        this.live = config.live

        this.chainId = config.chainId

        this.astroFactory = process.env.FACTORY_CONTRACT;
        this.astroRouter = process.env.ROUTER_CONTRACT;

        this.pairType = config.pairType
        this.tokenTypes = config.tokenTypes

        this.monitorNewPairs = false
        this.monitorRugs = false

        this.baseAssetName = "SEI"
        this.baseDenom = "usei"
        this.baseAssetPrice = 0;

        this.tokenTypes = ['native', 'tokenFactory'];
        this.pairType = '{"xyk":{}}';

        this.lowLiquidityThreshold = config.lowLiquidityThreshold
        this.highLiquidityThreshold = config.highLiquidityThreshold

        this.snipeAmount = config.snipeAmount
        this.profitGoalPercent = config.profitGoalPercent
        this.moonBagPercent = config.moonBagPercent
        this.stopLoss = config.stopLoss
        this.maxSpread = config.maxSpread
        this.tradeTimeLimit = config.tradeTimeLimit

        this.positions = new Map()
        this.allPairs = new Map();
        this.ignoredPairs = new Set();
        this.ruggedPairs = new Set();
        this.withdrawLiqProcessedTx = new Set()

        this.pairPriceMonitoringIntervals = new Map();
        this.sellPairPriceMonitoringIntervals = new Map();
        this.lastPrices = new Map();
        this.monitoringBasePairIntervalId = null;

        this.discordToken = process.env.DISCORD_TOKEN;
        this.discordChannelId = process.env.DISCORD_CHANNEL;
        this.discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });
        this.discordMessagesEnabled = config.discordMessagesEnabled
        this.discordTag = `<@352761566401265664>`
    }

    async initialize() {
        try {
            this.wallet = await restoreWallet(process.env.MNEMONIC);
            this.signingCosmWasmClient = await getSigningCosmWasmClient(this.rpc, this.wallet);

            this.txManager = new TransactionManager(this.signingCosmWasmClient)

            this.accounts = await this.wallet.getAccounts()

            this.account = this.accounts[0]
            this.publicKey = this.accounts[0].address

            console.log(`restored wallet ${this.publicKey}`.bgGreen);

            this.cosmWasmClient = await getCosmWasmClient(this.rpc);
            this.queryClient = await getQueryClient(this.rest);

            console.log(`Init on RPC: ${this.rpc} | REST: ${this.rest}`.bgGreen)

            try {
                await this.loadFromFile();
                await this.updateBaseAssetPrice()
                this.setupDiscordCommands()
            } catch (error) {
                console.error('Error during initialization:', error);
            }

            this.discordClient.on('ready', async () => {
                console.log(`Logged in as ${this.discordClient.user.tag}!`.gray);
                await this.sendMessageToDiscord(
                    `:arrows_clockwise: Start up Sei Sniper on RPC: ${this.rpc} | REST: ${this.rest}\n` +
                    `:chart_with_upwards_trend: Trading mode: ${this.live ? ':exclamation: LIVE :exclamation:' : 'TEST'}\n` +
                    `:gun: Snipe amount: ${this.snipeAmount} ${this.baseAssetName} ($${(this.baseAssetPrice * this.snipeAmount).toFixed(2)})` +
                    ` targeting pairs between $${this.lowLiquidityThreshold} and $${this.highLiquidityThreshold} in liquidity`
                )
                this.discordClient.guilds.cache.forEach(guild => {
                    guild.commands.create(new SlashCommandBuilder()
                        .setName('get_positions')
                        .setDescription('Get portfolio positions for a wallet address')
                    );
                    guild.commands.create(new SlashCommandBuilder()
                        .setName('buy_token')
                        .addStringOption(option => option.setName('pair').setDescription('The pair to buy').setRequired(true))
                        .addNumberOption(option => option.setName('amount').setDescription('The amount to buy').setRequired(true))
                        .setDescription('Buy a token using the pair address')
                    );
                    guild.commands.create(new SlashCommandBuilder()
                        .setName('sell_token')
                        .addStringOption(option => option.setName('pair').setDescription('The pair to sell').setRequired(true))
                        .setDescription('Sell a token using the pair address')
                    );
                    guild.commands.create(new SlashCommandBuilder()
                        .setName('monitor_to_sell')
                        .addStringOption(option => option.setName('pair').setDescription('The pair to monitor').setRequired(true))
                        .setDescription('Monitor a pair for opportunity to sell')
                    );
                });
                console.log("set up discord slash commands".gray)
            });

            await this.discordClient.login(this.discordToken);

        } catch (error) {
            console.error('Error during initialization:', error);
        }
    }

    async getBalanceOfToken(denom) {
        let balance;
        if (!denom.includes("factory")) {
            balance = await this.cosmWasmClient.queryContractSmart(denom, {
                balance: { address: this.publicKey }
            })
            balance = balance.balance
        }
        else {
            balance = await this.queryClient.cosmos.bank.v1beta1.balance({
                address: this.publicKey,
                denom: denom
            })
            balance = balance.amount
        }
        if (!balance) return 0
        return balance
    }

    setupDiscordCommands() {
        this.discordClient.on('interactionCreate', async interaction => {
            if (!interaction.isCommand()) return;
            const { commandName } = interaction;
            if (commandName === 'get_positions') {
                await interaction.reply("Fetching wallet holdings...");
                if (this.positions.size > 5) {
                    this.setMonitorNewPairs(false)
                    await this.executeGetPositionsCommand();
                    this.setMonitorNewPairs(true)
                }
                else {
                    await this.executeGetPositionsCommand();
                }
            }
            if (commandName === 'buy_token') {
                await interaction.reply("Buying token");
                const pairContract = interaction.options.getString('pair');
                const amount = interaction.options.getNumber('amount');
                await this.executeBuyCommand(pairContract, amount);
            }
            if (commandName === 'sell_token') {
                await interaction.reply("Selling token");
                const pairContract = interaction.options.getString('pair');
                await this.executeSellCommand(pairContract);
            }
            if (commandName === 'monitor_to_sell') {
                await interaction.reply("Monitoring token to sell");
                const pairContract = interaction.options.getString('pair');
                await this.executeMonitorToSellCommand(pairContract);
            }
        });
    }

    async executeGetPositionsCommand() {
        try {
            const walletAddress = this.publicKey;
            const portfolio = await this.getPortfolio(walletAddress);
            const message = `**Current holdings for ${walletAddress}**\n${await this.formatPortfolioMessage(portfolio)}`;
            await this.sendMessageToDiscord(message)
        } catch (error) {
            console.error('Error executing /get_positions command:', error);
            await this.sendMessageToDiscord('Error executing /get_positions command')
        }
    }

    async executeBuyCommand(pairContract, amount) {
        try {
            let pair = await this.getPairInfo(pairContract)
            if (!pair) {
                this.sendMessageToDiscord(`Could not get pair`)
                return
            }
            await this.calculateLiquidity(pair)
            if (pair.liquidity < this.lowLiquidityThreshold) {

                return
            }
            let result = await this.buyMemeToken(pair, amount)
            if (result && !this.allPairs.has(pairContract)) {
                this.allPairs.set(pairContract, pair);
                this.ignoredPairs.delete(pairContract);
            }
        } catch (error) {
            console.error('Error executing /buy_token command:', error);
            await this.sendMessageToDiscord('Error executing /buy_token command')
        }
    }

    async executeSellCommand(pairContract) {
        try {
            let pair = await this.getPairInfo(pairContract)
            const memeTokenMeta = pair.token0Meta.denom === this.baseDenom
                ? pair.token1Meta
                : pair.token0Meta;
            let balance = await this.getBalanceOfToken(memeTokenMeta.denom);
            if (!balance) {
                balance = this.positions.get(pairContract).balance
            }
            if (balance && Number(balance) > 0) {
                let result = await this.sellMemeToken(pair, balance)
                if (result && !this.allPairs.has(pairContract)) {
                    this.allPairs.set(pairContract, pair);
                    this.ignoredPairs.delete(pairContract);
                }
            }
        } catch (error) {
            console.error('Error executing /sell_token command:', error);
            await this.sendMessageToDiscord('Error executing /sell_token command')
        }
    }

    async executeMonitorToSellCommand(pairContract) {
        try {
            let pair = await this.getPairInfo(pairContract)
            await this.monitorPairToSell(pair, 5)
            if (pair && !this.allPairs.has(pairContract)) {
                this.allPairs.set(pairContract, pair);
                this.ignoredPairs.delete(pairContract);
            }
        } catch (error) {
            console.error('Error executing /monitor_to_sell command:', error);
            await this.sendMessageToDiscord('Error executing /monitor_to_sell command')
        }
    }

    async loadFromFile() {
        try {
            this.allPairs = await this.loadMapFromFile('allPairs.json', 'contract_addr');
            this.positions = await this.loadMapFromFile('positions.json', 'pair_contract');
            this.ignoredPairs = await this.loadSetFromFile('ignoredPairs.json');
            this.ruggedPairs = await this.loadSetFromFile('ruggedPairs.json');
            this.withdrawLiqProcessedTx = await this.loadSetFromFile('withdrawLiqProcessedTx.json');

            console.log('Loaded data from files'.gray);
        } catch (error) {
            console.error('Error loading data from files:', error);
        }
    }

    async loadMapFromFile(filename, keyProperty) {
        const pairs = await this.readDataFromFile(filename);
        return new Map(pairs.map(item => [item[keyProperty], item]));
    }

    async loadSetFromFile(filename) {
        const items = await this.readDataFromFile(filename);
        return new Set(items);
    }

    async saveToFile() {
        try {
            await this.saveDataToFile('allPairs.json', Array.from(this.allPairs.values()));
            await this.saveDataToFile('positions.json', Array.from(this.positions.values()));
            await this.saveDataToFile('ignoredPairs.json', Array.from(this.ignoredPairs));
            await this.saveDataToFile('ruggedPairs.json', Array.from(this.ruggedPairs));
            await this.saveDataToFile('withdrawLiqProcessedTx.json', Array.from(this.withdrawLiqProcessedTx));
        } catch (error) {
            console.error('Error saving data to files:', error);
        }
    }

    async readDataFromFile(filename) {
        const filePath = path.resolve(__dirname, '..', 'data', filename);
        try {
            const data = await fs.readFile(filePath, 'utf-8');
            return JSON.parse(data);
        } catch (error) {
            return filename === 'positions.json' || filename === 'allPairs.json' ? new Map() : new Set();
        }
    }

    async saveDataToFile(filename, data) {
        const filePath = path.resolve(__dirname, '..', 'data', filename);

        try {
            await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
        } catch (error) {
            console.error(`Error saving ${filename} to file:`, error);
        }
    }

    async sendMessageToDiscord(message) {
        if (!this.discordClient || !this.discordChannelId) {
            console.error('Discord client or channel information not available.');
            return;
        }

        const channel = this.discordClient.channels.cache.get(this.discordChannelId);
        if (!channel) {
            console.error('Discord channel not found.');
            return;
        }

        if (!this.discordMessagesEnabled) {
            return;
        }

        try {
            await channel.send(message);
        } catch (error) {
            console.error('Error sending message to Discord channel:', error);
        }
    }

    async updateBaseAssetPrice() {
        try {
            let result = await this.queryClient.seiprotocol.seichain.oracle.exchangeRate({ denom: 'usei' })

            this.baseAssetPrice = parseFloat(result['oracle_exchange_rate']['exchange_rate'])

            if (this.discordClient && this.discordClient.user) {
                const activityText = `${this.baseAssetName}: $${this.baseAssetPrice.toFixed(3)}`;
                this.discordClient.user.setActivity(activityText, { type: ActivityType.Watching });
            }
            await this.saveToFile()
        }
        catch (error) {
            console.error(`Error when updating base asset price`, error.message || error)
        }
    }

    startMonitoringBasePair(intervalInSeconds) {
        console.log('Base Asset monitoring started.'.grey);
        this.monitoringBasePairIntervalId = setInterval(async () => {
            await this.updateBaseAssetPrice();
        }, intervalInSeconds * 1000);
    }

    stopMonitoringBasePair() {
        clearInterval(this.monitoringBasePairIntervalId);
        console.log('Base Asset monitoring stopped.');
    }

    async getTokenInfo(denom) {
        try {
            const token = await this.cosmWasmClient.queryContractSmart(denom, { token_info: {} })
            return token;
        } catch (error) {
            console.error('Error fetching token info:', denom, error.message || error);
            return {}
        }
    }

    async getDenomMetadata(denom) {
        try {
            const token = await this.queryClient.cosmos.bank.v1beta1.denomMetadata({ denom })
            return token;
        } catch (error) {
            return { metadata: { name: '', symbol: '' } }
        }
    }

    async getTokenFactoryMetaData(denom) {
        console.log("get token factory metadata")
        try {
            const token = await this.queryClient.seiprotocol.seichain.tokenfactory.denomAuthorityMetadata({
                denom: denom
            })
            console.log(token)
            return token;
        } catch (error) {
            console.log(error)
            return { metadata: { name: '', symbol: '' } }
        }
    }

    async getPairInfo(pairContract) {
        let retryCount = 0;

        while (retryCount < 1) {
            try {
                const pairQuery = { pair: {} }
                const queryResponse = await this.cosmWasmClient.queryContractSmart(pairContract, pairQuery);
                const assetInfos = queryResponse['asset_infos'];
                const tokenInfos = [];
                for (const assetInfo of assetInfos) {
                    const denom = assetInfo['native_token']
                        ? assetInfo['native_token']['denom']
                        : assetInfo['token']['contract_addr'];

                    let tokenInfo = undefined

                    if (denom.includes("ibc")) {
                        continue
                    }
                    if (denom === this.baseDenom || denom.includes("factory")) {
                        tokenInfo = await this.getDenomMetadata(denom)
                        if (denom.includes("factory")) {
                            let name = denom.split("/")[2]
                            tokenInfo['metadata']['name'] = name
                            tokenInfo['metadata']['symbol'] = name
                        }
                        tokenInfo = tokenInfo.metadata
                    }
                    else {
                        tokenInfo = await this.getTokenInfo(denom);
                    }

                    if (!tokenInfo) continue
                    tokenInfos.push({
                        denom: denom,
                        seiscanLink: `https://www.seiscan.app/pacific-1/contracts/${denom}`,
                        name: 'n/a',
                        symbol: 'n/a',
                        decimals: 6,
                        ...tokenInfo,
                    });
                }
                if (tokenInfos.length !== 2) return null
                const [token0Info, token1Info] = tokenInfos;

                return {
                    token0Meta: token0Info,
                    token1Meta: token1Info,
                    seiscanLink: `https://www.seiscan.app/pacific-1/contracts/${pairContract}`,
                    astroportLink: `https://app.astroport.fi/swap?from=${token0Info.denom}&to=${token1Info.denom}`,
                    coinhallLink: `https://coinhall.org/sei/${pairContract}`,
                    ...queryResponse
                };

            } catch (error) {
                console.error(`Error fetching pair ${pairContract} info:`, error);
            }
        }
        console.error(`Max retry count reached. Unable to fetch pair ${pairContract} info.`);
        return null;
    }

    async getQuote(pair, amount) {
        if (!pair) return
        const offerAmount = amount * Math.pow(10, 6);
        const pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;
        const simulationQuery = {
            simulation: {
                offer_asset: {
                    info: {
                        native_token: {
                            denom: this.baseDenom
                        }
                    },
                    amount: offerAmount
                }
            }
        };
        try {
            const query = simulationQuery
            const sim = await this.cosmWasmClient.queryContractSmart(pair.contract_addr, query);
            const decodedData = sim
            return decodedData;
        } catch (error) {
            console.error(`Error getting quote for ${pairName}: ${error}`);
        }
    }

    async getQuoteFromRouter(pair, amount) {
        if (!pair || !pair.asset_infos || !Array.isArray(pair.asset_infos)) {
            console.error(`Invalid pair or asset_infos for getQuoteFromRouter:`, pair);
            return;
        }

        const pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;
        const askAssetIndex = pair.asset_infos.findIndex((assetInfo) => {
            if (assetInfo.token) {
                return assetInfo.token.contract_addr !== this.baseDenom;
            } else if (assetInfo.native_token) {
                return assetInfo.native_token.denom !== this.baseDenom;
            } else {
                return false;
            }
        })
        if (askAssetIndex === -1) {
            console.error(`Error finding ask asset for ${pairName}`);
            return null
        }

        const askAssetInfo = pair.asset_infos[askAssetIndex];
        const offerAmount = amount * Math.pow(10, 6);

        const simulationQuery = {
            simulate_swap_operations: {
                offer_amount: offerAmount.toString(),
                operations: [
                    {
                        astro_swap: {
                            offer_asset_info: {
                                native_token: {
                                    denom: this.baseDenom
                                }
                            },
                            ask_asset_info: askAssetInfo
                        }
                    }
                ]
            }
        };


        try {
            const query = simulationQuery
            const sim = await this.cosmWasmClient.queryContractSmart(this.astroRouter, query);
            const decodedData = sim
            return decodedData;
        } catch (error) {
            console.error(`Error getting quote for ${pairName}: ${error}`);
            return null
        }
    }

    async getSellQuoteFromRouter(pair, amount) {
        const pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;

        try {
            if (!pair || !pair.asset_infos || !Array.isArray(pair.asset_infos)) {
                throw new Error(`Invalid pair or asset_infos for getSellQuoteFromRouter: ${pair}`);
            }

            const assetToSell = pair.asset_infos.findIndex(assetInfo => {
                const isNativeToken = assetInfo.native_token && assetInfo.native_token.denom !== this.baseDenom;
                const isCW20Token = assetInfo.token && assetInfo.token.contract_addr !== this.baseTokenContractAddr;
                return isNativeToken || isCW20Token;
            });

            if (assetToSell === -1) {
                throw new Error(`Error finding ask asset for ${pairName}`);
            }
            const assetInfo = pair.asset_infos[assetToSell];

            const simulationQuery = {
                simulate_swap_operations: {
                    offer_amount: amount.toString(),
                    operations: [
                        {
                            astro_swap: {
                                offer_asset_info: assetInfo,
                                ask_asset_info: {
                                    native_token: {
                                        denom: this.baseDenom
                                    }
                                }
                            }
                        }
                    ]
                }
            };

            const query = simulationQuery
            const sim = await this.cosmWasmClient.queryContractSmart(this.astroRouter, query);
            const decodedData = sim
            return decodedData;
        } catch (error) {
            console.error(`Error getting sell quote for ${pairName}: ${error}`);
            return null;
        }
    }

    async calculateLiquidity(pair) {
        if (!pair) return
        try {
            const poolQuery = { pool: {} }
            let poolInfo = await this.cosmWasmClient.queryContractSmart(pair.contract_addr, poolQuery);

            const baseAssetAmount = poolInfo.assets.find(asset => {
                if (asset.info.native_token) {
                    return asset.info.native_token.denom === this.baseDenom
                } else if (asset.info.token) {
                    return asset.info.token.contract_addr === this.baseDenom
                }
                return false;
            })?.amount || 0;

            let stableDecimals = 0

            const baseAssetDecimals = 6;
            const baseAssetPrice = this.baseAssetPrice || 0;

            const numericBaseAssetAmount = Number(baseAssetAmount) / 10 ** baseAssetDecimals;
            let liquidity = numericBaseAssetAmount * baseAssetPrice;
            liquidity = (liquidity * 2) / Math.pow(10, stableDecimals)
            pair.liquidity = liquidity
            pair.liquidityUpdate = moment()

            return liquidity;
        } catch (error) {
            console.error('Error calculating liquidity:', error.originalMessage ?? error);
            return null;
        }
    }

    async monitorPairForPriceChange(pair, intervalInSeconds, trackingDurationMinutes, priceChangeThreshold) {
        try {
            let pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;
            if (this.pairPriceMonitoringIntervals.has(pair.contract_addr)) {
                console.log(`Pair ${pairName} is already being monitored.`);
                return;
            }

            let lastPrices = this.lastPrices.get(pair.contract_addr) || [];

            const monitoringIntervalId = setInterval(async () => {
                const updatedPair = await this.getPairInfo(pair.contract_addr);
                if (!updatedPair) return
                this.allPairs.set(pair.contract_addr, updatedPair)

                const quote = await this.getQuoteFromRouter(updatedPair, 1);
                if (!quote) return
                const currentPrice = this.baseAssetPrice / parseFloat(quote['amount'] / Math.pow(10, 6))

                lastPrices.push(currentPrice);
                lastPrices = lastPrices.slice(-trackingDurationMinutes * 60 / intervalInSeconds);

                const newHighestPrice = Math.max(...lastPrices, 0);
                const newLowestPrice = Math.min(...lastPrices, Infinity);

                const priceChangeToHighest = ((currentPrice - newHighestPrice) / newHighestPrice) * 100;
                const priceChangeToLowest = ((currentPrice - newLowestPrice) / newLowestPrice) * 100;

                await this.calculateLiquidity(pair)

                if (pair.liquidity < 1) {
                    let message = `:small_red_triangle_down: ${pairName} rugged!`
                    this.sendMessageToDiscord(message);
                }
                else {
                    if (Math.abs(priceChangeToHighest) > priceChangeThreshold) {
                        let message = `:small_red_triangle_down: ${pairName} Price is down ${parseFloat(priceChangeToHighest).toFixed(2)}% in the last ` +
                            `${trackingDurationMinutes} minutes. current: $${parseFloat(currentPrice).toFixed(10)}, ` +
                            `high: $${newHighestPrice.toFixed(10)}, liquidity: $${Math.round(pair.liquidity)}\n` +
                            `${pair.coinhallLink}\n${pair.astroportLink}`
                        this.sendMessageToDiscord(message);
                        this.lastPrices.delete(pair.contract_addr);
                        lastPrices = [];
                    }

                    if (priceChangeToLowest > priceChangeThreshold) {
                        let message = `:green_circle: ${pairName} price is up ${parseFloat(priceChangeToLowest).toFixed(2)}% in the last ` +
                            `${trackingDurationMinutes} minutes. current: $${parseFloat(currentPrice).toFixed(10)}, ` +
                            `low: $${newLowestPrice.toFixed(10)}, liquidity: $${Math.round(pair.liquidity)}\n` +
                            `${pair.coinhallLink}\n${pair.astroportLink}`;
                        this.sendMessageToDiscord(message);
                        this.lastPrices.delete(pair.contract_addr);
                        lastPrices = [];
                    }
                }

                console.log(`${pairName} price $${parseFloat(currentPrice).toFixed(12)}, liquidity: $${Math.round(pair.liquidity)}`.yellow)

                if (currentPrice == Infinity || pair.liquidity < 1) {
                    this.stopMonitoringPairForPriceChange(pair)
                }
            }, intervalInSeconds * 1000);

            this.pairPriceMonitoringIntervals.set(pair.contract_addr, monitoringIntervalId);

            console.log(`Price - Monitoring started for ${pairName}.`.bgCyan);
        } catch (error) {
            console.error('Error monitoring pair:', error);
        }
    }

    stopMonitoringPairForPriceChange(pair) {
        let pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`
        if (this.pairPriceMonitoringIntervals.has(pair.contract_addr)) {
            clearInterval(this.pairPriceMonitoringIntervals.get(pair.contract_addr));
            this.pairPriceMonitoringIntervals.delete(pair.contract_addr);

            console.log(`Monitoring stopped for ${pairName}.`.bgYellow);
        } else {
            console.log(`Pair ${pairName} is not being monitored.`.gray);
        }
    }

    async getPortfolio() {
        console.log("fetching portfolio".bgCyan)
        try {
            let balances = await this.queryClient.cosmos.bank.v1beta1.allBalances({
                address: this.publicKey
            })
            for (const position of this.positions.values()) {
                let denom = position.token_denom;

                let balance = await this.getBalanceOfToken(denom);
                let pair = this.allPairs.get(position.pair_contract)

                await this.calculateLiquidity(pair)
                if (pair.liquidity < 2 || balance == 0) {
                    this.positions.delete(pair.contract_addr)
                }

                if (pair.liquidity > 2 && !balances.balances.find(b => b.denom === denom)) {
                    balances.balances.push({
                        denom: denom,
                        amount: balance
                    });
                }
            }
            return balances
        } catch (error) {
            console.error('Error fetching account portfolio:', error);
        }
    }

    async updateLiquidityAllPairs() {
        console.log("update liquidity for all pairs")
        for (const pair of this.allPairs.values()) {
            await this.calculateLiquidity(pair);
            if (pair.liquidity < 10 && pair.liquidity > 0 && !this.positions.has(pair.contract_addr)) {
                this.allPairs.delete(pair.contract_addr)
                this.ignoredPairs.add(pair.contract_addr)
            }
        }
        await this.saveToFile()
    }

    async buyMemeToken(pair, amount, retries = 5) {
        if (!pair || !this.live) {
            console.error("Invalid pair or live trading not enabled");
            return;
        }

        const { token0Meta, token1Meta } = pair;
        const baseTokenMeta = token0Meta.denom === this.baseDenom ? token0Meta : token1Meta;
        const memeTokenMeta = token0Meta.denom === this.baseDenom ? token1Meta : token0Meta;

        console.log(`Attempting to buy ${memeTokenMeta.symbol}`);

        const adjustedAmount = amount * 10 ** (6);

        const swapOperations = {
            swap: {
                offer_asset: {
                    info: {
                        native_token: {
                            denom: baseTokenMeta.denom,
                        },
                    },
                    amount: adjustedAmount.toString(),
                },
                max_spread: this.maxSpread.toString(),
            },
        };

        const msg = {
            contractAddress: pair.contract_addr,
            sender: this.publicKey,
            msg: swapOperations,
            funds: [{
                denom: this.baseDenom,
                amount: adjustedAmount.toString(),
            }],
        };

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const result = await this.txManager.enqueue(msg);
                if (result) {
                    await this.sendMessageToDiscord(`Buy executed successfully: https://www.seiscan.app/pacific-1/txs/${result.transactionHash}`)
                    console.log(`Swap executed successfully: https://www.seiscan.app/pacific-1/txs/${result.transactionHash}`.bgGreen);

                    const returnAmount = this.parseReturnAmountFromEvents(result);

                    if (returnAmount !== undefined) {
                        this.handleSuccessfulSwap(pair, returnAmount, adjustedAmount, memeTokenMeta);
                        await this.monitorPairToSell(pair, 10);
                    } else {
                        console.error("Return amount not found in events.");
                    }

                    return result;
                }
                console.log(`Buy attempt ${attempt} failed. Retrying...`);
            } catch (error) {
                console.error(`Error executing swap (attempt ${attempt}):`, error);
            }
        }

        console.error(`Failed to execute swap after ${retries} attempts.`);
    }

    parseReturnAmountFromEvents(result) {
        const events = result.events;
        if (!events) return undefined;
        const wasmEvents = events.filter((event) => event.type === "wasm");
        if (wasmEvents.length < 1) return undefined;
        for (const i in wasmEvents) {
            let wasmEvent = wasmEvents[i]
            const returnAmountAttribute = wasmEvent.attributes.find((attr) => attr.key === "return_amount");
            if (returnAmountAttribute) {
                return returnAmountAttribute.value
            }
        }
        return undefined
    }

    handleSuccessfulSwap(pair, returnAmount, adjustedAmount, memeTokenMeta) {
        const balance = this.positions.get(pair.contract_addr)?.balance || 0;
        const profit = this.positions.get(pair.contract_addr)?.profit || 0;
        const amountIn = this.positions.get(pair.contract_addr)?.amount_in || 0;

        console.log(`${memeTokenMeta.denom} existing balance ${balance}`)
        const updatedBalance = Number(balance) + Number(returnAmount);
        console.log(`${memeTokenMeta.denom} updated balance ${updatedBalance}`)

        this.positions.set(pair.contract_addr, {
            pair_contract: pair.contract_addr,
            balance: updatedBalance,
            amount_in: Number(amountIn) + Number(adjustedAmount),
            token_denom: memeTokenMeta.denom,
            time_bought: moment(),
            profit: profit,
            is_moon_bag: false
        });

        console.log(this.positions.get(pair.contract_addr))

        this.sendMessageToDiscord(`:gun: Sniped token ${memeTokenMeta.symbol}! ` +
            `Balance: ${(updatedBalance / 10 ** memeTokenMeta.decimals).toFixed(3)} ` +
            `${this.discordTag}\n${pair.coinhallLink}`);
    }

    async sellMemeToken(pair, amount = null, maxRetries = 3) {
        if (!pair) {
            console.error("Invalid pair for sellMemeToken");
            return;
        }

        if (!this.live) {
            console.error("Live trading not enabled");
            return;
        }

        const memeTokenMeta = pair.token0Meta.denom === this.baseDenom
            ? pair.token1Meta
            : pair.token0Meta;

        console.log(`Attempting to sell token ${memeTokenMeta.symbol}`)

        const assetToSell = pair.asset_infos.findIndex(assetInfo => {
            const isNativeToken = assetInfo.native_token && assetInfo.native_token.denom !== this.baseDenom;
            const isCW20Token = assetInfo.token && assetInfo.token.contract_addr !== this.baseTokenContractAddr;
            return isNativeToken || isCW20Token;
        });

        if (assetToSell === -1) {
            throw new Error(`Error finding ask asset for ${pairName}`);
        }
        const assetInfo = pair.asset_infos[assetToSell];

        let position = this.positions.get(pair.contract_addr);

        if (!amount) {
            if (position) {
                console.log("get balance from positions")
                amount = this.positions.get(pair.contract_addr).balance;
            } else {
                console.log("get balance from bank")
                amount = await this.getBalanceOfToken(memeTokenMeta.denom);
            }
        }

        if (!amount) {
            console.log(`No balance to sell for ${memeTokenMeta.symbol}`)
            return
        }

        amount = Math.round(amount)

        let spread = this.maxSpread
        let retryCount = 0;
        while (retryCount < maxRetries) {
            const swapOperations = {
                swap: {
                    offer_asset: {
                        info: assetInfo,
                        amount: amount.toString(),
                    },
                    max_spread: spread.toString(),
                },
            };

            let msg = {
                contractAddress: pair.contract_addr,
                sender: this.publicKey,
                msg: swapOperations,
                funds: [{
                    denom: memeTokenMeta.denom,
                    amount: amount.toString(),
                }],
            };

            // is cw20
            if (!memeTokenMeta.denom.includes("factory")) {
                msg = {
                    contractAddress: memeTokenMeta.denom,
                    sender: this.publicKey,
                    msg: {
                        "send": {
                            "amount": amount.toString(),
                            "contract": pair.contract_addr,
                            "msg": btoa(JSON.stringify({
                                swap: {
                                    ask_asset_info: {
                                        native_token: {
                                            denom: this.baseDenom
                                        }
                                    },
                                    max_spread: spread.toString(),
                                }
                            }))
                        }
                    },
                };
            }

            try {
                console.log(`Attempting sell with spread: ${spread.toString()}`)
                let result = await this.txManager.enqueue(msg);

                if (!result) {
                    console.log("Sell failed".bgRed);
                    retryCount += 1;
                    spread += 0.2
                    if (!amount) {
                        console.log("refreshing balance, attempting sell again")
                        amount = await this.getBalanceOfToken(memeTokenMeta.denom);
                        amount = Math.round(amount)
                    }
                }
                else {
                    this.stopMonitoringPairToSell(pair)
                    await this.sendMessageToDiscord(`Sell executed successfully: https://www.seiscan.app/pacific-1/txs/${result.transactionHash}`)

                    console.log(`Swap executed successfully: https://www.seiscan.app/pacific-1/txs/${result.transactionHash}`.bgGreen);

                    let profit = 0
                    const returnAmount = this.parseReturnAmountFromEvents(result);
                    if (returnAmount !== undefined) {
                        profit = returnAmount - (position.amount_in + position.profit)
                    } else {
                        console.error("Return amount not found in sell events.");
                    }

                    let updatedBalance = Number(position.balance) - Number(amount)
                    let updatedAmountIn = Number(position.amount_in) - Number(returnAmount)
                    if (updatedAmountIn < 0) {
                        updatedAmountIn = 0
                    }

                    this.positions.set(pair.contract_addr, {
                        ...position,
                        amount_in: updatedAmountIn,
                        balance: updatedBalance,
                        profit: Number(position.profit) + Number(profit),
                        is_moon_bag: updatedBalance > 0 && updatedAmountIn == 0
                    });

                    profit = (profit / Math.pow(10, 6))
                    let returnAmountAdjusted = (returnAmount / Math.pow(10, 6))

                    const baseAssetPriceConverted = this.baseAssetPrice / Math.pow(10, 0)
                    const usdValue = (profit * baseAssetPriceConverted)

                    this.sendMessageToDiscord(
                        `${profit > 0 ? ':dollar:' : ':small_red_triangle_down:'} ` +
                        `Sold token ${memeTokenMeta.symbol} for ${returnAmountAdjusted.toFixed(4)} ${this.baseAssetName}. ` +
                        `PnL: ${profit > 0 ? '+' : ''}${profit.toFixed(4)} ${this.baseAssetName} ($${usdValue.toFixed(2)}) ${this.discordTag}\n${pair.coinhallLink}`
                    );
                    return result;
                }
            } catch (error) {
                console.error(`Error executing swap (Attempt ${retryCount + 1}/${maxRetries}):`, error);
                retryCount += 1;
                spread += 0.2
            }
        }
        console.error(`Exceeded maximum retry attempts (${maxRetries}). Sell operation failed.`);
        this.sendMessageToDiscord(`Failed to sell token ${memeTokenMeta.symbol} ${pair.coinhallLink} ${this.discordTag}`)

        return null
    }

    async formatPortfolioMessage(portfolio) {
        let formattedMessage = '';

        for (const balance of portfolio.balances) {
            if (Number(balance.amount) <= 0 || !balance.amount) continue;
            if (balance.denom === this.baseDenom) {
                let usdValue = this.baseAssetPrice * (balance.amount / Math.pow(10, 6))
                formattedMessage += `${this.baseAssetName}: ${(balance.amount / Math.pow(10, 6)).toFixed(2)} :dollar: $${usdValue.toFixed(2)}\n`
                continue
            }

            const pair = Array.from(this.allPairs.values()).find(pair => {
                return (
                    pair.token0Meta.denom === balance.denom ||
                    pair.token1Meta.denom === balance.denom
                );
            });

            if (pair) {
                const tokenDenom = pair.token0Meta.denom !== this.baseDenom
                    ? pair.token0Meta
                    : pair.token1Meta;

                const quote = await this.getSellQuoteFromRouter(pair, balance.amount);

                if (quote) {
                    const amountBack = (quote.amount / Math.pow(10, 6)).toFixed(3);
                    const convertedQuote = quote.amount / Math.pow(10, 6)
                    const baseAssetPriceConverted = this.baseAssetPrice / Math.pow(10, 0)

                    const usdValue = (convertedQuote * baseAssetPriceConverted)

                    if (usdValue.toFixed(2) > 0) {
                        formattedMessage += `${(balance.amount / Math.pow(10, tokenDenom.decimals)).toFixed(2)} ` +
                            `${tokenDenom.symbol} (${amountBack} ${this.baseAssetName} :dollar: $${usdValue.toFixed(2)}) ` +
                            `liquidity: $${pair.liquidity.toFixed(2)} ${pair.contract_addr}\n`;
                    }
                }
            }
        }

        return formattedMessage.trim();
    }

    async monitorPairToSell(pair, intervalInSeconds) {
        try {
            let pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;

            if (this.sellPairPriceMonitoringIntervals.has(pair.contract_addr)) {
                console.log(`Pair ${pairName} is already being monitored to sell.`);
                return;
            }

            const monitoringIntervalId = setInterval(async () => {
                const updatedPair = await this.getPairInfo(pair.contract_addr);
                if (!updatedPair) return
                this.allPairs.set(pair.contract_addr, updatedPair)

                let position = this.positions.get(pair.contract_addr)

                const quote = await this.getSellQuoteFromRouter(updatedPair, position.balance);

                const tokenDenom = pair.token0Meta.denom === position.token_denom
                    ? pair.token0Meta
                    : pair.token1Meta;

                let result = null;

                let currentTime = moment()
                if (currentTime > moment(position.time_bought).add(this.tradeTimeLimit, 'minute')) {
                    console.log(`trade time limit reached (${this.tradeTimeLimit} minutes)`)
                    await this.sendMessageToDiscord(`trade time limit reached for ${pairName} (${this.tradeTimeLimit} minutes)`)
                    this.stopMonitoringPairToSell(pair)
                    let balance = await this.getBalanceOfToken(tokenDenom.denom);
                    result = await this.sellMemeToken(pair, balance)
                    return
                }

                if (quote) {
                    const baseAssetPriceConverted = this.baseAssetPrice / Math.pow(10, 0)
                    const convertedQuote = quote.amount / Math.pow(10, 6)
                    const amountBack = (quote.amount / Math.pow(10, 6)).toFixed(3);
                    const usdValue = (convertedQuote * baseAssetPriceConverted)
                    const convertedBalance = position.balance / Math.pow(10, tokenDenom.decimals)
                    const price = usdValue / convertedBalance

                    const moonBagGoal = Math.round((this.snipeAmount * 5) * Math.pow(10, 6))

                    if (position.is_moon_bag && Number(quote.amount) > Number(moonBagGoal)) {
                        console.log(`taking profit on moon bag for ${tokenDenom.symbol}`)
                        this.stopMonitoringPairToSell(pair)
                        result = await this.sellMemeToken(pair, position.balance)
                        return
                    }
                    if (position.is_moon_bag) {
                        console.log(`${pairName} moon bag balance: ${(convertedBalance).toFixed(2)} ${tokenDenom.symbol}, ` +
                            `price: $${price.toFixed(8)} (${amountBack} ${this.baseAssetName} $${usdValue.toFixed(2)})`)
                        return
                    }

                    let amountIn = position.amount_in + position.profit

                    const percentageIncrease = ((quote.amount - amountIn) / amountIn) * 100;

                    if (percentageIncrease <= this.stopLoss * -1 && quote.amount < amountIn) {
                        console.log(`stop loss hit for ${tokenDenom.symbol} ${percentageIncrease}%`.bgRed)
                        await this.sendMessageToDiscord(`stop loss hit for ${tokenDenom.symbol} ${percentageIncrease.toFixed(2)}% ${this.discordTag}`)
                        this.stopMonitoringPairToSell(pair)

                        let liquidity = await this.calculateLiquidity(pair)
                        if (liquidity < 1) return

                        result = await this.sellMemeToken(pair, position.balance)
                        return
                    }
                    if (percentageIncrease >= this.profitGoalPercent && quote.amount > amountIn) {
                        console.log(`profit goal reached for ${tokenDenom.symbol} ${percentageIncrease.toFixed(2)}%`)
                        this.stopMonitoringPairToSell(pair)
                        if (percentageIncrease >= this.profitGoalPercent * 2) {
                            result = await this.sellMemeToken(pair, Number(position.balance) * 0.6)
                        }
                        else {
                            result = await this.sellMemeToken(pair, Number(position.balance) * (1 - this.moonBagPercent))
                        }
                        return result
                    }
                    let message = `${pairName}: balance: ${(convertedBalance).toFixed(2)} ${tokenDenom.symbol}, ` +
                        `price: $${price.toFixed(8)} (${amountBack} ${this.baseAssetName} $${usdValue.toFixed(2)}) ${percentageIncrease.toFixed(2)}%`
                    console.log(percentageIncrease > 0 ? message.green : message.red)
                }
            }, intervalInSeconds * 1000);

            this.sellPairPriceMonitoringIntervals.set(pair.contract_addr, monitoringIntervalId);

            console.log(`Sell - Monitoring started for ${pairName}.`.bgCyan);
        } catch (error) {
            console.error('Error monitoring pair:', error);
        }
    }

    stopMonitoringPairToSell(pair) {
        let pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`
        if (this.sellPairPriceMonitoringIntervals.has(pair.contract_addr)) {
            clearInterval(this.sellPairPriceMonitoringIntervals.get(pair.contract_addr));
            this.sellPairPriceMonitoringIntervals.delete(pair.contract_addr);

            console.log(`Monitoring to sell stopped for ${pairName}.`.bgCyan);
        } else {
            console.log(`Pair ${pairName} is not being monitored.`.gray);
        }
    }

    async monitorPairs(pairsToMonitorPrice) {
        const pairsToMonitor = Array.from(this.allPairs.values()).filter(pair => {
            return (
                (pairsToMonitorPrice.includes(pair.token0Meta.symbol) || pairsToMonitorPrice.includes(pair.token1Meta.symbol)) &&
                pair.liquidity > this.lowLiquidityThreshold
            );
        });

        const trackingPollInterval = 10; // seconds
        const trackingPriceDuration = 5; // minutes
        const priceChangePercentNotificationThreshold = 5; // percent

        for (const pair of pairsToMonitor) {
            await this.monitorPairForPriceChange(
                pair,
                trackingPollInterval,
                trackingPriceDuration,
                priceChangePercentNotificationThreshold
            );
        }
    }

    async getTxByHash(txHash) {
        const hash = txHash
        try {
            const transaction = await this.queryClient.cosmos.tx.v1beta1.getTx({ hash });
            return transaction
        }
        catch (error) {
            console.error(`Error when getting tx by hash: `, error.message || error)
        }
    }

    async checkForProvideLiquidity(pages = 1) {
        try {
            const startTime = new Date().getTime();

            for (let i = 0; i < pages; i++) {
                const transactions = await this.queryClient.cosmos.tx.v1beta1.getTxsEvent({
                    events: `wasm.action='provide_liquidity'`,
                    orderBy: 2,
                    pagination: i
                });

                for (const txResponse of transactions.tx_responses) {
                    const txTime = moment(txResponse['timestamp'], 'YYYY-MM-DD HH:mm:ss.SSS Z');
                    let json = JSON.parse(txResponse.raw_log)

                    for (const j in json) {
                        let event = json[j].events.find(x => x.type == "wasm")
                        if (!event || !event.attributes) continue
                        let isProvideLiquidity = event.attributes.find(x => x.key == "action" && x.value == "provide_liquidity")
                        if (!isProvideLiquidity) continue

                        let assetValues = event.attributes.find(x => x.key === "assets").value.split(',');

                        let baseAssetAmount = assetValues.map(asset => {
                            const amountMatch = asset.match(/(\d+)usei/);
                            return amountMatch ? amountMatch[1] : null;
                        }).filter(amount => amount !== null)[0];

                        let otherAmount = assetValues.map(asset => {
                            const amountMatch = asset.match(/(\d+)/);
                            return amountMatch ? amountMatch[0] : null;
                        }).filter(amount => amount !== null)[0];

                        let contractAddress = undefined
                        let lpAdderAddress = undefined
                        let lpReceiverAddress = undefined

                        // get the _contract_address attribute that is directly before the provide_liquidity attribute (the pair contract address)
                        for (let i = 1; i < event.attributes.length; i++) {
                            if (event.attributes[i].key === 'action' && event.attributes[i].value === 'provide_liquidity') {
                                if (event.attributes[i - 1] && event.attributes[i - 1].key === '_contract_address') {
                                    contractAddress = event.attributes[i - 1].value
                                }
                            }
                        }

                        // get the contract address of the person who added the liquidity 
                        for (let i = 1; i < event.attributes.length; i++) {
                            if (event.attributes[i].key === 'action' && event.attributes[i].value === 'provide_liquidity') {
                                if (event.attributes[i + 3] && event.attributes[i + 3].key === 'from') {
                                    lpAdderAddress = event.attributes[i + 3].value;
                                }
                            }
                        }

                        // get the contract address of the person who is getting the liquidity 
                        for (let i = 1; i < event.attributes.length; i++) {
                            if (event.attributes[i].key === 'action' && event.attributes[i].value === 'provide_liquidity') {
                                if (event.attributes[i + 2] && event.attributes[i + 2].key === 'receiver') {
                                    lpReceiverAddress = event.attributes[i + 2].value;
                                }
                            }
                        }

                        if (!this.allPairs.has(contractAddress) && !this.ignoredPairs.has(contractAddress)) {
                            let pair = await this.getPairInfo(contractAddress)

                            if (!pair) continue
                            pair.lpAdderAddress = lpAdderAddress
                            pair.lpReceiverAddress = lpReceiverAddress

                            const pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;
                            const memeTokenMeta = pair.token0Meta.denom === this.baseDenom ? pair.token1Meta : pair.token0Meta;

                            if (
                                pair &&
                                pair.token0Meta &&
                                pair.token1Meta &&
                                this.pairType === JSON.stringify(pair.pair_type) &&
                                (pair.token0Meta.denom === this.baseDenom ||
                                    pair.token1Meta.denom === this.baseDenom) &&
                                (!pair.token0Meta.denom.includes("ibc") &&
                                    !pair.token1Meta.denom.includes("ibc")
                                )
                            ) {
                                this.allPairs.set(contractAddress, { ...pair });

                                const message = `New pair found: ${pair.token0Meta.symbol}, ` +
                                    `${pair.token1Meta.symbol}: \n` +
                                    `${pair.seiscanLink}`;

                                console.log(message.bgMagenta)

                                const baseAssetDecimals = 6;
                                const baseAssetPrice = this.baseAssetPrice || 0;

                                const numericBaseAssetAmount = Number(baseAssetAmount) / 10 ** baseAssetDecimals;
                                const numericOtherAssetAmount = Number(otherAmount) / 10 ** memeTokenMeta.decimals;

                                let liquidity = numericBaseAssetAmount * baseAssetPrice;
                                liquidity = (liquidity * 2) / Math.pow(10, 0)

                                console.log(
                                    `${pairName} liquidity added: $${liquidity} ${txTime}\n` +
                                    `${numericBaseAssetAmount} ${this.baseAssetName}, ${numericOtherAssetAmount} ${memeTokenMeta.symbol}\n` +
                                    `LP added by: https://www.seiscan.app/pacific-1/accounts/${lpAdderAddress}\n` +
                                    `LP held by: https://www.seiscan.app/pacific-1/accounts/${lpReceiverAddress}\n` +
                                    `provide_liquidity tx: https://www.seiscan.app/pacific-1/txs/${txResponse.txhash}`
                                );

                                if (txTime < moment().subtract(1, 'minute')) {
                                    console.log(`liq added over time limit: ${txTime.fromNow()}`)
                                    return
                                }

                                if (liquidity > 1 && liquidity < this.lowLiquidityThreshold && txTime > moment().subtract(1, 'minute')) {
                                    console.log("small amount of liquidity added")
                                    this.sendMessageToDiscord(
                                        `:eyes: ${pairName} - Small liquidity added: $${liquidity.toFixed(2)}\n` +
                                        `<t:${txTime.unix()}:R>\n` +
                                        `${numericBaseAssetAmount} ${this.baseAssetName}, ${numericOtherAssetAmount} ${memeTokenMeta.symbol}\n` +
                                        `provide_liquidity tx: https://www.seiscan.app/pacific-1/txs/${txResponse.txhash}\n` +
                                        `LP added by: https://www.seiscan.app/pacific-1/accounts/${lpAdderAddress}\n` +
                                        `LP held by: https://www.seiscan.app/pacific-1/accounts/${lpReceiverAddress}\n` +
                                        `pair contract: ${pair.seiscanLink}`
                                    )

                                    return;
                                }

                                if (
                                    liquidity > this.lowLiquidityThreshold &&
                                    liquidity < this.highLiquidityThreshold &&
                                    txTime > moment().subtract(1, 'minute')
                                ) {
                                    this.sendMessageToDiscord(
                                        `:eyes: ${pairName} - Liquidity added: $${liquidity.toFixed(2)}\n` +
                                        `<t:${txTime.unix()}:R>\n` +
                                        `${numericBaseAssetAmount} ${this.baseAssetName}, ${numericOtherAssetAmount} ${memeTokenMeta.symbol}\n` +
                                        `provide_liquidity tx: https://www.seiscan.app/pacific-1/txs/${txResponse.txhash}\n` +
                                        `LP added by: https://www.seiscan.app/pacific-1/accounts/${lpAdderAddress}\n` +
                                        `LP held by: https://www.seiscan.app/pacific-1/accounts/${lpReceiverAddress}\n` +
                                        `pair contract: ${pair.seiscanLink}`
                                    )

                                    await this.buyMemeToken(pair, this.snipeAmount);
                                    return;
                                }
                            }
                            else {
                                console.log(`Ignored pair ${contractAddress}, ${JSON.stringify(pair, null, 2)}`);
                                this.sendMessageToDiscord(`Ignored new pair https://dexscreener.com/injective/${contractAddress}`);
                                this.ignoredPairs.add(contractAddress);
                            }
                        }
                    }
                }
            }

            // const endTime = new Date().getTime();
            // const executionTime = endTime - startTime;
            // console.log(`Finished check for provide_liquidity in ${executionTime} milliseconds`.gray);
        }
        catch (error) {
            console.log(`error when checking for provide liquidity`, error || error.message)
        }
    }

    async checkForWithdrawLiquidity(pages = 1) {
        try {
            const startTime = new Date().getTime();

            for (let i = 0; i < pages; i++) {
                const transactions = await this.queryClient.cosmos.tx.v1beta1.getTxsEvent({
                    events: `wasm.action='withdraw_liquidity'`,
                    orderBy: 2,
                    pagination: i
                });

                for (const txResponse of transactions.tx_responses) {
                    const txTime = moment(txResponse['timestamp'], 'YYYY-MM-DD HH:mm:ss.SSS Z');
                    let json = JSON.parse(txResponse.raw_log)

                    if (this.withdrawLiqProcessedTx.has(txResponse.txhash)) continue

                    for (const j in json) {
                        let event = json[j].events.find(x => x.type == "wasm")
                        if (!event || !event.attributes) continue
                        let isWithdrawLiquidity = event.attributes.find(x => x.key == "action" && x.value == "withdraw_liquidity")
                        if (!isWithdrawLiquidity) continue

                        let assetValues = event.attributes.find(x => x.key === "refund_assets").value.split(',');

                        let baseAssetAmount = assetValues.map(asset => {
                            const amountMatch = asset.match(/(\d+)usei/);
                            return amountMatch ? amountMatch[1] : null;
                        }).filter(amount => amount !== null)[0];

                        let otherAmount = assetValues.map(asset => {
                            const amountMatch = asset.match(/(\d+)/);
                            return amountMatch ? amountMatch[0] : null;
                        }).filter(amount => amount !== null)[0];

                        let contractAddress = undefined
                        let senderAddress = undefined
                        let lpReceiverAddress = undefined

                        // get the _contract_address attribute that is directly before the provide_liquidity attribute (the pair contract address)
                        for (let i = 1; i < event.attributes.length; i++) {
                            if (event.attributes[i].key === 'action' && event.attributes[i].value === 'withdraw_liquidity') {
                                if (event.attributes[i - 1] && event.attributes[i - 1].key === '_contract_address') {
                                    contractAddress = event.attributes[i - 1].value
                                }
                            }
                        }

                        for (let i = 1; i < event.attributes.length; i++) {
                            if (event.attributes[i].key === 'action' && event.attributes[i].value === 'withdraw_liquidity') {
                                if (event.attributes[i + 1] && event.attributes[i + 1].key === 'sender') {
                                    senderAddress = event.attributes[i + 1].value
                                }
                            }
                        }

                        for (let i = 1; i < event.attributes.length; i++) {
                            if (event.attributes[i].key === 'action' && event.attributes[i].value === 'transfer') {
                                if (event.attributes[i + 2] && event.attributes[i + 2].key === 'to') {
                                    lpReceiverAddress = event.attributes[i + 2].value
                                }
                            }
                        }

                        if (this.allPairs.has(contractAddress) && !this.ruggedPairs.has(contractAddress)) {
                            let pair = this.allPairs.get(contractAddress)
                            const pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;
                            const memeTokenMeta = pair.token0Meta.denom === this.baseDenom ? pair.token1Meta : pair.token0Meta;

                            const baseAssetDecimals = 6;
                            const baseAssetPrice = this.baseAssetPrice || 0;

                            const numericBaseAssetAmount = Number(baseAssetAmount) / 10 ** baseAssetDecimals;
                            const numericOtherAssetAmount = Number(otherAmount) / 10 ** memeTokenMeta.decimals;

                            let liquidity = numericBaseAssetAmount * baseAssetPrice;
                            liquidity = (liquidity * 2) / Math.pow(10, 0)

                            if (txTime > moment().subtract(1, 'minute') && liquidity < 5) {
                                this.sendMessageToDiscord(
                                    `:eyes: ${pairName} - Liquidity rugged: $${liquidity.toFixed(2)}\n` +
                                    `<t:${txTime.unix()}:R>\n` +
                                    `${numericBaseAssetAmount} ${this.baseAssetName}, ${numericOtherAssetAmount} ${memeTokenMeta.symbol}\n` +
                                    `withdraw_liquidity tx: https://www.seiscan.app/pacific-1/txs/${txResponse.txhash}\n` +
                                    `withdrew by: https://www.seiscan.app/pacific-1/accounts/${senderAddress}\n` +
                                    `sent to: https://www.seiscan.app/pacific-1/accounts/${lpReceiverAddress}\n` +
                                    `pair contract: ${pair.seiscanLink}`
                                )
                            }
                            if (liquidity < 5) {
                                this.ruggedPairs.add(contractAddress)
                            }
                        }
                    }
                    this.withdrawLiqProcessedTx.add(txResponse.txhash)
                }
            }
            // const endTime = new Date().getTime();
            // const executionTime = endTime - startTime;
            // console.log(`Finished check for withdraw_liquidity in ${executionTime} milliseconds`.gray);
        }
        catch (error) {
            console.log(`error when checking for withdraw liquidity`, error || error.message)
        }
    }

    setMonitorNewPairs(monitor) {
        this.monitorNewPairs = monitor
        console.log(`new pairs loop: ${this.monitorNewPairs}`.bgCyan)

        if (monitor) {
            this.sendMessageToDiscord(':dart: Begin monitoring for new Astroport liquidity')
            this.newLiquidityLoop()
        }
        else {
            this.sendMessageToDiscord(':pause_button: Stop monitoring for new Astroport liquidity')
        }
    }

    async newLiquidityLoop() {
        while (this.monitorNewPairs) {
            await this.checkForProvideLiquidity();
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    setMonitorRugs(monitor) {
        this.monitorRugs = monitor
        console.log(`rugs loop: ${this.monitorRugs}`.bgCyan)
        if (monitor) {
            this.rugsLoop()
        }
    }

    async rugsLoop() {
        while (this.monitorRugs) {
            await this.checkForWithdrawLiquidity();
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }

}

module.exports = SeiSniper;