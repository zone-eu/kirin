import type { EventEmitter } from 'node:events';
import type { LoggerLike } from '../types.js';

type ErrorTarget = EventEmitter & {
    stderr?: {
        write(message: string): unknown;
    };
};

const errorMessage = (err: unknown): string | undefined => {
    if (!err || typeof err !== 'object') {
        return undefined;
    }

    if ('message' in err && typeof err.message === 'string') {
        return err.message;
    }
    return undefined;
};

const formatError = (err: unknown): string => {
    try {
        if (err && typeof err === 'object') {
            if ('stack' in err && typeof err.stack === 'string') {
                return err.stack;
            }
            const message = errorMessage(err);
            if (message) {
                return message;
            }
        }
        return String(err);
    } catch (formatErr) {
        return `<unable to format error: ${errorMessage(formatErr) || 'unknown error'}>`;
    }
};

const reportError = (target: ErrorTarget, log: Pick<LoggerLike, 'error'>, label: string, err: unknown): void => {
    const message = formatError(err);

    try {
        log.error('App', `${label}: %s`, message);
    } catch {
        try {
            target.stderr?.write(`[kirin] ${label}: ${message}\n`);
        } catch {
            // There is no safe reporting path left, so keep the process alive silently.
        }
    }
};

export const installProcessErrorHandlers = ({
    log,
    target = process
}: {
    log: Pick<LoggerLike, 'error'>;
    target?: ErrorTarget;
}): (() => void) => {
    const onUnhandledRejection = (reason: unknown): void => {
        reportError(target, log, 'Unhandled rejection', reason);
    };

    const onUncaughtException = (err: Error, origin?: string): void => {
        reportError(target, log, `Uncaught exception (${origin || 'unknown origin'})`, err);
    };

    target.on('unhandledRejection', onUnhandledRejection);
    target.on('uncaughtException', onUncaughtException);

    return () => {
        target.removeListener('unhandledRejection', onUnhandledRejection);
        target.removeListener('uncaughtException', onUncaughtException);
    };
};
