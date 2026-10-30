const catalogueLimit = 2097152;
const metadataLimit = 262144;
const slugPattern = /^[a-z][a-z0-9-]{1,49}$/;
const repositoryPattern = /^([A-Za-z0-9_-][A-Za-z0-9_.-]*)\/([A-Za-z0-9_-][A-Za-z0-9_.-]*)$/;

export function repositoryName(value) {
    if (typeof value !== 'string') {
        throw new Error('A GitHub repository is required.');
    }
    const name = value.replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
    if (!repositoryPattern.test(name) || name.endsWith('.git')) {
        throw new Error('Invalid public GitHub repository.');
    }
    return name;
}

function translations(value, maximum) {
    if (typeof value === 'string') {
        if (!value.trim() || [...value].length > maximum) {
            throw new Error('Invalid catalogue text.');
        }
        return;
    }
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        !Object.keys(value).length ||
        Object.keys(value).length > 100
    ) {
        throw new Error('Catalogue values require text or a nonempty language dictionary.');
    }
    for (const [locale, text] of Object.entries(value)) {
        if (
            locale.length > 35 ||
            !/^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/.test(locale) ||
            typeof text !== 'string' ||
            !text.trim() ||
            [...text].length > maximum
        ) {
            throw new Error('Invalid catalogue translation.');
        }
    }
}

function publicUrl(value) {
    if (typeof value !== 'string' || value.length > 2048 || !/^https:\/\/(?:\[[^\]]+\]|[^/:?#]+)(?:\/|$)/i.test(value) || /[\x00-\x20\x7f"'<>`\\?#]/.test(value)) {
        throw new Error('Catalogue links require plain HTTPS URLs.');
    }
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) {
        throw new Error('Catalogue links require plain HTTPS URLs.');
    }
    return value;
}

export function validatePresentation(value, localImages = false) {
    translations(value.name, 120);
    translations(value.description, 1000);
    if (value.image !== undefined) {
        translations(value.image, 2048);
        for (const image of typeof value.image === 'string' ? [value.image] : Object.values(value.image)) {
            if (localImages && !/^https:/i.test(image)) {
                if (!/^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp|gif|avif)$/i.test(image)) {
                    throw new Error('Market images require a safe path inside resources/market or a plain HTTPS URL.');
                }
            } else {
                publicUrl(image);
            }
        }
    }
}

function resourceOffer(value, registeredRepository = null) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Invalid resource offer.');
    }
    const identity = typeof value.id === 'string' ? value.id.split('/') : [];
    if (
        identity.length !== 2 ||
        !identity.every((part) => slugPattern.test(part)) ||
        value.slug !== identity[1] ||
        !['plugin', 'theme', 'game'].includes(value.type) ||
        value.author?.id !== identity[0] ||
        typeof value.author.name !== 'string' ||
        !value.author.name.trim() ||
        [...value.author.name].length > 120 ||
        !['free', 'paid'].includes(value.commercial?.kind)
    ) {
        throw new Error('Invalid resource identity or commercial offer.');
    }
    validatePresentation(value);
    if (value.author.url !== undefined) publicUrl(value.author.url);
    if (value.commercial.url !== undefined) publicUrl(value.commercial.url);
    const repository = value.repository === undefined ? null : repositoryName(value.repository);
    if (registeredRepository !== null) {
        const registered = repositoryName(registeredRepository);
        const owner = registered.split('/')[0].toLowerCase();
        const author = slugPattern.test(owner) ? owner : `github-${owner}`;
        if (repository?.toLowerCase() !== registered.toLowerCase() || identity[0] !== author) {
            throw new Error('The release offer does not belong to the registered repository owner.');
        }
    }
    if (value.commercial.price !== undefined) {
        const price = value.commercial.price;
        if (
            !price ||
            typeof price !== 'object' ||
            Array.isArray(price) ||
            typeof price.amount !== 'string' ||
            !/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/.test(price.amount) ||
            typeof price.currency !== 'string' ||
            !/^[A-Z]{3}$/.test(price.currency)
        ) {
            throw new Error('Invalid informational package price.');
        }
    }
    const manual = value.manual_only ?? value.commercial.kind === 'paid';
    if (typeof manual !== 'boolean') {
        throw new Error('manual_only must be a boolean.');
    }
    return {
        id: value.id,
        slug: value.slug,
        type: value.type,
        name: value.name,
        description: value.description,
        ...(value.image !== undefined ? { image: value.image } : {}),
        author: value.author,
        ...(repository ? { repository: `https://github.com/${repository}` } : {}),
        commercial: value.commercial,
        manual_only: manual,
    };
}

