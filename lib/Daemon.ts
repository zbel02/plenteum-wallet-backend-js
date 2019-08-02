// Copyright (c) 2018, Zpalmtree
//
// Please see the included LICENSE file for more information.

import * as _ from 'lodash';

import request = require('request-promise-native');

import { EventEmitter } from 'events';

import * as http from 'http';
import * as https from 'https';

import { assertString, assertNumber, assertBooleanOrUndefined } from './Assert';
import { Block, TopBlock, DaemonType, DaemonConnection } from './Types';
import { Config, IConfig, MergeConfig } from './Config';
import { IDaemon } from './IDaemon';
import { validateAddresses } from './ValidateParameters';
import { LogCategory, logger, LogLevel } from './Logger';
import { WalletError, WalletErrorCode } from './WalletError';

export class Daemon extends EventEmitter implements IDaemon {

    /**
     * Daemon/API host
     */
    private host: string;

    /**
     * Daemon/API port
     */
    private port: number;

    /**
     * Whether we should use https for our requests
     */
    private ssl: boolean = true;

    /**
     * Have we determined if we should be using ssl or not?
     */
    private sslDetermined: boolean = false;

    /**
     * Whether we're talking to a conventional daemon, or a blockchain cache API
     */
    private isCacheApi: boolean = false;

    /**
     * Have we determined if this is a cache API or not?
     */
    private isCacheApiDetermined: boolean = false;

    /**
     * The address node fees will go to
     */
    private feeAddress: string = '';

    /**
     * The amount of the node fee in atomic units
     */
    private feeAmount: number = 0;

    /**
     * The amount of blocks the daemon we're connected to has
     */
    private localDaemonBlockCount = 0;

    /**
     * The amount of blocks the network has
     */
    private networkBlockCount = 0;

    /**
     * The amount of peers we have, incoming+outgoing
     */
    private peerCount = 0;

    /**
     * The hashrate of the last known local block
     */
    private lastKnownHashrate = 0;

    private config: Config = new Config();

    private httpAgent: http.Agent = new http.Agent({
        keepAlive: true,
        maxSockets: Infinity,
        keepAliveMsecs: 20000,
    });

    private httpsAgent: https.Agent = new https.Agent({
        keepAlive: true,
        maxSockets: Infinity,
        keepAliveMsecs: 20000,
    });

    /**
     * Did our last contact with the daemon succeed. Set to true initially
     * so initial failure to connect will fire disconnect event.
     */
    private connected: boolean = true;

    /**
     * @param host The host to access the API on. Can be an IP, or a URL, for
     *             example, 1.1.1.1, or cache.pleapps.plenteum.com
     *
     * @param port The port to access the API on. Normally 44016 for a Plenteum
     *             daemon, 80 for a HTTP api, or 443 for a HTTPS api.
     *
     * @param isCacheApi You can optionally specify whether this API is a
     *                   blockchain cache API to save a couple of requests.
     *                   If you're not sure, do not specify this parameter -
     *                   we will work it out automatically.
     *
     * @param ssl        You can optionally specify whether this API supports
     *                   ssl/tls/https to save a couple of requests.
     *                   If you're not sure, do not specify this parameter -
     *                   we will work it out automatically.
     */
    constructor(host: string, port: number, isCacheApi?: boolean, ssl?: boolean) {
        super();

        this.setMaxListeners(0);

        assertString(host, 'host');
        assertNumber(port, 'port');
        assertBooleanOrUndefined(isCacheApi, 'isCacheApi');
        assertBooleanOrUndefined(ssl, 'ssl');

        this.host = host;
        this.port = port;

        /* Raw IP's very rarely support SSL. This fixes the warning from
           https://github.com/nodejs/node/pull/23329 */
        if (/^(?!0)(?!.*\.$)((1?\d?\d|25[0-5]|2[0-4]\d)(\.|$)){4}$/.test(this.host) && ssl === undefined) {
            ssl = false;
        }
        
        if (isCacheApi !== undefined) {
            this.isCacheApi = isCacheApi;
            this.isCacheApiDetermined = true;
        }

        if (ssl !== undefined) {
            this.ssl = ssl;
            this.sslDetermined = true;
        }
    }

    public updateConfig(config: IConfig) {
        this.config = MergeConfig(config);
    }

    /**
     * Get the amount of blocks the network has
     */
    public getNetworkBlockCount(): number {
        return this.networkBlockCount;
    }

    /**
     * Get the amount of blocks the daemon we're connected to has
     */
    public getLocalDaemonBlockCount(): number {
        return this.localDaemonBlockCount;
    }

    /**
     * Initialize the daemon and the fee info
     */
    public async init(): Promise<void> {
        /* Note - if one promise throws, the other will be cancelled */
        await Promise.all([this.updateDaemonInfo(), this.updateFeeInfo()]);
    }

