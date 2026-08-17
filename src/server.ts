#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, parse, resolve } from 'node:path';
import { inspect } from 'node:util';
import { createKirinServer } from './create-kirin-server.js';
import { createLogger, getLogMethod } from './lib/logger.js';
import { installProcessErrorHandlers } from './lib/process-errors.js';
import type { KirinConfig, LoggerLike } from './types.js';

const bootstrapState: { log?: LoggerLike } = {};

const findPackageRoot = (): string => {
    let current = process.argv[1] ? dirname(realpathSync(resolve(process.argv[1]))) : process.cwd();

    while (current !== parse(current).root) {
        const manifestPath = resolve(current, 'package.json');
        if (existsSync(manifestPath)) {
            try {
                const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
                if (manifest && typeof manifest === 'object' && 'name' in manifest && manifest.name === '@zone-eu/kirin') {
                    return current;
                }
            } catch {
                // Continue upwards when an unrelated package manifest can not be parsed.
            }
        }
        current = dirname(current);
    }

    return process.cwd();
};

const formatUnknownError = (err: unknown): unknown => {
    if (err && typeof err === 'object') {
        if ('stack' in err && typeof err.stack === 'string') {
            return err.stack;
        }
        if ('message' in err && typeof err.message === 'string') {
            return err.message;
        }
    }
    return err;
};

const bootstrap = async (): Promise<void> => {
    const packageRoot = findPackageRoot();
    process.chdir(packageRoot);
    process.env.NODE_CONFIG_DIR ||= resolve(packageRoot, 'config');

    // Configuration must load after NODE_CONFIG_DIR is set; static ESM imports run too early.
    const { default: loadedConfig } = await import('@zone-eu/wild-config');
    const config = loadedConfig as unknown as KirinConfig;
    const log = createLogger(config);
    bootstrapState.log = log;

    if (process.env.NODE_CONFIG_ONLY === 'true') {
        console.log(inspect(config, false, 22));
        process.exit(0);
    }

    if (config.ident) {
        process.title = config.ident;
    }

    installProcessErrorHandlers({ log });

    const runningServer = await createKirinServer({ config, log });

    await runningServer.start();

    log.info('App', 'Kirin ready on %s:%s', config.smtp.host || '0.0.0.0', config.smtp.port);

    let closing = false;
    const shutdown = (signal: NodeJS.Signals): void => {
        if (closing) {
            return;
        }
        closing = true;

        getLogMethod(log, 'notice').call(log, 'App', 'Process [%s] received %s, closing server', process.pid, signal);
        runningServer
            .close()
            .catch((err) => {
                log.error('App', 'Failed to close server cleanly: %s', formatUnknownError(err));
            })
            .finally(() => {
                process.exit(0);
            });
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
};

bootstrap().catch((err) => {
    const message = formatUnknownError(err);
    process.exitCode = 1;
    try {
        if (bootstrapState.log) {
            bootstrapState.log.error('App', 'Failed to start server: %s', message);
            return;
        }
        process.stderr.write(`[kirin] Failed to start server: ${String(message)}\n`);
    } catch {
        // There is no safe reporting path left during bootstrap.
    }
});
