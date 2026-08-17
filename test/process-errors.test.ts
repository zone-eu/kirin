import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { installProcessErrorHandlers } from '../src/lib/process-errors.js';

const execFileAsync = promisify(execFile);

describe('process error handling', () => {
    it('logs unhandled rejections and uncaught exceptions', () => {
        const target = new EventEmitter();
        const calls: unknown[][] = [];
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
        assert.match(String(calls[0]?.[1]), /Unhandled rejection/);
        assert.match(String(calls[0]?.[2]), /rejected/);
        assert.match(String(calls[1]?.[1]), /Uncaught exception/);
        assert.match(String(calls[1]?.[2]), /thrown/);

        removeHandlers();
        assert.equal(target.listenerCount('unhandledRejection'), 0);
        assert.equal(target.listenerCount('uncaughtException'), 0);
    });

    it('keeps a compiled ESM process alive after both failure types', async () => {
        const handlerUrl = pathToFileURL(resolve('dist/esm/lib/process-errors.js')).href;
        // Script to check process
        const script = `
            import { writeSync } from 'node:fs';
            import { installProcessErrorHandlers } from ${JSON.stringify(handlerUrl)};
            const failures = [];
            const completionTimeout = setTimeout(() => process.exit(2), 1000);
            installProcessErrorHandlers({
                log: {
                    error(_component, label, message) {
                        failures.push({ label, message });
                        const loggedRejection = failures.some(
                            (failure) => failure.label.includes('Unhandled rejection') && failure.message.includes('rejected')
                        );
                        const loggedException = failures.some(
                            (failure) => failure.label.includes('Uncaught exception') && failure.message.includes('thrown')
                        );
                        if (loggedRejection && loggedException) {
                            clearTimeout(completionTimeout);
                            writeSync(1, 'still alive');
                            process.exit(0);
                        }
                    }
                }
            });
            Promise.reject(new Error('rejected'));
            setImmediate(() => {
                throw new Error('thrown');
            });
        `;

        const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', script], { timeout: 2000 });
        assert.equal(stdout, 'still alive');
    });

    it('exits unsuccessfully when the compiled bootstrap fails', async () => {
        const result = await new Promise<{ code: string | number | null | undefined; output: string }>((resolveResult) => {
            execFile(
                process.execPath,
                ['--enable-source-maps', resolve('dist/esm/server.js')],
                {
                    env: {
                        ...process.env,
                        APPCONF_smtp_tls_keyPath: '/definitely/missing/kirin-key.pem'
                    }
                },
                (err, stdout, stderr) => {
                    resolveResult({ code: err?.code, output: `${stdout}${stderr}` });
                }
            );
        });

        assert.equal(result.code, 1);
        if (result.output) {
            assert.match(result.output, /Failed to start server/);
        }
    });
});
