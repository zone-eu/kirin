declare module "punycode.js" {
    export function toASCII(input: string): string;
    export function toUnicode(input: string): string;
}

declare module "smtp-server" {
    export const SMTPServer: new (options: unknown) => unknown;
}
