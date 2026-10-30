import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { planVersion, recommendedBump, stableVersion } from './version.mjs';
import {
    assertPackageLimits,
    buildBundle,
    buildFrontend,
    manifestFor,
    marketResource,
    previousVersions,
    zipEntries,
} from './build.mjs';
import { createGitHubClient, githubTransport, localBundle, publishAssets } from './publish.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifest = {
    id: 'sample',
    name: 'Sample',
    description: 'A community extension.',
    type: 'plugin',
    version: '1.0.0-dev',
    requires: {
        cms: '^1.0',
        php: '^8.3',
        'plugin:foundation': '^1.0 || ^2.0',
        'plugin:cms': '^2.0',
        'plugin:php': '^3.0',
    },
};

test('GitHub requests preserve merge proof fields and HTTP refusal status', async () => {
    const client = createGitHubClient({ repository: 'Kraftink-CMS/Plugin-Sample', token: 'test-token',
        transport: async ({ method, headers }) => {
            assert.equal(headers['X-GitHub-Api-Version'], '2022-11-28');
            return method === 'GET'
                ? { status: 200, body: Buffer.from(JSON.stringify({ mergeable: true, merge_commit_sha: 'a'.repeat(40) })) }
                : { status: 405, body: Buffer.from('{}') };
        } });
    assert.equal((await client.request('GET', '/pulls/1')).merge_commit_sha, 'a'.repeat(40));
    await assert.rejects(client.request('PUT', '/pulls/1/merge', { sha: 'a'.repeat(40), merge_method: 'merge' }),
        (error) => error.status === 405 && /405/.test(error.message));
});

test('the shared GitHub client stays synchronous and rejects invalid replies and tag identities', async () => {
    assert.throws(() => createGitHubClient({ repository: '../outside', token: 'test-token' }), /GITHUB_REPOSITORY/);
    assert.throws(() => createGitHubClient({ repository: 'Kraftink-CMS/Plugin-Sample', token: 'invalid\ntoken' }), /GITHUB_TOKEN/);
    let response = { status: 404, body: Buffer.alloc(0) };
    const client = createGitHubClient({ repository: 'Kraftink-CMS/Plugin-Sample', token: 'test-token',
        transport: async () => response });
    assert.equal(client.then, undefined);
    assert.equal(await client.request('GET', '/releases/tags/v1.0.0'), null);
    response = { status: 204, body: Buffer.alloc(0) };
    assert.equal(await client.request('DELETE', '/git/refs/heads/example', undefined, 204), null);
    response = { status: 200, body: Buffer.from('invalid JSON') };
    await assert.rejects(client.request('GET', '/releases/latest'), /invalid JSON/);
    response.body = Buffer.from(JSON.stringify({ ref: 'refs/tags/v2.0.0', object: { type: 'commit', sha: 'a'.repeat(40) } }));
    await assert.rejects(client.tag('v1.0.0'), /unexpected tag reference/);
    response.body = Buffer.from(JSON.stringify({ ref: 'refs/tags/v1.0.0', object: { type: 'tree', sha: 'a'.repeat(40) } }));
    await assert.rejects(client.tag('v1.0.0'), /does not resolve to a commit/);
});

test('the shared GitHub transport bounds declared and streamed responses', async () => {
    const original = globalThis.fetch;
    const request = { method: 'GET', url: 'https://api.github.com/repos/Kraftink-CMS/Plugin-Sample/releases',
        headers: {}, limit: 4 };
    try {
        globalThis.fetch = async () => new Response('1234');
        assert.equal((await githubTransport(request)).body.toString(), '1234');
        for (const response of [
            () => new Response('12345'),
            () => new Response('1234', { headers: { 'Content-Length': '5' } }),
            () => new Response('1234', { headers: { 'Content-Length': 'invalid' } }),
        ]) {
            globalThis.fetch = async () => response();
            await assert.rejects(githubTransport(request), /size limit/);
        }
    } finally {
        globalThis.fetch = original;
    }
});

test('the shared GitHub client checks asset sizes and digests before accepting downloaded bytes', async () => {
    let calls = 0;
    const client = createGitHubClient({ repository: 'Kraftink-CMS/Plugin-Sample', token: 'test-token',
        transport: async ({ limit, binary }) => {
            calls++;
            assert.equal(limit, 4);
            assert.equal(binary, true);
            return { status: 200, body: Buffer.from('data') };
        } });
    const asset = { id: 1, state: 'uploaded', size: 4, digest: `sha256:${digest('data')}` };
    for (const size of [0, 536870913])
        await assert.rejects(client.bytes({ ...asset, size }, 4), /incomplete/);
    assert.equal(calls, 0);
    assert.equal((await client.bytes(asset, 4)).toString(), 'data');
    await assert.rejects(client.bytes({ ...asset, digest: `sha256:${'a'.repeat(64)}` }, 4), /declared digest/);
});

