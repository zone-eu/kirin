declare module 'punycode.js' {
    const punycode: {
        toASCII(input: string): string;
        toUnicode(input: string): string;
    };

    export default punycode;
}

declare module 'smtp-server' {
    import { EventEmitter } from 'node:events';
    import type { SmtpServerOptions } from '../src/types.js';

    export class SMTPServer extends EventEmitter {
        constructor(options: SmtpServerOptions);
        listen(port: number, host: string | undefined, callback: () => void): this;
        close(callback: () => void): void;
    }
}
