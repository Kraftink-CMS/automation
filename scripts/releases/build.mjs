import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { git, stableVersion } from './version.mjs';
import { buildComposer } from './composer.mjs';
import { validatePresentation } from '../market/catalogue.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const allowedRoot =
    /^(?:manifest\.json|composer\.(?:json|lock)|(?:LICENSE|NOTICE|README)(?:[.-][A-Za-z0-9_.-]+)?|_[A-Za-z0-9_.-]+\.scss)$/;
const allowedDirectory = /^(?:database|lang|public|resources|routes|src|views)\//;

export function assertPackageLimits({ files, extracted, archive = 0 }) {
    if (files > 10000 || extracted > 104857600 || archive > 52428800) {
        throw new Error('The extension exceeds the CMS package limits (10000 files, 100 MiB extracted, 50 MiB ZIP).');
    }
}

export async function compileStyles(files, manifest, compiler = null) {
    const inputs = manifest.build?.scss ?? [];
    if (!Array.isArray(inputs) || inputs.length > 100) {
        throw new Error('Invalid SCSS build inputs.');
    }
    if (!inputs.length) {
        return files;
    }
    const compile = compiler ?? (await import('sass')).compile;
    const stage = await mkdtemp(resolve(tmpdir(), 'kraftink-scss-'));
    try {
        const paths = new Map(files);
        for (const [path, bytes] of files) {
            await mkdir(dirname(resolve(stage, path)), { recursive: true });
            await writeFile(resolve(stage, path), bytes);
        }
        const outputs = new Set();
        for (const input of inputs) {
            if (
                typeof input !== 'string' ||
                !input.endsWith('.scss') ||
                !paths.has(input) ||
                input.split('/').some((part) => part === '..') ||
                /[\\:]/.test(input)
            ) {
                throw new Error('An SCSS input must be a committed package source.');
            }
            const filename = basename(input, '.scss').replace(/^_/, '') + '.css';
            if (!(manifest.assets?.styles ?? []).includes(filename) || outputs.has(filename)) {
                throw new Error('Each compiled stylesheet must have a unique declared asset.');
            }
            outputs.add(filename);
            const result = compile(resolve(stage, input), {
                style: 'compressed',
                charset: false,
                sourceMap: false,
            });
            paths.set(`public/${filename}`, Buffer.from(result.css));
        }
        return [...paths].sort(([left], [right]) => left.localeCompare(right, 'en'));
    } finally {
        await rm(stage, { recursive: true, force: true });
    }
}

function safePath(path) {
    return (
        typeof path === 'string' &&
        !/[\\:\x00-\x1f\x7f]/.test(path) &&
        path
            .split('/')
            .every(
                (part) =>
                    part &&
                    !part.startsWith('.') &&
                    !['node_modules', 'vendor'].includes(part) &&
                    !/[. ]$/.test(part) &&
                    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
            )
    );
}

async function npmRunner(args, { cwd }) {
    const directories = [dirname(process.execPath), ...(process.env.PATH ?? '').split(delimiter).filter(Boolean)];
    const candidates = [
        process.env.npm_execpath,
        ...directories.flatMap((directory) => [
            resolve(directory, 'node_modules/npm/bin/npm-cli.js'),
            resolve(directory, '../lib/node_modules/npm/bin/npm-cli.js'),
            resolve(directory, '../share/nodejs/npm/bin/npm-cli.js'),
        ]),
    ].filter(Boolean);
    for (const candidate of candidates) {
        let cli;
        try {
            cli = await realpath(candidate);
            if (basename(cli) !== 'npm-cli.js' || !(await lstat(cli)).isFile()) {
                continue;
            }
        } catch {
            continue;
        }
        const environment = Object.fromEntries(
            Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'),
        );
        environment.PATH = [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter);
        execFileSync(process.execPath, [cli, ...args], {
            cwd,
            shell: false,
            windowsHide: true,
            timeout: 300000,
            maxBuffer: 10 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...environment,
                npm_config_cache: resolve(cwd, '.npm-cache'),
                npm_config_update_notifier: 'false',
            },
        });
        return;
    }
    throw new Error(
        'npm is required to compile this extension. Set npm_execpath to npm-cli.js when it is outside PATH.',
    );
}

