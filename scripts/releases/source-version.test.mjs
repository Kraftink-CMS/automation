import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { inspectSourceVersion, nextDevelopmentVersion, sourceVersionChanges } from './source-version.mjs';

const read = (files) => async (path) => files[path] ?? null;
const pom = (content) => `<?xml version="1.0"?><project xmlns="http://maven.apache.org/POM/4.0.0">${content}</project>\n`;
const identity = '<groupId>example</groupId><artifactId>parent</artifactId>';
const parent = (artifact = 'parent', version = '1.0.0-dev') =>
    `<parent><groupId>example</groupId><artifactId>${artifact}</artifactId><version>${version}</version></parent>`;

async function fixture(context, files) {
    const root = await mkdtemp(resolve(tmpdir(), 'kraftink-source-version-'));
    context.after(() => rm(root, { recursive: true, force: true }));
    for (const [path, content] of Object.entries(files)) {
        await mkdir(dirname(resolve(root, path)), { recursive: true });
        await writeFile(resolve(root, path), content);
    }
    const git = (...args) => execFileSync('git', ['-C', root, ...args], {
        windowsHide: true,
        shell: false,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    git('init', '--initial-branch=dev');
    git('config', 'user.name', 'Source version tests');
    git('config', 'user.email', 'source-version@example.invalid');
    git('config', 'core.autocrlf', 'false');
    git('add', '.');
    git('commit', '-m', 'Initial metadata');
    return { root, git, sha: git('rev-parse', 'HEAD') };
}

test('JSON version changes preserve every byte outside the unique root value', async () => {
    const before = '\uFEFF{\r\n  "name": "Sample", "release": {"version":"9.0.0"},\r\n  "version" : "1.0.0-dev", "description": "escaped \\\"version\\\""\r\n}\r\n';
    const files = { 'manifest.json': before, 'pom.xml': 'This POM must never be read.' };
    const calls = [];
    const source = async (path) => {
        calls.push(path);
        return files[path] ?? null;
    };
    assert.deepEqual(await inspectSourceVersion({ read: source }), { format: 'json', version: '1.0.0-dev', paths: ['manifest.json'] });
    assert.deepEqual(calls, ['manifest.json']);
    const changes = await sourceVersionChanges({ read: source, version: '1.0.0', expectedVersion: '1.0.0-dev' });
    assert.deepEqual(changes, {
        source_version: '1.0.0-dev',
        version: '1.0.0',
        files: [{ path: 'manifest.json', before, after: before.replace('"1.0.0-dev"', '"1.0.0"') }],
    });
    assert.deepEqual((await sourceVersionChanges({ read: source, version: '1.0.0-dev' })).files, []);
});

test('escaped root JSON keys work while duplicate or invalid versions are rejected', async () => {
    const before = '{"\\u0076ersion":"0.0.1-dev","nested":{"version":"2.0.0"}}';
    assert.equal((await sourceVersionChanges({ read: read({ 'manifest.json': before }), version: '0.0.1' })).files[0].after,
        '{"\\u0076ersion":"0.0.1","nested":{"version":"2.0.0"}}');
    for (const content of [
        '{"version":"1.0.0-dev","\\u0076ersion":"1.0.0-dev"}',
        '{"version":null}',
        '{"version":"01.0.0"}',
        '{"version":"1.0.0-alpha.1"}',
        '{"version":"1.0.9007199254740992"}',
        '[{"version":"1.0.0"}]',
        '{"version":"1.0.0-dev"',
    ]) {
        await assert.rejects(inspectSourceVersion({ read: read({ 'manifest.json': content }) }));
    }
    await assert.rejects(sourceVersionChanges({ read: read({ 'manifest.json': '{"version":"1.0.1-dev"}' }),
        version: '1.0.1', expectedVersion: '1.0.0-dev' }), /changed before preparation/);
});

test('POM reactor edits update only project version and exact managed parent versions', async () => {
    const root = pom(`${identity}<version> 1.0.0-dev </version><!-- <version>do not touch</version> -->`
        + '<modules><module>child</module><module>unrelated</module></modules>'
        + '<dependencies><dependency><groupId>external</groupId><artifactId>dep</artifactId><version>1.0.0-dev</version></dependency></dependencies>');
    const child = pom(`${parent()}<artifactId>child</artifactId><modules><module>nested</module></modules>`
        + '<build><plugins><plugin><artifactId>example</artifactId><version>1.0.0-dev</version></plugin></plugins></build>');
    const nested = pom(`${parent('child')}<artifactId>nested</artifactId>`);
    const unrelated = pom(`${parent('external-parent', '5.0.0')}<artifactId>independent</artifactId><version>7.0.0</version>`);
    const files = { 'pom.xml': root, 'child/pom.xml': child, 'child/nested/pom.xml': nested, 'unrelated/pom.xml': unrelated };
    const source = read(files);
    assert.deepEqual(await inspectSourceVersion({ read: source }), {
        format: 'pom', version: '1.0.0-dev', paths: ['pom.xml', 'child/pom.xml', 'child/nested/pom.xml'],
    });
    const changes = await sourceVersionChanges({ read: source, version: '1.0.0' });
    assert.deepEqual(changes.files, [
        { path: 'pom.xml', before: root, after: root.replace('<version> 1.0.0-dev </version>', '<version> 1.0.0 </version>') },
        { path: 'child/pom.xml', before: child, after: child.replace(parent(), parent('parent', '1.0.0')) },
        { path: 'child/nested/pom.xml', before: nested, after: nested.replace(parent('child'), parent('child', '1.0.0')) },
    ]);
    assert.equal(files['unrelated/pom.xml'], unrelated);
    assert.deepEqual((await sourceVersionChanges({ read: source, version: '1.0.0-dev' })).files, []);
});

test('POM namespaces and attributes do not affect exact version boundaries', async () => {
    const before = '\uFEFF<?xml version="1.0"?>\r\n<m:project xmlns:m="urn:maven" note="a>b">\r\n'
        + `<m:groupId>example</m:groupId><m:artifactId>parent</m:artifactId><m:version>1.2.3-dev</m:version>\r\n</m:project>\r\n`;
    const result = await sourceVersionChanges({ read: read({ 'pom.xml': before }), version: '1.2.3' });
    assert.equal(result.files[0].after, before.replace('1.2.3-dev', '1.2.3'));
});

test('unsafe, incomplete or ambiguous POM metadata cannot produce edits', async () => {
    for (const body of [
        `${identity}<version>1.0.0-dev</version><modules><module>../outside</module></modules>`,
        `${identity}<version>1.0.0-dev</version><modules><module>C:/outside</module></modules>`,
        `${identity}<version>1.0.0-dev</version><modules><module>/outside</module></modules>`,
        `${identity}<version>1.0.0-dev</version><modules><module>child</module><module>child</module></modules>`,
        `${identity}<version>1.0.0-dev</version><modules><module>missing</module></modules>`,
        `${identity}<version>1.0.0-dev</version><version>2.0.0</version>`,
        `${identity}<version>${'${revision}'}</version>`,
        `${identity}<version>1.0.0-dev</artifactId>`,
    ]) {
        const files = { 'pom.xml': pom(body), 'child/pom.xml': pom(`${parent()}<artifactId>child</artifactId>`) };
        await assert.rejects(sourceVersionChanges({ read: read(files), version: '1.0.0' }));
    }
    await assert.rejects(inspectSourceVersion({ read: read({ 'pom.xml': '<!DOCTYPE project SYSTEM "https://example.invalid"><project/>' }) }), /entities/);
    await assert.rejects(inspectSourceVersion({ read: read({ 'pom.xml': pom(`${identity}<version>1.0.0-dev</version><modules><module>child</module></modules>`),
        'child/pom.xml': pom(`${parent('parent', '0.9.0-dev')}<artifactId>child</artifactId>`) }) }), /parent versions/);
});

test('metadata readers reject oversized or non-text content and excessive reactors', async () => {
    await assert.rejects(inspectSourceVersion({ read: read({ 'manifest.json': ' '.repeat(1048577) }) }), /bounded/);
    await assert.rejects(inspectSourceVersion({ read: read({ 'manifest.json': Buffer.from('{}') }) }), /UTF-8 text/);
    const files = { 'pom.xml': pom(`${identity}<version>1.0.0-dev</version><modules>`
        + Array.from({ length: 100 }, (_, index) => `<module>module${index}</module>`).join('') + '</modules>') };
    for (let index = 0; index < 100; index++) files[`module${index}/pom.xml`] = pom(`${parent()}<artifactId>module${index}</artifactId>`);
    await assert.rejects(inspectSourceVersion({ read: read(files) }), /excessive/);
});

test('default Git reader uses the exact committed bytes without changing the working tree', async (context) => {
    const before = '\uFEFF{\r\n "version": "1.0.0-dev"\r\n}\r\n';
    const data = await fixture(context, { 'manifest.json': before });
    await writeFile(resolve(data.root, 'manifest.json'), '{"version":"9.0.0-dev"}\n');
    const status = data.git('status', '--porcelain');
    const result = await sourceVersionChanges({ root: data.root, sha: data.sha, version: '1.0.0' });
    assert.equal(result.files[0].before, before);
    assert.equal(result.files[0].after, before.replace('1.0.0-dev', '1.0.0'));
    assert.equal(data.git('status', '--porcelain'), status);
    assert.equal(await readFile(resolve(data.root, 'manifest.json'), 'utf8'), '{"version":"9.0.0-dev"}\n');
    await assert.rejects(inspectSourceVersion({ root: data.root, sha: 'HEAD' }), /pinned/);
});

test('default Git reader refuses metadata symlinks and invalid UTF8 blobs', async (context) => {
    const data = await fixture(context, { 'manifest.json': '{"version":"1.0.0-dev"}' });
    const hash = execFileSync('git', ['-C', data.root, 'hash-object', '-w', '--stdin'], {
        input: '../outside', encoding: 'utf8', windowsHide: true, shell: false,
    }).trim();
    data.git('update-index', '--add', '--cacheinfo', '120000', hash, 'manifest.json');
    data.git('commit', '-m', 'Unsafe metadata symlink');
    await assert.rejects(inspectSourceVersion({ root: data.root, sha: data.git('rev-parse', 'HEAD') }), /tracked regular/);
    await writeFile(resolve(data.root, 'manifest.json'), Buffer.from([0xc3, 0x28]));
    data.git('add', 'manifest.json');
    data.git('commit', '-m', 'Invalid UTF8 metadata');
    await assert.rejects(inspectSourceVersion({ root: data.root, sha: data.git('rev-parse', 'HEAD') }));
});

test('development cycles advance one patch without replacing a higher prepared target', () => {
    assert.equal(nextDevelopmentVersion('0.0.1'), '0.0.2-dev');
    assert.equal(nextDevelopmentVersion('1.2.3', '1.2.3-dev'), '1.2.4-dev');
    assert.equal(nextDevelopmentVersion('1.2.3', '1.3.0-dev'), '1.3.0-dev');
    assert.equal(nextDevelopmentVersion('1.2.3', '2.0.0'), '2.0.0-dev');
    assert.throws(() => nextDevelopmentVersion('1.2.3-dev'));
    assert.throws(() => nextDevelopmentVersion('1.2.3', '1.3.0-alpha.1'));
    assert.throws(() => nextDevelopmentVersion('1.2.9007199254740991'));
});
