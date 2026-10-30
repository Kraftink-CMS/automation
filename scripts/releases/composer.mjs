import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const helper = fileURLToPath(new URL('./composer.php', import.meta.url));
const tools = fileURLToPath(new URL('./php-scoper/vendor', import.meta.url));
const runtimePath = /^(?:src|routes|database|lang|resources|views|public)\//;

function execute(binary, args, options) {
    return execFileSync(binary, args, {
        ...options,
        windowsHide: true,
        timeout: 300000,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

function command(binary, php) {
    return /\.(?:phar|php)$/i.test(binary) || binary.replaceAll('\\', '/').endsWith('/php-scoper')
        ? [php, binary]
        : [binary];
}

function sourcePath(path) {
    return (
        typeof path === 'string' &&
        path !== '' &&
        !isAbsolute(path) &&
        !/[\\:\x00-\x1f\x7f]/.test(path) &&
        !path
            .split('/')
            .some(
                (part) => part === '' || part === '.' || part === '..' || part === 'node_modules' || part === 'vendor',
            )
    );
}

export async function buildComposer(files, sources = files, runner = execute) {
    const inputs = new Map(sources);
    const manifestBytes = new Map(files).get('manifest.json');
    const manifest = manifestBytes ? JSON.parse(manifestBytes.toString('utf8')) : null;
    if (manifest && Object.hasOwn(manifest, 'libraries'))
        throw new Error('The libraries descriptor is generated during packaging.');
    if (!inputs.has('composer.json')) {
        if (inputs.has('composer.lock')) throw new Error('composer.lock requires composer.json.');
        return files;
    }
    if (!inputs.has('composer.lock')) throw new Error('Composer libraries require a committed composer.lock.');
    const composer = JSON.parse(inputs.get('composer.json').toString('utf8'));
    const lock = JSON.parse(inputs.get('composer.lock').toString('utf8'));
    if (!composer || Array.isArray(composer) || !lock || !Array.isArray(lock.packages)) {
        throw new Error('Invalid extension Composer configuration.');
    }
    const requirements = composer.require ?? {};
    const allowed = [
        '$schema',
        'name',
        'description',
        'version',
        'type',
        'license',
        'authors',
        'keywords',
        'homepage',
        'support',
        'funding',
        'readme',
        'require',
        'require-dev',
        'autoload',
        'autoload-dev',
    ];
    if (Object.keys(composer).some((key) => !allowed.includes(key))) {
        throw new Error('Composer extension sources may declare metadata, requirements and source autoloading only.');
    }
    if (!requirements || typeof requirements !== 'object' || Array.isArray(requirements)) {
        throw new Error('Composer require must be an object of package constraints.');
    }
    for (const [package_, constraint] of Object.entries(requirements)) {
        if (
            (!/^[a-z0-9]+(?:[_.-][a-z0-9]+)*\/[a-z0-9]+(?:(?:[_.]|-{1,2})[a-z0-9]+)*$/.test(package_) &&
                !/^(?:php|php-64bit|ext-[a-z0-9-]+|composer-runtime-api)$/.test(package_)) ||
            typeof constraint !== 'string' ||
            !constraint.trim() ||
            constraint.length > 200 ||
            /[\x00-\x1f\x7f]/.test(constraint)
        ) {
            throw new Error('Invalid Composer production requirement.');
        }
    }
    for (const package_ of lock.packages) {
        if (!['library', 'metapackage'].includes(package_.type ?? 'library')) {
            throw new Error('Private dependencies must be Composer libraries or metapackages.');
        }
    }
    if (!manifest) throw new Error('Composer libraries require the extension manifest.');
    if (composer.autoload) {
        const mapping = composer.autoload['psr-4'];
        if (
            Object.keys(composer.autoload).length !== 1 ||
            !manifest.namespace ||
            !mapping ||
            Object.keys(mapping).length !== 1 ||
            !['src', 'src/'].includes(mapping[manifest.namespace])
        ) {
            throw new Error('Composer source autoloading must map the manifest namespace to src/.');
        }
    }
    const php = process.env.PHP_BINARY || 'php';
    const composerCommand = command(process.env.COMPOSER_BINARY || 'composer', php);
    const scoperCommand = command(process.env.PHP_SCOPER_BINARY || join(tools, 'bin/php-scoper'), php);
    const toolAutoload = process.env.PHP_SCOPER_AUTOLOAD || join(tools, 'autoload.php');
    const prefix = `KraftInkPrivate\\P${sha256(`${manifest.type}:${manifest.id}`).slice(0, 24)}\\`;
    const stage = await mkdtemp(join(tmpdir(), 'kraftink-composer-'));
    try {
        const input = join(stage, 'input');
        const output = join(stage, 'output');
        const paths = new Map([...sources.filter(([path]) => sourcePath(path)), ...files]);
        for (const [path, bytes] of paths) {
            if (!sourcePath(path)) throw new Error('Unsafe Composer build input.');
            await mkdir(dirname(join(input, path)), { recursive: true });
            await writeFile(join(input, path), bytes);
        }
        const environment = {
            ...process.env,
            COMPOSER_HOME: join(stage, 'home'),
            COMPOSER_CACHE_DIR: join(stage, 'cache'),
            COMPOSER_VENDOR_DIR: join(input, 'vendor'),
        };
        const run = async (invocation, args, cwd) =>
            runner(invocation[0], [...invocation.slice(1), ...args], {
                cwd,
                env: {
                    ...environment,
                    COMPOSER_VENDOR_DIR: join(cwd, 'vendor'),
                },
            });
        await run(
            composerCommand,
            ['validate', '--no-check-publish', '--no-check-all', '--no-plugins', '--no-scripts', '--no-interaction'],
            input,
        );
        await run(
            composerCommand,
            [
                'install',
                '--no-dev',
                '--no-plugins',
                '--no-scripts',
                '--prefer-dist',
                '--no-interaction',
                '--no-progress',
                '--optimize-autoloader',
            ],
            input,
        );
        await rm(join(input, 'vendor/bin'), { recursive: true, force: true });
        await runner(php, [helper, 'configuration', input, prefix, toolAutoload], { cwd: input });
        const available = new Set(await readdir(input));
        const selected = [
            ...new Set([...files.map(([path]) => path.split('/')[0]), 'composer.json', 'composer.lock', 'vendor']),
        ].filter((name) => available.has(name) && name !== 'scoper.inc.php');
        await run(
            scoperCommand,
            [
                'add-prefix',
                '--config=kraftink-scoper.php',
                `--output-dir=${output}`,
                '--force',
                '--no-interaction',
                ...selected,
            ],
            input,
        );
        await runner(php, [helper, 'metadata', output, prefix, toolAutoload], {
            cwd: output,
        });
        const installedVersions = await readFile(join(output, 'vendor/composer/InstalledVersions.php'));
        await run(composerCommand, ['dump-autoload', '--no-dev', '--no-plugins', '--no-scripts', '--optimize'], output);
        await writeFile(join(output, 'vendor/composer/InstalledVersions.php'), installedVersions);
        await rm(join(output, 'vendor/bin'), { recursive: true, force: true });
        const exported = JSON.parse(
            String(
                await runner(php, [helper, 'export', output, prefix], {
                    cwd: output,
                }),
            ),
        );
        const prepared = new Map(files);
        for (const [path] of files) {
            if (runtimePath.test(path) && /\.(?:php|inc)$/.test(path)) {
                prepared.set(path, await readFile(join(output, path)));
            }
        }
        for (const path of exported.files) {
            if (!sourcePath(`libraries/${path}`) || (await lstat(join(output, 'vendor', path))).isSymbolicLink()) {
                throw new Error('Unsafe bundled Composer library path.');
            }
            prepared.set(`vendor/${path}`, await readFile(join(output, 'vendor', path)));
        }
        const index = await readFile(join(output, 'vendor/kraftink.json'));
        manifest.libraries = {
            prefix,
            manifest: 'vendor/kraftink.json',
            sha256: sha256(index),
        };
        prepared.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 4) + '\n'));
        return [...prepared].sort(([left], [right]) => left.localeCompare(right, 'en'));
    } finally {
        if (
            !resolve(stage).startsWith(resolve(tmpdir()) + '/') &&
            !resolve(stage).startsWith(resolve(tmpdir()) + '\\')
        ) {
            throw new Error('Unsafe Composer temporary directory.');
        }
        await rm(stage, { recursive: true, force: true });
    }
}
