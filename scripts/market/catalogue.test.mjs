import assert from 'node:assert/strict';
import test from 'node:test';
import {
    encodeCatalogue,
    fetchReleaseMetadata,
    generateCatalogue,
    metadataVersions,
    repositoryName,
    sourceResources,
} from './catalogue.mjs';

function offer(slug = 'sample', type = 'plugin') {
    return {
        id: `community/${slug}`,
        slug,
        type,
        name: { en: slug },
        description: { en: 'A community extension.' },
        author: { id: 'community', name: 'Community' },
        repository: `https://github.com/community/${type}-${slug}`,
        commercial: { kind: 'free' },
    };
}

function metadata(resource, version = '1.0.0', older = []) {
    if (!resource.slug) {
        const name = new URL(resource.repository).pathname.split('/').pop();
        const match = /^(plugin|theme|game)-(.+)$/i.exec(name);
        resource = { ...offer(match[2], match[1].toLowerCase()), repository: resource.repository };
    }
    const entry = (number) => ({
        version: number,
        requirements: {
            cms: '^1.0 || ^2.0',
            php: '>=8.3 <9.0',
            'plugin:dependency': '^1.0',
            'plugin:cms': '^2.0',
            'plugin:php': '^3.0',
        },
        download: {
            url: `${resource.repository}/releases/download/v${number}/${resource.slug}-${number}.zip`,
            sha256: 'a'.repeat(64),
        },
    });
    return {
        schema_version: 1,
        slug: resource.slug,
        type: resource.type,
        resource: structuredClone(resource),
        ...entry(version),
        versions: [entry(version), ...older.map(entry)],
    };
}

const source = (...resources) => ({
    schema_version: 1,
    repositories: resources.map((resource) => ({ repository: resource.repository, auto_update: true })),
    resources: [],
});

test('registrations require an explicit boolean update choice and unique valid repositories', () => {
    const resource = offer();
    const registry = source(resource);
    assert.deepEqual(sourceResources(registry).repositories, registry.repositories);
    for (const registration of [
        resource.repository,
        null,
        [],
        { repository: resource.repository },
        { repository: resource.repository, auto_update: null },
        { repository: resource.repository, auto_update: 'false' },
        { repository: resource.repository, auto_update: 1 },
        { repository: resource.repository, auto_update: true, enabled: true },
        { repository: '../Plugin-Sample', auto_update: true },
    ])
        assert.throws(() => sourceResources({ ...registry, repositories: [registration] }));
    assert.throws(
        () =>
            sourceResources({
                ...registry,
                repositories: [
                    { repository: 'Community/Plugin-Sample', auto_update: true },
                    { repository: 'community/plugin-sample', auto_update: false },
                ],
            }),
        /Duplicate/,
    );
    assert.deepEqual(
        sourceResources({
            ...registry,
            repositories: [{ repository: 'Community/Plugin-Sample', auto_update: false }],
        }).repositories,
        [{ repository: 'https://github.com/Community/Plugin-Sample', auto_update: false }],
    );
    const manual = { ...resource, versions: [metadata(resource).versions[0]] };
    assert.throws(() => sourceResources({ ...registry, resources: [manual] }), /both automatic and manual/);
    for (const invalid of [
        null,
        '',
        'Plugin-Sample',
        'Theme-Sample',
        'Game-Sample',
        '../Plugin-Sample',
        'community/plugin-sample; echo injected',
        1,
    ])
        assert.throws(() => repositoryName(invalid), /repository/);
    for (const repository of ['Plugin-Sample', 'Theme-Sample', 'Game-Sample']) {
        assert.throws(
            () => sourceResources({ schema_version: 1, repositories: [], resources: [{ ...manual, repository }] }),
            /repository/,
        );
    }
});

test('one central reconciliation resolves registered repositories with bounded concurrency', async () => {
    const resources = Array.from({ length: 45 }, (_, index) => offer(`package-${index}`));
    const calls = [];
    let active = 0;
    let maximum = 0;
    const result = await generateCatalogue({
        source: source(...resources),
        fetchMetadata: async (resource) => {
            calls.push(resource.repository);
            maximum = Math.max(maximum, ++active);
            await Promise.resolve();
            active--;
            return metadata(resource, '1.1.0', ['1.0.0']);
        },
    });
    assert.equal(calls.length, 45);
    assert.equal(maximum, 6);
    assert.equal(result.catalogue.resources.length, 45);
    assert.deepEqual(
        result.catalogue.resources[0].versions.map((entry) => entry.version),
        ['1.1.0', '1.0.0'],
    );
    assert.equal(result.catalogue.resources[0].release_source, undefined);
    assert.equal(result.failures.length, 0);
});