test('release manifests preserve flat Composer dependencies and reject bypasses', () => {
    const value = {
        ...manifest,
        integrations: {
            'plugin:optional': '>=1.0 <3.0',
            'game:minecraft': '^1.0',
        },
        conflicts: { 'theme:incompatible': '1.0.*' },
    };
    assert.deepEqual(manifestFor(JSON.stringify(value)), value);
    for (const id of ['cms', 'php']) {
        assert.equal(manifestFor(JSON.stringify({ ...value, id })).id, id);
    }
    for (const changes of [
        { requires: [] },
        { requires: { php: '^8.3' } },
        {
            requires: {
                cms: '^1.0',
                php: '^8.3',
                plugins: { foundation: '^1.0' },
            },
        },
        { requires: { cms: '^1.0', php: '^8.3', 'plugin:unknown': null } },
        { requires: { cms: '^1.0', php: '^8.3', foundation: '^1.0' } },
        {
            requires: {
                cms: '^1.0',
                php: '^8.3',
                'composer:Vendor/package': '^1.0',
            },
        },
        {
            requires: {
                cms: '^1.0',
                php: '^8.3',
                'composer:vendor/package': '^1.0',
            },
        },
        { requires: { cms: '^1.0', php: '^8.3', 'invalid/id': '^1.0' } },
        {
            requires: {
                cms: '^1.0',
                php: '^8.3',
                'plugin:foundation': 'invalid constraint',
            },
        },
        {
            requires: {
                cms: '^1.0',
                php: '^8.3',
                'plugin:foundation': ' '.repeat(200) + '*',
            },
        },
        { integrations: { cms: '^1.0' } },
        { integrations: { 'composer:vendor/package': '^1.0' } },
        { integrations: { optional: '^1.0' } },
        { integrations: { plugins: { optional: '^1.0' } } },
        { integrations: null },
        { conflicts: { php: '^8.3' } },
        { dependencies: ['foundation'] },
        { cms: '^1.0' },
        {
            libraries: {
                prefix: 'Custom\\',
                manifest: 'vendor/kraftink.json',
                sha256: 'a'.repeat(64),
            },
        },
    ]) {
        assert.throws(() => manifestFor(JSON.stringify({ ...value, ...changes })));
    }
});

test('release manifest validation accepts localized market presentation and repository images', () => {
    const value = {
        ...manifest,
        market: {
            name: { fr: 'Nom français' },
            description: { 'pt-BR': 'Descrição portuguesa.' },
            image: { fr: 'preview-fr.jpg', en: 'resources/market/en/preview.webp' },
        },
    };
    assert.deepEqual(manifestFor(JSON.stringify(value)), value);
    for (const market of [
        { name: {} },
        { name: { fr: '' } },
        { description: { fr: 'a'.repeat(1001) } },
        { image: '../outside.png' },
        { image: 'preview.svg' },
        { image: 'https://images.example:443/preview.png' },
        { image: 'https://images.example/preview.png?' },
        { image: 'https://images.example/preview.png#' },
    ]) {
        assert.throws(() => manifestFor(JSON.stringify({ ...manifest, market })));
    }
});

