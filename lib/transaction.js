// @ts-check
'use strict';

const { Readable } = require('stream');
const { randomBytes } = require('crypto');
const { HeaderWrapper } = require('./header-wrapper');

const HEADER_BREAK_CRLF = Buffer.from('\r\n\r\n');
const HEADER_BREAK_LF = Buffer.from('\n\n');

/**
 * @typedef {import('@zone-eu/types').SmtpAddress} SmtpAddress
 * @typedef {import('@zone-eu/types').SmtpSession} SmtpSession
 * @typedef {import('@zone-eu/types').Envelope} Envelope
 * @typedef {string | number | Buffer} HeaderValue
 * @typedef {'add' | 'prepend' | 'remove'} HeaderOperationType
 * @typedef {{ type: HeaderOperationType, name: string, value?: HeaderValue }} HeaderOperation
 * @typedef {{ headers: Buffer, body: Buffer }} MessageParts
 * @typedef {{ results: Map<string, unknown> }} TransactionConnection
 * @typedef {Omit<SmtpAddress, 'address'> & {
 *   addressValue: string,
 *   user: string,
 *   host: string,
 *   address: () => string
 * }} TransactionAddress
 */

/**
 * Converts an SMTP server address into the ZoneMTA-compatible transaction shape.
 *
 * @param {SmtpAddress | TransactionAddress | false | null | undefined} address
 * @returns {TransactionAddress | false}
 */
const wrapAddress = address => {
    if (!address) {
        return false;
    }

    const rawAddress =
        typeof address.address === 'string' ? address.address : typeof address.addressValue === 'string' ? address.addressValue : '';
    const atPos = rawAddress.lastIndexOf('@');
    const user = atPos >= 0 ? rawAddress.substring(0, atPos) : rawAddress;
    const host = atPos >= 0 ? rawAddress.substring(atPos + 1) : '';

    /** @type {TransactionAddress} */
    const wrappedAddress = {
        ...address,
        addressValue: rawAddress,
        user,
        host,
        address() {
            return rawAddress;
        }
    };

    return wrappedAddress;
};

/**
 * Splits a raw RFC 5322 message without copying the underlying buffer.
 *
 * @param {Buffer} buffer
 * @returns {MessageParts}
 */
const splitMessage = buffer => {
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

class KirinTransaction {
    /**
     * @param {TransactionConnection} connection
     */
    constructor(connection) {
        this.connection = connection;
        this.uuid = randomBytes(12).toString('hex');
        /** @type {Record<string, unknown>} */
        this.notes = {};
        this.results = connection.results;
        /** @type {string | false} */
        this.responseMessage = false;
        /** @type {Envelope | false} */
        this.envelope = false;

        /** @type {TransactionAddress | false} */
        this.mail_from = false;
        /** @type {TransactionAddress[]} */
        this.rcpt_to = [];
        this.messageSize = 0;
        /** @type {InstanceType<typeof HeaderWrapper> | false} */
        this.header = false;
        /** @type {Buffer} */
        this.sourceBuffer = Buffer.alloc(0);
        /** @type {Buffer} */
        this.bodyBuffer = this.sourceBuffer;
        /** @type {HeaderOperation[]} */
        this.pendingHeaderOps = [];
    }

    /**
     * Refreshes transaction addresses from the current SMTP session envelope.
     *
     * @param {SmtpSession} session
     * @returns {void}
     */
    syncEnvelope(session) {
        this.mail_from = wrapAddress(session.envelope?.mailFrom);
        this.rcpt_to = (session.envelope?.rcptTo || []).map(address => wrapAddress(address)).filter(address => address !== false);
    }

    /**
     * @param {SmtpAddress} address
     * @returns {void}
     */
    setMailFrom(address) {
        this.mail_from = wrapAddress(address);
    }

    /**
     * @param {string} name
     * @param {HeaderValue} value
     * @returns {void}
     */
    add_header(name, value) {
        this._queueOrApply('add', name, value);
    }

    /**
     * @param {string} name
     * @param {HeaderValue} value
     * @returns {void}
     */
    add_leading_header(name, value) {
        this._queueOrApply('prepend', name, value);
    }

    /**
     * @param {string} name
     * @returns {void}
     */
    remove_header(name) {
        this._queueOrApply('remove', name);
    }

    /**
     * Retains the raw message and creates header/body views over it.
     *
     * @param {Buffer | string} buffer
     * @returns {void}
     */
    setMessage(buffer) {
        this.sourceBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || Buffer.alloc(0));
        this.messageSize = this.sourceBuffer.length;

        const parts = splitMessage(this.sourceBuffer);
        this.bodyBuffer = parts.body;
        this.header = new HeaderWrapper(parts.headers);
        this._applyPendingHeaderOps();
    }

    /** @returns {void} */
    clearMessage() {
        this.header = false;
        this.sourceBuffer = Buffer.alloc(0);
        this.bodyBuffer = this.sourceBuffer;
        this.pendingHeaderOps = [];
    }

    /** @returns {Readable} */
    getSourceStream() {
        return Readable.from([this.sourceBuffer]);
    }

    /** @returns {Buffer} */
    getMessageBuffer() {
        const headers = this.header ? this.header.build() : Buffer.from('\r\n\r\n');
        return Buffer.concat([headers, this.bodyBuffer]);
    }

    /** @returns {Buffer[]} */
    getMessageChunks() {
        return [this.getMessageBuffer()];
    }

    /** @returns {number} */
    getMessageSize() {
        return this.getMessageBuffer().length;
    }

    /**
     * @param {HeaderOperationType} type
     * @param {string} name
     * @param {HeaderValue} [value]
     * @returns {void}
     */
    _queueOrApply(type, name, value) {
        if (!this.header) {
            this.pendingHeaderOps.push({ type, name, value });
            return;
        }

        this._applyHeaderOp({ type, name, value });
    }

    /** @returns {void} */
    _applyPendingHeaderOps() {
        for (const operation of this.pendingHeaderOps) {
            this._applyHeaderOp(operation);
        }
        this.pendingHeaderOps = [];
    }

    /**
     * @param {HeaderOperation} operation
     * @returns {void}
     */
    _applyHeaderOp(operation) {
        const header = /** @type {InstanceType<typeof HeaderWrapper>} */ (this.header);

        switch (operation.type) {
            case 'remove':
                header.remove(operation.name);
                return;
            case 'prepend':
                header.add(operation.name, operation.value, 0);
                return;
            case 'add':
            default:
                header.add(operation.name, operation.value, 1);
        }
    }
}

module.exports = { KirinTransaction };