test('full reconciliation preserves frozen offers exactly and never creates an unpublished frozen offer', async () => {
    const frozen = offer('frozen');
    const active = offer('active');
    const unpublished = offer('unpublished');
    const prior = await generateCatalogue({
        source: source(frozen, active),
        fetchMetadata: async (resource) => metadata(resource, '1.1.0', ['1.0.0']),
    });
    const frozenOffer = prior.catalogue.resources.find((resource) => resource.slug === 'frozen');
    frozenOffer.versions.reverse();
    frozenOffer.versions[0].download.sha256 = 'A'.repeat(64);
    delete frozenOffer.manual_only;
    const previous = structuredClone(prior.catalogue);
    const registry = source(frozen, active, unpublished);
    registry.repositories[0].auto_update = false;
    registry.repositories[2].auto_update = false;
    const original = structuredClone(registry);
    const calls = [];
    const result = await generateCatalogue({
        source: registry,
        previous,
        fetchMetadata: async (resource) => {
            calls.push(resource.repository);
            return metadata(resource, '1.2.0', ['1.1.0', '1.0.0']);
        },
    });
    assert.deepEqual(calls, [active.repository]);
    assert.equal(result.checked, 1);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(
        result.catalogue.resources.find((resource) => resource.slug === 'frozen'),
        frozenOffer,
    );
    assert.equal(
        result.catalogue.resources.find((resource) => resource.slug === 'active').versions[0].version,
        '1.2.0',
    );
    assert.equal(
        result.catalogue.resources.some((resource) => resource.slug === 'unpublished'),
        false,
    );
    assert.deepEqual(registry, original);
    assert.deepEqual(previous, prior.catalogue);
});

test('frozen notifications are successful skips and unfreezing resumes the latest public release', async () => {
    const resource = offer();
    const registry = source(resource);
    const prior = await generateCatalogue({
        source: registry,
        fetchMetadata: async () => metadata(resource),
    });
    registry.repositories[0].auto_update = false;
    const skipped = await generateCatalogue({
        source: registry,
        previous: prior.catalogue,
        repository: 'Community/Plugin-Sample',
        fetchMetadata: async () => assert.fail('Frozen notifications must not fetch release metadata.'),
    });
    assert.equal(skipped.checked, 0);
    assert.deepEqual(skipped.failures, []);
    assert.deepEqual(skipped.catalogue, prior.catalogue);
    assert.equal(skipped.bytes, prior.bytes);
    registry.repositories[0].auto_update = true;
    const refreshed = await generateCatalogue({
        source: registry,
        previous: skipped.catalogue,
        fetchMetadata: async () => metadata(resource, '1.1.0', ['1.0.0']),
    });
    assert.equal(refreshed.checked, 1);
    assert.equal(refreshed.catalogue.resources[0].versions[0].version, '1.1.0');
});

test('an explicit manual refresh imports a frozen registration without enabling future automatic updates', async () => {
    const resource = offer();
    const registry = source(resource);
    registry.repositories[0].auto_update = false;
    const first = await generateCatalogue({
        source: registry,
        repository: resource.repository,
        force: true,
        fetchMetadata: async () => metadata(resource),
    });
    assert.equal(first.checked, 1);
    assert.deepEqual(first.failures, []);
    assert.equal(first.catalogue.resources[0].slug, resource.slug);
    assert.equal(registry.repositories[0].auto_update, false);
    const next = await generateCatalogue({
        source: registry,
        previous: first.catalogue,
        fetchMetadata: async () => assert.fail('The manual import must not enable automatic updates.'),
    });
    assert.equal(next.checked, 0);
    assert.deepEqual(next.catalogue, first.catalogue);
    const unregistered = await generateCatalogue({
        source: registry,
        previous: first.catalogue,
        repository: 'community/plugin-unregistered',
        force: true,
        fetchMetadata: async () => assert.fail('A manual refresh must not register another repository.'),
    });
    assert.equal(unregistered.checked, 0);
    assert.deepEqual(unregistered.catalogue, first.catalogue);
});

