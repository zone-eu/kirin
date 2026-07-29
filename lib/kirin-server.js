// @ts-check
'use strict';

/**
 * @typedef {import('@zone-eu/types').SmtpAddress} SmtpAddress
 * @typedef {import('@zone-eu/types').SmtpAuth} SmtpAuth
 * @typedef {Omit<import('@zone-eu/types').SmtpResponseError, 'code'> & { code?: string | number }} SmtpError
 * @typedef {import('@zone-eu/types').SmtpSession & {
 *   secure?: boolean,
 *   localAddress?: string,
 *   localPort?: number,
 *   openingCommand?: string
 * }} SmtpSession
 * @typedef {import('stream').Readable & { sizeExceeded?: boolean }} SmtpDataStream
 * @typedef {(err?: SmtpError | null) => void} SmtpCallback
 * @typedef {(err?: SmtpError | null, result?: { user: string }) => void} SmtpAuthCallback
 * @typedef {(err?: SmtpError | null, message?: string) => void} SmtpDataCallback
 * @typedef {{ keyPath?: string, certPath?: string, caPath?: string }} TlsConfig
 * @typedef {Object} SmtpConfig
 * @property {boolean} [enabled]
 * @property {string} [host]
 * @property {string | number} [port]
 * @property {string} [name]
 * @property {string} [banner]
 * @property {string | number} [size]
 * @property {string | number} [dataHookTimeout]
 * @property {boolean} [secure]
 * @property {boolean} [secured]
 * @property {boolean} [needsUpgrade]
 * @property {boolean} [disableSTARTTLS]
 * @property {boolean} [authentication]
 * @property {boolean} [authOptional]
 * @property {string | number} [closeTimeout]
 * @property {string | number} [maxClients]
 * @property {boolean} [useProxy]
 * @property {boolean} [useXClient]
 * @property {boolean} [useXForward]
 * @property {string | string[]} [disabledCommands]
 * @property {TlsConfig} [tls]
 * @typedef {{ ident?: string, smtp: SmtpConfig }} KirinConfig
 * @typedef {{
 *   info: (...args: unknown[]) => void,
 *   error: (...args: unknown[]) => void,
 *   verbose: (...args: unknown[]) => void,
 *   notice?: (...args: unknown[]) => void,
 *   [level: string]: ((...args: unknown[]) => void) | undefined
 * }} LoggerLike
 * @typedef {{
 *   hooks: Map<string, unknown[]>,
 *   runHooks: (name: string, args: unknown[]) => Promise<void>
 * }} PluginHandlerLike
 * @typedef {Object} SmtpServerOptions
 * @property {boolean} secure
 * @property {boolean} secured
 * @property {boolean} needsUpgrade
 * @property {unknown} logger
 * @property {string | false} name
 * @property {string} banner
 * @property {number} size
 * @property {boolean} authOptional
 * @property {boolean} useProxy
 * @property {boolean} useXClient
 * @property {boolean} useXForward
 * @property {number | undefined} closeTimeout
 * @property {number | undefined} maxClients
 * @property {Buffer | undefined} key
 * @property {Buffer | undefined} cert
 * @property {Buffer | undefined} ca
 * @property {string[]} disabledCommands
 * @property {(session: SmtpSession, callback: SmtpCallback) => void} onConnect
 * @property {(socket: unknown, session: SmtpSession, callback: SmtpCallback) => void} onSecure
 * @property {(auth: SmtpAuth, session: SmtpSession, callback: SmtpAuthCallback) => void} onAuth
 * @property {(address: SmtpAddress, session: SmtpSession, callback: SmtpCallback) => void} onMailFrom
 * @property {(address: SmtpAddress, session: SmtpSession, callback: SmtpCallback) => void} onRcptTo
 * @property {(stream: SmtpDataStream, session: SmtpSession, callback: SmtpDataCallback) => void} onData
 * @property {(session: SmtpSession) => void} onClose
 * @typedef {{
 *   on: (event: 'error', listener: (err: Error) => void) => SmtpServerInstance,
 *   once: (event: 'error', listener: (err: Error) => void) => SmtpServerInstance,
 *   removeListener: (event: 'error', listener: (err: Error) => void) => SmtpServerInstance,
 *   listen: (port: number, host: string | undefined, callback: () => void) => unknown,
 *   close: (callback: () => void) => void
 * }} SmtpServerInstance
 * @typedef {new (options: SmtpServerOptions) => SmtpServerInstance} SmtpServerConstructor
 */

