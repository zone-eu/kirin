import { KirinServer } from './lib/kirin-server.js';
import { createLogger } from './lib/logger.js';
import { loadPlugins } from './lib/plugins.js';
import type { KirinConfig, LoggerLike, PluginHandlerLike } from './types.js';

export interface CreateKirinServerOptions {
    config: KirinConfig;
    log?: LoggerLike;
    /** An initialized plugin handler. When omitted, Kirin loads plugins from config. */
    plugins?: PluginHandlerLike;
}

/** Creates a fully wired Kirin server without starting its SMTP listener. */
export const createKirinServer = async ({
    config,
    log = createLogger(config),
    plugins
}: CreateKirinServerOptions): Promise<KirinServer> => {
    if (plugins) {
        return new KirinServer({ config, log, plugins });
    }

    const serverReference: { current?: KirinServer } = {};
    const loadedPlugins = await loadPlugins(config, log, (session) => {
        if (!serverReference.current) {
            throw new Error('SMTP server is not initialized');
        }
        return serverReference.current.getConnection(session);
    });
    const server = new KirinServer({ config, log, plugins: loadedPlugins });
    serverReference.current = server;
    return server;
};