test('manual refresh updates only its frozen target and preserves every other published offer', async () => {
    const first = offer('first');
    const second = offer('second');
    const registry = source(first, second);
    const prior = await generateCatalogue({
        source: registry,
        fetchMetadata: async (resource) => metadata(resource),
    });
    for (const registration of registry.repositories) registration.auto_update = false;
    const calls = [];
    const result = await generateCatalogue({
        source: registry,
        previous: prior.catalogue,
        repository: first.repository,
        force: true,
        fetchMetadata: async (resource) => {
            calls.push(resource.repository);
            return metadata(resource, '1.0.1', ['1.0.0']);
        },
    });
    assert.deepEqual(calls, [first.repository]);
    assert.equal(result.checked, 1);
    assert.equal(
        result.catalogue.resources.find((resource) => resource.slug === 'first').versions[0].version,
        '1.0.1',
    );
    assert.deepEqual(
        result.catalogue.resources.find((resource) => resource.slug === 'second'),
        prior.catalogue.resources.find((resource) => resource.slug === 'second'),
    );
    assert.ok(registry.repositories.every((registration) => registration.auto_update === false));
});

test('a manual bulk refresh updates every registered offer including paused first imports', async () => {
    const active = offer('active');
    const frozen = offer('frozen');
    const unpublished = offer('unpublished');
    const removed = offer('removed');
    const manual = { ...offer('manual'), versions: [metadata(offer('manual')).versions[0]] };
    const prior = await generateCatalogue({
        source: { ...source(active, frozen, removed), resources: [manual] },
        fetchMetadata: async (resource) => metadata(resource),
    });
    const registry = { ...source(active, frozen, unpublished), resources: [manual] };
    registry.repositories[1].auto_update = false;
    registry.repositories[2].auto_update = false;
    const original = structuredClone(registry);
    const calls = [];
    const result = await generateCatalogue({
        source: registry,
        previous: prior.catalogue,
        force: true,
        fetchMetadata: async (resource) => {
            calls.push(resource.repository);
            return metadata(resource, '1.0.1', ['1.0.0']);
        },
    });
    assert.deepEqual(calls.sort(), [active.repository, frozen.repository, unpublished.repository].sort());
    assert.equal(result.checked, 3);
    assert.deepEqual(result.failures, []);
    for (const slug of ['active', 'frozen', 'unpublished'])
        assert.equal(
            result.catalogue.resources.find((resource) => resource.slug === slug).versions[0].version,
            '1.0.1',
        );
    assert.equal(
        result.catalogue.resources.some((resource) => resource.slug === 'removed'),
        false,
    );
    assert.deepEqual(
        result.catalogue.resources.find((resource) => resource.slug === 'manual'),
        prior.catalogue.resources.find((resource) => resource.slug === 'manual'),
    );
    assert.deepEqual(registry, original);
});

test('a manual bulk refresh keeps cached paused offers on failures, downgrades, or changed checksums', async () => {
    const downgrade = offer('downgrade');
    const checksum = offer('checksum');
    const unavailable = offer('unavailable');
    const prior = await generateCatalogue({
        source: source(downgrade, checksum),
        fetchMetadata: async (resource) => metadata(resource, '1.1.0'),
    });
    const registry = source(downgrade, checksum, unavailable);
    for (const registration of registry.repositories) registration.auto_update = false;
    const result = await generateCatalogue({
        source: registry,
        previous: prior.catalogue,
        repository: null,
        force: true,
        fetchMetadata: async (resource) => {
            if (resource.repository === unavailable.repository) throw new Error('Release unavailable.');
            if (resource.repository === downgrade.repository) return metadata(resource);
            const changed = metadata(resource, '1.2.0', ['1.1.0']);
            changed.versions[1].download.sha256 = 'b'.repeat(64);
            return changed;
        },
    });
    assert.equal(result.checked, 3);
    assert.deepEqual(result.catalogue, prior.catalogue);
    assert.equal(result.failures.length, 3);
    assert.equal(
        result.failures.find((failure) => failure.repository === repositoryName(unavailable.repository))
            .preserved,
        false,
    );
    assert.equal(result.failures.filter((failure) => failure.preserved).length, 2);
    assert.ok(registry.repositories.every((registration) => registration.auto_update === false));
});

