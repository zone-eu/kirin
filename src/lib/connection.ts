import os from 'node:os';
import ipaddr from 'ipaddr.js';
import { formatLogSource, getLogMethod } from './logger.js';
import { KirinTransaction } from './transaction.js';
import type { KirinConfig, LoggerLike, LogLevel, PluginIdentity, SmtpSession } from '../types.js';

interface ConnectionRuntime {
    config: Pick<KirinConfig, 'smtp'>;
    log: LoggerLike;
}

const isPrivateAddress = (address: string): boolean => {
    try {
        const parsed = ipaddr.parse(address);
        return ['loopback', 'private', 'linkLocal', 'uniqueLocal', 'carrierGradeNat', 'unspecified'].includes(parsed.range());
    } catch {
        return false;
    }
};

export class KirinConnection {
    readonly runtime: ConnectionRuntime;
    session: SmtpSession;
    transaction: KirinTransaction | false = false;
    readonly results = new Map<string, unknown>();
    readonly remote: {
        ip: string;
        port: number | undefined;
        is_private: boolean;
    };
    readonly local: {
        ip: string | undefined;
        port: number | undefined;
        host: string;
    };
    readonly hello: {
        host: string | undefined;
    };
    greeting: string | undefined;
    tls_cipher: string | false;

    constructor(runtime: ConnectionRuntime, session: SmtpSession) {
        this.runtime = runtime;
        this.session = session;

        this.remote = {
            ip: session.remoteAddress,
            port: session.remotePort,
            is_private: isPrivateAddress(session.remoteAddress)
        };

        this.local = {
            ip: session.localAddress,
            port: session.localPort,
            host: runtime.config.smtp.name || os.hostname()
        };

        this.hello = {
            host: session.hostNameAppearsAs
        };

        this.greeting = session.openingCommand;
        this.tls_cipher = this.getTlsCipher(session);

        if (session.secure) {
            this.results.set('tls', {
                enabled: true,
                cipher: this.tls_cipher
            });
        }
    }

    refreshSession(session: SmtpSession): void {
        this.session = session;
        this.remote.ip = session.remoteAddress;
        this.remote.port = session.remotePort;
        this.remote.is_private = isPrivateAddress(session.remoteAddress);
        this.local.ip = session.localAddress;
        this.local.port = session.localPort;
        this.local.host = this.runtime.config.smtp.name || os.hostname();
        this.hello.host = session.hostNameAppearsAs;
        this.greeting = session.openingCommand;
        this.tls_cipher = this.getTlsCipher(session);

        if (session.secure) {
            this.results.set('tls', {
                enabled: true,
                cipher: this.tls_cipher
            });
        } else {
            this.results.delete('tls');
        }

        if (this.transaction) {
            this.transaction.syncEnvelope(session);
        }
    }

    resetTransaction(): KirinTransaction {
        this.transaction = new KirinTransaction(this);
        this.transaction.notes.sender = '';
        this.transaction.notes.transmissionType = this.session.transmissionType;
        this.transaction.syncEnvelope(this.session);
        return this.transaction;
    }

    prepareMessage(rawBuffer: Buffer | string): void {
        const transaction = this.transaction || this.resetTransaction();
        transaction.syncEnvelope(this.session);
        transaction.setMessage(rawBuffer);
    }

    auth_results(info: string | false | null | undefined): void {
        if (!info || !this.transaction) {
            return;
        }

        this.transaction.add_header('Authentication-Results', `${this.local.host}; ${info}`);
    }

    logdebug(plugin: PluginIdentity | false | null | undefined, message: string, ...args: unknown[]): void {
        this.log('verbose', plugin, message, ...args);
    }

    loginfo(plugin: PluginIdentity | false | null | undefined, message: string, ...args: unknown[]): void {
        this.log('info', plugin, message, ...args);
    }

    lognotice(plugin: PluginIdentity | false | null | undefined, message: string, ...args: unknown[]): void {
        this.log('notice', plugin, message, ...args);
    }

    logerror(plugin: PluginIdentity | false | null | undefined, message: string, ...args: unknown[]): void {
        this.log('error', plugin, message, ...args);
    }

    private log(level: LogLevel, plugin: PluginIdentity | false | null | undefined, message: string, ...args: unknown[]): void {
        const source = (plugin && (plugin.title || plugin.name)) || 'Kirin';
        getLogMethod(this.runtime.log, level).call(this.runtime.log, formatLogSource(source, this.session.id), message, ...args);
    }

    private getTlsCipher(session: SmtpSession): string | false {
        const tlsOptions = session.tlsOptions;
        return tlsOptions && typeof tlsOptions === 'object' && typeof tlsOptions.name === 'string' ? tlsOptions.name : false;
    }
}