export function sourceResources(source) {
    const repositories = source?.repositories ?? [];
    const resources = source?.resources ?? [];
    if (
        source?.schema_version !== 1 ||
        !Array.isArray(repositories) ||
        !Array.isArray(resources) ||
        repositories.length + resources.length > 1000
    ) {
        throw new Error('Invalid resource registry schema or size.');
    }
    const seen = new Set();
    const registered = repositories.map((value) => {
        if (
            !value ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            Object.keys(value).sort().join(',') !== 'auto_update,repository' ||
            typeof value.auto_update !== 'boolean'
        ) {
            throw new Error('Repository registrations require repository and a boolean auto_update.');
        }
        const name = repositoryName(value.repository);
        if (seen.has(name.toLowerCase())) {
            throw new Error('Duplicate registered repository.');
        }
        seen.add(name.toLowerCase());
        return { repository: `https://github.com/${name}`, auto_update: value.auto_update };
    });
    const manual = catalogueResources({ schema_version: 1, resources });
    if (
        manual.some(
            (resource) => resource.repository && seen.has(repositoryName(resource.repository).toLowerCase()),
        )
    ) {
        throw new Error('A repository cannot be both automatic and manual.');
    }
    return { repositories: registered, resources: manual };
}

function stableVersion(value) {
    if (
        typeof value !== 'string' ||
        !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) ||
        value.split('.').some((part) => !Number.isSafeInteger(Number(part)))
    ) {
        throw new Error('Only stable X.Y.Z versions are accepted.');
    }
    return value;
}

function compareVersions(left, right) {
    const a = left.split('.').map(Number);
    const b = right.split('.').map(Number);
    for (let index = 0; index < 3; index++) {
        if (a[index] !== b[index]) return a[index] - b[index];
    }
    return 0;
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
        groups.some((group) => {
            const parts = group.replace(/\s+-\s+/g, ' ').split(/[\s,]+/);
            return !parts.length || parts.some((part) => !token.test(part));
        })
    ) {
        throw new Error('Unsupported package compatibility constraint.');
    }
    return value;
}

function versionEntry(value, resource, strictArchive = false) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid release version entry.');
    const version = stableVersion(value.version);
    const requirements = value.requirements;
    if (!requirements || typeof requirements !== 'object' || Array.isArray(requirements))
        throw new Error('Missing release requirements.');
    constraint(requirements.cms);
    constraint(requirements.php);
    for (const [slug, requirement] of Object.entries(requirements)) {
        if (!['cms', 'php'].includes(slug) && !/^(?:plugin|theme|game):[a-z][a-z0-9-]{1,49}$/.test(slug)) {
            throw new Error('Invalid dependency identity.');
        }
        constraint(requirement);
    }
    if (resource.manual_only && value.download === undefined) {
        return { version, requirements };
    }
    publicUrl(value.download?.url);
    if (!/^[a-f0-9]{64}$/i.test(value.download?.sha256)) {
        throw new Error('Invalid release archive checksum.');
    }
    if (!strictArchive) {
        const download = new URL(value.download.url);
        const github =
            download.hostname === 'github.com' &&
            /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/download\/[^/]+\/[^/]+\.zip$/.test(
                download.pathname,
            );
        const archive =
            download.hostname === 'github.com' &&
            /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/archive\/refs\/(?:tags|heads)\/.+\.zip$/.test(
                download.pathname,
            );
        const codeload =
            download.hostname === 'codeload.github.com' &&
            /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/zip\/refs\/(?:tags|heads)\/.+/.test(download.pathname);
        if (!github && !archive && !codeload) {
            throw new Error('Automatic downloads require a supported GitHub archive.');
        }
        return {
            version,
            requirements,
            download: { url: value.download.url, sha256: value.download.sha256.toLowerCase() },
        };
    }
    const repository = repositoryName(resource.repository);
    const expected = `/releases/download/v${version}/${resource.slug}-${version}.zip`;
    const url = new URL(value.download?.url);
    const parts = url.pathname.split('/');
    if (
        url.origin !== 'https://github.com' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        `${parts[1]}/${parts[2]}`.toLowerCase() !== repository.toLowerCase() ||
        '/' + parts.slice(3).join('/') !== expected ||
        !/^[a-f0-9]{64}$/i.test(value.download?.sha256)
    ) {
        throw new Error('Release archive identity or checksum mismatch.');
    }
    return {
        version,
        requirements,
        download: { url: value.download.url, sha256: value.download.sha256.toLowerCase() },
    };
}

