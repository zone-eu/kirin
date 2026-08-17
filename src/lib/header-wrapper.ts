import { Headers } from '@zone-eu/mailsplit';

export type HeaderValue = string | number | Buffer;

export class HeaderWrapper {
    readonly headers: Headers;

    constructor(rawHeaders: Buffer) {
        this.headers = new Headers(rawHeaders || Buffer.alloc(0));
    }

    get(name: string): string {
        return this.get_all(name)[0] || '';
    }

    get_all(name: string): string[] {
        const key = (name || '').toString().toLowerCase().trim();
        return this.headers.get(name).map((line) => {
            const match = line.match(/^([^:]+):(.*)$/s);
            const fieldName = match?.[1];
            const fieldValue = match?.[2];
            if (!fieldName || fieldValue === undefined || fieldName.toLowerCase().trim() !== key) {
                return line;
            }
            return fieldValue.trim();
        });
    }

    add(name: string, value: HeaderValue): void {
        this.headers.add(name, value, this.headers.getList().length);
    }

    addLeadingHeader(name: string, value: HeaderValue): void {
        this.headers.add(name, value, 0);
    }

    addAt(name: string, value: HeaderValue, index: number): void {
        this.headers.add(name, value, index);
    }

    remove(name: string): void {
        this.headers.remove(name);
    }

    build(): Buffer {
        return this.headers.build('\r\n');
    }
}
