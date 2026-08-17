// Shared runtime contracts for Kirin's typed integration boundaries.
import type { AnyRecord, Envelope, SmtpAddress, SmtpAuth, SmtpResponseError } from '@zone-eu/types';
import type { Readable } from 'node:stream';
import type { PluginsConfig, LogOptions } from '@zone-eu/wild-plugins/types';

export type { Envelope, SmtpAddress, SmtpAuth };

export type LogMethod = (...args: unknown[]) => void;
export type LogLevel = 'verbose' | 'info' | 'notice' | 'error';

export interface LoggerLike {
    [key: string]: unknown;
    info: LogMethod;
    error: LogMethod;
    verbose: LogMethod;
    notice?: LogMethod;
}

export interface TlsConfig {
    keyPath?: string;
    certPath?: string;
    caPath?: string;
}

export interface SmtpConfig {
    enabled?: boolean;
    host?: string;
    port?: string | number;
    name?: string;
    banner?: string;
    size?: string | number;
    dataHookTimeout?: string | number;
    secure?: boolean;
    secured?: boolean;
    needsUpgrade?: boolean;
    disableSTARTTLS?: boolean;
    authentication?: boolean;
    authOptional?: boolean;
    closeTimeout?: string | number;
    maxClients?: string | number;
    useProxy?: boolean;
    useXClient?: boolean;
    useXForward?: boolean;
    disabledCommands?: string | string[];
    tls?: TlsConfig;
}

export interface KirinConfig {
    ident?: string;
    user?: string;
    group?: string;
    smtp: SmtpConfig;
    plugins?: {
        pluginsPath?: string;
        conf?: PluginsConfig;
    };
    log?: LogOptions & {
        level?: string;
    };
}

export interface SmtpEnvelope {
    [key: string]: unknown;
    mailFrom?: SmtpAddress | false | null;
    rcptTo?: SmtpAddress[];
}

export interface SmtpSession {
    [key: string]: unknown;
    id: string;
    interface?: string;
    envelopeId?: string;
    envelope: SmtpEnvelope;
    remoteAddress: string;
    remotePort?: number;
    clientHostname?: string;
    hostNameAppearsAs?: string;
    transmissionType?: string;
    user?: string | false;
    sendingZone?: string;
    secure?: boolean;
    localAddress?: string;
    localPort?: number;
    openingCommand?: string;
    tlsOptions?: string | AnyRecord | false;
}

export interface SmtpError extends Error {
    responseCode?: SmtpResponseError['responseCode'];
    category?: SmtpResponseError['category'];
    code?: string | number;
}

export type SmtpDataStream = Readable & {
    sizeExceeded?: boolean;
};

export type SmtpCallback = (err?: SmtpError | null) => void;
export type SmtpAuthCallback = (err?: SmtpError | null, result?: { user: string }) => void;
export type SmtpDataCallback = (err?: SmtpError | null, message?: string) => void;

export interface SmtpServerOptions {
    secure: boolean;
    secured: boolean;
    needsUpgrade: boolean;
    logger: unknown;
    name: string | false;
    banner: string;
    size: number;
    authOptional: boolean;
    useProxy: boolean;
    useXClient: boolean;
    useXForward: boolean;
    closeTimeout: number | undefined;
    maxClients: number | undefined;
    key: Buffer | undefined;
    cert: Buffer | undefined;
    ca: Buffer | undefined;
    disabledCommands: string[];
    onConnect: (session: SmtpSession, callback: SmtpCallback) => void;
    onSecure: (socket: unknown, session: SmtpSession, callback: SmtpCallback) => void;
    onAuth: (auth: SmtpAuth, session: SmtpSession, callback: SmtpAuthCallback) => void;
    onMailFrom: (address: SmtpAddress, session: SmtpSession, callback: SmtpCallback) => void;
    onRcptTo: (address: SmtpAddress, session: SmtpSession, callback: SmtpCallback) => void;
    onData: (stream: SmtpDataStream, session: SmtpSession, callback: SmtpDataCallback) => void;
    onClose: (session: SmtpSession) => void;
}

export interface SmtpServerInstance {
    on(event: 'error', listener: (err: Error) => void): this;
    once(event: 'error', listener: (err: Error) => void): this;
    removeListener(event: 'error', listener: (err: Error) => void): this;
    listen(port: number, host: string | undefined, callback: () => void): this;
    close(callback: () => void): void;
}

export interface PluginHandlerLike {
    hooks: {
        get(name: string): readonly unknown[] | undefined;
    };
    runHooks(name: string, args: unknown[]): Promise<void>;
}

export interface PluginIdentity {
    title?: string;
    name?: string;
}
