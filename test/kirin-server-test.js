'use strict';

const assert = require('assert');
const { PassThrough } = require('stream');
const { KirinServer } = require('../lib/kirin-server');
const { normalizeAddress } = require('../lib/smtp-envelope');
const { KirinTransaction } = require('../lib/transaction');

class FakePlugins {
    constructor() {
        this.hooks = new Map();
        this.actions = new Map();
        this.calls = [];
    }

    on(name, action) {
        this.hooks.set(name, [{ name }]);
        this.actions.set(name, action);
    }

    runHooks(name, args) {
        this.calls.push({ name, args });
        const action = this.actions.get(name);
        return Promise.resolve().then(() => action?.(...args));
    }
}

const createSession = overrides => ({
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

const createRuntime = ({ smtp, plugins } = {}) => {
    plugins = plugins || new FakePlugins();
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
        log: {
            info() {},
            error() {},
            verbose() {},
            notice() {}
        },
        plugins
    });

    return { runtime, plugins, options: runtime.createServerOptions() };
};

const callHandler = (handler, ...args) =>
    new Promise(resolve => {
        handler(...args, (err, result) => resolve({ err, result }));
    });

describe('KirinServer SMTP hooks', () => {
    it('passes the original session to smtp:connect and keeps internal state private', async () => {
        const { runtime, plugins, options } = createRuntime();
        const session = createSession();

        const { err } = await callHandler(options.onConnect, session);

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
        const { err, result } = await callHandler(options.onAuth, auth, createSession());

        assert(err);
        assert.equal(err.responseCode, 535);
        assert.equal(result, undefined);
    });

    it('passes auth and session in ZoneMTA order and returns the accepted username', async () => {
        const plugins = new FakePlugins();
        plugins.on('smtp:auth', auth => {
            auth.username = 'canonical@example';
        });
        const { options } = createRuntime({ smtp: { authentication: true }, plugins });
        const session = createSession();
        const auth = { method: 'PLAIN', username: 'user@example', password: 'secret' };

        const { err, result } = await callHandler(options.onAuth, auth, session);

        assert.ifError(err);
        assert.deepEqual(result, { user: 'canonical@example' });
        assert.deepEqual(plugins.calls[0], { name: 'smtp:auth', args: [auth, session] });
    });

    it('preserves auth hook errors', async () => {
        const plugins = new FakePlugins();
        plugins.on('smtp:auth', () => {
            const error = new Error('Temporarily unavailable');
            error.responseCode = 454;
            throw error;
        });
        const { options } = createRuntime({ smtp: { authentication: true }, plugins });
        const auth = { method: 'LOGIN', username: 'user@example', password: 'secret' };

        const { err } = await callHandler(options.onAuth, auth, createSession());

        assert(err);
        assert.equal(err.responseCode, 454);
    });

    it('passes the untouched MAIL FROM address and assigns the envelope id before the hook', async () => {
        const plugins = new FakePlugins();
        const { runtime, options } = createRuntime({ plugins });
        const session = createSession();
        const address = { address: 'sender@example.com', args: { SIZE: '123' } };
        const connection = runtime.getConnection(session);

        const { err } = await callHandler(options.onMailFrom, address, session);

        assert.ifError(err);
        assert.equal(typeof address.address, 'string');
        assert.deepEqual(plugins.calls[0], { name: 'smtp:mail_from', args: [address, session] });
        assert.equal(session.envelopeId, connection.transaction.uuid);
        assert.equal(connection.transaction.mail_from.address(), address.address);
    });

    it('passes the untouched RCPT TO address and session', async () => {
        const plugins = new FakePlugins();
        const { options } = createRuntime({ plugins });
        const sender = { address: 'sender@example.com', args: {} };
        const recipient = { address: 'recipient@example.com', args: { NOTIFY: 'FAILURE' }, dsn: { notify: ['FAILURE'] } };
        const session = createSession({ envelope: { mailFrom: sender, rcptTo: [] } });

        const { err } = await callHandler(options.onRcptTo, recipient, session);

        assert.ifError(err);
        assert.equal(typeof recipient.address, 'string');
        assert.deepEqual(plugins.calls[0], { name: 'smtp:rcpt_to', args: [recipient, session] });
    });

    it('builds and retains a ZoneMTA-compatible DATA envelope', async () => {
        const plugins = new FakePlugins();
        const { runtime, options } = createRuntime({ plugins });
        let bufferedMessage;
        plugins.on('smtp:data', (envelope, hookSession) => {
            envelope.route = 'local';
            bufferedMessage = runtime.getConnection(hookSession).transaction.getMessageBuffer();
        });
        const sender = { address: 'Sender@TÄST.example', args: {} };
        const recipients = [{ address: 'One@EXAMPLE.COM', args: {} }, { address: 'üser@TÄST.example', args: {} }];
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
        const stream = new PassThrough();
        stream.sizeExceeded = false;
        const message = Buffer.from('From: sender@example.com\r\nTo: one@example.com\r\n\r\nHello');

        const resultPromise = callHandler(options.onData, stream, session);
        stream.end(message);
        const { err, result } = await resultPromise;

        assert.ifError(err);
        assert.equal(result, 'Message accepted');
        assert.equal(plugins.calls.length, 1);
        assert.equal(plugins.calls[0].name, 'smtp:data');
        assert.strictEqual(plugins.calls[0].args[1], session);

        const envelope = plugins.calls[0].args[0];
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
        assert.strictEqual(connection.transaction.envelope, envelope);
        assert.equal(connection.transaction.messageSize, message.length);
        assert.match(bufferedMessage.toString(), /^Received: /);
        assert.match(bufferedMessage.toString(), /\r\n\r\nHello$/);
        assert.equal(connection.transaction.sourceBuffer.length, 0);
        assert.equal(connection.transaction.bodyBuffer.length, 0);
    });

    it('rejects DATA marked oversized by smtp-server after draining the source stream', async () => {
        const { plugins, options } = createRuntime({ smtp: { size: 16 } });
        const session = createSession();
        const stream = new PassThrough();
        stream.sizeExceeded = true;
        const resultPromise = callHandler(options.onData, stream, session);

        stream.end(Buffer.alloc(64));
        const { err } = await resultPromise;

        assert(err);
        assert.equal(err.responseCode, 552);
        assert.equal(stream.readableEnded, true);
        assert.equal(plugins.calls.length, 0);
    });

    it('releases buffered RAM when smtp:data exceeds its timeout', async () => {
        const plugins = new FakePlugins();
        plugins.on('smtp:data', () => new Promise(() => {}));
        const { runtime, options } = createRuntime({ plugins, smtp: { dataHookTimeout: 10 } });
        const session = createSession();
        const stream = new PassThrough();
        const resultPromise = callHandler(options.onData, stream, session);

        stream.end('Subject: timeout\r\n\r\nBody');
        const { err } = await resultPromise;

        assert(err);
        assert.equal(err.responseCode, 451);
        assert.match(err.message, /timed out/);
        assert.equal(runtime.getConnection(session).transaction.sourceBuffer.length, 0);
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
});
