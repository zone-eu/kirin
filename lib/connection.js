// @ts-check
'use strict';

const os = require('os');
const ipaddr = require('ipaddr.js');
const { KirinTransaction } = require('./transaction');

/**
 * @typedef {import('@zone-eu/types').SmtpSession & {
 *   localAddress?: string,
 *   localPort?: number,
 *   openingCommand?: string,
 *   secure?: boolean
 * }} SmtpSession
 * @typedef {{ title?: string, name?: string }} PluginIdentity
 * @typedef {{
 *   info: (...args: unknown[]) => void,
 *   error: (...args: unknown[]) => void,
 *   verbose: (...args: unknown[]) => void,
 *   notice?: (...args: unknown[]) => void,
 *   [level: string]: ((...args: unknown[]) => void) | undefined
 * }} LoggerLike
 * @typedef {{ config: { smtp: { name?: string } }, log: LoggerLike }} RuntimeLike
 */

/**
 * @param {string} address
 * @returns {boolean}
 */
const isPrivateAddress = address => {
    try {
        const parsed = ipaddr.parse(address);
        return ['loopback', 'private', 'linkLocal', 'uniqueLocal', 'carrierGradeNat', 'unspecified'].includes(parsed.range());
    } catch {
        return false;
    }
};

class KirinConnection {
    /**
     * @param {RuntimeLike} runtime
     * @param {SmtpSession} session
     */
    constructor(runtime, session) {
        this.runtime = runtime;
        this.session = session;
        /** @type {InstanceType<typeof KirinTransaction> | false} */
        this.transaction = false;
        /** @type {Map<string, unknown>} */
        this.results = new Map();

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
        this.tls_cipher = this._getTlsCipher(session);

        if (session.secure) {
            this.results.set('tls', {
                enabled: true,
                cipher: this.tls_cipher
            });
        }
    }

    /**
     * @param {SmtpSession} session
     * @returns {void}
     */
    refreshSession(session) {
        this.session = session;
        this.remote.ip = session.remoteAddress;
        this.remote.port = session.remotePort;
        this.remote.is_private = isPrivateAddress(session.remoteAddress);
        this.local.ip = session.localAddress;
        this.local.port = session.localPort;
        this.local.host = this.runtime.config.smtp.name || os.hostname();
        this.hello.host = session.hostNameAppearsAs;
        this.greeting = session.openingCommand;
        this.tls_cipher = this._getTlsCipher(session);

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

    /** @returns {InstanceType<typeof KirinTransaction>} */
    resetTransaction() {
        this.transaction = new KirinTransaction(this);
        this.transaction.notes.sender = '';
        this.transaction.notes.transmissionType = this.session.transmissionType;
        this.transaction.syncEnvelope(this.session);
        return this.transaction;
    }

    /**
     * @param {Buffer | string} rawBuffer
     * @returns {void}
     */
    prepareMessage(rawBuffer) {
        const transaction = this.transaction || this.resetTransaction();
        transaction.syncEnvelope(this.session);
        transaction.setMessage(rawBuffer);
    }

    /**
     * @param {string | false | null | undefined} info
     * @returns {void}
     */
    auth_results(info) {
        if (!info || !this.transaction) {
            return;
        }

        this.transaction.add_header('Authentication-Results', `${this.local.host}; ${info}`);
    }

    /**
     * @param {string} level
     * @param {PluginIdentity | false | null | undefined} plugin
     * @param {string} message
     * @param {...unknown} args
     * @returns {void}
     */
    _log(level, plugin, message, ...args) {
        const source = (plugin && (plugin.title || plugin.name)) || 'Kirin';
        const logMethod = this.runtime.log[level] || this.runtime.log.info;
        logMethod(source, message, ...args);
    }

    /**
     * @param {PluginIdentity | false | null | undefined} plugin
     * @param {string} message
     * @param {...unknown} args
     * @returns {void}
     */
    logdebug(plugin, message, ...args) {
        this._log('verbose', plugin, message, ...args);
    }

    /**
     * @param {PluginIdentity | false | null | undefined} plugin
     * @param {string} message
     * @param {...unknown} args
     * @returns {void}
     */
    loginfo(plugin, message, ...args) {
        this._log('info', plugin, message, ...args);
    }

    /**
     * @param {PluginIdentity | false | null | undefined} plugin
     * @param {string} message
     * @param {...unknown} args
     * @returns {void}
     */
    lognotice(plugin, message, ...args) {
        this._log('notice', plugin, message, ...args);
    }

    /**
     * @param {PluginIdentity | false | null | undefined} plugin
     * @param {string} message
     * @param {...unknown} args
     * @returns {void}
     */
    logerror(plugin, message, ...args) {
        this._log('error', plugin, message, ...args);
    }

    /**
     * @param {SmtpSession} session
     * @returns {string | false}
     */
    _getTlsCipher(session) {
        const tlsOptions = session.tlsOptions;
        return tlsOptions && typeof tlsOptions === 'object' && typeof tlsOptions.name === 'string' ? tlsOptions.name : false;
    }
}

module.exports = { KirinConnection };
