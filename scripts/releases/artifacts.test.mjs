import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { planArtifactVersion } from './artifacts.mjs';
import { collectCustomAssets } from './context.mjs';

function git(root, ...args) {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function fixture(t, version) {
    const root = await mkdtemp(resolve(tmpdir(), 'kraftink-artifacts-version-'));
    t.after(async () => {
        assert.equal(dirname(root), resolve(tmpdir()));
        await rm(root, { recursive: true, force: true });
    });
    git(root, 'init', '-b', 'master');
    git(root, 'config', 'user.name', 'Release fixture');
    git(root, 'config', 'user.email', 'release@example.invalid');
    await writeFile(resolve(root, 'pom.xml'), `<project><modelVersion>4.0.0</modelVersion><groupId>example</groupId><artifactId>connector</artifactId><version>${version}</version></project>\n`);
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'feat: initial connector');
    return root;
}

test('custom artifacts publish the stable version already committed in the POM', async (t) => {
    const root = await fixture(t, '1.0.0');
    const selected = await planArtifactVersion({ root });
    assert.equal(selected.plan.version, '1.0.0');
    assert.equal(selected.source_version, true);
    git(root, 'tag', 'v1.0.0');
    await writeFile(resolve(root, 'pom.xml'), '<project><groupId>example</groupId><artifactId>connector</artifactId><version>1.1.0</version></project>\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'feat: new connector support');
    assert.equal((await planArtifactVersion({ root })).plan.version, '1.1.0');
    await assert.rejects(planArtifactVersion({ root, version: '2.0.0' }), /differs from the stable source/);
});

test('custom publication refuses a development source version on master', async (t) => {
    const root = await fixture(t, '1.0.0-dev');
    await assert.rejects(planArtifactVersion({ root }), /stable X.Y.Z/);
});

test('custom asset collection hashes sorted files and preserves an existing reserved bundle', async (t) => {
    const directory = await mkdtemp(resolve(tmpdir(), 'kraftink-custom-assets-'));
    t.after(() => {
        assert.equal(dirname(directory), resolve(tmpdir()));
        return rm(directory, { recursive: true, force: true });
    });
    const bundle = '{"preserve":"unchanged"}\n';
    await writeFile(resolve(directory, 'bundle.json'), bundle);
    await writeFile(resolve(directory, 'z.jar'), 'last asset');
    await writeFile(resolve(directory, 'a.jar'), 'first asset');
    assert.deepEqual(await collectCustomAssets(directory), [
        { name: 'a.jar', size: 11, sha256: createHash('sha256').update('first asset').digest('hex') },
        { name: 'z.jar', size: 10, sha256: createHash('sha256').update('last asset').digest('hex') },
    ]);
    assert.equal(await readFile(resolve(directory, 'bundle.json'), 'utf8'), bundle);
});

test('custom asset collection rejects empty, invalid, nested and excessive assets before publication', async (t) => {
    const directory = await mkdtemp(resolve(tmpdir(), 'kraftink-custom-assets-'));
    t.after(() => {
        assert.equal(dirname(directory), resolve(tmpdir()));
        return rm(directory, { recursive: true, force: true });
    });
    await writeFile(resolve(directory, 'bundle.json'), '{}');
    await assert.rejects(collectCustomAssets(directory), /between 1 and 100 assets/);
    await writeFile(resolve(directory, 'empty.jar'), '');
    await assert.rejects(collectCustomAssets(directory), /bounded regular files/);
    await rm(resolve(directory, 'empty.jar'));
    await writeFile(resolve(directory, 'unsafe name.jar'), 'built');
    await assert.rejects(collectCustomAssets(directory), /Invalid custom release asset name/);
    await rm(resolve(directory, 'unsafe name.jar'));
    await mkdir(resolve(directory, 'nested'));
    await assert.rejects(collectCustomAssets(directory), /bounded regular files/);
    await rmdir(resolve(directory, 'nested'));
    await Promise.all(Array.from({ length: 101 }, (_, index) => writeFile(resolve(directory, `asset-${index}.jar`), 'built')));
    await assert.rejects(collectCustomAssets(directory), /between 1 and 100 assets/);
});

test('custom asset collection refuses directory links and linked entries', async (t) => {
    const root = await mkdtemp(resolve(tmpdir(), 'kraftink-custom-assets-'));
    t.after(() => {
        assert.equal(dirname(root), resolve(tmpdir()));
        return rm(root, { recursive: true, force: true });
    });
    const target = resolve(root, 'target');
    const directory = resolve(root, 'assets');
    await mkdir(target);
    await mkdir(directory);
    await writeFile(resolve(target, 'original.jar'), 'untouched');
    await symlink(target, resolve(root, 'redirected'), 'junction');
    await assert.rejects(collectCustomAssets(resolve(root, 'redirected')), /regular directory/);
    await symlink(target, resolve(directory, 'linked.jar'), 'junction');
    await assert.rejects(collectCustomAssets(directory), /bounded regular files/);
    assert.equal(await readFile(resolve(target, 'original.jar'), 'utf8'), 'untouched');
});