export function metadataVersions(metadata, resource) {
    if (metadata?.schema_version !== 1 || metadata.slug !== resource.slug || metadata.type !== resource.type)
        throw new Error('Release metadata identity mismatch.');
    stableVersion(metadata.version);
    const entries = metadata.versions;
    if (!Array.isArray(entries) || !entries.length || entries.length > 100)
        throw new Error('Invalid release version history.');
    const seen = new Set();
    const versions = entries
        .map((entry) => {
            const version = versionEntry(entry, resource, true);
            if (seen.has(version.version)) throw new Error('Duplicate release version.');
            seen.add(version.version);
            return version;
        })
        .sort((a, b) => compareVersions(b.version, a.version));
    if (versions[0].version !== metadata.version)
        throw new Error('The current release must be the newest stable version.');
    return versions;
}

function catalogueResources(catalogue) {
    if (
        catalogue?.schema_version !== 1 ||
        !Array.isArray(catalogue.resources) ||
        catalogue.resources.length > 1000
    ) {
        throw new Error('Invalid catalogue schema or size.');
    }
    const ids = new Set();
    return catalogue.resources.map((raw) => {
        const resource = resourceOffer(raw);
        if (ids.has(resource.id)) throw new Error('Duplicate catalogue resource identity.');
        ids.add(resource.id);
        if (!Array.isArray(raw.versions) || !raw.versions.length || raw.versions.length > 100)
            throw new Error('Invalid existing catalogue versions.');
        const versions = raw.versions
            .map((entry) => versionEntry(entry, resource))
            .sort((a, b) => compareVersions(b.version, a.version));
        if (new Set(versions.map((entry) => entry.version)).size !== versions.length)
            throw new Error('Duplicate catalogue version.');
        return { ...resource, versions };
    });
}

export function encodeCatalogue(catalogue, limit = catalogueLimit, preserved = new Set()) {
    const output = structuredClone(catalogue);
    let bytes = JSON.stringify(output, null, 4) + '\n';
    let size = Buffer.byteLength(bytes);
    let candidates = output.resources.filter(
        (resource) => resource.versions.length > 1 && !preserved.has(resource.id),
    );
    while (size > limit && candidates.length) {
        const next = [];
        for (const resource of candidates) {
            if (size <= limit) break;
            const removed = JSON.stringify(resource.versions.pop(), null, 4);
            size -= Buffer.byteLength(removed) + 16 * removed.split('\n').length + 2;
            if (resource.versions.length > 1) next.push(resource);
        }
        candidates = next;
    }
    bytes = JSON.stringify(output, null, 4) + '\n';
    if (Buffer.byteLength(bytes) > limit)
        throw new Error('The latest published versions exceed the 2 MiB catalogue limit.');
    return { catalogue: output, bytes };
}