    /**
     * Update the daemon info
     */
    public async updateDaemonInfo(): Promise<void> {
        let info;

        const haveDeterminedSsl = this.sslDetermined;

        try {
            info = await this.makeGetRequest('/info');
        } catch (err) {
            logger.log(
                'Failed to update daemon info: ' + err.toString(),
                LogLevel.INFO,
                [LogCategory.DAEMON],
            );

            return;
        }

        /* Possibly determined daemon type was HTTPS, got a valid response,
           but not valid data. Manually set to http and try again. */
        if (info.height === undefined && !haveDeterminedSsl) {
            this.sslDetermined = true;
            this.ssl = false;

            return this.updateDaemonInfo();
        }

        /* Are we talking to a cache API or not? */
        if (!this.isCacheApiDetermined) {
            if (info.isCacheApi !== undefined && _.isBoolean(info.isCacheApi)) {
                this.isCacheApi = info.isCacheApi;
                this.isCacheApiDetermined = true;
            } else {
                this.isCacheApi = false;
                this.isCacheApiDetermined = true;
            }
        }

        /* Height returned is one more than the current height - but we
           don't want to overflow if the height returned is zero */
        if (info.network_height !== 0) {
            info.network_height--;
        }

        if (this.localDaemonBlockCount !== info.height 
         || this.networkBlockCount !== info.network_height) {
            this.emit('heightchange', info.height, info.network_height);
        }

        this.localDaemonBlockCount = info.height;
        this.networkBlockCount = info.network_height;
        
        this.peerCount = info.incoming_connections_count + info.outgoing_connections_count;

        this.lastKnownHashrate = info.difficulty / this.config.blockTargetTime;
    }

    /**
     * Get the node fee and address
     */
    public nodeFee(): [string, number] {
        return [this.feeAddress, this.feeAmount];
    }

    /**
     * @param blockHashCheckpoints  Hashes of the last known blocks. Later
     *                              blocks (higher block height) should be
     *                              ordered at the front of the array.
     *
     * @param startHeight           Height to start taking blocks from
     * @param startTimestamp        Block timestamp to start taking blocks from
     *
     * Gets blocks from the daemon. Blocks are returned starting from the last
     * known block hash (if higher than the startHeight/startTimestamp)
     */
    public async getWalletSyncData(
        blockHashCheckpoints: string[],
        startHeight: number,
        startTimestamp: number,
        blockCount: number): Promise<[Block[], TopBlock | undefined]> {

        let data;

        try {
            data = await this.makePostRequest('/getwalletsyncdata', {
                blockCount,
                blockHashCheckpoints,
                skipCoinbaseTransactions: !this.config.scanCoinbaseTransactions,
                startHeight,
                startTimestamp,
            });
        } catch (err) {
            logger.log(
                'Failed to get wallet sync data: ' + err.toString(),
                LogLevel.INFO,
                [LogCategory.DAEMON],
            );

            return [[], undefined];
        }

        if (data.synced && data.topBlock && data.topBlock.height && data.topBlock.hash) {
            return [data.items.map(Block.fromJSON), data.topBlock];
        }

        return [data.items.map(Block.fromJSON), undefined];
    }

    /**
     * @returns Returns a mapping of transaction hashes to global indexes
     *
     * Get global indexes for the transactions in the range
     * [startHeight, endHeight]
     */
    public async getGlobalIndexesForRange(
        startHeight: number,
        endHeight: number): Promise<Map<string, number[]>> {

        if (this.isCacheApi) {
            throw new Error(
                'This call is not supported on the cache api. The cache API ' +
                'returns global indexes directly from /getWalletSyncData',
            );
        }

        try {
            const data = await this.makePostRequest('/get_global_indexes_for_range', {
                startHeight,
                endHeight,
            });

            const indexes: Map<string, number[]> = new Map();

            for (const index of data.indexes) {
                indexes.set(index.key, index.value);
            }

            return indexes;
        } catch (err) {
            logger.log(
                'Failed to get global indexes: ' + err.toString(),
                LogLevel.ERROR,
                LogCategory.DAEMON,
            );

            return new Map();
        }
    }

    public async getCancelledTransactions(transactionHashes: string[]): Promise<string[]> {
        try {
            const data = await this.makePostRequest('/get_transactions_status', {
                transactionHashes,
            });

            return data.transactionsUnknown || [];
        } catch (err) {
            logger.log(
                'Failed to get transactions status: ' + err.toString(),
                LogLevel.ERROR,
                LogCategory.DAEMON,
            );

            return [];
        }
    }

