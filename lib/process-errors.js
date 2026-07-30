'use strict';

const formatError = err => {
    try {
        if (err && err.stack) {
            return err.stack;
        }
        if (err && err.message) {
            return err.message;
        }
        return String(err);
    } catch (formatErr) {
        return `<unable to format error: ${formatErr && formatErr.message ? formatErr.message : 'unknown error'}>`;
    }
};

const reportError = (target, log, label, err) => {
    const message = formatError(err);

    try {
        log.error('App', `${label}: %s`, message);
    } catch (logErr) {
        // An exception handler must not become another reason for the process to exit.
        try {
            target.stderr?.write(`[kirin] ${label}: ${message}\n`);
        } catch (writeErr) {
            // There is no safe reporting path left, so keep the process alive silently.
        }
    }
};

const installProcessErrorHandlers = ({ log, target = process }) => {
    const onUnhandledRejection = reason => {
        reportError(target, log, 'Unhandled rejection', reason);
    };

    const onUncaughtException = (err, origin) => {
        reportError(target, log, `Uncaught exception (${origin || 'unknown origin'})`, err);
    };

    target.on('unhandledRejection', onUnhandledRejection);
    target.on('uncaughtException', onUncaughtException);

    return () => {
        target.removeListener('unhandledRejection', onUnhandledRejection);
        target.removeListener('uncaughtException', onUncaughtException);
    };
};

module.exports = { installProcessErrorHandlers };
