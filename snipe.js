
const { DirectSecp256k1HdWallet } = require("@cosmjs/proto-signing");
const { getCosmWasmClient,
    getQueryClient,
    restoreWallet,
    getSigningCosmWasmClient,
    getSigningClient,
    COMPASS_WALLET
} = require("@sei-js/core");
const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const { SlashCommandBuilder } = require('@discordjs/builders');
const moment = require('moment');
const fs = require('fs/promises');
const TransactionManager = require("./transactions")
var colors = require("colors");
colors.enable();
require('dotenv').config();

class SeiSniper {
    constructor(config) {
        this.rpc = config.rpc
        this.rest = config.rest
        this.live = config.live

        this.astroFactory = process.env.FACTORY_CONTRACT;
        this.astroRouter = process.env.ROUTER_CONTRACT;

        this.pairType = config.pairType
        this.tokenTypes = config.tokenTypes

        this.monitorNewPairs = false

        this.txManager = new TransactionManager(this.privateKey)

        this.baseAssetName = "SEI"
        this.baseDenom = "usei"
        this.baseAsset = null
        this.stableAsset = null
        this.baseAssetPrice = 0;

        this.tokenTypes = ['native', 'tokenFactory'];
        this.pairType = '{"xyk":{}}';

        this.lowLiquidityThreshold = config.lowLiquidityThreshold
        this.highLiquidityThreshold = config.highLiquidityThreshold

        this.snipeAmount = config.snipeAmount
        this.profitGoalPercent = config.profitGoalPercent
        this.stopLoss = config.stopLoss
        this.maxSpread = config.maxSpread
        this.tradeTimeLimit = config.tradeTimeLimit
        this.positions = new Map()

        this.allPairs = new Map();
        this.ignoredPairs = new Set();

        this.pairPriceMonitoringIntervals = new Map();
        this.lowLiquidityPairMonitoringIntervals = new Map();
        this.sellPairPriceMonitoringIntervals = new Map();
        this.lastPrices = new Map();

        this.lowLiqPairsToMonitor = new Set()

        this.monitoringNewPairIntervalId = null;
        this.monitoringBasePairIntervalId = null;

        this.discordToken = process.env.DISCORD_TOKEN;
        this.discordChannelId = process.env.DISCORD_CHANNEL;

        this.discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });
        this.discordClient.login(this.discordToken);

        this.discordTag = `<@352761566401265664>`
        this.discordClient.on('ready', () => {
            console.log(`Logged in as ${this.discordClient.user.tag}!`);
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
            console.log("set up discord slash commands")
        });

        this.allPairsQuery = {
            pairs: {
                start_after: [],
                limit: 50,
            },
        };
    }

    async initialize() {

        try {
            this.wallet = await restoreWallet(process.env.MNEMONIC);
            console.log('restored wallet');

            // let chainId = 0
            // this.offlineSigner = await this.wallet.getOfflineSigner(chainId);
            // this.signingClient = await getSigningClient(this.rpc, this.offlineSigner);
            // this.signingCosmWasmClient = await getSigningCosmWasmClient(this.rpc, this.offlineSigner);

            this.cosmWasmClient = await getCosmWasmClient(this.rpc);
            this.queryClient = await getQueryClient(this.rest);

            console.log("Init on ".green, this.rest)

            try {
                await this.loadFromFile('data.json');
                await this.updateBaseAssetPrice()
                this.setupDiscordCommands()
            } catch (error) {
                console.error('Error during initialization:', error);
            }

        } catch (error) {
            console.error('Error during initialization:', error);
        }
    }

    async getBalanceOfToken(denom) {
        return await this.chainGrpcBankApi.fetchBalance({
            accountAddress: this.walletAddress,
            denom,
        })
    }

    setupDiscordCommands() {
        this.discordClient.on('interactionCreate', async interaction => {
            if (!interaction.isCommand()) return;
            const { commandName } = interaction;
            if (commandName === 'get_positions') {
                await interaction.reply("Fetching wallet holdings...");
                await this.executeGetPositionsCommand();
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
            const walletAddress = this.walletAddress;
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
                this.monitorLowLiquidityPair(pair, 5, this.lowLiquidityThreshold)
                await this.sendMessageToDiscord(`:eyes: Monitoring token for liquidity change`)
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
            if (balance) {
                let result = await this.sellMemeToken(pair, balance.amount)
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

    async loadFromFile(filename) {
        try {
            const data = await fs.readFile(filename, 'utf-8');
            const jsonData = JSON.parse(data);
            if (jsonData.allPairs) {
                this.allPairs = new Map(jsonData.allPairs.map(pair => [pair.contract_addr, pair]));
                console.log('Loaded allPairs from file');
            }
            if (jsonData.positions) {
                this.positions = new Map(jsonData.positions.map(position => [position.pair_contract, position]));
                console.log('Loaded positions from file');
            }
            if (jsonData.ignoredPairs) {
                this.ignoredPairs = new Set(jsonData.ignoredPairs);
                console.log('Loaded ignoredPairs from file');
            }
        } catch (error) {
            console.error('Error loading data from file:', error);
        }
    }

    async saveToFile(filename) {
        try {
            const dataToSave = {
                allPairs: Array.from(this.allPairs.values()),
                positions: Array.from(this.positions.values()),
                ignoredPairs: Array.from(this.ignoredPairs),
            };
            await fs.writeFile(filename, JSON.stringify(dataToSave, null, 2), 'utf-8');
        } catch (error) {
            console.error('Error saving data to file:', error);
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

        try {
            await channel.send(message);
        } catch (error) {
            console.error('Error sending message to Discord channel:', error);
        }
    }

    async updateBaseAssetPrice() {
        let result = await this.queryClient.seiprotocol.seichain.oracle.exchangeRate({ denom: 'usei' })

        this.baseAssetPrice = parseFloat(result['oracle_exchange_rate']['exchange_rate'])

        if (this.discordClient && this.discordClient.user) {
            const activityText = `${this.baseAssetName}: $${this.baseAssetPrice.toFixed(3)}`;
            this.discordClient.user.setActivity(activityText, { type: ActivityType.Watching });
        }
        await this.saveToFile('data.json')
    }

    startMonitoringBasePair(intervalInSeconds) {
        console.log('Base Asset monitoring started.');
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
            console.error('Error fetching token info:', error.message || error);
            return {}
        }
    }

    async getDenomMetadata(denom) {
        try {
            const token = await this.queryClient.cosmos.bank.v1beta1.denomMetadata({ denom })
            return token;
        } catch (error) {
            console.error('Error fetching denom metadata:', error.message || error);
            return { metadata: { name: '', symbol: '' } }
        }
    }

    async getContractHistory(pairContract) {
        const contractHistory = await this.chainGrpcWasmApi.fetchContractHistory(
            pairContract
        )
        console.log(contractHistory)
        contractHistory.entriesList.map((item) => {
            console.log(new TextDecoder().decode(item.msg))
        })
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
        const offerAmount = amount * Math.pow(10, this.baseAsset ? this.baseAsset.decimals : 18);
        const pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;
        const simulationQuery = {
            simulation: {
                offer_asset: {
                    info: {
                        native_token: {
                            denom: this.baseDenom
                        }
                    },
                    amount: offerAmount.toString()
                }
            }
        };
        try {
            const query = simulationQuery
            const sim = await this.cosmWasmClient.queryContractSmart(pair.contract_addr, query);

            const decodedData = sim.data
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
        const askAssetIndex = pair.asset_infos.findIndex(assetInfo => assetInfo.native_token.denom !== this.baseDenom);
        if (askAssetIndex === -1) {
            console.error(`Error finding ask asset for ${pairName}`);
            return;
        }

        const askAssetInfo = pair.asset_infos[askAssetIndex];
        const offerAmount = amount * Math.pow(10, this.baseAsset.decimals);

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

            const decodedData = sim.data
            return decodedData;
        } catch (error) {
            console.error(`Error getting quote for ${pairName}: ${error}`);
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
            const decodedData = sim.data
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
                const currentPrice = this.baseAssetPrice / quote['amount'];

                lastPrices.push(currentPrice);
                lastPrices = lastPrices.slice(-trackingDurationMinutes * 60 / intervalInSeconds);

                const newHighestPrice = Math.max(...lastPrices, 0);
                const newLowestPrice = Math.min(...lastPrices, Infinity);

                const priceChangeToHighest = ((currentPrice - newHighestPrice) / newHighestPrice) * 100;
                const priceChangeToLowest = ((currentPrice - newLowestPrice) / newLowestPrice) * 100;

                await this.calculateLiquidity(pair)

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

                console.log(`${pairName} price ${parseFloat(currentPrice).toFixed(10)}, liquidity: $${Math.round(pair.liquidity)}`)

                if (currentPrice == Infinity) {
                    this.stopMonitoringPairForPriceChange(pair)
                }
            }, intervalInSeconds * 1000);

            this.pairPriceMonitoringIntervals.set(pair.contract_addr, monitoringIntervalId);

            console.log(`Price - Monitoring started for ${pairName}.`);
        } catch (error) {
            console.error('Error monitoring pair:', error);
        }
    }

    stopMonitoringPairForPriceChange(pair) {
        let pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`
        if (this.pairPriceMonitoringIntervals.has(pair.contract_addr)) {
            clearInterval(this.pairPriceMonitoringIntervals.get(pair.contract_addr));
            this.pairPriceMonitoringIntervals.delete(pair.contract_addr);

            console.log(`Monitoring stopped for ${pairName}.`);
        } else {
            console.log(`Pair ${pairName} is not being monitored.`);
        }
    }

    async getPortfolio() {
        console.log("fetching portfolio")
        try {

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
        await this.saveToFile('data.json')
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

        return

        const adjustedAmount = amount * 10 ** (this.baseAsset ? this.baseAsset.decimals : 18);

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

        const msg = MsgExecuteContractCompat.fromJSON({
            contractAddress: pair.contract_addr,
            sender: this.walletAddress,
            msg: swapOperations,
            funds: {
                denom: this.baseDenom,
                amount: adjustedAmount,
            },
        });

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const result = await this.txManager.enqueue(msg);
                if (result) {
                    console.log("Swap executed successfully:", result.txHash);

                    const returnAmount = this.parseReturnAmountFromEvents(result.rawLog);
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

    parseReturnAmountFromEvents(rawLog) {
        const events = JSON.parse(rawLog)[0]?.events;
        if (!events) return undefined;

        const wasmEvent = events.find((event) => event.type === "wasm");
        if (!wasmEvent) return undefined;

        const returnAmountAttribute = wasmEvent.attributes.find((attr) => attr.key === "return_amount");
        console.log(`return amount ${returnAmountAttribute.value}`)
        return returnAmountAttribute ? returnAmountAttribute.value : undefined;
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
            `<@352761566401265664>\n${pair.coinhallLink}`);
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

        let position = this.positions.get(pair.contract_addr);

        if (!amount) {
            if (position) {
                console.log("get balance from positions")
                amount = this.positions.get(pair.contract_addr).balance;
            } else {
                console.log("get balance from bank")
                amount = await this.getBalanceOfToken(memeTokenMeta.denom).amount;
            }
        }

        if (!amount) {
            console.log(`No balance to sell for ${memeTokenMeta.symbol}`)
            return
        }

        amount = Math.round(amount)

        let spread = this.maxSpread
        // if (memeTokenMeta.symbol == "n/a") {
        //     amount = amount / Math.pow(10, memeTokenMeta.decimals)
        // }
        let retryCount = 0;
        while (retryCount < maxRetries) {
            // if (memeTokenMeta.symbol == "n/a") {
            //     const decimalPrecision = [6, 8, 18][retryCount];
            // }
            const swapOperations = {
                swap: {
                    offer_asset: {
                        info: {
                            native_token: {
                                denom: memeTokenMeta.denom,
                            },
                        },
                        amount: amount.toString(),
                    },
                    max_spread: spread.toString(),
                },
            };

            const msg = MsgExecuteContractCompat.fromJSON({
                contractAddress: pair.contract_addr,
                sender: this.walletAddress,
                msg: swapOperations,
                funds: {
                    denom: memeTokenMeta.denom,
                    amount: amount.toString(),
                },
            });

            try {
                let result = await this.txManager.enqueue(msg);

                if (!result) {
                    console.log("Sell failed");
                    retryCount += 1;
                    spread += 0.2
                    if (!amount) {
                        console.log("refreshing balance, attempting sell again")
                        amount = await this.getBalanceOfToken(memeTokenMeta.denom).amount;
                        amount = Math.round(amount)
                    }
                }
                else {
                    this.stopMonitoringPairToSell(pair)

                    console.log("Swap executed successfully:", result.txHash);

                    let profit = 0
                    const returnAmount = this.parseReturnAmountFromEvents(result.rawLog);
                    if (returnAmount !== undefined) {
                        profit = returnAmount - position.amount_in
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

                    profit = (profit / Math.pow(10, this.baseAsset.decimals))
                    let returnAmountAdjusted = (returnAmount / Math.pow(10, this.baseAsset.decimals))

                    const baseAssetPriceConverted = this.baseAssetPrice / Math.pow(10, this.stableAsset.decimals)
                    const usdValue = (profit * baseAssetPriceConverted)

                    this.sendMessageToDiscord(
                        `${profit > 0 ? ':dollar:' : ':small_red_triangle_down:'} ` +
                        `Sold token ${memeTokenMeta.symbol} for ${returnAmountAdjusted.toFixed(4)} ${this.baseAssetName}. ` +
                        `PnL: ${profit > 0 ? '+' : ''}${profit.toFixed(4)} ${this.baseAssetName} ($${usdValue.toFixed(2)}) <@352761566401265664>\n${pair.coinhallLink}`
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

        for (const balance of portfolio.bankBalancesList) {
            if (balance.denom === this.baseDenom || balance.amount <= 0) continue;

            const pair = Array.from(this.allPairs.values()).find(pair => {
                return (
                    pair.token0Meta.denom === balance.denom ||
                    pair.token1Meta.denom === balance.denom
                );
            });

            if (pair) {
                const pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;
                const tokenDenom = pair.asset_infos[0].native_token.denom === balance.denom
                    ? pair.token0Meta
                    : pair.token1Meta;

                const quote = await this.getSellQuoteFromRouter(pair, balance.amount);

                if (quote) {
                    const amountBack = (quote.amount / Math.pow(10, this.baseAsset.decimals)).toFixed(3);
                    const convertedQuote = quote.amount / Math.pow(10, this.baseAsset.decimals)
                    const baseAssetPriceConverted = this.baseAssetPrice / Math.pow(10, this.stableAsset.decimals)

                    const usdValue = (convertedQuote * baseAssetPriceConverted)

                    if (usdValue > 0.1) {
                        formattedMessage += `${pairName}: ${(balance.amount / Math.pow(10, tokenDenom.decimals)).toFixed(2)} ` +
                            `${tokenDenom.symbol} (${amountBack} ${this.baseAssetName} $${usdValue.toFixed(2)})\n${pair.coinhallLink}\n`;
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
                    this.stopMonitoringPairToSell(pair)
                    result = await this.sellMemeToken(pair, position.balance)
                    return
                }

                if (quote) {
                    const baseAssetPriceConverted = this.baseAssetPrice / Math.pow(10, this.stableAsset.decimals)
                    const convertedQuote = quote.amount / Math.pow(10, this.baseAsset.decimals)
                    const amountBack = (quote.amount / Math.pow(10, this.baseAsset.decimals)).toFixed(3);
                    const usdValue = (convertedQuote * baseAssetPriceConverted)
                    const convertedBalance = position.balance / Math.pow(10, tokenDenom.decimals)
                    const price = usdValue / convertedBalance

                    const moonBagGoal = Math.round((this.snipeAmount * 5) * Math.pow(10, this.baseAsset.decimals))

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

                    const percentageIncrease = ((quote.amount - position.amount_in) / position.amount_in) * 100;

                    if (percentageIncrease <= this.stopLoss * -1 && quote.amount < position.amount_in) {
                        console.log(`stop loss hit for ${tokenDenom.symbol} ${percentageIncrease}%`)
                        this.stopMonitoringPairToSell(pair)
                        result = await this.sellMemeToken(pair, position.balance)
                        return
                    }
                    if (percentageIncrease >= this.profitGoalPercent && quote.amount > position.amount_in) {
                        console.log(`profit goal reached for ${tokenDenom.symbol} ${percentageIncrease}%`)
                        this.stopMonitoringPairToSell(pair)
                        if (percentageIncrease >= this.profitGoalPercent * 2) {
                            result = await this.sellMemeToken(pair, Number(position.balance) * 0.6)
                        }
                        else {
                            result = await this.sellMemeToken(pair, Number(position.balance) * 0.85)
                        }
                        return result
                    }

                    console.log(`${pairName}: balance: ${(convertedBalance).toFixed(2)} ${tokenDenom.symbol}, ` +
                        `price: $${price.toFixed(8)} (${amountBack} ${this.baseAssetName} $${usdValue.toFixed(2)}) ${percentageIncrease.toFixed(2)}%`)
                }
            }, intervalInSeconds * 1000);

            this.sellPairPriceMonitoringIntervals.set(pair.contract_addr, monitoringIntervalId);

            console.log(`Sell - Monitoring started for ${pairName}.`);
        } catch (error) {
            console.error('Error monitoring pair:', error);
        }
    }

    stopMonitoringPairToSell(pair) {
        let pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`
        if (this.sellPairPriceMonitoringIntervals.has(pair.contract_addr)) {
            clearInterval(this.sellPairPriceMonitoringIntervals.get(pair.contract_addr));
            this.sellPairPriceMonitoringIntervals.delete(pair.contract_addr);

            console.log(`Monitoring to sell stopped for ${pairName}.`);
        } else {
            console.log(`Pair ${pairName} is not being monitored.`);
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

    startStreamingTransactions() {
        const endpoints = getNetworkEndpoints(Network.Mainnet)
        const indexerGrpcExplorerStream = new IndexerGrpcExplorerStream(
            endpoints.indexer,
        )

        const streamFn = indexerGrpcExplorerStream.streamTransactions.bind(
            indexerGrpcExplorerStream,
        )

        const callback = (transactions) => {
            console.log(transactions)
        }

        const streamFnArgs = {
            callback,
        }

        streamFn(streamFnArgs)
    }

    async getTxByHash(txHash) {
        const hash = txHash
        const transaction = await this.queryClient.cosmos.tx.v1beta1.getTx({ hash });
        return transaction
    }

    async checkFactoryForNewPairs() {
        try {
            const startTime = new Date().getTime();

            const transactions = await this.queryClient.cosmos.tx.v1beta1.getTxsEvent({
                events: `wasm.action='create_pair'`,
                orderBy: 2,
                pagination: 0
            });

            for (const txResponse of transactions.tx_responses) {
                let json = JSON.parse(txResponse.raw_log)
                let event = json[0].events.find(x => x.type == "wasm")
                let pairAddress = event.attributes.find(x => x.key == "pair_contract_addr").value

                if (!this.allPairs.has(pairAddress) && !this.ignoredPairs.has(pairAddress)) {
                    let pairInfo = await this.getPairInfo(pairAddress);

                    if (
                        pairInfo &&
                        pairInfo.token0Meta &&
                        pairInfo.token1Meta &&
                        this.pairType === JSON.stringify(pairInfo.pair_type) &&
                        (pairInfo.token0Meta.denom === this.baseDenom ||
                            pairInfo.token1Meta.denom === this.baseDenom)
                    ) {
                        this.allPairs.set(pairAddress, { ...pairInfo });
                        const message = `:new: New pair found: ${pairInfo.token0Meta.symbol}, ` +
                            `${pairInfo.token1Meta.symbol}: ` +
                            `\n${pairInfo.astroportLink}\n` +
                            // `\n${pairInfo.seiscanLink}\n` +
                            // `${pairInfo.token0Meta.seiscanLink}\n${pairInfo.token1Meta.seiscanLink}`;

                            this.sendMessageToDiscord(message);
                        await this.calculateLiquidity(pairInfo);
                        console.log(`${pairAddress} liquidity: ${pairInfo.liquidity}`)
                        if (pairInfo.liquidity > this.lowLiquidityThreshold &&
                            pairInfo.liquidity < this.highLiquidityThreshold) {
                            await this.buyMemeToken(pairInfo, this.snipeAmount);
                        } else {
                            this.startMonitorPairForLiq(pairAddress);
                        }
                    } else {
                        console.log(`Ignored pair ${pairAddress}`);
                        this.sendMessageToDiscord(`Ignored new pair https://coinhall.org/sei/${pairAddress}`);
                        this.ignoredPairs.add(pairAddress);
                    }
                }
            }

            const endTime = new Date().getTime();
            const executionTime = endTime - startTime;
            console.log(`Finished check for new pairs in ${executionTime} milliseconds`.gray);
        } catch (error) {
            console.error('Error in checkFactoryForNewPairs:', error);
            // You can add additional error handling logic here if needed.
        }
    }

    async checkPairForProvideLiquidity(pairContract) {
        let pair = await this.getPairInfo(pairContract)
        const pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;

        const startTime = new Date().getTime();
        const currentLiquidity = await this.calculateLiquidity(pair);

        console.log(`${pairName} liquidity: ${currentLiquidity}`)

        if (currentLiquidity && currentLiquidity > this.lowLiquidityThreshold && currentLiquidity < this.highLiquidityThreshold) {
            this.stopMonitorPairForLiq(pairContract)
            console.log(`Monitoring ${pairName} - Liquidity Added: $${currentLiquidity}`);
            this.sendMessageToDiscord(`:eyes: ${pairName} - Liquidity Added: $${currentLiquidity}\n${pair.astroportLink}\n${pair.dexscreenerLink}\n<@352761566401265664>`)
            await this.buyMemeToken(pair, this.snipeAmount)
        }

        const endTime = new Date().getTime();
        const executionTime = endTime - startTime;
        console.log(`Finished check for liq for pair ${pairName} in ${executionTime} milliseconds`);
    }

    startMonitorPairForLiq(pair) {
        this.lowLiqPairsToMonitor.add(pair)
        if (this.lowLiqPairsToMonitor.size == 1) {
            this.liquidityLoop()
        }
    }

    stopMonitorPairForLiq(pair) {
        this.lowLiqPairsToMonitor.delete(pair)
    }

    async liquidityLoop() {
        console.log(`liquidity loop: ${this.lowLiqPairsToMonitor.size > 0}`);

        while (this.lowLiqPairsToMonitor.size > 0) {
            for (const pair of this.lowLiqPairsToMonitor.values()) {
                await this.checkPairForProvideLiquidity(pair);
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    setMonitorNewPairs(monitor) {
        this.monitorNewPairs = monitor
        if (monitor) {
            this.sendMessageToDiscord('Monitoring for new pairs')
            this.newPairsLoop()
        }
    }

    async newPairsLoop() {
        console.log(`new pairs loop: ${this.monitorNewPairs}`)
        while (this.monitorNewPairs) {
            await this.checkFactoryForNewPairs();
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

}

module.exports = SeiSniper;