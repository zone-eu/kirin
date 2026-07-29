'use strict';

const PluginHandler = require('@zone-eu/wild-plugins');

const loadPlugins = async (config, log, getConnection) => {
    const handler = new PluginHandler({
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
    });

    await new Promise(resolve => handler.load(resolve));
    await handler.runHooks('init', []);

    return handler;
};

module.exports = { loadPlugins };
