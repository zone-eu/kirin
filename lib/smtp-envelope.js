// @ts-check
'use strict';

const punycode = require('punycode.js');

/**
 * Normalizes an SMTP envelope address using the same rules as ZoneMTA.
 *
 * @param {import('@zone-eu/types').SmtpAddress | string | false | null | undefined} address
 * @returns {string}
 */
const normalizeAddress = address => {
    const input = typeof address === 'string' ? address : address && typeof address === 'object' ? address.address : undefined;
    if (!input) {
        return '';
    }

    let normalized = input
        .toString()
        .replace(/[\x00-\x1F<>]+/g, ' ')
        .trim();
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
 * @param {{ uuid: string }} transaction
 * @param {import('@zone-eu/types').SmtpSession} session
 * @param {string} interfaceName
 * @returns {import('@zone-eu/types').Envelope}
 */
const buildEnvelope = (transaction, session, interfaceName) => {
    /** @type {import('@zone-eu/types').Envelope} */
    const envelope = {
        sessionId: session.id,
        id: transaction.uuid,
        interface: interfaceName,
        from: normalizeAddress(session.envelope.mailFrom),
        to: (session.envelope.rcptTo || []).map(address => normalizeAddress(address)),
        origin: session.remoteAddress,
        originhost: session.clientHostname || false,
        transhost: session.hostNameAppearsAs || false,
        transtype: session.transmissionType,
        user: session.user || false,
        time: Date.now()
    };

    if (session.sendingZone) {
        envelope.sendingZone = session.sendingZone;
    }

    if (session.tlsOptions) {
        envelope.tls = session.tlsOptions;
    }

    return envelope;
};

module.exports = { buildEnvelope, normalizeAddress };
