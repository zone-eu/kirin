import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { HeaderWrapper, type HeaderValue } from './header-wrapper.js';
import type { Envelope, SmtpAddress, SmtpSession } from '../types.js';

const HEADER_BREAK_CRLF = Buffer.from('\r\n\r\n');
const HEADER_BREAK_LF = Buffer.from('\n\n');

type HeaderOperationType = 'add' | 'prepend' | 'remove';

interface HeaderOperation {
    type: HeaderOperationType;
    name: string;
    value: HeaderValue | undefined;
}

interface MessageParts {
    headers: Buffer;
    body: Buffer;
}

export interface TransactionConnection {
    results: Map<string, unknown>;
}

export type TransactionAddress = Omit<SmtpAddress, 'address'> & {
    addressValue: string;
    user: string;
    host: string;
    address: () => string;
};

/** Converts an SMTP server address into the ZoneMTA-compatible transaction shape. */
const wrapAddress = (address: SmtpAddress | TransactionAddress | false | null | undefined): TransactionAddress | false => {
    if (!address) {
        return false;
    }

    const rawAddress =
        typeof address.address === 'string' ? address.address : typeof address.addressValue === 'string' ? address.addressValue : '';
    const atPos = rawAddress.lastIndexOf('@');
    const user = atPos >= 0 ? rawAddress.substring(0, atPos) : rawAddress;
    const host = atPos >= 0 ? rawAddress.substring(atPos + 1) : '';

    return {
        ...address,
        addressValue: rawAddress,
        user,
        host,
        address: () => rawAddress
    };
};

/** Splits a raw RFC 5322 message without copying the underlying buffer. */
const splitMessage = (buffer: Buffer): MessageParts => {
    const crlfIndex = buffer.indexOf(HEADER_BREAK_CRLF);
    const lfIndex = buffer.indexOf(HEADER_BREAK_LF);
    const useLf = crlfIndex < 0 || (lfIndex >= 0 && lfIndex < crlfIndex);
    const index = useLf ? lfIndex : crlfIndex;
    const separatorLength = useLf ? HEADER_BREAK_LF.length : HEADER_BREAK_CRLF.length;

    if (index < 0) {
        return {
            headers: buffer,
            body: buffer.subarray(buffer.length)
        };
    }

    return {
        headers: buffer.subarray(0, index),
        body: buffer.subarray(index + separatorLength)
    };
};

export class KirinTransaction {
    readonly connection: TransactionConnection;
    readonly uuid: string;
    readonly notes: Record<string, unknown> = {};
    readonly results: Map<string, unknown>;
    responseMessage: string | false = false;
    envelope: Envelope | false = false;
    mail_from: TransactionAddress | false = false;
    rcpt_to: TransactionAddress[] = [];
    messageSize = 0;
    header: HeaderWrapper | false = false;
    sourceBuffer: Buffer = Buffer.alloc(0);
    bodyBuffer: Buffer = this.sourceBuffer;
    private pendingHeaderOps: HeaderOperation[] = [];

    constructor(connection: TransactionConnection) {
        this.connection = connection;
        this.uuid = randomBytes(12).toString('hex');
        this.results = connection.results;
    }

    /** Refreshes transaction addresses from the current SMTP session envelope. */
    syncEnvelope(session: SmtpSession): void {
        this.mail_from = wrapAddress(session.envelope?.mailFrom);
        this.rcpt_to = (session.envelope?.rcptTo || [])
            .map((address) => wrapAddress(address))
            .filter((address): address is TransactionAddress => address !== false);
    }

    setMailFrom(address: SmtpAddress): void {
        this.mail_from = wrapAddress(address);
    }

    add_header(name: string, value: HeaderValue): void {
        this.queueOrApply('add', name, value);
    }

    add_leading_header(name: string, value: HeaderValue): void {
        this.queueOrApply('prepend', name, value);
    }

    remove_header(name: string): void {
        this.queueOrApply('remove', name);
    }

    /** Retains the raw message and creates header/body views over it. */
    setMessage(buffer: Buffer | string): void {
        this.sourceBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
        this.messageSize = this.sourceBuffer.length;

        const parts = splitMessage(this.sourceBuffer);
        this.bodyBuffer = parts.body;
        this.header = new HeaderWrapper(parts.headers);
        this.applyPendingHeaderOps();
    }

    clearMessage(): void {
        this.header = false;
        this.sourceBuffer = Buffer.alloc(0);
        this.bodyBuffer = this.sourceBuffer;
        this.pendingHeaderOps = [];
    }

    getSourceStream(): Readable {
        return Readable.from([this.sourceBuffer]);
    }

    getMessageBuffer(): Buffer {
        const headers = this.header ? this.header.build() : Buffer.from('\r\n\r\n');
        return Buffer.concat([headers, this.bodyBuffer]);
    }

    getMessageChunks(): Buffer[] {
        return [this.getMessageBuffer()];
    }

    getMessageSize(): number {
        return this.getMessageBuffer().length;
    }

    private queueOrApply(type: HeaderOperationType, name: string, value?: HeaderValue): void {
        const operation: HeaderOperation = { type, name, value };
        if (!this.header) {
            this.pendingHeaderOps.push(operation);
            return;
        }

        this.applyHeaderOp(operation);
    }

    private applyPendingHeaderOps(): void {
        for (const operation of this.pendingHeaderOps) {
            this.applyHeaderOp(operation);
        }
        this.pendingHeaderOps = [];
    }

    private applyHeaderOp(operation: HeaderOperation): void {
        if (!this.header) {
            throw new Error('Message headers are not initialized');
        }

        switch (operation.type) {
            case 'remove':
                this.header.remove(operation.name);
                return;
            case 'prepend':
                this.header.addLeadingHeader(operation.name, operation.value ?? '');
                return;
            case 'add':
                this.header.add(operation.name, operation.value ?? '');
        }
    }
}
