import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { KirinServer, type SmtpServerFactory } from '../src/lib/kirin-server.js';
import { normalizeAddress } from '../src/lib/smtp-envelope.js';
import { KirinTransaction } from '../src/lib/transaction.js';
import type {
    Envelope,
    KirinConfig,
    LoggerLike,
    PluginHandlerLike,
    SmtpDataStream,
    SmtpError,
    SmtpServerInstance,
    SmtpServerOptions,
    SmtpSession
} from '../src/types.js';

type HookAction = (...args: unknown[]) => unknown;

class FakePlugins implements PluginHandlerLike {
    readonly hooks = new Map<string, unknown[]>();
    readonly actions = new Map<string, HookAction>();
    readonly calls: Array<{ name: string; args: unknown[] }> = [];

    on<Args extends unknown[]>(name: string, action: (...args: Args) => unknown): void {
        this.hooks.set(name, [{ name }]);
        this.actions.set(name, action as HookAction);
    }

    runHooks(name: string, args: unknown[]): Promise<void> {
        this.calls.push({ name, args });
        const action = this.actions.get(name);
        return Promise.resolve()
            .then(() => action?.(...args))
            .then(() => undefined);
    }
}

const createSession = (overrides: Partial<SmtpSession> = {}): SmtpSession => ({
    id: 'session-id',
    secure: false,
    remoteAddress: '192.0.2.10',
    remotePort: 12345,
    localAddress: '192.0.2.20',
    localPort: 2525,
    clientHostname: 'client.example',
    hostNameAppearsAs: 'helo.example',
    openingCommand: 'EHLO',
    transmissionType: 'ESMTP',
    tlsOptions: false,
    user: false,
    envelope: {
        mailFrom: false,
        rcptTo: []
    },
    ...overrides
});

const silentLogger: LoggerLike = {
    info() {},
    error() {},
    verbose() {},
    notice() {}
};

class FakeSmtpServer extends EventEmitter implements SmtpServerInstance {
    listening = false;

    constructor(private readonly listenError?: Error) {
        super();
    }

    listen(_port: number, _host: string | undefined, callback: () => void): this {
        queueMicrotask(() => {
            if (this.listenError) {
                this.emit('error', this.listenError);
                return;
            }
            this.listening = true;
            callback();
        });
        return this;
    }

    close(callback: () => void): void {
        this.listening = false;
        queueMicrotask(callback);
    }
}

const createRuntime = ({
    smtp,
    plugins = new FakePlugins()
}: {
    smtp?: Partial<KirinConfig['smtp']>;
    plugins?: FakePlugins;
} = {}): { runtime: KirinServer; plugins: FakePlugins; options: SmtpServerOptions } => {
    const runtime = new KirinServer({
        config: {
            ident: 'kirin-test',
            smtp: {
                enabled: true,
                name: 'mx.example',
                size: 1024 * 1024,
                authentication: false,
                authOptional: true,
                disableSTARTTLS: true,
                ...smtp
            }
        },
        log: silentLogger,
        plugins
    });

    return { runtime, plugins, options: runtime.createServerOptions() };
};

interface CallbackResult {
    err: SmtpError | null | undefined;
    result: unknown;
}

const callHandler = (invoke: (callback: (err?: SmtpError | null, result?: unknown) => void) => void): Promise<CallbackResult> =>
    new Promise((resolve) => {
        invoke((err, result) => resolve({ err, result }));
    });

