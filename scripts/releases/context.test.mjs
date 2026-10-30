import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { buildBundle } from './build.mjs';
import { verifyBuiltAssets } from './context.mjs';
import { planVersion } from './version.mjs';

const repository = 'example/Plugin-Sample';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifest = {
    id: 'sample',
    name: 'Sample',
    description: 'An independently built package.',
    type: 'plugin',
    version: '1.0.0-dev',
    requires: { cms: '>=0.0.1', php: '^8.3' },
};

async function fixture(context, tagged = false) {
    const stage = await mkdtemp(resolve(tmpdir(), 'kraftink-release-context-'));
    context.after(() => rm(stage, { recursive: true, force: true }));
    const root = resolve(stage, 'package');
    const directory = resolve(stage, 'context');
    const assetsDirectory = resolve(stage, 'assets');
    await mkdir(resolve(root, '.github'), { recursive: true });
    await mkdir(resolve(root, 'src'));
    await writeFile(resolve(root, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(
        resolve(root, 'src/Example.php'),
        '<?php throw new RuntimeException("Do not execute source code.");\n',
    );
    await writeFile(
        resolve(root, '.github/release-policy.json'),
        JSON.stringify({
            schema: 1,
            initial_version: '1.0.0',
            default_bump: 'patch',
            next_version: null,
        }),
    );
    const git = (...args) =>
        execFileSync('git', ['-C', root, ...args], {
            windowsHide: true,
            shell: false,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
    git('init', '--initial-branch=master');
    git('config', 'user.name', 'Release context tests');
    git('config', 'user.email', 'release-context@example.invalid');
    git('add', '.');
    git('commit', '-m', 'chore: initial source');
    if (tagged) {
        git('tag', 'v1.2.3');
        await writeFile(resolve(root, 'src/Example.php'), '<?php return false;\n');
        git('commit', '-am', 'fix: next package');
    }
    const sha = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/master', sha);
    return { root, directory, assetsDirectory, git, sha };
}

async function rewriteMetadata(directory, change) {
    const path = resolve(directory, 'kraftink-extension.json');
    const metadata = JSON.parse(await readFile(path, 'utf8'));
    change(metadata);
    const bytes = Buffer.from(JSON.stringify(metadata));
    await writeFile(path, bytes);
    const bundlePath = resolve(directory, 'bundle.json');
    const bundle = JSON.parse(await readFile(bundlePath, 'utf8'));
    const asset = bundle.assets.find((value) => value.name === 'kraftink-extension.json');
    Object.assign(asset, { size: bytes.length, sha256: digest(bytes) });
    await writeFile(bundlePath, JSON.stringify(bundle));
}

test('rehashed build metadata cannot change requirements, URLs or trusted history', async (context) => {
    const source = await fixture(context);
    const plan = await planVersion({ root: source.root });
    for (const [change, pattern] of [
        [
            (value) => {
                value.resource.id = 'another/sample';
            },
            /committed source identity/,
        ],
        [
            (value) => {
                value.slug = 'another';
            },
            /committed source identity/,
        ],
        [
            (value) => {
                value.version = '9.0.0';
            },
            /committed source identity/,
        ],
        [
            (value) => {
                value.requirements.cms = '^9.0';
            },
            /committed source identity/,
        ],
        [
            (value) => {
                value.download.url = 'https://example.com/package.zip';
            },
            /committed source identity/,
        ],
        [
            (value) => {
                value.versions[0].version = '9.0.0';
            },
            /trusted release history/,
        ],
    ]) {
        await buildBundle({
            root: source.root,
            repository,
            plan,
            directory: source.assetsDirectory,
        });
        await rewriteMetadata(source.assetsDirectory, change);
        await assert.rejects(
            verifyBuiltAssets({
                plan,
                manifest,
                history: [],
                repository,
                directory: source.assetsDirectory,
            }),
            pattern,
        );
    }
});

test('unexpected artifact files and a rehashed checksum mismatch are rejected', async (context) => {
    const source = await fixture(context);
    const plan = await planVersion({ root: source.root });
    await buildBundle({
        root: source.root,
        repository,
        plan,
        directory: source.assetsDirectory,
    });
    const settings = {
        plan,
        manifest,
        history: [],
        repository,
        directory: source.assetsDirectory,
    };
    await writeFile(
        resolve(source.assetsDirectory, 'unexpected.js'),
        'throw new Error("Never execute build artifacts");',
    );
    await assert.rejects(verifyBuiltAssets(settings), /Unexpected files/);
    await rm(resolve(source.assetsDirectory, 'unexpected.js'));
    const filename = `sample-${plan.version}.zip.sha256`;
    const bytes = Buffer.from(`${'a'.repeat(64)}  sample-${plan.version}.zip\n`);
    await writeFile(resolve(source.assetsDirectory, filename), bytes);
    const bundlePath = resolve(source.assetsDirectory, 'bundle.json');
    const bundle = JSON.parse(await readFile(bundlePath, 'utf8'));
    Object.assign(
        bundle.assets.find((asset) => asset.name === filename),
        { size: bytes.length, sha256: digest(bytes) },
    );
    await writeFile(bundlePath, JSON.stringify(bundle));
    await assert.rejects(verifyBuiltAssets(settings), /checksum file/);
});