    /**
     * Gets random outputs for the given amounts. requestedOuts per. Usually mixin+1.
     *
     * @returns Returns an array of amounts to global indexes and keys. There
     *          should be requestedOuts indexes if the daemon fully fulfilled
     *          our request.
     */
    public async getRandomOutputsByAmount(
        amounts: number[],
        requestedOuts: number): Promise<Array<[number, Array<[number, string]>]>> {

        let data;

        try {
            if (this.isCacheApi) {
                data = await this.makePostRequest('/randomOutputs', {
                    amounts: amounts,
                    mixin: requestedOuts,
                });
            } else {
                const tmp = await this.makePostRequest('/getrandom_outs', {
                    amounts: amounts,
                    outs_count: requestedOuts,
                });

                data = tmp.outs || [];
            }
        } catch (err) {
            logger.log(
                'Failed to get random outs: ' + err.toString(),
                LogLevel.ERROR,
                [LogCategory.TRANSACTIONS, LogCategory.DAEMON],
            );

            return [];
        }

        const outputs: Array<[number, Array<[number, string]>]> = [];

        for (const output of data) {
            const indexes: Array<[number, string]> = [];

            for (const outs of output.outs) {
                indexes.push([outs.global_amount_index, outs.out_key]);
            }

            /* Sort by output index to make it hard to determine real one */
            outputs.push([output.amount, _.sortBy(indexes, ([index, key]) => index)]);
        }

        return outputs;
    }

    public async sendTransaction(rawTransaction: string): Promise<boolean> {
        const result = await this.makePostRequest('/sendrawtransaction', {
            tx_as_hex: rawTransaction,
        });

        return result.status.toUpperCase() === 'OK';
    }

    public getConnectionInfo(): DaemonConnection {
        return {
            host: this.host,
            port: this.port,
            daemonType: this.isCacheApi ? DaemonType.BlockchainCacheApi : DaemonType.ConventionalDaemon,
            daemonTypeDetermined: this.isCacheApiDetermined,
            ssl: this.ssl,
            sslDetermined: this.sslDetermined,
        };
    }

    /**
     * Update the fee address and amount
     */
    private async updateFeeInfo(): Promise<void> {
        let feeInfo;

        try {
            feeInfo = await this.makeGetRequest('/fee');
        } catch (err) {
            logger.log(
                'Failed to update fee info: ' + err.toString(),
                LogLevel.INFO,
                [LogCategory.DAEMON],
            );
            return;
        }

        if (feeInfo.address === '') {
            return;
        }

        const integratedAddressesAllowed: boolean = false;

        const err: WalletErrorCode = validateAddresses(
            new Array(feeInfo.address), integratedAddressesAllowed, this.config,
        ).errorCode;

        if (err !== WalletErrorCode.SUCCESS) {
            logger.log(
                'Failed to validate address from daemon fee info: ' + err.toString(),
                LogLevel.WARNING,
                [LogCategory.DAEMON],
            );

            return;
        }

        if (feeInfo.amount > 0) {
            this.feeAddress = feeInfo.address;
            this.feeAmount = feeInfo.amount;
        }
    }

    private async makeGetRequest(endpoint: string): Promise<any> {
        return this.makeRequest(endpoint, 'GET');
    }

    private async makePostRequest(endpoint: string, body: any): Promise<any> {
        return this.makeRequest(endpoint, 'POST', body);
    }

    /**
     * Makes a get request to the given endpoint
     */
    private async makeRequest(endpoint: string, method: string, body?: any): Promise<any> {
        try {
            const protocol = this.sslDetermined ? (this.ssl ? 'https' : 'http') : 'https';

            const data = await request({
                body: body,
                json: true,
                method: method,
                timeout: this.config.requestTimeout,
                /* Start by trying HTTPS if we haven't determined whether it's
                   HTTPS or HTTP yet. */
                url: `${protocol}://${this.host}:${this.port}${endpoint}`,
                agent: protocol === 'https' ? this.httpsAgent : this.httpAgent,
            });

            /* Cool, https works. Store for later. */
            if (!this.sslDetermined) {
                this.ssl = true;
                this.sslDetermined = true;
            }

            if (!this.connected) {
                this.emit('connect');
                this.connected = true;
            }

            return data;
        } catch (err) {
            /* No point trying again with SSL - we already have decided what
               type it is. */
            if (this.sslDetermined) {
                if (this.connected) {
                    this.emit('disconnect', err);
                    this.connected = false;
                }

                throw err;
            }

            try {
                const data = await request({
                    body: body,
                    json: true,
                    method: method,
                    timeout: this.config.requestTimeout,
                    /* Lets try HTTP now. */
                    url: `http://${this.host}:${this.port}${endpoint}`,
                    agent: this.httpAgent,
                });

                this.ssl = false;
                this.sslDetermined = true;

                if (!this.connected) {
                    this.emit('connect');
                    this.connected = true;
                }

                return data;

            } catch (err) {
                if (this.connected) {
                    this.emit('disconnect', err);
                    this.connected = false;
                }

                throw err;
            }
        }
    }
}