test('nonboolean force values are rejected before any metadata fetch', async () => {
    for (const options of [
        { force: 'true', repository: offer().repository },
        { force: 1, repository: offer().repository },
        { force: null, repository: offer().repository },
        { force: 'true' },
    ])
        await assert.rejects(
            generateCatalogue({
                source: source(offer()),
                ...options,
                fetchMetadata: async () => assert.fail('Invalid force options must not fetch metadata.'),
            }),
            /force option/,
        );
});

test('invalid notification repository selectors are rejected before fetching metadata', async () => {
    for (const repository of [
        '',
        '../Plugin-Sample',
        'community/plugin-sample; echo injected',
        'community/plugin-sample\n',
        1,
    ])
        await assert.rejects(
            generateCatalogue({
                source: source(offer()),
                repository,
                fetchMetadata: async () => assert.fail('Invalid selectors must not fetch release metadata.'),
            }),
            /repository/,
        );
});

test('targeted publication fetches only a registered repository and preserves every other published offer', async () => {
    const first = offer('first');
    const second = offer('second');
    const prior = await generateCatalogue({
        source: source(first, second),
        fetchMetadata: async (resource) => metadata(resource, '1.0.1', ['1.0.0']),
    });
    const untouched = prior.catalogue.resources.find((resource) => resource.slug === 'second');
    untouched.versions.reverse();
    untouched.versions[0].download.sha256 = 'A'.repeat(64);
    delete untouched.manual_only;
    const calls = [];
    const result = await generateCatalogue({
        source: source(first, second),
        previous: prior.catalogue,
        repository: 'community/plugin-first',
        fetchMetadata: async (resource) => {
            calls.push(resource.repository);
            return metadata(resource, '1.0.2', ['1.0.1', '1.0.0']);
        },
    });
    assert.deepEqual(calls, [first.repository]);
    assert.equal(
        result.catalogue.resources.find((resource) => resource.slug === 'first').versions[0].version,
        '1.0.2',
    );
    assert.deepEqual(
        result.catalogue.resources.find((resource) => resource.slug === 'second'),
        prior.catalogue.resources.find((resource) => resource.slug === 'second'),
    );
    const ignored = await generateCatalogue({
        source: source(first, second),
        previous: prior.catalogue,
        repository: 'unknown/unregistered',
        fetchMetadata: async () => assert.fail('Must not request an unknown repository.'),
    });
    assert.equal(ignored.checked, 0);
    assert.deepEqual(ignored.failures, []);
    assert.deepEqual(ignored.catalogue, prior.catalogue);
});

test('a targeted refresh defers unrelated manual changes and curation removals until full reconciliation', async () => {
    const active = offer('active');
    const removed = offer('removed');
    const manual = { ...offer('manual'), versions: [metadata(offer('manual')).versions[0]] };
    const initial = { ...source(active, removed), resources: [manual] };
    const prior = await generateCatalogue({
        source: initial,
        fetchMetadata: async (resource) => metadata(resource),
    });
    const registry = { ...source(active), resources: [{ ...manual, name: { en: 'Pending manual change' } }] };
    const targeted = await generateCatalogue({
        source: registry,
        previous: prior.catalogue,
        repository: active.repository,
        fetchMetadata: async (resource) => metadata(resource, '1.0.1', ['1.0.0']),
    });
    for (const slug of ['manual', 'removed'])
        assert.deepEqual(
            targeted.catalogue.resources.find((resource) => resource.slug === slug),
            prior.catalogue.resources.find((resource) => resource.slug === slug),
        );
    const full = await generateCatalogue({
        source: registry,
        previous: targeted.catalogue,
        fetchMetadata: async (resource) => metadata(resource, '1.0.1', ['1.0.0']),
    });
    assert.equal(
        full.catalogue.resources.some((resource) => resource.slug === 'removed'),
        false,
    );
    assert.equal(
        full.catalogue.resources.find((resource) => resource.slug === 'manual').name.en,
        'Pending manual change',
    );
});