export async function buildFrontend(files, sources = files, runner = npmRunner, manifest = null) {
    const inputs = new Map(sources);
    const styles = manifest?.build?.scss ?? [];
    if (!Array.isArray(styles) || styles.length > 100) {
        throw new Error('Invalid SCSS build inputs.');
    }
    if (!inputs.has('package.json')) {
        if (inputs.has('package-lock.json') || styles.length) {
            throw new Error('A frontend build requires package.json with pinned build dependencies.');
        }
        return files;
    }
    const configuration = JSON.parse(inputs.get('package.json').toString());
    if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
        throw new Error('Invalid frontend package.json.');
    }
    const scripted = Object.hasOwn(configuration.scripts ?? {}, 'build');
    if (!scripted && !styles.length) {
        return files;
    }
    if (scripted && (typeof configuration.scripts.build !== 'string' || !configuration.scripts.build.trim())) {
        throw new Error('The frontend build script must be a nonempty command.');
    }
    if (!inputs.has('package-lock.json')) {
        throw new Error('A frontend build requires a committed package-lock.json.');
    }
    const lock = JSON.parse(inputs.get('package-lock.json').toString());
    if (
        ![2, 3].includes(lock?.lockfileVersion) ||
        !lock.packages?.[''] ||
        typeof lock.packages[''] !== 'object' ||
        Array.isArray(lock.packages[''])
    ) {
        throw new Error('The frontend build requires a current npm package lock.');
    }
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        const entries = (value) =>
            Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right, 'en'));
        if (JSON.stringify(entries(configuration[section])) !== JSON.stringify(entries(lock.packages[''][section]))) {
            throw new Error(
                'Frontend dependencies do not match package-lock.json. Run npm install and commit the lock.',
            );
        }
    }
    const stage = await mkdtemp(resolve(tmpdir(), 'kraftink-frontend-'));
    try {
        for (const [path, bytes, mode] of sources) {
            if (!safePath(path)) {
                throw new Error('Unsafe frontend build input.');
            }
            await mkdir(dirname(resolve(stage, path)), { recursive: true });
            await writeFile(resolve(stage, path), bytes, {
                mode: mode === '100755' ? 0o755 : 0o644,
            });
        }
        await runner(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
            cwd: stage,
        });
        if (scripted) {
            await runner(['run', 'build', '--ignore-scripts'], { cwd: stage });
        } else {
            const { compile } = createRequire(resolve(stage, 'package.json'))('sass');
            const compiled = await compileStyles(files, manifest, compile);
            for (const [path, bytes] of compiled) {
                if (path.startsWith('public/')) {
                    await mkdir(dirname(resolve(stage, path)), {
                        recursive: true,
                    });
                    await writeFile(resolve(stage, path), bytes);
                }
            }
        }
        const prepared = files.filter(([path]) => !path.startsWith('public/'));
        const seen = new Set(prepared.map(([path]) => path.toLowerCase()));
        let extracted = prepared.reduce((size, [, bytes]) => size + bytes.length, 0);
        const visit = async (path) => {
            const info = await lstat(resolve(stage, path));
            if (!safePath(path) || info.isSymbolicLink()) {
                throw new Error('Unsafe frontend build output.');
            }
            if (info.isDirectory()) {
                for (const child of (await readdir(resolve(stage, path))).sort()) {
                    await visit(`${path}/${child}`);
                }
                return;
            }
            if (!info.isFile() || seen.has(path.toLowerCase())) {
                throw new Error('Unsafe frontend build output.');
            }
            extracted += info.size;
            assertPackageLimits({ files: prepared.length + 1, extracted });
            seen.add(path.toLowerCase());
            prepared.push([path, await readFile(resolve(stage, path))]);
        };
        await visit('public');
        return prepared.sort(([left], [right]) => left.localeCompare(right, 'en'));
    } finally {
        await rm(stage, { recursive: true, force: true });
    }
}

