'use strict';

module.exports = {
    title: 'CommonJS compatibility fixture',
    init(plugin, done) {
        plugin.addHook('smtp:connect', (session, next) => {
            session.commonJsConnection = plugin.manager.options.getConnection(session);
            next();
        });
        done();
    }
};
