import { build } from 'esbuild';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

const projectRoot = process.cwd();
const sourceRoot = resolve(projectRoot, 'src');

const findSources = async (directory: string): Promise<string[]> => {
    const entries = await readdir(directory, { withFileTypes: true });
    const sources = await Promise.all(
        entries.map((entry) => {
            const entryPath = resolve(directory, entry.name);
            return entry.isDirectory() ? findSources(entryPath) : Promise.resolve(entryPath);
        })
    );

    return sources.flat().filter((filePath) => filePath.endsWith('.ts') && !filePath.endsWith('.d.ts'));
};

const main = async (): Promise<void> => {
    const sourceFiles = await findSources(sourceRoot);
    const entryPoints = Object.fromEntries(
        sourceFiles.map((filePath) => [relative(sourceRoot, filePath).split(sep).join('/').replace(/\.ts$/, ''), filePath])
    );

    await Promise.all(
        (['esm', 'cjs'] as const).map(async (format) => {
            const outputDirectory = resolve(projectRoot, 'dist', format);
            await build({
                entryPoints,
                outdir: outputDirectory,
                bundle: false,
                format,
                platform: 'node',
                target: 'node20',
                packages: 'external',
                sourcemap: true,
                sourcesContent: true,
                logLevel: 'info'
            });
            await mkdir(outputDirectory, { recursive: true });
            await writeFile(
                resolve(outputDirectory, 'package.json'),
                `${JSON.stringify({ type: format === 'esm' ? 'module' : 'commonjs' }, null, 4)}\n`
            );
        })
    );
};

main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack || err.message : String(err)}\n`);
    process.exitCode = 1;
});