test('curation removes unregistered cached offers while keeping registered frozen and manual offers', async () => {
    const removed = offer('removed');
    const retained = offer('retained');
    const prior = await generateCatalogue({
        source: source(removed, retained),
        fetchMetadata: async (resource) => metadata(resource),
    });
    const registry = source(retained);
    registry.repositories[0].auto_update = false;
    const manual = { ...offer('manual'), versions: [metadata(offer('manual')).versions[0]] };
    registry.resources = [manual];
    const result = await generateCatalogue({
        source: registry,
        previous: prior.catalogue,
        fetchMetadata: async () => assert.fail('Only frozen and manual offers remain.'),
    });
    assert.equal(result.checked, 0);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(
        result.catalogue.resources.map((resource) => resource.slug),
        ['manual', 'retained'],
    );
    assert.deepEqual(
        result.catalogue.resources.find((resource) => resource.slug === 'retained'),
        prior.catalogue.resources.find((resource) => resource.slug === 'retained'),
    );
});

test('repository failures preserve previous versions and omit offers without a published version', async () => {
    const first = offer('first');
    const second = offer('second');
    const unavailable = offer('unavailable');
    const prior = await generateCatalogue({
        source: source(first),
        fetchMetadata: async (resource) => metadata(resource),
    });
    const result = await generateCatalogue({
        source: source(first, second, unavailable),
        previous: prior.catalogue,
        fetchMetadata: async (resource) => {
            if (resource.repository !== second.repository) throw new Error('Network unavailable.');
            return metadata(resource, '1.1.0');
        },
    });
    assert.deepEqual(
        result.catalogue.resources.map((resource) => resource.slug),
        ['first', 'second'],
    );
    assert.equal(result.failures.length, 2);
    assert.equal(
        result.failures.find((failure) => failure.repository.endsWith('plugin-first')).preserved,
        true,
    );
    assert.equal(
        result.failures.find((failure) => failure.repository.endsWith('plugin-unavailable')).preserved,
        false,
    );
});

test('a failed changed repository cannot inherit the former repository archive and full reconciliation removes unregistered offers', async () => {
    const first = offer('first');
    const second = offer('second');
    const prior = await generateCatalogue({
        source: source(first, second),
        fetchMetadata: async (resource) => metadata(resource),
    });
    first.repository = 'https://github.com/other/plugin-first';
    const result = await generateCatalogue({
        source: source(first),
        previous: prior.catalogue,
        fetchMetadata: async () => {
            throw new Error('No release.');
        },
    });
    assert.deepEqual(result.catalogue.resources, []);
});

test('untrusted metadata cannot change identity, stability, archive origin, checksums, or requirements', () => {
    const resource = offer();
    const changes = [
        (value) => {
            value.slug = 'other';
        },
        (value) => {
            value.type = 'theme';
        },
        (value) => {
            value.version = '1.0.0-beta.1';
        },
        (value) => {
            delete value.versions;
        },
        (value) => {
            value.versions = null;
        },
        (value) => {
            value.versions = [];
        },
        (value) => {
            value.versions = {};
        },
        (value) => {
            value.versions[0].download.url =
                'https://github.com/other/plugin-sample/releases/download/v1.0.0/sample-1.0.0.zip';
        },
        (value) => {
            value.versions[0].download.sha256 = 'invalid';
        },
        (value) => {
            value.versions[0].requirements.cms = 'invalid constraint';
        },
        (value) => {
            value.versions.push(value.versions[0]);
        },
        (value) => {
            value.versions[0].requirements.plugins = { 'invalid/name': '^1.0' };
        },
    ];
    for (const change of changes) {
        const value = metadata(resource);
        change(value);
        assert.throws(() => metadataVersions(value, resource));
    }
    assert.throws(() => sourceResources(source(resource, resource)), /Duplicate/);
    assert.throws(
        () => sourceResources(source({ ...resource, repository: 'https://github.com/../repo' })),
        /repository/,
    );
});

test('a latest release downgrade preserves the newest known catalogue', async () => {
    const resource = offer();
    const prior = await generateCatalogue({
        source: source(resource),
        fetchMetadata: async (value) => metadata(value, '1.1.0'),
    });
    const result = await generateCatalogue({
        source: source(resource),
        previous: prior.catalogue,
        fetchMetadata: async (value) => metadata(value),
    });
    assert.equal(result.catalogue.resources[0].versions[0].version, '1.1.0');
    assert.equal(result.failures[0].preserved, true);
});

