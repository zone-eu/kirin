'use strict';

const log = require('npmlog');

const createLogger = config => {
    log.level = config.log?.level || 'info';
    return log;
};

const createSmtpLogger = log => ({
    info(...args) {
        args.shift();
        log.info('SMTP', ...args);
    },
    debug(...args) {
        args.shift();
        log.verbose('SMTP', ...args);
    },
    error(...args) {
        args.shift();
        log.error('SMTP', ...args);
    }
});

module.exports = { createLogger, createSmtpLogger };
