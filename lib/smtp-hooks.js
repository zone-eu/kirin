// @ts-check
'use strict';

/**
 * @typedef {Object} PluginHandlerLike
 * @property {Map<string, unknown[]>} hooks
 * @property {(name: string, args: unknown[]) => Promise<void>} runHooks
 */

class SmtpHooks {
    /**
     * @param {PluginHandlerLike} handler
     */
    constructor(handler) {
        this.handler = handler;
    }

    /**
     * @param {keyof import('@zone-eu/types').ZoneMtaHookArgumentMap} name
     * @returns {boolean}
     */
    has(name) {
        return (this.handler.hooks.get(name)?.length || 0) > 0;
    }

    /**
     * @param {import('@zone-eu/types').SmtpSession} session
     * @returns {Promise<void>}
     */
    connect(session) {
        return this.handler.runHooks('smtp:connect', [session]);
    }

    /**
     * @param {import('@zone-eu/types').SmtpAuth} auth
     * @param {import('@zone-eu/types').SmtpSession} session
     * @returns {Promise<void>}
     */
    auth(auth, session) {
        return this.handler.runHooks('smtp:auth', [auth, session]);
    }

    /**
     * @param {import('@zone-eu/types').SmtpAddress} address
     * @param {import('@zone-eu/types').SmtpSession} session
     * @returns {Promise<void>}
     */
    mailFrom(address, session) {
        return this.handler.runHooks('smtp:mail_from', [address, session]);
    }

    /**
     * @param {import('@zone-eu/types').SmtpAddress} address
     * @param {import('@zone-eu/types').SmtpSession} session
     * @returns {Promise<void>}
     */
    rcptTo(address, session) {
        return this.handler.runHooks('smtp:rcpt_to', [address, session]);
    }

    /**
     * @param {import('@zone-eu/types').Envelope} envelope
     * @param {import('@zone-eu/types').SmtpSession} session
     * @returns {Promise<void>}
     */
    data(envelope, session) {
        return this.handler.runHooks('smtp:data', [envelope, session]);
    }
}

module.exports = { SmtpHooks };
