import type { Envelope, SmtpAddress, SmtpAuth, ZoneMtaHookArgumentMap } from '@zone-eu/types';
import type { PluginHandlerLike, SmtpSession } from '../types.js';

export class SmtpHooks {
    constructor(readonly handler: PluginHandlerLike) {
        this.handler = handler;
    }

    has(name: keyof ZoneMtaHookArgumentMap): boolean {
        return (this.handler.hooks.get(name)?.length || 0) > 0;
    }

    connect(session: SmtpSession): Promise<void> {
        return this.handler.runHooks('smtp:connect', [session]);
    }

    auth(auth: SmtpAuth, session: SmtpSession): Promise<void> {
        return this.handler.runHooks('smtp:auth', [auth, session]);
    }

    mailFrom(address: SmtpAddress, session: SmtpSession): Promise<void> {
        return this.handler.runHooks('smtp:mail_from', [address, session]);
    }

    rcptTo(address: SmtpAddress, session: SmtpSession): Promise<void> {
        return this.handler.runHooks('smtp:rcpt_to', [address, session]);
    }

    data(envelope: Envelope, session: SmtpSession): Promise<void> {
        return this.handler.runHooks('smtp:data', [envelope, session]);
    }
}
