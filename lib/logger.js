'use strict';

const log = require('npmlog');
const errorSessionIds = new WeakMap();

/**
 * @param {string} source
 * @param {unknown} sessionId
 * @returns {string}
 */
const formatLogSource = (source, sessionId) =>
    sessionId === undefined || sessionId === null || sessionId === '' ? source : `[${String(sessionId)}] ${source}`;

/**
 * smtp-server includes `cid` on normal connection log metadata, but its
 * connection error path currently supplies the id as the first format value.
 *
 * @param {unknown} metadata
 * @param {unknown[]} args
 * @returns {unknown}
 */
const getSmtpSessionId = (metadata, args) => {
    if (!metadata || typeof metadata !== 'object') {
        return undefined;
    }
    if (metadata.cid !== undefined && metadata.cid !== null && metadata.cid !== '') {
        return metadata.cid;
    }
    if (metadata.tnx === 'error' && typeof args[0] === 'string' && args[0].startsWith('%s')) {
        return args[1];
    }
    return undefined;
};

/**
 * @param {unknown} err
 * @returns {unknown}
 */
const getErrorSessionId = err => (err && typeof err === 'object' ? errorSessionIds.get(err) : undefined);

const createLogger = config => {
    log.level = config.log?.level || 'info';
    return log;
};

const createSmtpLogger = log => {
    const write = (level, metadata, args) => {
        const sessionId = getSmtpSessionId(metadata, args);
        if (sessionId !== undefined && metadata && typeof metadata === 'object' && metadata.err instanceof Error) {
            errorSessionIds.set(metadata.err, sessionId);
        }
        log[level](formatLogSource('SMTP', sessionId), ...args);
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

module.exports = { createLogger, createSmtpLogger, formatLogSource, getErrorSessionId };
