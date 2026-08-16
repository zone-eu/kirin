import PluginHandler from '@zone-eu/wild-plugins';
import type { PluginHandlerOptions } from '@zone-eu/wild-plugins/types';
import type { KirinConnection } from './connection.js';
import type { KirinConfig, LoggerLike, SmtpSession } from '../types.js';

export type GetConnection = (session: SmtpSession) => KirinConnection;

type KirinPluginHandlerOptions = PluginHandlerOptions & {
    getConnection: GetConnection;
};

export const loadPlugins = async (config: KirinConfig, log: LoggerLike, getConnection: GetConnection): Promise<PluginHandler> => {
    const options: KirinPluginHandlerOptions = {
        logger: log,
        pluginsPath: config.plugins?.pluginsPath || './plugins',
        plugins: config.plugins?.conf || {},
        context: 'receiver',
        getConnection,
        log: config.log || {},
        db: {
            senderDb: false,
            redis: false
        }
    };
    const handler = new PluginHandler(options);

    await new Promise<void>((resolve) => handler.load(() => resolve()));
    await handler.runHooks('init', []);

    return handler;
};