describe('KirinServer SMTP hooks', () => {
    it('retries failed starts, coalesces concurrent starts, and restarts after close', async () => {
        const plugins = new FakePlugins();
        const servers: FakeSmtpServer[] = [];
        const createSmtpServer: SmtpServerFactory = () => {
            const server = new FakeSmtpServer(servers.length === 0 ? new Error('address unavailable') : undefined);
            servers.push(server);
            return server;
        };
        const runtime = new KirinServer({
            config: { smtp: { host: '127.0.0.1', port: 2525 } },
            log: silentLogger,
            plugins,
            createSmtpServer
        });

        await assert.rejects(runtime.start(), /address unavailable/);

        const [first, duplicate] = await Promise.all([runtime.start(), runtime.start()]);
        assert(first);
        assert.strictEqual(duplicate, first);
        assert.equal(servers.length, 2);

        await runtime.close();
        assert.equal((first as FakeSmtpServer).listening, false);

        const restarted = await runtime.start();
        assert(restarted);
        assert.notStrictEqual(restarted, first);
        assert.equal(servers.length, 3);
        await runtime.close();
    });

    it('passes the original session to smtp:connect and keeps internal state private', async () => {
        const { runtime, plugins, options } = createRuntime();
        const session = createSession();

        const { err } = await callHandler((callback) => options.onConnect(session, callback));

        assert.ifError(err);
        assert.equal(session.interface, 'kirin-test');
        assert.equal(Object.prototype.hasOwnProperty.call(session, '__kirinConnection'), false);
        assert.deepEqual(plugins.calls, [{ name: 'smtp:connect', args: [session] }]);
        assert(runtime.getConnection(session));
    });

    it('does not advertise AUTH by default', () => {
        const { options } = createRuntime();
        assert(options.disabledCommands.includes('AUTH'));
    });

    it('advertises the configured message size limit', () => {
        const { options } = createRuntime({ smtp: { size: 1024 } });
        assert.equal(options.size, 1024);
    });

    it('rejects AUTH when enabled without an auth hook', async () => {
        const { options } = createRuntime({ smtp: { authentication: true } });
        const auth = { method: 'PLAIN', username: 'user@example', password: 'secret' };
        const { err, result } = await callHandler((callback) => options.onAuth(auth, createSession(), callback));

        assert(err);
        assert.equal(err.responseCode, 535);
        assert.equal(result, undefined);
    });

    it('passes auth and session in ZoneMTA order and returns the accepted username', async () => {
        const plugins = new FakePlugins();
        plugins.on<[{ username: string }]>('smtp:auth', (auth) => {
            auth.username = 'canonical@example';
        });
        const { options } = createRuntime({ smtp: { authentication: true }, plugins });
        const session = createSession();
        const auth = { method: 'PLAIN', username: 'user@example', password: 'secret' };

        const { err, result } = await callHandler((callback) => options.onAuth(auth, session, callback));

        assert.ifError(err);
        assert.deepEqual(result, { user: 'canonical@example' });
        assert.deepEqual(plugins.calls[0], { name: 'smtp:auth', args: [auth, session] });
    });

    it('preserves auth hook errors', async () => {
        const plugins = new FakePlugins();
        plugins.on('smtp:auth', () => {
            const error = new Error('Temporarily unavailable') as SmtpError;
            error.responseCode = 454;
            throw error;
        });
        const { options } = createRuntime({ smtp: { authentication: true }, plugins });
        const auth = { method: 'LOGIN', username: 'user@example', password: 'secret' };

        const { err } = await callHandler((callback) => options.onAuth(auth, createSession(), callback));

        assert(err);
        assert.equal(err.responseCode, 454);
    });

    it('passes the untouched MAIL FROM address and assigns the envelope id before the hook', async () => {
        const plugins = new FakePlugins();
        const { runtime, options } = createRuntime({ plugins });
        const session = createSession();
        const address = { address: 'sender@example.com', args: { SIZE: '123' } };
        const connection = runtime.getConnection(session);

        const { err } = await callHandler((callback) => options.onMailFrom(address, session, callback));

        assert.ifError(err);
        assert.equal(typeof address.address, 'string');
        assert.deepEqual(plugins.calls[0], { name: 'smtp:mail_from', args: [address, session] });
        assert(connection.transaction);
        assert.equal(session.envelopeId, connection.transaction.uuid);
        assert(connection.transaction.mail_from);
        assert.equal(connection.transaction.mail_from.address(), address.address);
    });

    it('passes the untouched RCPT TO address and session', async () => {
        const plugins = new FakePlugins();
        const { options } = createRuntime({ plugins });
        const sender = { address: 'sender@example.com', args: {} };
        const recipient = { address: 'recipient@example.com', args: { NOTIFY: 'FAILURE' }, dsn: { notify: ['FAILURE'] } };
        const session = createSession({ envelope: { mailFrom: sender, rcptTo: [] } });

        const { err } = await callHandler((callback) => options.onRcptTo(recipient, session, callback));

        assert.ifError(err);
        assert.equal(typeof recipient.address, 'string');
        assert.deepEqual(plugins.calls[0], { name: 'smtp:rcpt_to', args: [recipient, session] });
    });

    it('builds and retains a ZoneMTA-compatible DATA envelope', async () => {
        const plugins = new FakePlugins();
        const { runtime, options } = createRuntime({ plugins });
        let bufferedMessage: Buffer | undefined;
        plugins.on<[Envelope, SmtpSession]>('smtp:data', (envelope, hookSession) => {
            envelope.route = 'local';
            const hookTransaction = runtime.getConnection(hookSession).transaction;
            assert(hookTransaction);
            bufferedMessage = hookTransaction.getMessageBuffer();
        });
        const sender = { address: 'Sender@TÄST.example', args: {} };
        const recipients = [
            { address: 'One@EXAMPLE.COM', args: {} },
            { address: 'üser@TÄST.example', args: {} }
        ];
        const session = createSession({
            secure: true,
            tlsOptions: { name: 'TLS_AES_256_GCM_SHA384', version: 'TLSv1.3' },
            user: 'authenticated@example',
            sendingZone: 'default',
            envelope: { mailFrom: sender, rcptTo: recipients }
        });
        const connection = runtime.getConnection(session);
        const transaction = connection.resetTransaction();
        session.envelopeId = transaction.uuid;
        const stream = new PassThrough() as PassThrough & SmtpDataStream;
        stream.sizeExceeded = false;
        const message = Buffer.from('From: sender@example.com\r\nTo: one@example.com\r\n\r\nHello');

        const resultPromise = callHandler((callback) => options.onData(stream, session, callback));
        stream.end(message);
        const { err, result } = await resultPromise;

        assert.ifError(err);
        assert.equal(result, 'Message accepted');
        assert.equal(plugins.calls.length, 1);
        const dataCall = plugins.calls[0];
        assert(dataCall);
        assert.equal(dataCall.name, 'smtp:data');
        assert.strictEqual(dataCall.args[1], session);

        const envelope = dataCall.args[0] as Envelope;
        assert.deepEqual(envelope, {
            sessionId: 'session-id',
            id: transaction.uuid,
            interface: 'kirin-test',
            from: 'Sender@xn--tst-qla.example',
            to: ['One@example.com', 'üser@täst.example'],
            origin: '192.0.2.10',
            originhost: 'client.example',
            transhost: 'helo.example',
            transtype: 'ESMTP',
            user: 'authenticated@example',
            time: envelope.time,
            sendingZone: 'default',
            tls: session.tlsOptions,
            route: 'local'
        });
        assert.equal(typeof envelope.time, 'number');
        assert.strictEqual(transaction.envelope, envelope);
        assert.equal(transaction.messageSize, message.length);
        assert(bufferedMessage);
        assert.match(bufferedMessage.toString(), /^Received: /);
        assert.match(bufferedMessage.toString(), /\r\n\r\nHello$/);
        assert.equal(transaction.sourceBuffer.length, 0);
        assert.equal(transaction.bodyBuffer.length, 0);
    });

    it('rejects DATA marked oversized by smtp-server after draining the source stream', async () => {
        const { plugins, options } = createRuntime({ smtp: { size: 16 } });
        const session = createSession();
        const stream = new PassThrough() as PassThrough & SmtpDataStream;
        stream.sizeExceeded = true;
        const resultPromise = callHandler((callback) => options.onData(stream, session, callback));

        stream.end(Buffer.alloc(64));
        const { err } = await resultPromise;

        assert(err);
        assert.equal(err.responseCode, 552);
        assert.equal(stream.readableEnded, true);
        assert.equal(plugins.calls.length, 0);
    });

    it('releases buffered RAM when smtp:data exceeds its timeout', async () => {
        const plugins = new FakePlugins();
        plugins.on('smtp:data', () => new Promise<never>(() => {}));
        const { runtime, options } = createRuntime({ plugins, smtp: { dataHookTimeout: 10 } });
        const session = createSession();
        const stream = new PassThrough() as PassThrough & SmtpDataStream;
        const resultPromise = callHandler((callback) => options.onData(stream, session, callback));

        stream.end('Subject: timeout\r\n\r\nBody');
        const { err } = await resultPromise;

        assert(err);
        assert.equal(err.responseCode, 451);
        assert.match(err.message, /timed out/);
        const transaction = runtime.getConnection(session).transaction;
        assert(transaction);
        assert.equal(transaction.sourceBuffer.length, 0);
    });

    it('does not emit a nonstandard smtp:close hook', () => {
        const { runtime, plugins, options } = createRuntime();
        const session = createSession();
        const connection = runtime.getConnection(session);

        options.onClose(session);

        assert.deepEqual(plugins.calls, []);
        assert.notStrictEqual(runtime.getConnection(session), connection);
    });
});