test('catalogue versions retain direct IDs and reject malformed dependency declarations', () => {
    const resource = offer();
    const value = metadata(resource);
    assert.deepEqual(metadataVersions(value, resource)[0].requirements, value.versions[0].requirements);
    for (const invalid of [
        [],
        null,
        { cms: '^1.0' },
        { cms: '^1.0', php: '^8.3', plugins: { dependency: '^1.0' } },
        { cms: '^1.0', php: '^8.3', themes: [] },
        { cms: '^1.0', php: '^8.3', 'plugin:dependency': null },
        { cms: '^1.0', php: '^8.3', dependency: '^1.0' },
        { cms: '^1.0', php: '^8.3', 'composer:Vendor/package': '^1.0' },
        { cms: '^1.0', php: '^8.3', 'composer:vendor/package': '^1.0' },
        { cms: '^1.0', php: '^8.3', 'plugin:dependency': 'invalid constraint' },
        { cms: '^1.0', php: '^8.3', 'plugin:dependency': ' '.repeat(200) + '*' },
        { cms: '^1.0', php: '^8.3', 'invalid/id': '^1.0' },
    ]) {
        const changed = structuredClone(value);
        changed.versions[0].requirements = invalid;
        assert.throws(() => metadataVersions(changed, resource));
    }
    for (const id of ['cms', 'php']) {
        assert.doesNotThrow(() =>
            sourceResources({
                schema_version: 1,
                repositories: [],
                resources: [
                    {
                        ...offer(id),
                        versions: [metadata(offer(id)).versions[0]],
                    },
                ],
            }),
        );
    }
});

test('repository registrations contain no duplicated presentation and releases own their translated offers', async () => {
    const resource = offer();
    const registry = source(resource);
    assert.deepEqual(registry.repositories, [{ repository: resource.repository, auto_update: true }]);
    const latest = metadata(resource);
    latest.resource.name = { fr: 'Nom du paquet', en: 'Package name' };
    latest.resource.description = { fr: 'Présentation du paquet.', en: 'Package presentation.' };
    const first = await generateCatalogue({ source: registry, fetchMetadata: async () => latest });
    assert.deepEqual(first.catalogue.resources[0].name, latest.resource.name);
    latest.resource.description.fr = 'Présentation mise à jour.';
    const updated = await generateCatalogue({
        source: registry,
        previous: first.catalogue,
        fetchMetadata: async () => latest,
    });
    assert.equal(updated.catalogue.resources[0].description.fr, 'Présentation mise à jour.');
    assert.equal(updated.catalogue.resources[0].author.id, 'community');
    assert.deepEqual(registry, source(resource));
});

test('catalogues preserve raw values, independent languages and images through release refreshes', async () => {
    const resource = {
        ...offer(),
        name: 'Untranslated package name',
        description: { fr: 'Description française.', 'pt-BR': 'Descrição portuguesa.' },
        image: { fr: 'https://images.example/fr.png', 'zh-Hant-TW': 'https://images.example/zh.webp' },
    };
    const first = await generateCatalogue({ source: source(resource), fetchMetadata: async () => metadata(resource) });
    assert.equal(first.failures.length, 0);
    assert.equal(first.catalogue.resources[0].name, resource.name);
    assert.deepEqual(first.catalogue.resources[0].description, resource.description);
    assert.deepEqual(first.catalogue.resources[0].image, resource.image);
    const updated = { ...resource, image: 'https://images.example/preview.png' };
    const second = await generateCatalogue({
        source: source(resource),
        previous: first.catalogue,
        fetchMetadata: async () => metadata(updated, '1.1.0', ['1.0.0']),
    });
    assert.equal(second.failures.length, 0);
    assert.equal(second.catalogue.resources[0].image, updated.image);
    assert.deepEqual(second.catalogue.resources[0].versions.map(({ version }) => version), ['1.1.0', '1.0.0']);
    const manual = { ...resource, versions: metadata(resource).versions };
    assert.deepEqual(sourceResources({ schema_version: 1, repositories: [], resources: [manual] }).resources[0].image, resource.image);
});