function constraint(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) {
        throw new Error('Invalid package compatibility constraint.');
    }
    const token =
        /^(?:~|\^|<=|>=|==|!=|<>|<|>|=)?(?:v?\d+(?:\.(?:\d+|[xX*])){0,3}|[xX*])(?:-(?:alpha|beta|RC|rc|dev|patch|pl|p)[A-Za-z0-9.-]*)?(?:@(?:stable|RC|beta|alpha|dev))?$/;
    const groups = value
        .trim()
        .replace(/([~^<>=!]{1,2})\s+/g, '$1')
        .split(/\s*\|\|?\s*/);
    if (
        groups.some((group) =>
            group
                .replace(/\s+-\s+/g, ' ')
                .split(/[\s,]+/)
                .some((part) => !token.test(part)),
        )
    ) {
        throw new Error('Unsupported package compatibility constraint.');
    }
}

function constraints(value, platform = false) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Package dependencies must be an object of IDs and Composer constraints.');
    }
    if (platform && (!Object.hasOwn(value, 'cms') || !Object.hasOwn(value, 'php'))) {
        throw new Error('Extension CMS and PHP requirements are required.');
    }
    for (const [id, requirement] of Object.entries(value)) {
        const extension = /^(?:plugin|theme|game):[a-z][a-z0-9-]{1,49}$/.test(id);
        if (!extension && !(platform && ['cms', 'php'].includes(id))) {
            throw new Error('Invalid dependency identity.');
        }
        constraint(requirement);
    }
}

export function manifestFor(raw) {
    const manifest = JSON.parse(raw);
    if (
        !/^[a-z][a-z0-9-]{1,49}$/.test(manifest.id) ||
        !['plugin', 'theme', 'game'].includes(manifest.type) ||
        typeof manifest.name !== 'string' ||
        !manifest.name.trim()
    ) {
        throw new Error('Invalid extension identity.');
    }
    const market = manifest.market ?? {};
    if (typeof market !== 'object' || Array.isArray(market)) {
        throw new Error('Invalid extension market settings.');
    }
    validatePresentation({
        name: market.name ?? manifest.name,
        description: market.description ?? manifest.description,
        ...(Object.hasOwn(market, 'image') ? { image: market.image } : {}),
    }, true);
    constraints(manifest.requires, true);
    for (const section of ['integrations', 'conflicts']) {
        if (Object.hasOwn(manifest, section)) {
            constraints(manifest[section]);
        }
    }
    if (Object.hasOwn(manifest, 'dependencies') || Object.hasOwn(manifest, 'cms')) {
        throw new Error('Declare dependencies and platform constraints in requires.');
    }
    if (Object.hasOwn(manifest, 'libraries')) {
        throw new Error('The libraries descriptor is generated during packaging.');
    }
    return manifest;
}