const fs = require('fs');
const os = require('os');
const { SMTPServer } = /** @type {{ SMTPServer: SmtpServerConstructor }} */ (require('smtp-server'));
const { createSmtpLogger } = require('./logger');
const { KirinConnection } = require('./connection');
const { buildEnvelope } = require('./smtp-envelope');
const { SmtpHooks } = require('./smtp-hooks');

const DEFAULT_MESSAGE_SIZE = 50 * 1024 * 1024;
const DEFAULT_DATA_HOOK_TIMEOUT = 30 * 1000;

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
const positiveInteger = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
};

/**
 * @template T
 * @param {PromiseLike<T>} promise
 * @param {number} timeoutMs
 * @returns {Promise<T>}
 */
const runWithTimeout = (promise, timeoutMs) =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            /** @type {SmtpError} */
            const error = new Error(`smtp:data hook timed out after ${timeoutMs} ms`);
            error.responseCode = 451;
            reject(error);
        }, timeoutMs);
        timer.unref?.();

        promise.then(
            result => {
                clearTimeout(timer);
                resolve(result);
            },
            err => {
                clearTimeout(timer);
                reject(err);
            }
        );
    });

/**
 * Normalizes plugin and stream failures into an SMTP response error.
 *
 * @param {unknown} err
 * @param {number} [fallbackCode]
 * @returns {SmtpError}
 */
const normalizeError = (err, fallbackCode) => {
    if (!err) {
        /** @type {SmtpError} */
        const error = new Error('Temporary failure');
        error.responseCode = fallbackCode || 451;
        return error;
    }

    if (err instanceof Error) {
        const smtpError = /** @type {SmtpError} */ (err);
        if (!smtpError.responseCode && typeof smtpError.code === 'number') {
            smtpError.responseCode = smtpError.code;
        }
        if (!smtpError.responseCode) {
            smtpError.responseCode = fallbackCode || 451;
        }
        return smtpError;
    }

    const legacyError = /** @type {{ reply?: unknown, code?: unknown }} */ (err);
    if (typeof err === 'object' && legacyError.reply) {
        /** @type {SmtpError} */
        const error = new Error(String(legacyError.reply));
        error.responseCode = (typeof legacyError.code === 'number' && legacyError.code) || fallbackCode || 451;
        return error;
    }

    /** @type {SmtpError} */
    const error = new Error(String(err));
    error.responseCode = fallbackCode || 451;
    return error;
};

/**
 * @param {string | false | null | undefined} filePath
 * @returns {Buffer | undefined}
 */
const readTlsFile = filePath => {
    if (!filePath) {
        return undefined;
    }

    return fs.readFileSync(filePath);
};

class KirinServer {
    /**
     * @param {{ config: KirinConfig, log: LoggerLike, plugins: PluginHandlerLike }} options
     */
    constructor({ config, log, plugins }) {
        this.config = config;
        this.log = log;
        this.plugins = plugins;
        this.smtpHooks = new SmtpHooks(plugins);
        /** @type {WeakMap<SmtpSession, InstanceType<typeof KirinConnection>>} */
        this.connections = new WeakMap();
        /** @type {WeakMap<SmtpSession, () => void>} */
        this.activeMessages = new WeakMap();
        /** @type {SmtpServerInstance | false} */
        this.server = false;
    }

