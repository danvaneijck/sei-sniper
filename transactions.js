
class TransactionManager {

    constructor(privateKey) {
        this.privateKey = privateKey
        this.queue = [];
        this.isProcessing = false;
    }

    enqueue(message) {
        return new Promise((resolve, reject) => {
            this.queue.push({ transaction: message, resolve, reject });

            if (!this.isProcessing) {
                this.processQueue();
            }
        });
    }

    dequeue() {
        return this.queue.shift();
    }

    processQueue() {
        if (!this.isProcessing && this.queue.length > 0) {
            this.isProcessing = true;

            const { transaction, resolve, reject } = this.dequeue();

            this.signAndBroadcastTransaction(transaction)
                .then((txResponse) => {
                    resolve(txResponse);
                    this.isProcessing = false;
                    this.processQueue();
                })
                .catch((error) => {
                    reject(null);
                    console.error('Transaction failed:', error);
                    this.isProcessing = false;
                    this.processQueue();
                });
        }
    }

    async signAndBroadcastTransaction(msg, memo = '') {
        try {


        } catch (error) {
            console.error(`Error in signAndBroadcastTransaction: ${error}`);
        }
    }
}

module.exports = TransactionManager