test('catalogues reject invalid raw text, language dictionaries and image links', () => {
    const resource = offer();
    for (const changes of [
        { name: '' },
        { name: 'a'.repeat(121) },
        { description: {} },
        { description: { fr: '' } },
        { description: { invalid_language: 'Description' } },
        { image: {} },
        { image: { en: null } },
        { image: 'http://images.example/preview.png' },
        { image: 'https://user:password@images.example/preview.png' },
        { image: 'https://images.example/preview.png?token=value' },
        { image: 'https://images.example/preview.png?' },
        { image: 'https://images.example/preview.png#fragment' },
        { image: 'https://images.example/preview.png#' },
        { image: 'https://images.example:443/preview.png' },
        { image: 'preview.png' },
        { image: 'https://images.example/preview image.png' },
        { image: 'https://images.example/' + 'a'.repeat(2048) },
    ]) {
        const manual = { ...resource, ...changes, versions: metadata(resource).versions };
        assert.throws(() => sourceResources({ schema_version: 1, repositories: [], resources: [manual] }));
    }
});

test('manual external offers publish prices and compatibility without a GitHub repository or archive', async () => {
    const resource = offer('external');
    delete resource.repository;
    resource.commercial = {
        kind: 'paid',
        url: 'https://creator.example/products/external',
        price: { amount: '12.50', currency: 'EUR' },
    };
    resource.versions = [{ version: '1.0.0', requirements: { cms: '^1.0', php: '^8.3' } }];
    const registry = { schema_version: 1, repositories: [], resources: [resource] };
    const result = await generateCatalogue({
        source: registry,
        fetchMetadata: async () => {
            throw new Error('Manual offers must not fetch releases.');
        },
    });
    assert.equal(result.checked, 0);
    assert.equal(result.failures.length, 0);
    assert.equal(result.catalogue.resources[0].manual_only, true);
    assert.deepEqual(result.catalogue.resources[0].commercial, resource.commercial);
    assert.equal(result.catalogue.resources[0].versions[0].download, undefined);
    for (const price of [
        { amount: '-1', currency: 'EUR' },
        { amount: 'NaN', currency: 'EUR' },
        { amount: 5, currency: 'EUR' },
        { amount: '1.00', currency: 'eur' },
    ]) {
        await assert.rejects(
            generateCatalogue({
                source: {
                    ...registry,
                    resources: [{ ...resource, commercial: { ...resource.commercial, price } }],
                },
            }),
            /price/,
        );
    }
});

test('repository owners outside CMS identity syntax receive a deterministic author prefix', async () => {
    const resource = offer();
    resource.repository = 'https://github.com/7/plugin-sample';
    resource.id = 'github-7/sample';
    resource.author.id = 'github-7';
    const result = await generateCatalogue({
        source: source(resource),
        fetchMetadata: async () => metadata(resource),
    });
    assert.equal(result.failures.length, 0);
    assert.equal(result.catalogue.resources[0].id, 'github-7/sample');
});

test('release descriptions cannot impersonate another repository owner or change an installed package identity', async () => {
    const resource = offer();
    const prior = await generateCatalogue({
        source: source(resource),
        fetchMetadata: async () => metadata(resource),
    });
    const changes = [
        (value) => {
            value.resource.repository = 'https://github.com/other/plugin-sample';
        },
        (value) => {
            value.resource.author.id = 'other';
            value.resource.id = 'other/sample';
        },
        (value) => {
            value.resource.name = { en: '' };
        },
        (value) => {
            value.resource.id = 'community/renamed';
            value.resource.slug = 'renamed';
            value.slug = 'renamed';
        },
    ];
    for (const change of changes) {
        const latest = metadata(resource);
        change(latest);
        const result = await generateCatalogue({
            source: source(resource),
            previous: prior.catalogue,
            fetchMetadata: async () => latest,
        });
        assert.deepEqual(result.catalogue, prior.catalogue);
        assert.equal(result.failures[0].preserved, true);
    }
});

test('the checksum of an already published version is immutable in the catalogue', async () => {
    const resource = offer();
    const prior = await generateCatalogue({
        source: source(resource),
        fetchMetadata: async (value) => metadata(value),
    });
    const changed = metadata(resource);
    changed.versions[0].download.sha256 = 'b'.repeat(64);
    const result = await generateCatalogue({
        source: source(resource),
        previous: prior.catalogue,
        fetchMetadata: async () => changed,
    });
    assert.deepEqual(result.catalogue, prior.catalogue);
    assert.equal(result.failures[0].preserved, true);
});

