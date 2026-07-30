'use strict';

const assert = require('assert');
const { KirinConnection } = require('../lib/connection');
const { createSmtpLogger, formatLogSource, getErrorSessionId } = require('../lib/logger');

const createRecordingLogger = () => {
    const calls = [];
    const logger = {};

    for (const level of ['verbose', 'info', 'notice', 'error']) {
        logger[level] = (...args) => calls.push({ level, args });
    }

    return { calls, logger };
};

describe('session logging', () => {
    it('adds smtp-server connection ids to SMTP log sources', () => {
        const { calls, logger } = createRecordingLogger();
        const smtpLogger = createSmtpLogger(logger);

        smtpLogger.info({ cid: 'smtp-session-id', tnx: 'connection' }, 'Connection from %s', 'client.example');
        smtpLogger.debug({ cid: 'smtp-session-id', tnx: 'send' }, 'S:', '220 Ready');
        smtpLogger.error({ cid: 'smtp-session-id', tnx: 'error' }, 'Connection failed');

        assert.deepEqual(calls, [
            {
                level: 'info',
                args: ['[smtp-session-id] SMTP', 'Connection from %s', 'client.example']
            },
            {
                level: 'verbose',
                args: ['[smtp-session-id] SMTP', 'S:', '220 Ready']
            },
            {
                level: 'error',
                args: ['[smtp-session-id] SMTP', 'Connection failed']
            }
        ]);
    });

    it('leaves server-wide SMTP logs without a session id', () => {
        const { calls, logger } = createRecordingLogger();
        const smtpLogger = createSmtpLogger(logger);

        smtpLogger.info({ tnx: 'listen' }, 'SMTP Server listening');

        assert.deepEqual(calls, [
            {
                level: 'info',
                args: ['SMTP', 'SMTP Server listening']
            }
        ]);
    });

    it('retains the session id for smtp-server connection errors', () => {
        const { calls, logger } = createRecordingLogger();
        const smtpLogger = createSmtpLogger(logger);
        const err = new Error('broken TLS record');

        smtpLogger.error({ err, tnx: 'error' }, '%s %s %s', 'error-session-id', '192.0.2.10', err.message);

        assert.deepEqual(calls, [
            {
                level: 'error',
                args: ['[error-session-id] SMTP', '%s %s %s', 'error-session-id', '192.0.2.10', 'broken TLS record']
            }
        ]);
        assert.equal(getErrorSessionId(err), 'error-session-id');
    });

    it('adds the session id to plugin-facing connection logs', () => {
        const { calls, logger } = createRecordingLogger();
        const connection = new KirinConnection(
            {
                config: { smtp: { name: 'mx.example.test' } },
                log: logger
            },
            {
                id: 'plugin-session-id',
                remoteAddress: '192.0.2.10',
                remotePort: 12345,
                localAddress: '192.0.2.20',
                localPort: 2525,
                hostNameAppearsAs: 'client.example',
                openingCommand: 'EHLO',
                transmissionType: 'ESMTP',
                secure: false,
                tlsOptions: false
            }
        );

        connection.loginfo({ name: 'example-plugin' }, 'Handled %s', 'event');
        connection.logerror(false, 'Rejected message');

        assert.deepEqual(calls, [
            {
                level: 'info',
                args: ['[plugin-session-id] example-plugin', 'Handled %s', 'event']
            },
            {
                level: 'error',
                args: ['[plugin-session-id] Kirin', 'Rejected message']
            }
        ]);
    });

    it('does not add brackets when no session id is available', () => {
        assert.equal(formatLogSource('SMTP', undefined), 'SMTP');
        assert.equal(formatLogSource('SMTP', ''), 'SMTP');
    });
});
