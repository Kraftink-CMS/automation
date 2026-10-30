import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { buildComposer } from './composer.mjs';

const php = process.env.PHP_BINARY || 'php';
const composer = process.env.COMPOSER_BINARY || 'composer';
const tools = fileURLToPath(new URL('./php-scoper/vendor/autoload.php', import.meta.url));
const encode = (value) => Buffer.from(JSON.stringify(value, null, 4) + '\n');

test('Composer builds require a lock and reject active root configuration before running tools', async () => {
    const manifest = ['manifest.json', encode({ id: 'fixture', type: 'plugin' })];
    const runner = () => {
        throw new Error('Build tools must not run.');
    };
    await assert.rejects(
        buildComposer([['manifest.json', encode({ id: 'fixture', type: 'plugin', libraries: {} })]], [], runner),
        /generated during packaging/,
    );
    await assert.rejects(
        buildComposer([manifest], [manifest, ['composer.json', encode({ require: {} })]], runner),
        /committed composer.lock/,
    );
    for (const key of ['scripts', 'config', 'repositories', 'replace', 'provide', 'conflict']) {
        await assert.rejects(
            buildComposer(
                [manifest],
                [
                    manifest,
                    ['composer.json', encode({ require: {}, [key]: {} })],
                    ['composer.lock', encode({ packages: [] })],
                ],
                runner,
            ),
            /metadata, requirements/,
        );
    }
});