async function fixture(context, type = 'plugin') {
    const root = await mkdtemp(resolve(tmpdir(), 'kraftink-package-'));
    context.after(() => rm(root, { recursive: true, force: true }));
    const git = (...args) =>
        execFileSync('git', ['-C', root, ...args], {
            encoding: 'utf8',
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
    git('init', '-b', 'master');
    git('config', 'user.name', 'Package tests');
    git('config', 'user.email', 'package-tests@example.invalid');
    await mkdir(resolve(root, '.github'), { recursive: true });
    await mkdir(resolve(root, 'src'));
    await writeFile(resolve(root, 'manifest.json'), JSON.stringify({ ...manifest, type }));
    await writeFile(resolve(root, 'src/example.php'), '<?php return true;\n');
    await writeFile(
        resolve(root, '.github/release-policy.json'),
        JSON.stringify({
            schema: 1,
            initial_version: '1.0.0',
            default_bump: 'patch',
            next_version: null,
        }),
    );
    await writeFile(resolve(root, '.env'), 'PRIVATE=excluded');
    git('add', '.');
    git('commit', '-m', 'feat: initial package');
    return { root, git, repository: 'example/Plugin-Sample' };
}

test('stable versions reject prereleases and infer the highest commit level', () => {
    assert.throws(() => stableVersion('1.2.0-beta.1'));
    assert.throws(() => stableVersion('01.0.0'));
    assert.equal(recommendedBump(['fix: first', 'feat: second']), 'minor');
    assert.equal(recommendedBump(['feat: second', 'fix!: change contract']), 'major');
});

test('published archives respect the CMS extraction and download limits', () => {
    assert.doesNotThrow(() =>
        assertPackageLimits({
            files: 10000,
            extracted: 104857600,
            archive: 52428800,
        }),
    );
    assert.throws(() => assertPackageLimits({ files: 10001, extracted: 1 }), /CMS package limits/);
    assert.throws(() => assertPackageLimits({ files: 1, extracted: 104857601 }), /CMS package limits/);
    assert.throws(() => assertPackageLimits({ files: 1, extracted: 1, archive: 52428801 }), /CMS package limits/);
});

test('tags govern versions, reruns reuse the same commit and dev cannot publish', async (context) => {
    const { root, git } = await fixture(context);
    const first = await planVersion({ root });
    assert.equal(first.version, '1.0.0');
    git('tag', first.tag);
    assert.equal((await planVersion({ root })).version, first.version);
    await writeFile(resolve(root, 'src/example.php'), '<?php return false;\n');
    git('commit', '-am', 'feat: new behavior');
    assert.equal((await planVersion({ root })).version, '1.1.0');
    assert.equal((await planVersion({ root, bump: 'patch' })).version, '1.0.1');
    await assert.rejects(planVersion({ root, version: '1.0.0' }), /exceed/);
    git('checkout', '-b', 'dev');
    await assert.rejects(planVersion({ root }), /master/);
});

for (const type of ['plugin', 'theme', 'game']) {
    test(`${type} archives use committed files, stamp the manifest and publish deterministic metadata`, async (context) => {
        const { root, repository } = await fixture(context, type);
        const plan = await planVersion({ root });
        const directory = await mkdtemp(resolve(tmpdir(), 'kraftink-assets-'));
        context.after(() => rm(directory, { recursive: true, force: true }));
        const built = await buildBundle({ root, repository, plan, directory });
        const bytes = await readFile(resolve(directory, 'sample-1.0.0.zip'));
        const files = zipEntries(bytes);
        assert.equal(JSON.parse(files.get('manifest.json')).version, '1.0.0');
        assert.equal(JSON.parse(files.get('manifest.json')).type, type);
        assert.equal(files.has('.env'), false);
        assert.equal(files.has('.github/release-policy.json'), false);
        assert.equal(files.get('src/example.php').toString(), '<?php return true;\n');
        assert.equal(built.metadata.download.sha256, digest(bytes));
        assert.equal(built.metadata.versions[0].version, plan.version);
        assert.equal(built.metadata.resource.name, 'Sample');
        assert.equal(built.metadata.resource.description, 'A community extension.');
        assert.equal(built.metadata.resource.id, 'example/sample');
        assert.equal(
            built.metadata.download.url,
            `https://github.com/${repository}/releases/download/v1.0.0/sample-1.0.0.zip`,
        );
        await writeFile(resolve(root, 'src/example.php'), 'uncommitted change');
        await buildBundle({ root, repository, plan, directory });
        assert.deepEqual(await readFile(resolve(directory, 'sample-1.0.0.zip')), bytes);
        assert.equal((await localBundle(plan, directory)).length, 3);
        await writeFile(resolve(directory, 'sample-1.0.0.zip'), 'corrupted');
        await assert.rejects(localBundle(plan, directory), /changed|checksum/);
    });
}

test('market presentation comes from committed package translations and commercial settings', async (context) => {
    const { root, repository, git } = await fixture(context);
    await mkdir(resolve(root, 'lang/fr'), { recursive: true });
    await mkdir(resolve(root, 'lang/en'), { recursive: true });
    await mkdir(resolve(root, 'resources/market'), { recursive: true });
    await writeFile(resolve(root, 'resources/market/preview-fr.png'), 'committed French preview');
    await writeFile(resolve(root, 'resources/market/preview-en.png'), 'committed English preview');
    await writeFile(
        resolve(root, 'lang/fr/messages.php'),
        "<?php return ['name' => 'Module français', 'description' => 'Description française.'];\n",
    );
    await writeFile(
        resolve(root, 'lang/en/messages.php'),
        "<?php return ['name' => 'English package', 'description' => 'English description.'];\n",
    );
    await writeFile(
        resolve(root, 'manifest.json'),
        JSON.stringify({
            ...manifest,
            description: 'sample::messages.description',
            market: {
                name: 'sample::messages.name',
                image: { fr: 'preview-fr.png', en: 'resources/market/preview-en.png' },
                author: { name: 'Community' },
                commercial: {
                    kind: 'paid',
                    url: 'https://example.test/acquire',
                    price: { amount: '9.99', currency: 'EUR' },
                },
            },
        }),
    );
    git('add', '.');
    git('commit', '-m', 'feat: localized package presentation');
    const plan = await planVersion({ root });
    await writeFile(
        resolve(root, 'lang/fr/messages.php'),
        "<?php throw new RuntimeException('Uncommitted translation executed');\n",
    );
    const directory = await mkdtemp(resolve(tmpdir(), 'kraftink-metadata-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const { metadata } = await buildBundle({
        root,
        repository,
        plan,
        directory,
    });
    assert.deepEqual(metadata.resource.name, {
        en: 'English package',
        fr: 'Module français',
    });
    assert.deepEqual(metadata.resource.description, {
        en: 'English description.',
        fr: 'Description française.',
    });
    assert.deepEqual(metadata.resource.image, {
        en: `https://raw.githubusercontent.com/${repository}/${plan.tag}/resources/market/preview-en.png`,
        fr: `https://raw.githubusercontent.com/${repository}/${plan.tag}/resources/market/preview-fr.png`,
    });
    assert.equal(metadata.resource.author.name, 'Community');
    assert.equal(metadata.resource.manual_only, true);
    assert.equal(metadata.resource.commercial.url, 'https://example.test/acquire');
    assert.deepEqual(metadata.resource.commercial.price, {
        amount: '9.99',
        currency: 'EUR',
    });
    const packaged = zipEntries(await readFile(resolve(directory, 'sample-1.0.0.zip')));
    assert.equal(JSON.parse(packaged.get('manifest.json')).name, 'Sample');
    assert.equal(packaged.get('lang/fr/messages.php').toString().includes('Description française.'), true);
    assert.equal(packaged.get('resources/market/preview-fr.png').toString(), 'committed French preview');
});

test('market translations preserve only available values and reject unresolved keys or invalid prices', async () => {
    const localized = {
        ...manifest,
        name: 'sample::messages.name',
        description: 'sample::messages.description',
    };
    const files = [
        ['manifest.json', Buffer.from(JSON.stringify(localized))],
        [
            'lang/en/messages.php',
            Buffer.from("<?php return ['name' => 'English package', 'description' => 'English description.'];\n"),
        ],
        ['lang/fr/messages.php', Buffer.from('<?php return [];\n')],
    ];
    const resource = await marketResource(files, 'example/Plugin-Sample');
    assert.deepEqual(resource.name, {
        en: 'English package',
    });
    const shortOwner = await marketResource(files, '7/Plugin-Sample');
    assert.equal(shortOwner.author.id, 'github-7');
    assert.equal(shortOwner.id, 'github-7/sample');
    assert.equal(shortOwner.repository, 'https://github.com/7/Plugin-Sample');
    localized.name = 'another::messages.name';
    files[0][1] = Buffer.from(JSON.stringify(localized));
    await assert.rejects(marketResource(files, 'example/Plugin-Sample'), /must belong to the package/);
    localized.name = manifest.name;
    localized.market = {
        commercial: { kind: 'paid', price: { amount: 'NaN', currency: 'EUR' } },
    };
    files[0][1] = Buffer.from(JSON.stringify(localized));
    await assert.rejects(marketResource(files, 'example/Plugin-Sample'), /decimal amount string/);
    localized.market.commercial.price = null;
    files[0][1] = Buffer.from(JSON.stringify(localized));
    await assert.rejects(marketResource(files, 'example/Plugin-Sample'), /decimal amount string/);
    localized.market.commercial = { kind: 'paid', url: null };
    files[0][1] = Buffer.from(JSON.stringify(localized));
    await assert.rejects(marketResource(files, 'example/Plugin-Sample'), /plain HTTPS URLs/);
});

test('market metadata keeps untranslated literals and independently available package languages', async () => {
    const files = [
        ['manifest.json', Buffer.from(JSON.stringify(manifest))],
        ['lang/fr/messages.php', Buffer.from("<?php return ['name' => 'Nom français'];\n")],
        ['lang/pt-BR/messages.php', Buffer.from("<?php return ['description' => 'Descrição portuguesa.'];\n")],
        ['lang/zh-Hant-TW/messages.php', Buffer.from("<?php return ['name' => '繁體中文'];\n")],
    ];
    const raw = await marketResource(files, 'example/Plugin-Sample');
    assert.equal(raw.name, manifest.name);
    assert.equal(raw.description, manifest.description);
    assert.equal(raw.image, undefined);
    files[0][1] = Buffer.from(JSON.stringify({
        ...manifest,
        market: { name: 'sample::messages.name', description: 'sample::messages.description' },
    }));
    const translated = await marketResource(files, 'example/Plugin-Sample');
    assert.deepEqual(translated.name, { fr: 'Nom français', 'zh-Hant-TW': '繁體中文' });
    assert.deepEqual(translated.description, { 'pt-BR': 'Descrição portuguesa.' });
});

test('market metadata exports explicit language dictionaries and image variants without inventing languages', async () => {
    const market = {
        name: { fr: 'Nom français' },
        description: { 'pt-BR': 'Descrição portuguesa.' },
        image: { fr: 'https://images.example/fr.png', en: 'https://images.example/en.webp' },
    };
    const files = [['manifest.json', Buffer.from(JSON.stringify({ ...manifest, market }))]];
    const resource = await marketResource(files, 'example/Plugin-Sample');
    assert.deepEqual(resource.name, market.name);
    assert.deepEqual(resource.description, market.description);
    assert.deepEqual(resource.image, market.image);
    market.image = 'https://images.example/preview.png';
    files[0][1] = Buffer.from(JSON.stringify({ ...manifest, market }));
    assert.equal((await marketResource(files, 'example/Plugin-Sample')).image, market.image);
});

test('market metadata refuses malformed dictionaries and unsafe image URLs', async () => {
    const invalid = [
        { name: {} },
        { name: { fr: '' } },
        { description: { invalid_language: 'Description' } },
        { description: { fr: 'a'.repeat(1001) } },
        { image: null },
        { image: {} },
        { image: { en: null } },
        { image: 'http://images.example/preview.png' },
        { image: 'https://user:password@images.example/preview.png' },
        { image: 'https://images.example/preview.png?token=value' },
        { image: 'https://images.example/preview.png?' },
        { image: 'https://images.example/preview.png#fragment' },
        { image: 'https://images.example/preview.png#' },
        { image: 'https://images.example:443/preview.png' },
        { image: 'https://images.example/preview image.png' },
        { image: 'https://images.example/' + 'a'.repeat(2048) },
    ];
    for (const market of invalid) {
        const files = [['manifest.json', Buffer.from(JSON.stringify({ ...manifest, market }))]];
        await assert.rejects(marketResource(files, 'example/Plugin-Sample'));
    }
});

test('repository images resolve from fixed package resources to immutable release tag URLs', async () => {
    const value = {
        ...manifest,
        version: '1.2.3',
        market: { image: { fr: 'preview.jpg', en: 'resources/market/en/preview.webp', 'pt-BR': 'pt/preview.png' } },
    };
    const files = [
        ['manifest.json', Buffer.from(JSON.stringify(value))],
        ['resources/market/preview.jpg', Buffer.from('French preview')],
        ['resources/market/en/preview.webp', Buffer.from('English preview')],
        ['resources/market/pt/preview.png', Buffer.from('Portuguese preview')],
    ];
    const resource = await marketResource(files, 'example/Plugin-Sample');
    assert.deepEqual(resource.image, {
        en: 'https://raw.githubusercontent.com/example/Plugin-Sample/v1.2.3/resources/market/en/preview.webp',
        fr: 'https://raw.githubusercontent.com/example/Plugin-Sample/v1.2.3/resources/market/preview.jpg',
        'pt-BR': 'https://raw.githubusercontent.com/example/Plugin-Sample/v1.2.3/resources/market/pt/preview.png',
    });
    for (const image of [
        '../preview.jpg', '/preview.jpg', 'C:\\preview.jpg', 'en\\preview.webp',
        'en/../preview.jpg', 'preview.svg', 'missing.png', 'resources/market/../../preview.jpg',
    ]) {
        files[0][1] = Buffer.from(JSON.stringify({ ...value, market: { image } }));
        await assert.rejects(marketResource(files, 'example/Plugin-Sample'));
    }
    files[0][1] = Buffer.from(JSON.stringify({ ...value, version: '1.2.3-dev' }));
    await assert.rejects(marketResource(files, 'example/Plugin-Sample'), /stable staged package version/);
});

test('repository image resolution refuses symbolic links in image paths', async (context) => {
    const root = await mkdtemp(resolve(tmpdir(), 'kraftink-image-path-'));
    context.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(resolve(root, 'resources/market'), { recursive: true });
    await mkdir(resolve(root, 'outside'), { recursive: true });
    await writeFile(resolve(root, 'outside/preview.jpg'), 'outside image');
    await symlink(resolve(root, 'outside'), resolve(root, 'resources/market/linked'), 'junction');
    await writeFile(resolve(root, 'manifest.json'), JSON.stringify({
        ...manifest,
        version: '1.2.3',
        market: { image: 'linked/preview.jpg' },
    }));
    assert.throws(() => execFileSync(
        process.env.PHP_BINARY || 'php',
        [fileURLToPath(new URL('./market.php', import.meta.url)), root, 'example/Plugin-Sample'],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    ), /symbolic links|unsafe/);
});

test('release history is fetched from the previous stable asset and rejects another package', async () => {
    const version = {
        version: '1.0.0',
        requirements: manifest.requires,
        download: {
            url: 'https://github.com/example/Plugin-Sample/releases/download/v1.0.0/sample-1.0.0.zip',
            sha256: 'a'.repeat(64),
        },
    };
    const metadata = {
        schema_version: 1,
        slug: 'sample',
        type: 'plugin',
        ...version,
        versions: [version],
    };
    const client = {
        release: async () => ({
            tag_name: 'v1.0.0',
            draft: false,
            prerelease: false,
        }),
        assets: async () => [{ name: 'kraftink-extension.json' }],
        bytes: async () => Buffer.from(JSON.stringify(metadata)),
    };
    const input = {
        plan: { base_tag: 'v1.0.0' },
        repository: 'example/Plugin-Sample',
        manifest,
        client,
    };
    assert.deepEqual(await previousVersions(input), [version]);
    for (const versions of [undefined, null, [], {}, Array.from({ length: 101 }, () => version)]) {
        metadata.versions = versions;
        await assert.rejects(previousVersions(input), /Invalid previous version history/);
    }
    metadata.versions = [version];
    metadata.slug = 'other';
    await assert.rejects(previousVersions(input), /identity/);
});

test('SCSS is compiled from committed sources and replaces stale CSS inside the package', async (context) => {
    const { root, repository, git } = await fixture(context, 'theme');
    const source = '.sample { color: red; }';
    const theme = {
        ...manifest,
        type: 'theme',
        build: { scss: ['_theme.scss'] },
        assets: { styles: ['theme.css'] },
    };
    await mkdir(resolve(root, 'public'));
    await writeFile(resolve(root, 'manifest.json'), JSON.stringify(theme));
    await writeFile(resolve(root, '_theme.scss'), source);
    await writeFile(resolve(root, 'public/theme.css'), 'stale CSS');
    git('add', '.');
    git('commit', '-m', 'feat: theme styles');
    const plan = await planVersion({ root });
    await writeFile(resolve(root, '_theme.scss'), 'uncommitted CSS');
    const directory = await mkdtemp(resolve(tmpdir(), 'kraftink-styles-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    let calls = 0;
    const compiler = (path) => {
        calls++;
        assert.equal(readFileSync(path, 'utf8'), source);
        return { css: '.sample{color:red}' };
    };
    await buildBundle({ root, plan, repository, directory, compiler });
    const files = zipEntries(await readFile(resolve(directory, 'sample-1.0.0.zip')));
    assert.equal(calls, 1);
    assert.equal(files.get('public/theme.css').toString(), '.sample{color:red}');
});

function frontendSources(extra = {}) {
    const configuration = {
        name: 'frontend-fixture',
        private: true,
        scripts: { build: 'node build.mjs' },
    };
    const lock = {
        name: configuration.name,
        lockfileVersion: 3,
        packages: { '': { name: configuration.name } },
    };
    return [
        ['package.json', Buffer.from(JSON.stringify(configuration))],
        ['package-lock.json', Buffer.from(JSON.stringify(lock))],
        ...Object.entries(extra).map(([path, contents]) => [path, Buffer.from(contents)]),
    ];
}

test('frontend builds use committed inputs and package only public outputs', async (context) => {
    const { root, repository, git } = await fixture(context);
    const sources = frontendSources({
        'build.mjs': 'committed build source',
        'public/site.css': 'stale CSS',
    });
    for (const [path, bytes] of sources) {
        await mkdir(resolve(root, path, '..'), { recursive: true });
        await writeFile(resolve(root, path), bytes);
    }
    git('add', '.');
    git('commit', '-m', 'feat: frontend build');
    const plan = await planVersion({ root });
    await writeFile(resolve(root, 'build.mjs'), 'uncommitted build source');
    const directory = resolve(root, 'release-assets');
    const calls = [];
    let stage;
    const frontendRunner = async (args, { cwd }) => {
        stage = cwd;
        assert.notEqual(cwd, root);
        assert.equal(await readFile(resolve(cwd, 'build.mjs'), 'utf8'), 'committed build source');
        calls.push(args);
        if (args[0] === 'run') {
            await mkdir(resolve(cwd, 'node_modules'), { recursive: true });
            await writeFile(resolve(cwd, 'node_modules/private.js'), 'build dependency');
            await writeFile(resolve(cwd, 'public/site.css'), 'compiled CSS');
            await writeFile(resolve(cwd, 'src/example.php'), 'a build cannot replace runtime PHP');
        }
    };
    await buildBundle({ root, repository, plan, directory, frontendRunner });
    const files = zipEntries(await readFile(resolve(directory, 'sample-1.0.0.zip')));
    assert.deepEqual(calls, [
        ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
        ['run', 'build', '--ignore-scripts'],
    ]);
    assert.equal(files.get('public/site.css').toString(), 'compiled CSS');
    assert.equal(files.get('src/example.php').toString(), '<?php return true;\n');
    assert.equal(files.has('package.json'), false);
    assert.equal(files.has('package-lock.json'), false);
    assert.equal(files.has('build.mjs'), false);
    assert.equal(
        [...files.keys()].some((path) => path.includes('node_modules')),
        false,
    );
    assert.equal(await readFile(resolve(root, 'public/site.css'), 'utf8'), 'stale CSS');
    assert.equal(await readFile(resolve(root, 'build.mjs'), 'utf8'), 'uncommitted build source');
    await assert.rejects(access(stage), { code: 'ENOENT' });
});

test('frontend builds require a matching lock and fail without changing runtime files', async () => {
    const files = [['public/site.css', Buffer.from('original CSS')]];
    const runner = async () => {
        throw new Error('npm must not run for invalid inputs');
    };
    const missing = frontendSources().filter(([path]) => path !== 'package-lock.json');
    await assert.rejects(buildFrontend(files, missing, runner), /committed package-lock/);
    const mismatched = frontendSources();
    mismatched[0][1] = Buffer.from(
        JSON.stringify({
            scripts: { build: 'node build.mjs' },
            dependencies: { example: '1.0.0' },
        }),
    );
    await assert.rejects(buildFrontend(files, mismatched, runner), /do not match/);
    await assert.rejects(
        buildFrontend(files, frontendSources(), async () => {
            throw new Error('npm ci failed');
        }),
        /npm ci failed/,
    );
    assert.equal(files[0][1].toString(), 'original CSS');
});

test('frontend output symlinks cannot enter an extension archive', async () => {
    const files = [['public/site.css', Buffer.from('original CSS')]];
    const runner = async (args, { cwd }) => {
        if (args[0] === 'run') {
            await mkdir(resolve(cwd, 'generated'));
            await symlink(
                resolve(cwd, 'generated'),
                resolve(cwd, 'public'),
                process.platform === 'win32' ? 'junction' : 'dir',
            );
        }
    };
    await assert.rejects(buildFrontend(files, frontendSources(), runner), /Unsafe frontend build output/);
});

test('a real npm build produces installable assets without install hooks or a Node runtime dependency', async () => {
    const sources = frontendSources({
        'build.mjs':
            "import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('public', { recursive: true }); writeFileSync('public/compiled.js', process.version);",
    });
    const configuration = JSON.parse(sources[0][1]);
    configuration.scripts.prebuild = 'node missing-forbidden-prebuild.mjs';
    configuration.scripts.postinstall = 'node missing-forbidden-postinstall.mjs';
    sources[0][1] = Buffer.from(JSON.stringify(configuration));
    const files = new Map(await buildFrontend([], sources));
    assert.equal(files.get('public/compiled.js').toString(), process.version);
    assert.equal(
        [...files.keys()].some((path) => path.includes('node_modules')),
        false,
    );
});

test('local checks build current sources without Git or changing the package checkout', async (context) => {
    const root = await mkdtemp(resolve(tmpdir(), 'kraftink-check-'));
    context.after(() => rm(root, { recursive: true, force: true }));
    const localManifest = { ...manifest, market: { image: 'preview.jpg' } };
    const sources = frontendSources({
        'manifest.json': JSON.stringify(localManifest),
        'build.mjs':
            "import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('public', { recursive: true }); writeFileSync('public/site.css', 'compiled asset');",
        'public/site.css': 'original CSS',
        'resources/market/preview.jpg': 'original image',
    });
    for (const [path, bytes] of sources) {
        await mkdir(resolve(root, path, '..'), { recursive: true });
        await writeFile(resolve(root, path), bytes);
    }
    execFileSync(process.execPath, [fileURLToPath(new URL('./build.mjs', import.meta.url)), 'check'], {
        cwd: root,
        windowsHide: true,
        shell: false,
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(await readFile(resolve(root, 'public/site.css'), 'utf8'), 'original CSS');
    assert.deepEqual(JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8')), localManifest);
    assert.equal(await readFile(resolve(root, 'resources/market/preview.jpg'), 'utf8'), 'original image');
    await assert.rejects(access(resolve(root, '.git')), { code: 'ENOENT' });
    await assert.rejects(access(resolve(root, 'node_modules')), {
        code: 'ENOENT',
    });
});

test('builtin game protection prevents an independent market release', async (context) => {
    const { root, repository, git } = await fixture(context, 'game');
    await writeFile(resolve(root, 'manifest.json'), JSON.stringify({ ...manifest, type: 'game', builtin: true }));
    git('commit', '-am', 'fix: preserve bundled game policy');
    const plan = await planVersion({ root });
    await assert.rejects(
        buildBundle({
            root,
            repository,
            plan,
            directory: resolve(root, 'assets'),
        }),
        /released with KraftInk/,
    );
});

class FakeClient {
    constructor() {
        this.sha = null;
        this.current = null;
        this.files = [];
        this.uploads = 0;
        this.calls = [];
    }
    async tag() {
        return this.sha;
    }
    async release() {
        return this.current;
    }
    async assets() {
        return this.files;
    }
    async upload(release, asset) {
        this.uploads++;
        this.files.push({
            id: this.uploads,
            name: asset.name,
            size: asset.size,
            state: 'uploaded',
            digest: `sha256:${asset.sha256}`,
        });
    }
    async request(method, path, body) {
        this.calls.push({ method, path, body });
        if (method === 'POST' && path === '/git/refs') {
            this.sha = body.sha;
            return {};
        }
        if (method === 'POST' && path === '/releases') {
            this.current = {
                id: 1,
                ...body,
                draft: true,
                prerelease: false,
            };
            return this.current;
        }
        if (method === 'GET' && path === '/releases/1') {
            return { ...this.current };
        }
        if (method === 'GET' && path === '/releases/latest') {
            return null;
        }
        if (method === 'PATCH' && path === '/releases/1') {
            this.current = { ...this.current, ...body };
            return this.current;
        }
        throw new Error(`Unexpected request ${method} ${path}`);
    }
}

test('publishing resumes a draft and never replaces a published or conflicting release', async (context) => {
    const { root, repository } = await fixture(context);
    const plan = await planVersion({ root });
    const directory = await mkdtemp(resolve(tmpdir(), 'kraftink-publish-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    await buildBundle({ root, repository, plan, directory });
    const client = new FakeClient();
    client.sha = plan.sha;
    client.current = {
        id: 1,
        tag_name: plan.tag,
        draft: true,
        prerelease: false,
        body: 'Notes from an interrupted attempt.',
    };
    const phases = [];
    const settings = { plan, directory, client, body: '## Changes\n\nA useful update.',
        beforeMutation: async (phase) => phases.push(phase) };
    assert.equal((await publishAssets(settings)).published, true);
    assert.equal(client.current.body, settings.body);
    assert.deepEqual(phases, ['notes', 'publish']);
    assert.equal(client.uploads, 3);
    const calls = client.calls.length;
    assert.equal((await publishAssets({ ...settings, body: 'Changed after publication.' })).published, false);
    assert.equal(client.current.body, settings.body);
    assert.equal(client.calls.length, calls);
    assert.equal(client.uploads, 3);
    client.files[0].digest = `sha256:${'b'.repeat(64)}`;
    await assert.rejects(publishAssets(settings), /cannot be replaced/);
    client.sha = 'f'.repeat(40);
    await assert.rejects(publishAssets(settings), /another commit/);
});

test('publication generates notes from source commits and disables GitHub PR notes', async (context) => {
    const { root, repository } = await fixture(context);
    const plan = await planVersion({ root });
    const directory = resolve(root, 'assets');
    await buildBundle({ root, repository, plan, directory });
    const client = new FakeClient();
    await publishAssets({ root, repository, plan, directory, client,
        notes: { mode: 'append', message: '## Highlights\n\nA first package.' } });
    const created = client.calls.find((call) => call.method === 'POST' && call.path === '/releases');
    assert.equal(created.body.generate_release_notes, false);
    assert.match(created.body.body, /^## Highlights\n\nA first package\.\n\n## Changes/);
    assert.match(created.body.body, /feat: initial package/);
    assert.match(created.body.body, new RegExp(`https://github.com/${repository}/commit/${plan.sha}`));
    assert.equal(client.current.body, created.body.body);
    assert.equal(client.calls.filter((call) => call.method === 'PATCH' && Object.hasOwn(call.body, 'body')).length, 0);
});

test('invalid prepared notes fail before mutation and a published draft cannot receive new notes', async (context) => {
    const { root, repository } = await fixture(context);
    const plan = await planVersion({ root });
    const directory = resolve(root, 'assets');
    await buildBundle({ root, repository, plan, directory });
    const client = new FakeClient();
    for (const body of ['x'.repeat(20481), '\u0000', { text: 'invalid' }]) {
        await assert.rejects(publishAssets({ plan, directory, client, body }), /20480 UTF-8 bytes/);
    }
    assert.deepEqual(client.calls, []);
    client.sha = plan.sha;
    client.current = { id: 1, tag_name: plan.tag, draft: true, prerelease: false, body: 'Original.' };
    await assert.rejects(publishAssets({ plan, directory, client, body: 'Prepared.',
        beforeMutation: async (phase) => {
            assert.equal(phase, 'notes');
            client.current.draft = false;
        } }), /mutable draft/);
    assert.equal(client.current.body, 'Original.');
    assert.equal(client.calls.filter((call) => call.method === 'PATCH').length, 0);
});
