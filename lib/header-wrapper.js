'use strict';

const { Headers } = require('@zone-eu/mailsplit');

class HeaderWrapper {
    constructor(rawHeaders) {
        this.headers = new Headers(rawHeaders || Buffer.alloc(0));
    }

    get(name) {
        return this.get_all(name)[0] || '';
    }

    get_all(name) {
        const key = (name || '').toString().toLowerCase().trim();
        return this.headers.get(name).map(line => {
            const match = line.match(/^([^:]+):(.*)$/s);
            if (!match || match[1].toLowerCase().trim() !== key) {
                return line;
            }
            return match[2].trim();
        });
    }

    add(name, value, index) {
        this.headers.add(name, value, index);
    }

    remove(name) {
        this.headers.remove(name);
    }

    build() {
        return this.headers.build('\r\n');
    }
}

module.exports = { HeaderWrapper };