export async function marketResource(files, repository) {
    const stage = await mkdtemp(resolve(tmpdir(), 'kraftink-market-'));
    try {
        for (const [path, bytes] of files) {
            if (
                path !== 'manifest.json' &&
                !/^lang\/[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*\/[A-Za-z0-9_-]+\.php$/.test(path) &&
                !path.startsWith('resources/market/')
            ) {
                continue;
            }
            if (!safePath(path)) {
                throw new Error('Unsafe file in the market metadata stage.');
            }
            await mkdir(dirname(resolve(stage, path)), { recursive: true });
            await writeFile(resolve(stage, path), bytes);
        }
        const exporter = fileURLToPath(new URL('./market.php', import.meta.url));
        const output = execFileSync(process.env.PHP_BINARY || 'php', [exporter, stage, repository], {
            windowsHide: true,
            shell: false,
            encoding: 'utf8',
            timeout: 15000,
            maxBuffer: 262144,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        return JSON.parse(output);
    } finally {
        await rm(stage, { recursive: true, force: true });
    }
}

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

export function zipFiles(files) {
    const local = [];
    const central = [];
    let offset = 0;
    for (const [name, bytes] of files) {
        const path = Buffer.from(name, 'utf8');
        const compressed = deflateRawSync(bytes, { level: 9 });
        const crc = crc32(bytes);
        const entry = Buffer.alloc(30);
        entry.writeUInt32LE(0x04034b50);
        entry.writeUInt16LE(20, 4);
        entry.writeUInt16LE(0x800, 6);
        entry.writeUInt16LE(8, 8);
        entry.writeUInt16LE(33, 12);
        entry.writeUInt32LE(crc, 14);
        entry.writeUInt32LE(compressed.length, 18);
        entry.writeUInt32LE(bytes.length, 22);
        entry.writeUInt16LE(path.length, 26);
        local.push(entry, path, compressed);
        const directory = Buffer.alloc(46);
        directory.writeUInt32LE(0x02014b50);
        directory.writeUInt16LE(20, 4);
        directory.writeUInt16LE(20, 6);
        directory.writeUInt16LE(0x800, 8);
        directory.writeUInt16LE(8, 10);
        directory.writeUInt16LE(33, 14);
        directory.writeUInt32LE(crc, 16);
        directory.writeUInt32LE(compressed.length, 20);
        directory.writeUInt32LE(bytes.length, 24);
        directory.writeUInt16LE(path.length, 28);
        directory.writeUInt32LE(offset, 42);
        central.push(directory, path);
        offset += entry.length + path.length + compressed.length;
    }
    const index = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(index.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, index, end]);
}

export function zipEntries(bytes) {
    const files = new Map();
    let offset = 0;
    while (bytes.readUInt32LE(offset) === 0x04034b50) {
        const size = bytes.readUInt32LE(offset + 18);
        const nameLength = bytes.readUInt16LE(offset + 26);
        const extraLength = bytes.readUInt16LE(offset + 28);
        const start = offset + 30 + nameLength + extraLength;
        const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
        files.set(name, inflateRawSync(bytes.subarray(start, start + size)));
        offset = start + size;
    }
    return files;
}

function versionEntry(value, repository, slug) {
    stableVersion(value.version);
    constraints(value.requirements, true);
    const url = `https://github.com/${repository}/releases/download/v${value.version}/${slug}-${value.version}.zip`;
    if (
        !value.requirements ||
        typeof value.requirements.cms !== 'string' ||
        typeof value.requirements.php !== 'string' ||
        value.download?.url !== url ||
        !/^[a-f0-9]{64}$/.test(value.download?.sha256)
    ) {
        throw new Error('Previous release metadata contains an invalid package version.');
    }
    return {
        version: value.version,
        requirements: value.requirements,
        download: value.download,
    };
}

export async function previousVersions({ plan, repository, manifest, client }) {
    if (!plan.base_tag) {
        return [];
    }
    const release = await client.release(plan.base_tag);
    if (!release || release.draft !== false || release.prerelease !== false || release.tag_name !== plan.base_tag) {
        throw new Error('The previous stable release is incomplete.');
    }
    const matches = (await client.assets(release)).filter((asset) => asset.name === 'kraftink-extension.json');
    if (matches.length !== 1) {
        throw new Error('The previous stable release metadata is missing or ambiguous.');
    }
    const previous = JSON.parse((await client.bytes(matches[0], 262144)).toString('utf8'));
    if (
        previous.schema_version !== 1 ||
        previous.slug !== manifest.id ||
        previous.type !== manifest.type ||
        previous.version !== plan.base_tag.slice(1)
    ) {
        throw new Error('The previous stable release identity changed.');
    }
    const versions = previous.versions;
    if (!Array.isArray(versions) || versions.length > 100 || !versions.length) {
        throw new Error('Invalid previous version history.');
    }
    return versions.map((entry) => versionEntry(entry, repository, manifest.id));
}

function packageFiles(root, sha, manifest) {
    const names = git(root, ['ls-tree', '-rz', '--full-tree', sha]).split('\0').filter(Boolean);
    const files = [];
    const sources = [];
    const seen = new Set();
    let extracted = 0;
    for (const entry of names) {
        const match = /^(\d+) blob ([a-f0-9]+)\t(.+)$/s.exec(entry);
        if (!match) {
            throw new Error('Submodules and unsupported Git entries cannot be packaged.');
        }
        const [, mode, object, path] = match;
        const packaged = allowedRoot.test(path) || allowedDirectory.test(path);
        if (!safePath(path)) {
            if (packaged) {
                throw new Error('Unsafe file in the extension package.');
            }
            continue;
        }
        if (!/^100(?:644|755)$/.test(mode) || seen.has(path.toLowerCase())) {
            throw new Error('Unsafe file in the extension package.');
        }
        seen.add(path.toLowerCase());
        const bytes =
            path === 'manifest.json'
                ? Buffer.from(JSON.stringify(manifest, null, 4) + '\n')
                : execFileSync('git', ['-C', root, 'cat-file', 'blob', object], {
                      windowsHide: true,
                      maxBuffer: 128 * 1024 * 1024,
                  });
        sources.push([path, bytes, mode]);
        if (packaged) {
            files.push([path, bytes]);
        }
        extracted += bytes.length;
        assertPackageLimits({ files: sources.length, extracted });
    }
    if (!files.some(([path]) => path === 'manifest.json')) {
        throw new Error('Invalid extension package file inventory.');
    }
    return { files, sources };
}

async function workingPackageFiles(root, manifest) {
    const files = [];
    const sources = [];
    const seen = new Set();
    let extracted = 0;
    const visit = async (directory = '') => {
        for (const entry of await readdir(resolve(root, directory), {
            withFileTypes: true,
        })) {
            const path = directory ? `${directory}/${entry.name}` : entry.name;
            if (!safePath(path) || path === 'dist') {
                continue;
            }
            if (entry.isSymbolicLink()) {
                throw new Error('Unsafe frontend build input.');
            }
            if (entry.isDirectory()) {
                await visit(path);
                continue;
            }
            if (!entry.isFile() || seen.has(path.toLowerCase())) {
                throw new Error('Unsafe file in the extension package.');
            }
            const info = await lstat(resolve(root, path));
            extracted += info.size;
            assertPackageLimits({ files: sources.length + 1, extracted });
            seen.add(path.toLowerCase());
            const bytes =
                path === 'manifest.json'
                    ? Buffer.from(JSON.stringify(manifest, null, 4) + '\n')
                    : await readFile(resolve(root, path));
            sources.push([path, bytes, info.mode & 0o111 ? '100755' : '100644']);
            if (allowedRoot.test(path) || allowedDirectory.test(path)) {
                files.push([path, bytes]);
            }
        }
    };
    await visit();
    return { files, sources };
}

export async function buildBundle({
    root = process.cwd(),
    plan,
    repository,
    directory,
    history = [],
    compiler = null,
    frontendRunner = undefined,
    composerRunner = undefined,
}) {
    stableVersion(plan.version);
    if (
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
        plan.tag !== `v${plan.version}` ||
        git(root, ['rev-parse', 'HEAD']) !== plan.sha
    ) {
        throw new Error('The build repository does not match the release plan.');
    }
    const manifest = manifestFor(git(root, ['show', `${plan.sha}:manifest.json`]));
    if (manifest.builtin === true) {
        throw new Error(
            'Bundled games are released with KraftInk. An independent game requires its own non-builtin package.',
        );
    }
    manifest.version = plan.version;
    const { files, sources } = packageFiles(root, plan.sha, manifest);
    const assets = compiler
        ? await compileStyles(files, manifest, compiler)
        : await buildFrontend(files, sources, frontendRunner, manifest);
    const prepared = await buildComposer(assets, sources, composerRunner);
    const extracted = prepared.reduce((size, [, bytes]) => size + bytes.length, 0);
    assertPackageLimits({ files: prepared.length, extracted });
    const archive = zipFiles(prepared);
    assertPackageLimits({
        files: prepared.length,
        extracted,
        archive: archive.length,
    });
    const filename = `${manifest.id}-${plan.version}.zip`;
    const current = {
        version: plan.version,
        requirements: manifest.requires,
        download: {
            url: `https://github.com/${repository}/releases/download/${plan.tag}/${filename}`,
            sha256: digest(archive),
        },
    };
    const versions = [current, ...history.filter((entry) => entry.version !== plan.version)].slice(0, 100);
    const versionNames = new Set();
    versions.forEach((entry) => {
        versionEntry(entry, repository, manifest.id);
        if (versionNames.has(entry.version)) {
            throw new Error('Duplicate package versions in release history.');
        }
        versionNames.add(entry.version);
    });
    const resource = await marketResource(prepared, repository);
    const metadata = {
        schema_version: 1,
        resource,
        slug: manifest.id,
        type: manifest.type,
        ...current,
        versions,
    };
    let metadataBytes = Buffer.from(JSON.stringify(metadata, null, 4) + '\n');
    while (metadataBytes.length > 262144 && versions.length > 1) {
        versions.pop();
        metadataBytes = Buffer.from(JSON.stringify(metadata, null, 4) + '\n');
    }
    if (metadataBytes.length > 262144) {
        throw new Error('The current release metadata exceeds the market 256 KiB limit.');
    }
    const releaseAssets = new Map([
        [filename, archive],
        [`${filename}.sha256`, Buffer.from(`${digest(archive)}  ${filename}\n`)],
        ['kraftink-extension.json', metadataBytes],
    ]);
    await mkdir(directory, { recursive: true });
    for (const [name, bytes] of releaseAssets) {
        await writeFile(resolve(directory, name), bytes);
    }
    const bundle = {
        version: plan.version,
        sha: plan.sha,
        assets: [...releaseAssets].map(([name, bytes]) => ({
            name,
            size: bytes.length,
            sha256: digest(bytes),
        })),
    };
    await writeFile(resolve(directory, 'bundle.json'), JSON.stringify(bundle, null, 4) + '\n');
    return { metadata, bundle };
}

async function main() {
    const [command, planPath, directory, historyPath] = process.argv.slice(2);
    if (command === 'check' && process.argv.length === 3) {
        const root = process.cwd();
        const manifest = manifestFor(await readFile(resolve(root, 'manifest.json'), 'utf8'));
        manifest.version = String(manifest.version ?? '').replace(/-dev$/, '');
        stableVersion(manifest.version);
        const { files, sources } = await workingPackageFiles(root, manifest);
        const assets = await buildFrontend(files, sources, undefined, manifest);
        const prepared = await buildComposer(assets, sources);
        await marketResource(
            prepared,
            process.env.KRAFTINK_EXTENSION_REPOSITORY || process.env.GITHUB_REPOSITORY || 'community/Package',
        );
        return;
    }
    if (command !== 'build' || !planPath || !directory || !historyPath || process.argv.length !== 6) {
        throw new Error('Usage: build.mjs check | build <plan.json> <assets-directory> <history.json>');
    }
    const plan = JSON.parse(await readFile(resolve(planPath), 'utf8'));
    const repository = process.env.KRAFTINK_EXTENSION_REPOSITORY || process.env.GITHUB_REPOSITORY;
    const history = JSON.parse(await readFile(resolve(historyPath), 'utf8'));
    if (!Array.isArray(history) || history.length > 100) {
        throw new Error('The trusted release history must be a bounded array.');
    }
    await buildBundle({ plan, repository, directory, history });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`Package build failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}