    /**
     * @param {SmtpSession} session
     * @returns {InstanceType<typeof KirinConnection>}
     */
    getConnection(session) {
        let connection = this.connections.get(session);

        if (!connection) {
            connection = new KirinConnection(this, session);
            this.connections.set(session, connection);
        } else {
            connection.refreshSession(session);
        }

        return connection;
    }

    /**
     * @param {InstanceType<typeof KirinConnection>} connection
     * @returns {string}
     */
    buildReceivedHeader(connection) {
        const remoteName = connection.session.hostNameAppearsAs || connection.session.clientHostname || `[${connection.remote.ip}]`;
        const peer = connection.session.clientHostname || `[${connection.remote.ip}]`;
        const byHost = this.config.smtp.name || os.hostname();
        const withProto = connection.session.transmissionType || 'SMTP';
        return `from ${remoteName} (${peer} [${connection.remote.ip}]) by ${byHost} with ${withProto}; ${new Date()
            .toUTCString()
            .replace('GMT', '+0000')}`;
    }

    /** @returns {SmtpServerOptions} */
    createServerOptions() {
        const smtp = this.config.smtp || {};
        const tls = smtp.tls || {};
        const authentication = smtp.authentication === true;
        const messageSize = positiveInteger(smtp.size, DEFAULT_MESSAGE_SIZE);
        const hookTimeout = positiveInteger(smtp.dataHookTimeout, DEFAULT_DATA_HOOK_TIMEOUT);

        return {
            secure: !!smtp.secure,
            secured: !!smtp.secured,
            needsUpgrade: !!smtp.needsUpgrade,
            logger: createSmtpLogger(this.log),
            name: smtp.name || false,
            banner: smtp.banner || 'Welcome to Kirin',
            size: messageSize,
            authOptional: smtp.authOptional !== false,
            useProxy: !!smtp.useProxy,
            useXClient: !!smtp.useXClient,
            useXForward: !!smtp.useXForward,
            closeTimeout: Number(smtp.closeTimeout) || undefined,
            maxClients: Number(smtp.maxClients) || undefined,
            key: readTlsFile(tls.keyPath),
            cert: readTlsFile(tls.certPath),
            ca: readTlsFile(tls.caPath),
            disabledCommands: /** @type {string[]} */ ([])
                .concat(smtp.disabledCommands || [])
                .concat(authentication ? [] : ['AUTH'])
                .concat(smtp.disableSTARTTLS ? ['STARTTLS'] : []),
            onConnect: (session, callback) => {
                session.interface = this.config.ident || 'kirin';
                this.getConnection(session);
                this.smtpHooks
                    .connect(session)
                    .then(() => callback())
                    .catch(err => callback(normalizeError(err, 554)));
            },
            onSecure: (_socket, session, callback) => {
                this.getConnection(session);
                callback();
            },
            onAuth: (auth, session, callback) => {
                this.getConnection(session);

                if (!authentication || !this.smtpHooks.has('smtp:auth')) {
                    /** @type {SmtpError} */
                    const error = new Error('Authentication not available');
                    error.responseCode = 535;
                    return callback(error);
                }

                if (!auth.username) {
                    /** @type {SmtpError} */
                    const error = new Error('Invalid username or password');
                    error.responseCode = 535;
                    return callback(error);
                }

                this.smtpHooks
                    .auth(auth, session)
                    .then(() => callback(null, { user: auth.username }))
                    .catch(err => callback(normalizeError(err, 535)));
            },
            onMailFrom: (address, session, callback) => {
                const connection = this.getConnection(session);
                const transaction = connection.resetTransaction();
                transaction.notes.sender = address.address || '';
                transaction.setMailFrom(address);
                session.envelopeId = transaction.uuid;

                this.smtpHooks
                    .mailFrom(address, session)
                    .then(() => callback())
                    .catch(err => callback(normalizeError(err, 550)));
            },
            onRcptTo: (address, session, callback) => {
                const connection = this.getConnection(session);
                const transaction = connection.transaction || connection.resetTransaction();
                transaction.syncEnvelope(session);

                this.smtpHooks
                    .rcptTo(address, session)
                    .then(() => callback())
                    .catch(err => callback(normalizeError(err, 550)));
            },
            onData: (stream, session, callback) => {
                const connection = this.getConnection(session);
                const transaction = connection.transaction || connection.resetTransaction();
                transaction.syncEnvelope(session);
                /** @type {Buffer[]} */
                const chunks = [];

                let returned = false;
                let streamEnded = false;
                /** @type {SmtpDataCallback} */
                const done = (...args) => {
                    if (returned) {
                        return;
                    }
                    returned = true;
                    callback(...args);
                };

                const disposeMessage = () => {
                    this.activeMessages.delete(session);
                    transaction.clearMessage();
                    chunks.length = 0;
                };
                this.activeMessages.set(session, disposeMessage);

                stream.on('data', chunk => {
                    if (stream.sizeExceeded) {
                        chunks.length = 0;
                        return;
                    }
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                });

                stream.once('error', err => {
                    disposeMessage();
                    done(normalizeError(err, 451));
                });

                stream.once('close', () => {
                    if (!streamEnded) {
                        disposeMessage();
                        done(normalizeError(new Error('Message stream closed before completion'), 451));
                    }
                });

                stream.once('end', () => {
                    streamEnded = true;

                    if (stream.sizeExceeded) {
                        /** @type {SmtpError} */
                        const error = new Error(`Message exceeds fixed maximum message size ${messageSize} B`);
                        error.responseCode = 552;
                        disposeMessage();
                        return done(error);
                    }

                    try {
                        const message = Buffer.concat(chunks);
                        chunks.length = 0;
                        transaction.add_leading_header('Received', this.buildReceivedHeader(connection));
                        connection.prepareMessage(message);
                    } catch (err) {
                        disposeMessage();
                        return done(normalizeError(err, 452));
                    }

                    /** @type {Promise<void>} */
                    let hookPromise;
                    try {
                        const envelope = buildEnvelope(transaction, session, session.interface || this.config.ident || 'kirin');
                        transaction.envelope = envelope;
                        hookPromise = this.smtpHooks.data(envelope, session);
                    } catch (err) {
                        disposeMessage();
                        return done(normalizeError(err, 451));
                    }

                    runWithTimeout(hookPromise, hookTimeout).then(
                        () => {
                            const responseMessage = transaction.responseMessage || 'Message accepted';
                            disposeMessage();
                            done(null, responseMessage);
                        },
                        err => {
                            disposeMessage();
                            done(normalizeError(err, 451));
                        }
                    );
                });
            },
            onClose: session => {
                this.activeMessages.get(session)?.();
                this.connections.delete(session);
            }
        };
    }

