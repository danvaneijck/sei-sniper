
const { seiprotocol } = require("@sei-js/proto");
const { calculateFee, coin } = require('@cosmjs/stargate')

const { getCosmWasmClient,
    getQueryClient,
    restoreWallet,
    getSigningCosmWasmClient,
} = require("@sei-js/core");

const moment = require('moment');
const fs = require('fs/promises');
const path = require('path')
const TransactionManager = require("./Transactions")

var colors = require("colors");
colors.enable();
require('dotenv').config();

class SeiTokenGen {
    constructor(config) {
        this.rpc = config.rpc
        this.rest = config.rest
        this.astroFactory = config.astroFactory
        this.astroRouter = config.astroRouter

        this.pairType = config.pairType

        this.gasFee = calculateFee(150000, "0.1usei");
    }

    async initialize() {
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

    }

    async createDenom(name) {

        const { createDenom } = seiprotocol.seichain.tokenfactory.MessageComposer.withTypeUrl;

        const msg = createDenom({
            sender: this.publicKey,
            subdenom: name
        });

        const fee = calculateFee(150000, "0.1usei");
        const response = await this.signingCosmWasmClient.signAndBroadcast(this.publicKey, [msg], fee);
        console.log(response)
        return response
    }

    async getDenomFromCreator(creator) {
        let result = await this.queryClient.seiprotocol.seichain.tokenfactory.denomsFromCreator({
            creator: creator
        })
        console.log(result)
        return result['denoms']
    }

    async mint(denom, amount) {
        console.log(`attempting to mint ${amount} of ${denom}`)
        const { mint } = seiprotocol.seichain.tokenfactory.MessageComposer.withTypeUrl;

        const msg = mint({
            sender: this.publicKey,
            amount: {
                denom: denom,
                amount: amount.toString()
            }
        });

        console.log(msg)
        const response = await this.signingCosmWasmClient.signAndBroadcast(this.publicKey, [msg], this.gasFee);
        console.log(response)
        return response
    }

    async createPair(denom) {
        console.log("attempting to create astro pair")
        const createXYKPairMsg = {
            "create_pair": {
                "pair_type": {
                    "xyk": {}
                },
                "asset_infos": [
                    {
                        "native_token": {
                            "denom": denom
                        }
                    },
                    {
                        "native_token": {
                            "denom": "usei"
                        }
                    }
                ]
            }
        };
        const executeCreateXYKPair = await this.signingCosmWasmClient.execute(
            this.publicKey,
            this.astroFactory,
            createXYKPairMsg,
            calculateFee(1000000, "0.5usei"),
            "" // memo
        );

        console.log(executeCreateXYKPair);
    }

    async getPairAddress(denom) {
        console.log(`getting pair address for ${denom}`)
        const pairQuery = await this.cosmWasmClient.queryContractSmart(
            this.astroFactory,
            {
                "pair": {
                    "asset_infos": [
                        {
                            "native_token": {
                                "denom": denom
                            }
                        },
                        {
                            "native_token": {
                                "denom": "usei"
                            }
                        }
                    ]
                }
            }
        );
        return pairQuery["contract_addr"]
    }

    async increaseAllowance(pairAddress, tokenAddress) {
        console.log(`attempt increase allowance of ${tokenAddress}`)

        const increaseTokenAllowanceMsg = {
            "increase_allowance": {
                "spender": pairAddress,
                "amount": "1000",
                "expires": {
                    "never": {}
                }
            }
        };

        const executeIncreaseTokenAllowance = await this.signingCosmWasmClient.execute(
            this.publicKey,
            tokenAddress,
            increaseTokenAllowanceMsg,
            this.gasFee,
            "" // memo
        );

        console.log(executeIncreaseTokenAllowance);
    }

    async provideLiquidity(pairAddress, denom, tokenAmount, seiAmount) {
        console.log(`attempt provide liquidity for denom ${denom} on pair ${pairAddress}`)

        const provideLiquidityMsg = {
            "provide_liquidity": {
                "assets": [
                    {
                        "amount": tokenAmount.toString(),
                        "info": {
                            "native_token": {
                                "denom": denom
                            }
                        }
                    },
                    {
                        "amount": seiAmount.toString(),
                        "info": {
                            "native_token": {
                                "denom": "usei"
                            }
                        }
                    }
                ]
            }
        };

        const funds = [
            coin(tokenAmount.toString(), denom),
            coin(seiAmount.toString(), "usei")
        ]

        const executeProvideLiquidity = await this.signingCosmWasmClient.execute(
            this.publicKey,
            pairAddress,
            provideLiquidityMsg,
            calculateFee(1000000, "0.1usei"),
            "", // memo
            funds
        );

        console.log(executeProvideLiquidity);
    }

    async getPairInfo(pair) {
        const pairQuery = { pair: {} }
        let queryResponse = await this.cosmWasmClient.queryContractSmart(pair, pairQuery);
        console.log(queryResponse)

        const poolQuery = { pool: {} }
        queryResponse = await this.cosmWasmClient.queryContractSmart(pair, poolQuery);
        console.log(queryResponse)
    }

    async withdrawLiquidity(pairAddress, token) {
        console.log(`attempt withdraw liquidity for denom ${token} on pair ${pairAddress}`)

        const pairQuery = { pair: {} }
        let queryResponse = await this.cosmWasmClient.queryContractSmart(pairAddress, pairQuery);
        let liquidityAddress = queryResponse['liquidity_token']

        const poolQuery = { pool: {} }
        queryResponse = await this.cosmWasmClient.queryContractSmart(pairAddress, poolQuery);
        let amount = queryResponse['total_share']
        console.log(amount)
        amount = Math.round(Number(amount) - (Number(amount) * 0.002))
        console.log(amount)

        const withdrawLiquidityMsg = {
            "withdraw_liquidity": {}
        }

        const msg = {
            "send": {
                "contract": pairAddress,
                "amount": amount.toString(),
                "msg": btoa(JSON.stringify(withdrawLiquidityMsg))
            }
        }

        console.log(JSON.stringify(msg, null, 2))

        const executeWithdrawLiquidity = await this.signingCosmWasmClient.execute(
            this.publicKey,
            liquidityAddress,
            msg,
            calculateFee(1000000, "0.1usei"),
            "", // memo
        );

        console.log(executeWithdrawLiquidity);

    }

}

module.exports = SeiTokenGen;