test('generation is byte stable and does not mutate its source or previous catalogue', async () => {
    const resource = offer();
    const registry = source(resource);
    const first = await generateCatalogue({
        source: registry,
        fetchMetadata: async () => metadata(resource),
    });
    const originalSource = structuredClone(registry);
    const originalCatalogue = structuredClone(first.catalogue);
    const second = await generateCatalogue({
        source: registry,
        previous: first.catalogue,
        fetchMetadata: async () => metadata(resource),
    });
    assert.equal(second.bytes, first.bytes);
    assert.deepEqual(JSON.parse(second.bytes), second.catalogue);
    assert.deepEqual(registry, originalSource);
    assert.deepEqual(first.catalogue, originalCatalogue);
});

test('size reduction preserves frozen or untargeted history and fails when it cannot fit', () => {
    const frozen = offer('frozen');
    frozen.versions = metadataVersions(metadata(frozen, '1.1.0', ['1.0.1', '1.0.0']), frozen);
    const active = offer('active');
    active.versions = metadataVersions(metadata(active, '1.1.0', ['1.0.1', '1.0.0']), active);
    const catalogue = { schema_version: 1, resources: [frozen, active] };
    const minimal = structuredClone(catalogue);
    minimal.resources[1].versions = [minimal.resources[1].versions[0]];
    const limit = Buffer.byteLength(JSON.stringify(minimal, null, 4) + '\n');
    const reduced = encodeCatalogue(catalogue, limit, new Set([frozen.id]));
    assert.deepEqual(reduced.catalogue.resources[0], frozen);
    assert.equal(reduced.catalogue.resources[1].versions.length, 1);
    assert.equal(active.versions.length, 3);
    assert.throws(
        () => encodeCatalogue(catalogue, limit - 1, new Set([frozen.id])),
        /latest published versions/,
    );
});

test('history is trimmed to the CMS feed limit while keeping the latest version of every offer', () => {
    const resources = Array.from({ length: 50 }, (_, index) => {
        const resource = offer(`package-${index}`);
        resource.versions = metadataVersions(
            metadata(
                resource,
                '2.0.0',
                Array.from({ length: 99 }, (__, number) => `1.0.${98 - number}`),
            ),
            resource,
        );
        return resource;
    });
    const result = encodeCatalogue({ schema_version: 1, resources });
    assert.ok(Buffer.byteLength(result.bytes) <= 2097152);
    assert.equal(result.catalogue.resources.length, 50);
    assert.ok(result.catalogue.resources.every((resource) => resource.versions[0].version === '2.0.0'));
    assert.ok(result.catalogue.resources.some((resource) => resource.versions.length < 100));
    assert.throws(
        () =>
            encodeCatalogue(
                { schema_version: 1, resources: [{ ...offer(), versions: [metadata(offer()).versions[0]] }] },
                50,
            ),
        /latest published versions/,
    );
});

test('release metadata follows only bounded HTTPS redirects for the same repository or GitHub CDN', async () => {
    const resource = offer();
    for (const target of [
        resource.repository + '/releases/download/v1.0.0/kraftink-extension.json',
        'https://release-assets.githubusercontent.com/path?signature=temporary',
    ]) {
        let requests = 0;
        const value = await fetchReleaseMetadata(resource, async () =>
            ++requests === 1
                ? new Response('', { status: 302, headers: { location: target } })
                : Response.json(metadata(resource)),
        );
        assert.equal(value.version, '1.0.0');
    }
    for (const target of [
        'https://evil.example/metadata',
        'https://github.com/other/repo/releases/download/v1.0.0/kraftink-extension.json',
        'http://release-assets.githubusercontent.com/path',
        'https://user:password@release-assets.githubusercontent.com/path',
    ]) {
        await assert.rejects(
            fetchReleaseMetadata(
                resource,
                async () => new Response('', { status: 302, headers: { location: target } }),
            ),
            /Untrusted/,
        );
    }
    await assert.rejects(
        fetchReleaseMetadata(resource, async () => new Response(' '.repeat(262145))),
        /size limit/,
    );
});