    /** @returns {Promise<SmtpServerInstance | false>} */
    async start() {
        if (this.server) {
            return this.server;
        }

        if (this.config.smtp.enabled === false) {
            return false;
        }

        const server = new SMTPServer(this.createServerOptions());
        this.server = server;
        server.on('error', err => {
            this.log.error('SMTP', 'Server error: %s', err.stack || err.message || err);
        });

        await new Promise((resolve, reject) => {
            const host = this.config.smtp.host || undefined;
            const port = Number.isFinite(Number(this.config.smtp.port)) ? Number(this.config.smtp.port) : 2525;

            function onListening() {
                server.removeListener('error', onError);
                resolve(undefined);
            }

            /** @param {Error} err */
            function onError(err) {
                reject(err);
            }

            server.once('error', onError);
            server.listen(port, host, onListening);
        });

        return this.server;
    }

    /** @returns {Promise<void>} */
    async close() {
        if (!this.server) {
            return;
        }

        try {
            await this.plugins.runHooks('shutdown', []);
        } catch (err) {
            this.log.error('App', 'Shutdown hook failed: %s', err instanceof Error ? err.stack || err.message : err);
        }

        const server = this.server;
        await new Promise(resolve => server.close(() => resolve(undefined)));
    }
}

module.exports = { KirinServer };
