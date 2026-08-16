import log from 'npmlog';
import type { KirinConfig, LoggerLike, LogLevel, LogMethod } from '../types.js';

interface SmtpLogMetadata {
    cid?: unknown;
    tnx?: unknown;
    err?: unknown;
}

export interface SmtpLogger {
    info(metadata: unknown, ...args: unknown[]): void;
    debug(metadata: unknown, ...args: unknown[]): void;
    error(metadata: unknown, ...args: unknown[]): void;
}

const errorSessionIds = new WeakMap<object, unknown>();

const formatSessionId = (sessionId: unknown): string => {
    if (typeof sessionId === 'string') {
        return sessionId;
    }
    if (typeof sessionId === 'number' || typeof sessionId === 'boolean' || typeof sessionId === 'bigint' || typeof sessionId === 'symbol') {
        return String(sessionId);
    }
    return Object.prototype.toString.call(sessionId);
};

export const formatLogSource = (source: string, sessionId: unknown): string =>
    sessionId === undefined || sessionId === null || sessionId === '' ? source : `[${formatSessionId(sessionId)}] ${source}`;

/** Resolves an optional log level while preserving the legacy fallback to info. */
export const getLogMethod = (logger: LoggerLike, level: LogLevel): LogMethod => {
    const method = logger[level];
    return typeof method === 'function' ? method : logger.info;
};

/** Extracts smtp-server's connection id from normal and connection-error metadata. */
const getSmtpSessionId = (metadata: unknown, args: unknown[]): unknown => {
    if (!metadata || typeof metadata !== 'object') {
        return undefined;
    }

    const smtpMetadata = metadata as SmtpLogMetadata;
    if (smtpMetadata.cid !== undefined && smtpMetadata.cid !== null && smtpMetadata.cid !== '') {
        return smtpMetadata.cid;
    }
    if (smtpMetadata.tnx === 'error' && typeof args[0] === 'string' && args[0].startsWith('%s')) {
        return args[1];
    }
    return undefined;
};

export const getErrorSessionId = (err: unknown): unknown => (err && typeof err === 'object' ? errorSessionIds.get(err) : undefined);

export const createLogger = (config: Pick<KirinConfig, 'log'>): LoggerLike => {
    log.level = config.log?.level || 'info';
    return log as unknown as LoggerLike;
};

export const createSmtpLogger = (logger: LoggerLike): SmtpLogger => {
    const write = (level: Exclude<LogLevel, 'notice'>, metadata: unknown, args: unknown[]): void => {
        const sessionId = getSmtpSessionId(metadata, args);
        if (sessionId !== undefined && metadata && typeof metadata === 'object') {
            const smtpMetadata = metadata as SmtpLogMetadata;
            if (smtpMetadata.err instanceof Error) {
                errorSessionIds.set(smtpMetadata.err, sessionId);
            }
        }
        getLogMethod(logger, level).call(logger, formatLogSource('SMTP', sessionId), ...args);
    };

    return {
        info(metadata, ...args) {
            write('info', metadata, args);
        },
        debug(metadata, ...args) {
            write('verbose', metadata, args);
        },
        error(metadata, ...args) {
            write('error', metadata, args);
        }
    };
};
