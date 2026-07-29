'use strict';

const Path = require('path');

process.chdir(__dirname);
process.env.NODE_CONFIG_DIR = process.env.NODE_CONFIG_DIR || Path.join(__dirname, 'config');

const cluster = require('cluster');
const os = require('os');
const util = require('util');
const config = require('@zone-eu/wild-config');
const { createLogger } = require('./lib/logger');
const { installProcessErrorHandlers } = require('./lib/process-errors');
const startWorker = require('./worker');

const log = createLogger(config);

const parseProcessCount = value => {
    if (!value) {
        return 1;
    }

    if (typeof value === 'string' && /^\s*cpus\s*$/i.test(value)) {
        return os.cpus().length;
    }

    const count = Number(value);
    if (!Number.isFinite(count) || count < 1) {
        return 1;
    }

    return Math.floor(count);
};

const processCount = parseProcessCount(config.processes);

if (process.env.NODE_CONFIG_ONLY === 'true') {
    console.log(util.inspect(config, false, 22));
    process.exit(0);
}

if (config.ident) {
    process.title = config.ident;
}

installProcessErrorHandlers({ log });

const start = async () => {
    try {
        await startWorker({ config, log });
    } catch (err) {
        log.error('App', 'Failed to start worker: %s', err && (err.stack || err.message) ? err.stack || err.message : err);
    }
};

if (processCount <= 1 || cluster.isWorker) {
    start();
} else if (cluster.isPrimary) {
    let shuttingDown = false;

    log.info('App', 'Master [%s] is running with %s workers', process.pid, processCount);

    const forkWorker = () => {
        if (shuttingDown) {
            return;
        }

        const worker = cluster.fork();
        log.info('App', 'Forked worker %s', worker.process.pid);
    };

    for (let i = 0; i < processCount; i++) {
        forkWorker();
    }

    cluster.on('exit', worker => {
        log.notice('App', 'Worker %s exited', worker.process.pid);
        if (!shuttingDown) {
            setTimeout(forkWorker, 1000);
        }
    });

    const shutdown = signal => {
        if (shuttingDown) {
            return;
        }

        shuttingDown = true;
        log.notice('App', 'Master received %s, shutting down', signal);
        for (const worker of Object.values(cluster.workers || {})) {
            if (worker) {
                worker.kill(signal);
            }
        }
        setTimeout(() => process.exit(0), 1000).unref();
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}
