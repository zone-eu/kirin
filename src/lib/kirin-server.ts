import { readFileSync } from 'node:fs';
import os from 'node:os';
import { SMTPServer } from 'smtp-server';
import { KirinConnection } from './connection.js';
import { createSmtpLogger, formatLogSource, getErrorSessionId } from './logger.js';
import { buildEnvelope } from './smtp-envelope.js';
import { SmtpHooks } from './smtp-hooks.js';
import type {
    KirinConfig,
    LoggerLike,
    PluginHandlerLike,
    SmtpDataCallback,
    SmtpError,
    SmtpServerInstance,
    SmtpServerOptions,
    SmtpSession
} from '../types.js';

const DEFAULT_MESSAGE_SIZE = 50 * 1024 * 1024;
const DEFAULT_DATA_HOOK_TIMEOUT = 30 * 1000;

const describeUnknown = (value: unknown): string => {
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'symbol') {
        return String(value);
    }
    if (value === null || value === undefined) {
        return String(value);
    }
    try {
        return JSON.stringify(value) || Object.prototype.toString.call(value);
    } catch {
        return Object.prototype.toString.call(value);
    }
};

const positiveInteger = (value: unknown, fallback: number): number => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
};

const runWithTimeout = <T>(promise: PromiseLike<T>, timeoutMs: number): Promise<T> =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const error = new Error(`smtp:data hook timed out after ${timeoutMs} ms`) as SmtpError;
            error.responseCode = 451;
            reject(error);
        }, timeoutMs);
        timer.unref();

        promise.then(
            (result) => {
                clearTimeout(timer);
                resolve(result);
            },
            (err) => {
                clearTimeout(timer);
                reject(normalizeError(err));
            }
        );
    });

/** Normalizes plugin and stream failures into an SMTP response error. */
const normalizeError = (err: unknown, fallbackCode = 451): SmtpError => {
    if (!err) {
        const error = new Error('Temporary failure') as SmtpError;
        error.responseCode = fallbackCode;
        return error;
    }

    if (err instanceof Error) {
        const smtpError = err as SmtpError;
        if (!smtpError.responseCode && typeof smtpError.code === 'number') {
            smtpError.responseCode = smtpError.code;
        }
        if (!smtpError.responseCode) {
            smtpError.responseCode = fallbackCode;
        }
        return smtpError;
    }

    if (typeof err === 'object') {
        const legacyError = err as { reply?: unknown; code?: unknown };
        if (legacyError.reply) {
            const error = new Error(describeUnknown(legacyError.reply)) as SmtpError;
            error.responseCode = (typeof legacyError.code === 'number' && legacyError.code) || fallbackCode;
            return error;
        }
    }

    const error = new Error(describeUnknown(err)) as SmtpError;
    error.responseCode = fallbackCode;
    return error;
};

const readTlsFile = (filePath: string | false | null | undefined): Buffer | undefined => (filePath ? readFileSync(filePath) : undefined);

export type SmtpServerFactory = (options: SmtpServerOptions) => SmtpServerInstance;

export interface KirinServerOptions {
    config: KirinConfig;
    log: LoggerLike;
    plugins: PluginHandlerLike;
    /** Overrides smtp-server construction, primarily for embedders and tests. */
    createSmtpServer?: SmtpServerFactory;
}

export class KirinServer {
    readonly config: KirinConfig;
    readonly log: LoggerLike;
    readonly plugins: PluginHandlerLike;
    readonly smtpHooks: SmtpHooks;
    private readonly createSmtpServer: SmtpServerFactory;
    private readonly connections = new WeakMap<SmtpSession, KirinConnection>();
    private readonly activeMessages = new WeakMap<SmtpSession, () => void>();
    private server: SmtpServerInstance | false = false;
    private starting: Promise<SmtpServerInstance> | false = false;
    private closing: Promise<void> | false = false;

    constructor({ config, log, plugins, createSmtpServer = (options) => new SMTPServer(options) }: KirinServerOptions) {
        this.config = config;
        this.log = log;
        this.plugins = plugins;
        this.smtpHooks = new SmtpHooks(plugins);
        this.createSmtpServer = createSmtpServer;
    }

    getConnection(session: SmtpSession): KirinConnection {
        let connection = this.connections.get(session);

        if (!connection) {
            connection = new KirinConnection(this, session);
            this.connections.set(session, connection);
        } else {
            connection.refreshSession(session);
        }

        return connection;
    }

    buildReceivedHeader(connection: KirinConnection): string {
        const remoteName = connection.session.hostNameAppearsAs || connection.session.clientHostname || `[${connection.remote.ip}]`;
        const peer = connection.session.clientHostname || `[${connection.remote.ip}]`;
        const byHost = this.config.smtp.name || os.hostname();
        const withProto = connection.session.transmissionType || 'SMTP';
        return `from ${remoteName} (${peer} [${connection.remote.ip}]) by ${byHost} with ${withProto}; ${new Date()
            .toUTCString()
            .replace('GMT', '+0000')}`;
    }

