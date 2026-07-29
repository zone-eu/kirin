'use strict';

const assert = require('assert');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const { installProcessErrorHandlers } = require('../lib/process-errors');

describe('process error handling', () => {
    it('logs unhandled rejections and uncaught exceptions', () => {
        const target = new EventEmitter();
        const calls = [];
        const removeHandlers = installProcessErrorHandlers({
            target,
            log: {
                error(...args) {
                    calls.push(args);
                }
            }
        });

        target.emit('unhandledRejection', new Error('rejected'));
        target.emit('uncaughtException', new Error('thrown'), 'uncaughtException');

        assert.equal(calls.length, 2);
        assert.match(calls[0][1], /Unhandled rejection/);
        assert.match(calls[0][2], /rejected/);
        assert.match(calls[1][1], /Uncaught exception/);
        assert.match(calls[1][2], /thrown/);

        removeHandlers();
        assert.equal(target.listenerCount('unhandledRejection'), 0);
        assert.equal(target.listenerCount('uncaughtException'), 0);
    });

    it('keeps a process alive after both failure types', done => {
        const handlerPath = require.resolve('../lib/process-errors');
        const script = `
            const { installProcessErrorHandlers } = require(${JSON.stringify(handlerPath)});
            const failures = [];
            installProcessErrorHandlers({
                log: {
                    error(_component, label) {
                        failures.push(label);
                    }
                }
            });
            Promise.reject(new Error('rejected'));
            setImmediate(() => {
                throw new Error('thrown');
            });
            setTimeout(() => {
                if (failures.length !== 2) {
                    process.exit(2);
                }
                require('fs').writeSync(1, 'still alive');
                process.exit(0);
            }, 50);
        `;

        execFile(process.execPath, ['-e', script], { timeout: 2000 }, (err, stdout) => {
            assert.ifError(err);
            assert.equal(stdout, 'still alive');
            done();
        });
    });
});