export async function generateCatalogue({
    source,
    previous = { schema_version: 1, resources: [] },
    repository = null,
    force = false,
    fetchMetadata = fetchReleaseMetadata,
}) {
    if (typeof force !== 'boolean') throw new Error('The force option must be a boolean.');
    const registry = sourceResources(source);
    const prior = catalogueResources(previous);
    const target = repository === null ? null : repositoryName(repository).toLowerCase();
    const selected = registry.repositories.filter(
        (resource) =>
            (resource.auto_update || force) &&
            (!target || repositoryName(resource.repository).toLowerCase() === target),
    );
    const keyFor = (resource) =>
        resource.repository ? repositoryName(resource.repository).toLowerCase() : null;
    const registered = new Set(registry.repositories.map(keyFor));
    const manualIds = new Set(registry.resources.map((resource) => resource.id));
    const old = new Map();
    for (const resource of prior) {
        const key = keyFor(resource);
        if (key && registered.has(key) && !manualIds.has(resource.id)) {
            if (old.has(key)) throw new Error('Duplicate automatic repository in the existing catalogue.');
            old.set(key, resource);
        }
    }
    const snapshots = new Map(previous.resources.map((resource) => [resource.id, resource]));
    const untouched = target
        ? previous.resources
              .filter((resource) => !selected.length || keyFor(resource) !== target)
              .map((resource) => structuredClone(resource))
        : registry.resources;
    const result = new Map();
    const preserved = new Set(target ? untouched.map((resource) => resource.id) : []);
    if (target && selected.length && old.has(target)) {
        result.set(target, structuredClone(snapshots.get(old.get(target).id)));
    }
    for (const registration of registry.repositories) {
        const key = keyFor(registration);
        const existing = old.get(key);
        if (!target && !force && !registration.auto_update && existing) {
            result.set(key, structuredClone(snapshots.get(existing.id)));
            preserved.add(existing.id);
        }
    }
    const failures = [];
    let offset = 0;
    const workers = Array.from({ length: Math.min(6, selected.length) }, async () => {
        while (offset < selected.length) {
            const registration = selected[offset++];
            const key = keyFor(registration);
            const existing = old.get(key);
            try {
                const metadata = await fetchMetadata(registration);
                const resource = resourceOffer(metadata?.resource, registration.repository);
                if (existing && (resource.id !== existing.id || resource.type !== existing.type)) {
                    throw new Error('The published package identity changed.');
                }
                const versions = metadataVersions(metadata, resource);
                if (existing && compareVersions(versions[0].version, existing.versions[0].version) < 0) {
                    throw new Error('The published release would downgrade the existing catalogue.');
                }
                if (existing) {
                    for (const entry of versions) {
                        const known = existing.versions.find(
                            (previousVersion) => previousVersion.version === entry.version,
                        );
                        if (known && known.download?.sha256 !== entry.download?.sha256)
                            throw new Error('A previously published archive checksum changed.');
                    }
                }
                result.set(key, { ...resource, versions });
            } catch {
                if (existing) result.set(key, existing);
                else result.delete(key);
                failures.push({
                    repository: repositoryName(registration.repository),
                    preserved: Boolean(existing),
                });
            }
        }
    });
    await Promise.all(workers);
    const resources = [...result.values(), ...untouched].sort((a, b) => a.id.localeCompare(b.id, 'en'));
    if (new Set(resources.map((resource) => resource.id)).size !== resources.length) {
        throw new Error('Duplicate generated resource identity.');
    }
    if (resources.length > 1000) throw new Error('The generated catalogue exceeds 1000 resources.');
    const encoded = encodeCatalogue({ schema_version: 1, resources }, catalogueLimit, preserved);
    return {
        ...encoded,
        failures: failures.sort((a, b) => a.repository.localeCompare(b.repository, 'en')),
        checked: selected.length,
    };
}

async function responseBytes(response, limit = metadataLimit) {
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit))
        throw new Error('Response exceeds its size limit.');
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body ?? []) {
        total += chunk.length;
        if (total > limit) throw new Error('Response exceeds its size limit.');
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

export async function fetchReleaseMetadata(resource, transport = fetch) {
    const repository = repositoryName(resource.repository);
    let url = new URL(`https://github.com/${repository}/releases/latest/download/kraftink-extension.json`);
    const signal = AbortSignal.timeout(15000);
    for (let redirects = 0; redirects <= 3; redirects++) {
        const response = await transport(url, {
            headers: { Accept: 'application/json', 'User-Agent': 'KraftInk-Market' },
            redirect: 'manual',
            signal,
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel();
            const location = response.headers.get('location');
            const next = new URL(location ?? '', url);
            const prefix = `/${repository}/releases/download/`;
            const github =
                next.hostname === 'github.com' &&
                next.pathname.toLowerCase().startsWith(prefix.toLowerCase()) &&
                /^v\d+\.\d+\.\d+\/kraftink-extension\.json$/.test(next.pathname.slice(prefix.length)) &&
                !next.search;
            const cdn = ['objects.githubusercontent.com', 'release-assets.githubusercontent.com'].includes(
                next.hostname,
            );
            if (
                !location ||
                redirects === 3 ||
                next.protocol !== 'https:' ||
                next.port ||
                next.username ||
                next.password ||
                next.hash ||
                (!github && !cdn)
            )
                throw new Error('Untrusted release metadata redirect.');
            url = next;
            continue;
        }
        if (response.status !== 200) throw new Error('No complete public release metadata is available.');
        return JSON.parse((await responseBytes(response)).toString('utf8'));
    }
    throw new Error('Too many release metadata redirects.');
}