    createServerOptions(): SmtpServerOptions {
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
            disabledCommands: ([] as string[])
                .concat(smtp.disabledCommands || [])
                .concat(authentication ? [] : ['AUTH'])
                .concat(smtp.disableSTARTTLS ? ['STARTTLS'] : []),
            onConnect: (session, callback) => {
                session.interface = this.config.ident || 'kirin';
                this.getConnection(session);
                this.smtpHooks
                    .connect(session)
                    .then(() => callback())
                    .catch((err) => callback(normalizeError(err, 554)));
            },
            onSecure: (_socket, session, callback) => {
                this.getConnection(session);
                callback();
            },
            onAuth: (auth, session, callback) => {
                this.getConnection(session);

                if (!authentication || !this.smtpHooks.has('smtp:auth')) {
                    const error = new Error('Authentication not available') as SmtpError;
                    error.responseCode = 535;
                    callback(error);
                    return;
                }

                if (!auth.username) {
                    const error = new Error('Invalid username or password') as SmtpError;
                    error.responseCode = 535;
                    callback(error);
                    return;
                }

                this.smtpHooks
                    .auth(auth, session)
                    .then(() => callback(null, { user: auth.username }))
                    .catch((err) => callback(normalizeError(err, 535)));
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
                    .catch((err) => callback(normalizeError(err, 550)));
            },
            onRcptTo: (address, session, callback) => {
                const connection = this.getConnection(session);
                const transaction = connection.transaction || connection.resetTransaction();
                transaction.syncEnvelope(session);

                this.smtpHooks
                    .rcptTo(address, session)
                    .then(() => callback())
                    .catch((err) => callback(normalizeError(err, 550)));
            },
            onData: (stream, session, callback) => {
                const connection = this.getConnection(session);
                const transaction = connection.transaction || connection.resetTransaction();
                transaction.syncEnvelope(session);
                const chunks: Buffer[] = [];

                let returned = false;
                let streamEnded = false;
                const done: SmtpDataCallback = (...args) => {
                    if (returned) {
                        return;
                    }
                    returned = true;
                    callback(...args);
                };

                const disposeMessage = (): void => {
                    this.activeMessages.delete(session);
                    transaction.clearMessage();
                    chunks.length = 0;
                };
                this.activeMessages.set(session, disposeMessage);

                stream.on('data', (chunk: Buffer | string | Uint8Array) => {
                    if (stream.sizeExceeded) {
                        chunks.length = 0;
                        return;
                    }
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                });

                stream.once('error', (err) => {
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
                        const error = new Error(`Message exceeds fixed maximum message size ${messageSize} B`) as SmtpError;
                        error.responseCode = 552;
                        disposeMessage();
                        done(error);
                        return;
                    }

                    try {
                        const message = Buffer.concat(chunks);
                        chunks.length = 0;
                        transaction.add_leading_header('Received', this.buildReceivedHeader(connection));
                        connection.prepareMessage(message);
                    } catch (err) {
                        disposeMessage();
                        done(normalizeError(err, 452));
                        return;
                    }

                    let hookPromise: Promise<void>;
                    try {
                        const envelope = buildEnvelope(transaction, session, session.interface || this.config.ident || 'kirin');
                        transaction.envelope = envelope;
                        hookPromise = this.smtpHooks.data(envelope, session);
                    } catch (err) {
                        disposeMessage();
                        done(normalizeError(err, 451));
                        return;
                    }

                    runWithTimeout(hookPromise, hookTimeout).then(
                        () => {
                            const responseMessage = transaction.responseMessage || 'Message accepted';
                            disposeMessage();
                            done(null, responseMessage);
                        },
                        (err) => {
                            disposeMessage();
                            done(normalizeError(err, 451));
                        }
                    );
                });
            },
            onClose: (session) => {
                this.activeMessages.get(session)?.();
                this.connections.delete(session);
            }
        };
    }

    async start(): Promise<SmtpServerInstance | false> {
        if (this.closing) {
            await this.closing;
        }

        if (this.server) {
            return this.server;
        }

        if (this.config.smtp.enabled === false) {
            return false;
        }

        const operation = this.starting || this.openServer();
        this.starting = operation;

        try {
            return await operation;
        } finally {
            if (this.starting === operation) {
                this.starting = false;
            }
        }
    }

    private async openServer(): Promise<SmtpServerInstance> {
        const server = this.createSmtpServer(this.createServerOptions());
        server.on('error', (err: Error) => {
            this.log.error(formatLogSource('SMTP', getErrorSessionId(err)), 'Server error: %s', err.stack || err.message || err);
        });

        await new Promise<void>((resolve, reject) => {
            const host = this.config.smtp.host || undefined;
            const port = Number.isFinite(Number(this.config.smtp.port)) ? Number(this.config.smtp.port) : 2525;

            const onListening = (): void => {
                server.removeListener('error', onError);
                resolve();
            };

            const onError = (err: Error): void => {
                reject(err);
            };

            server.once('error', onError);
            server.listen(port, host, onListening);
        });

        this.server = server;
        return server;
    }

    async close(): Promise<void> {
        if (this.closing) {
            return this.closing;
        }

        const operation = this.closeServer();
        this.closing = operation;

        try {
            await operation;
        } finally {
            if (this.closing === operation) {
                this.closing = false;
            }
        }
    }

    private async closeServer(): Promise<void> {
        if (this.starting) {
            try {
                await this.starting;
            } catch {
                return;
            }
        }

        const server = this.server;
        if (!server) {
            return;
        }
        this.server = false;

        try {
            await this.plugins.runHooks('shutdown', []);
        } catch (err) {
            this.log.error('App', 'Shutdown hook failed: %s', err instanceof Error ? err.stack || err.message : err);
        }

        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}
