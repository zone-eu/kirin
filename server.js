'use strict';

const Path = require('path');

process.chdir(__dirname);
process.env.NODE_CONFIG_DIR = process.env.NODE_CONFIG_DIR || Path.join(__dirname, 'config');

const util = require('util');
const config = require('@zone-eu/wild-config');
const { KirinServer } = require('./lib/kirin-server');
const { createLogger } = require('./lib/logger');
const { loadPlugins } = require('./lib/plugins');
const { installProcessErrorHandlers } = require('./lib/process-errors');

const log = createLogger(config);

if (process.env.NODE_CONFIG_ONLY === 'true') {
    console.log(util.inspect(config, false, 22));
    process.exit(0);
}

if (config.ident) {
    process.title = config.ident;
}

installProcessErrorHandlers({ log });

const start = async () => {
    let server;
    const plugins = await loadPlugins(config, log, session => {
        if (!server) {
            throw new Error('SMTP server is not initialized');
        }
        return server.getConnection(session);
    });
    server = new KirinServer({ config, log, plugins });

    await server.start();

    log.info('App', 'Kirin ready on %s:%s', config.smtp.host || '0.0.0.0', config.smtp.port);

    let closing = false;
    const shutdown = signal => {
        if (closing) {
            return;
        }
        closing = true;

        log.notice('App', 'Process [%s] received %s, closing server', process.pid, signal);
        server
            .close()
            .catch(err => {
                log.error('App', 'Failed to close server cleanly: %s', err.stack || err.message || err);
            })
            .finally(() => {
                process.exit(0);
            });
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
};

start().catch(err => {
    try {
        log.error('App', 'Failed to start server: %s', err && (err.stack || err.message) ? err.stack || err.message : err);
    } catch (logErr) {
        process.stderr.write(`[kirin] Failed to start server: ${err && (err.stack || err.message) ? err.stack || err.message : err}\n`);
    }
});
