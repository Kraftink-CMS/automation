import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { localBundle } from './publish.mjs';

const tool = (name) => fileURLToPath(new URL(`./${name}.mjs`, import.meta.url));

async function fixture(context) {
    const stage = await mkdtemp(resolve(tmpdir(), 'kraftink-central-tools-'));
    context.after(() => rm(stage, { recursive: true, force: true }));
    const root = resolve(stage, 'package');
    const output = resolve(stage, 'assets');
    await mkdir(resolve(root, '.github'), { recursive: true });
    await mkdir(resolve(root, 'src'));
    await writeFile(
        resolve(root, 'manifest.json'),
        JSON.stringify({
            id: 'central-example',
            type: 'plugin',
            name: 'Central example',
            description: 'An independently maintained community package.',
            version: '1.0.0-dev',
            requires: { cms: '>=0.0.1', php: '^8.3' },
        }),
    );
    await writeFile(resolve(root, 'src/Example.php'), '<?php return true;\n');
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
            encoding: 'utf8',
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
    git('init', '--initial-branch=master');
    git('config', 'user.name', 'Central tooling tests');
    git('config', 'user.email', 'central-tooling@example.invalid');
    git('add', '.');
    git('commit', '-m', 'feat: independent package');
    return { stage, root, output, git };
}

test('central CLI entry points plan and build an independent clean repository without copied tools', async (context) => {
    const { stage, root, output, git } = await fixture(context);
    const options = {
        cwd: root,
        shell: false,
        windowsHide: true,
        encoding: 'utf8',
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            GITHUB_REPOSITORY: 'example/Plugin-Central',
            GITHUB_TOKEN: '',
        },
    };
    const plan = JSON.parse(execFileSync(process.execPath, [tool('version'), 'plan'], options));
    assert.equal(plan.sha, git('rev-parse', 'HEAD'));
    assert.equal(plan.version, '1.0.0');
    const planPath = resolve(stage, 'release-plan.json');
    const historyPath = resolve(stage, 'release-history.json');
    await writeFile(planPath, JSON.stringify(plan));
    await writeFile(historyPath, '[]');
    execFileSync(process.execPath, [tool('build'), 'build', planPath, output, historyPath], options);
    assert.equal((await localBundle(plan, output)).length, 3);
    const metadata = JSON.parse(await readFile(resolve(output, 'kraftink-extension.json'), 'utf8'));
    assert.equal(metadata.slug, 'central-example');
    assert.equal(metadata.version, plan.version);
    assert.equal(
        metadata.download.url,
        'https://github.com/example/Plugin-Central/releases/download/v1.0.0/central-example-1.0.0.zip',
    );
    assert.equal(git('status', '--porcelain'), '');
    await assert.rejects(access(resolve(root, 'scripts')), { code: 'ENOENT' });
    await assert.rejects(access(resolve(root, 'node_modules')), {
        code: 'ENOENT',
    });
});

test('central Sass dependencies resolve without author repository dependencies', async (context) => {
    const { root } = await fixture(context);
    const program = `const { compileStyles } = await import(${JSON.stringify(new URL('./build.mjs', import.meta.url).href)});
const files = await compileStyles([['resources/theme.scss', Buffer.from('body { color: #123456; }')]], {
    build: { scss: ['resources/theme.scss'] },
    assets: { styles: ['theme.css'] }
});
process.stdout.write(new Map(files).get('public/theme.css'));`;
    const css = execFileSync(process.execPath, ['--input-type=module', '-e', program], {
        cwd: root,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(css, 'body{color:#123456}');
    await assert.rejects(access(resolve(root, 'node_modules')), {
        code: 'ENOENT',
    });
});

test('later release builds consume trusted history without a GitHub token', async (context) => {
    const { stage, root, output, git } = await fixture(context);
    git('tag', 'v1.0.0');
    await writeFile(resolve(root, 'src/Example.php'), '<?php return false;\n');
    git('commit', '-am', 'fix: later release');
    const options = {
        cwd: root,
        shell: false,
        windowsHide: true,
        encoding: 'utf8',
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GITHUB_REPOSITORY: 'example/Plugin-Central', GITHUB_TOKEN: '' },
    };
    const plan = JSON.parse(execFileSync(process.execPath, [tool('version'), 'plan'], options));
    assert.equal(plan.version, '1.0.1');
    const history = [
        {
            version: '1.0.0',
            requirements: { cms: '>=0.0.1', php: '^8.3' },
            download: {
                url: 'https://github.com/example/Plugin-Central/releases/download/v1.0.0/central-example-1.0.0.zip',
                sha256: 'a'.repeat(64),
            },
        },
    ];
    const planPath = resolve(stage, 'release-plan.json');
    const historyPath = resolve(stage, 'release-history.json');
    await writeFile(planPath, JSON.stringify(plan));
    await writeFile(historyPath, JSON.stringify(history));
    execFileSync(process.execPath, [tool('build'), 'build', planPath, output, historyPath], options);
    const metadata = JSON.parse(await readFile(resolve(output, 'kraftink-extension.json'), 'utf8'));
    assert.deepEqual(metadata.versions[1], history[0]);
    assert.equal(git('status', '--porcelain'), '');
});
