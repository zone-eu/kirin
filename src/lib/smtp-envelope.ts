import punycode from 'punycode.js';
import type { Envelope, SmtpAddress, SmtpSession } from '../types.js';

const replaceInvalidAddressCharacters = (value: string): string => {
    let result = '';
    let replacing = false;

    for (const character of value) {
        const codePoint = character.codePointAt(0) ?? 0;
        const invalid = codePoint <= 31 || character === '<' || character === '>';
        if (invalid) {
            if (!replacing) {
                result += ' ';
                replacing = true;
            }
        } else {
            result += character;
            replacing = false;
        }
    }

    return result;
};

/**
 * Normalizes an SMTP envelope address using the same rules as ZoneMTA.
 *
 * @param address SMTP address to normalize.
 */
export const normalizeAddress = (address: SmtpAddress | string | false | null | undefined): string => {
    const input = typeof address === 'string' ? address : address && typeof address === 'object' ? address.address : undefined;
    if (!input) {
        return '';
    }

    let normalized = replaceInvalidAddressCharacters(input.toString()).trim();
    const atPos = normalized.lastIndexOf('@');

    if (atPos < 0) {
        return normalized;
    }

    let user = normalized.substring(0, atPos).trim();
    const domain = normalized.substring(atPos + 1);
    let encodedDomain = domain;

    try {
        encodedDomain = /[\x80-\uFFFF]/.test(user) ? punycode.toUnicode(domain.toLowerCase()) : punycode.toASCII(domain.toLowerCase());
    } catch {
        // Keep the domain as supplied if it can not be converted.
    }

    if (user.includes(' ')) {
        if (!user.startsWith('"')) {
            user = `"${user}`;
        }
        if (!user.endsWith('"')) {
            user = `${user}"`;
        }
    }

    normalized = `${user}@${encodedDomain}`;
    return normalized;
};

/**
 * @param transaction Transaction supplying the envelope id.
 * @param session Active SMTP session.
 * @param interfaceName Receiver interface name.
 */
export const buildEnvelope = (transaction: { uuid: string }, session: SmtpSession, interfaceName: string): Envelope => {
    const envelope: Envelope = {
        sessionId: session.id,
        id: transaction.uuid,
        interface: interfaceName,
        from: normalizeAddress(session.envelope.mailFrom),
        to: (session.envelope.rcptTo || []).map((address) => normalizeAddress(address)),
        origin: session.remoteAddress,
        originhost: session.clientHostname || false,
        transhost: session.hostNameAppearsAs || false,
        user: session.user || false,
        time: Date.now()
    };

    if (session.transmissionType !== undefined) {
        envelope.transtype = session.transmissionType;
    }

    if (session.sendingZone) {
        envelope.sendingZone = session.sendingZone;
    }

    if (session.tlsOptions) {
        envelope.tls = session.tlsOptions;
    }

    return envelope;
};
