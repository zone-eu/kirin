import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createKirinServer } from '../src/index.js';
import { KirinConnection } from '../src/lib/connection.js';
import { loadPlugins } from '../src/lib/plugins.js';
import type { LoggerLike, SmtpSession } from '../src/types.js';

const silentLogger: LoggerLike = {
    info() {},
    error() {},
    verbose() {},
    notice() {}
};

const isExportObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';

describe('compiled package compatibility', () => {
    it('exports the public API through both ESM and CommonJS builds', async () => {
        const packageSpecifier = ['@zone-eu', 'kirin'].join('/');
        const esmExports: unknown = await import(packageSpecifier);
        const require = createRequire(resolve('package.json'));
        const commonJsExports: unknown = require(packageSpecifier);

        assert(isExportObject(esmExports));
        assert(isExportObject(commonJsExports));
        assert.equal(typeof esmExports.KirinServer, 'function');
        assert.equal(typeof commonJsExports.KirinServer, 'function');
        assert.equal(typeof esmExports.createKirinServer, 'function');
        assert.equal(typeof commonJsExports.createKirinServer, 'function');
        assert.equal((esmExports.KirinServer as { name?: string }).name, 'KirinServer');
        assert.equal((commonJsExports.KirinServer as { name?: string }).name, 'KirinServer');
    });

    it('creates an initialized public server with injected integrations', async () => {
        const plugins = {
            hooks: new Map<string, unknown[]>(),
            async runHooks(): Promise<void> {}
        };
        const server = await createKirinServer({
            config: { smtp: { enabled: false } },
            log: silentLogger,
            plugins
        });

        assert.strictEqual(server.plugins, plugins);
        assert.equal(await server.start(), false);
    });

    it('loads a legacy CommonJS plugin and exposes getConnection', async () => {
        const session: SmtpSession = {
            id: 'commonjs-plugin-session',
            remoteAddress: '192.0.2.10',
            envelope: {
                mailFrom: false,
                rcptTo: []
            }
        };
        const connection = new KirinConnection({ config: { smtp: {} }, log: silentLogger }, session);
        const handler = await loadPlugins(
            {
                smtp: {},
                plugins: {
                    pluginsPath: resolve('test/fixtures'),
                    conf: {
                        'commonjs-plugin': {
                            enabled: true
                        }
                    }
                }
            },
            silentLogger,
            () => connection
        );

        await handler.runHooks('smtp:connect', [session]);

        assert.equal(session.commonJsConnection, connection);
    });
});