describe('normalizeAddress', () => {
    it('handles null senders, control characters, spaces, and internationalized domains', () => {
        assert.equal(normalizeAddress(false), '');
        assert.equal(normalizeAddress({ address: '<User@EXAMPLE.COM>' }), 'User@example.com');
        assert.equal(normalizeAddress({ address: 'first last@EXAMPLE.COM' }), '"first last"@example.com');
        assert.equal(normalizeAddress({ address: 'üser@TÄST.example' }), 'üser@täst.example');
    });
});

describe('KirinTransaction', () => {
    it('uses the first header boundary when line endings are mixed', () => {
        const transaction = new KirinTransaction({ results: new Map() });
        transaction.setMessage(Buffer.from('Subject: test\n\nBody\r\n\r\nMore body'));

        assert.equal(transaction.bodyBuffer.toString(), 'Body\r\n\r\nMore body');
    });

    it('adds headers at the trailing, leading, and specified positions', () => {
        const transaction = new KirinTransaction({ results: new Map() });
        transaction.setMessage(Buffer.from('From: sender@example.com\r\nTo: recipient@example.com\r\n\r\nBody'));
        assert(transaction.header);

        transaction.header.add('X-Trailing', 'trailing');
        transaction.header.addLeadingHeader('X-Leading', 'leading');
        transaction.header.addAt('X-Indexed', 'indexed', 2);

        assert.equal(
            transaction.getMessageBuffer().toString(),
            [
                'X-Leading: leading',
                'From: sender@example.com',
                'X-Indexed: indexed',
                'To: recipient@example.com',
                'X-Trailing: trailing',
                '',
                'Body'
            ].join('\r\n')
        );
    });

    it('makes transaction add_header trailing and add_leading_header leading', () => {
        const transaction = new KirinTransaction({ results: new Map() });
        transaction.add_header('X-Trailing', 'trailing');
        transaction.add_leading_header('X-Leading', 'leading');
        transaction.setMessage(Buffer.from('Subject: test\r\n\r\nBody'));

        assert.equal(
            transaction.getMessageBuffer().toString(),
            ['X-Leading: leading', 'Subject: test', 'X-Trailing: trailing', '', 'Body'].join('\r\n')
        );
    });
});