test(
    'real Composer and PHP-Scoper bundle two private SDK versions without changing host symbols',
    { skip: !existsSync(tools) },
    async () => {
        const directory = await mkdtemp(join(tmpdir(), 'kraftink-private-sdk-'));
        const previous = {
            PHP_BINARY: process.env.PHP_BINARY,
            COMPOSER_BINARY: process.env.COMPOSER_BINARY,
        };
        process.env.PHP_BINARY = php;
        process.env.COMPOSER_BINARY = composer;
        try {
            const built = [];
            for (const [id, version] of [
                ['first-private-sdk', '1.0.0'],
                ['second-private-sdk', '2.0.0'],
            ]) {
                const root = join(directory, id);
                await mkdir(root, { recursive: true });
                const archive = join(root, 'sdk.zip');
                const sdk = {
                    'src/Version.php': `<?php namespace FixturePrivateSdk; class Version { public static function value(): string { return '${version}'; } }`,
                    'functions.php': `<?php const FIXTURE_SDK_VALUE = '${version}'; function fixture_sdk_helper(): string { return '${version}'; }`,
                };
                execFileSync(
                    php,
                    [
                        '-r',
                        '$z = new ZipArchive(); $z->open($argv[1], ZipArchive::CREATE); foreach (json_decode($argv[2], true) as $name => $body) { $z->addFromString($name, $body); } $z->close();',
                        archive,
                        JSON.stringify(sdk),
                    ],
                    { windowsHide: true },
                );
                const namespace = `FixturePlugins\\${id.startsWith('first') ? 'First' : 'Second'}\\`;
                const manifest = {
                    id,
                    name: id,
                    type: 'plugin',
                    version: '1.0.0',
                    namespace,
                    provider: namespace + 'Provider',
                    requires: { cms: '^1.0', php: '^8.3' },
                };
                const metadata = {
                    name: `fixture/${id}`,
                    description: 'Isolated build fixture.',
                    license: 'MIT',
                    require: { php: '^8.3', 'fixture/private-sdk': version },
                    autoload: { 'psr-4': { [namespace]: 'src/' } },
                };
                const composerJson = encode(metadata);
                const relevant = {
                    name: metadata.name,
                    require: metadata.require,
                };
                const contentHash = execFileSync(
                    php,
                    [
                        '-r',
                        '$value=json_decode($argv[1],true); ksort($value); echo md5(json_encode($value));',
                        JSON.stringify(relevant),
                    ],
                    { encoding: 'utf8', windowsHide: true },
                );
                const lock = {
                    'content-hash': contentHash,
                    packages: [
                        {
                            name: 'fixture/private-sdk',
                            version,
                            type: 'library',
                            license: ['MIT'],
                            dist: {
                                type: 'zip',
                                url: pathToFileURL(archive).href,
                            },
                            autoload: {
                                'psr-4': { 'FixturePrivateSdk\\': 'src/' },
                                files: ['functions.php'],
                            },
                            require: {
                                php: '^8.0 || ^8.4',
                                'composer-runtime-api': '^2.0',
                            },
                        },
                    ],
                    'packages-dev': [],
                    aliases: [],
                    'minimum-stability': 'stable',
                    'stability-flags': {},
                    'prefer-stable': false,
                    'prefer-lowest': false,
                    platform: {},
                    'platform-dev': {},
                    'plugin-api-version': '2.9.0',
                };
                const source = `<?php namespace ${namespace.slice(0, -1)}; class Provider { public static function values(): array { return [\\FixturePrivateSdk\\Version::value(), \\fixture_sdk_helper(), \\Composer\\InstalledVersions::getPrettyVersion('fixture/private-sdk'), \\app(), \\FIXTURE_SDK_VALUE]; } }`;
                const files = [
                    ['manifest.json', encode(manifest)],
                    ['composer.json', composerJson],
                    ['composer.lock', encode(lock)],
                    ['src/Provider.php', Buffer.from(source)],
                ];
                const runtime = new Map(await buildComposer(files));
                if (id.startsWith('first')) {
                    const stale = files.map(([path, bytes]) => [
                        path,
                        path === 'composer.json'
                            ? encode({
                                  ...metadata,
                                  require: {
                                      ...metadata.require,
                                      'fixture/private-sdk': '^9.0',
                                  },
                              })
                            : bytes,
                    ]);
                    await assert.rejects(buildComposer(stale), /Command failed/);
                }
                const result = JSON.parse(runtime.get('manifest.json').toString());
                assert.match(result.libraries.prefix, /^KraftInkPrivate\\P[a-f0-9]{24}\\$/);
                const index = JSON.parse(runtime.get('vendor/kraftink.json').toString());
                assert.equal(
                    createHash('sha256').update(runtime.get('vendor/kraftink.json')).digest('hex'),
                    result.libraries.sha256,
                );
                assert.ok(Object.keys(index.classmap).every((name) => name.startsWith(result.libraries.prefix)));
                assert.ok(Object.keys(index.psr4).every((name) => name.startsWith(result.libraries.prefix)));
                for (const [path, bytes] of runtime) {
                    await mkdir(dirname(join(root, 'built', path)), {
                        recursive: true,
                    });
                    await writeFile(join(root, 'built', path), bytes);
                }
                built.push({
                    root: join(root, 'built'),
                    namespace,
                    prefix: result.libraries.prefix,
                });
            }
            assert.notEqual(built[0].prefix, built[1].prefix);
            const hostVendor = join(directory, 'host');
            await mkdir(join(hostVendor, 'composer'), { recursive: true });
            await writeFile(
                join(hostVendor, 'composer/installed.php'),
                "<?php return ['root'=>['name'=>'fixture/host', 'version'=>'9.9.0.0', 'pretty_version'=>'9.9.0', 'aliases'=>[], 'type'=>'project', 'install_path'=>__DIR__], 'versions'=>['fixture/private-sdk'=>['version'=>'9.9.0.0','pretty_version'=>'9.9.0','aliases'=>[]]]];",
            );
            const check = `<?php
namespace FixturePrivateSdk { class Version { public static function value(): string { return 'host'; } } }
namespace {
require $argv[2];
$hostLoader = new \\Composer\\Autoload\\ClassLoader($argv[3]);
$hostLoader->register();
function fixture_sdk_helper(): string { return 'host'; }
const FIXTURE_SDK_VALUE = 'host';
function app(): string { return 'host application'; }
$roots = json_decode($argv[1], true);
foreach ($roots as $entry) {
    $vendor = $entry['root'].'/vendor';
    $index = json_decode(file_get_contents($vendor.'/kraftink.json'), true);
    spl_autoload_register(function ($class) use ($index, $vendor) { if (isset($index['classmap'][$class])) { require $vendor.'/'.$index['classmap'][$class]; } });
    foreach ($index['files'] as $file) { require_once $vendor.'/'.$file; }
    require $entry['root'].'/src/Provider.php';
}
echo json_encode([\\FixturePlugins\\First\\Provider::values(), \\FixturePlugins\\Second\\Provider::values(), \\FixturePrivateSdk\\Version::value(), fixture_sdk_helper()]);
}
`;
            const checkPath = join(directory, 'check.php');
            await writeFile(checkPath, check);
            const output = execFileSync(php, [checkPath, JSON.stringify(built), tools, hostVendor], {
                windowsHide: true,
                encoding: 'utf8',
            });
            assert.deepEqual(JSON.parse(output), [
                ['1.0.0', '1.0.0', '1.0.0', 'host application', '1.0.0'],
                ['2.0.0', '2.0.0', '2.0.0', 'host application', '2.0.0'],
                'host',
                'host',
            ]);
        } finally {
            for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
            await rm(directory, { recursive: true, force: true });
        }
    },
);
