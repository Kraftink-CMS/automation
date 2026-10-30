import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReleaseNotes, normalizeReleaseNotes } from './notes.mjs';
import { createGitHubClient } from './github-client.mjs';
import { compareVersions, planVersion, stableVersion } from './version.mjs';

export { createGitHubClient, githubTransport } from './github-client.mjs';

const archiveLimit = 536870912;
const validSha = (value) => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const validDigest = (value) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);

async function fileBytes(path, limit) {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > limit) {
        throw new Error('Release assets must be bounded regular files.');
    }
    const bytes = await readFile(path);
    if (bytes.length !== stat.size || bytes.length > limit) {
        throw new Error('Release asset changed while reading.');
    }
    return bytes;
}

function assertAsset(asset) {
    if (
        !asset ||
        !Number.isSafeInteger(asset.id) ||
        asset.id < 1 ||
        !Number.isSafeInteger(asset.size) ||
        asset.size < 1 ||
        asset.size > archiveLimit ||
        asset.state !== 'uploaded' ||
        !validDigest(asset.digest)
    ) {
        throw new Error('GitHub asset has no verifiable SHA-256 digest or is incomplete.');
    }
}

export async function localBundle(plan, directory) {
    stableVersion(plan.version);
    if (
        plan.schema !== 1 ||
        plan.mode !== 'stable' ||
        plan.branch !== 'master' ||
        plan.tag !== `v${plan.version}` ||
        !validSha(plan.sha)
    ) {
        throw new Error('A stable master release plan is required.');
    }
    const root = await realpath(directory);
    const bundle = JSON.parse((await fileBytes(resolve(root, 'bundle.json'), 65536)).toString('utf8'));
    if (
        bundle.version !== plan.version ||
        bundle.sha !== plan.sha ||
        !Array.isArray(bundle.assets) ||
        !bundle.assets.length ||
        bundle.assets.length > 100
    ) {
        throw new Error('The asset bundle does not match the release plan.');
    }
    const names = new Set();
    const assets = [];
    for (const asset of bundle.assets) {
        if (
            !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(asset.name) ||
            asset.name === 'bundle.json' ||
            names.has(asset.name) ||
            !/^[a-f0-9]{64}$/.test(asset.sha256)
        ) {
            throw new Error('Invalid or duplicate bundle asset.');
        }
        names.add(asset.name);
        const path = resolve(root, asset.name);
        const stat = await lstat(path);
        if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.size !== asset.size ||
            stat.size < 1 ||
            stat.size > archiveLimit
        ) {
            throw new Error('A release asset is missing or changed.');
        }
        const digest = createHash('sha256');
        for await (const bytes of createReadStream(path)) {
            digest.update(bytes);
        }
        if (digest.digest('hex') !== asset.sha256) {
            throw new Error('A release asset checksum does not match its bundle.');
        }
        assets.push({ ...asset, path });
    }
    return assets;
}

async function identity(plan, client) {
    const sha = await client.tag(plan.tag);
    if (sha && sha !== plan.sha) {
        throw new Error('The GitHub release tag points to another commit.');
    }
    const release = await client.release(plan.tag);
    if (
        release &&
        (!sha || release.tag_name !== plan.tag || release.prerelease !== false || typeof release.draft !== 'boolean')
    ) {
        throw new Error('The GitHub release does not match its stable commit tag.');
    }
    return { sha, release };
}

async function requireParent(plan, client) {
    if (!plan.base_tag) {
        return;
    }
    const parent = await client.release(plan.base_tag);
    if (
        !parent ||
        parent.draft !== false ||
        parent.prerelease !== false ||
        parent.tag_name !== plan.base_tag ||
        !(await client.tag(plan.base_tag))
    ) {
        throw new Error('Resume the previous incomplete release before publishing another version.');
    }
}

async function requireDraft(release, client) {
    const current = await client.request('GET', `/releases/${release.id}`);
    if (
        !current ||
        current.id !== release.id ||
        current.tag_name !== release.tag_name ||
        current.draft !== true ||
        current.prerelease !== false
    ) {
        throw new Error('The release is no longer a matching mutable draft.');
    }
    return current;
}

function matchAssets(local, remote, required) {
    const mapped = new Map();
    for (const asset of local) {
        const matches = remote.filter((entry) => entry.name === asset.name);
        if (matches.length > 1 || (required && matches.length !== 1)) {
            throw new Error('Published assets are missing or ambiguous.');
        }
        if (matches.length) {
            mapped.set(asset.name, matches[0]);
        }
    }
    return mapped;
}

function verifiedAssets(local, remote) {
    const mapped = matchAssets(local, remote, true);
    for (const asset of local) {
        const entry = mapped.get(asset.name);
        assertAsset(entry);
        if (entry.size !== asset.size || entry.digest !== `sha256:${asset.sha256}`) {
            throw new Error('Published assets differ from the local bundle and cannot be replaced.');
        }
    }
}

export async function inspectRelease({ plan, client, directory }) {
    const { sha, release } = await identity(plan, client);
    if (release?.draft === false) {
        if (!directory) {
            throw new Error('A local bundle is required to verify a published release.');
        }
        verifiedAssets(await localBundle(plan, directory), await client.assets(release));
    }
    return {
        complete: release?.draft === false,
        tag_exists: sha !== null,
        draft: release?.draft === true,
        version: plan.version,
    };
}

export async function publishAssets({
    plan, directory, client, title = 'Release', body = null, root = null, repository = null,
    notes = {}, beforeMutation = async () => {},
}) {
    const local = await localBundle(plan, directory);
    let { sha, release } = await identity(plan, client);
    if (release && release.draft === false) {
        verifiedAssets(local, await client.assets(release));
        return { complete: true, published: false, version: plan.version };
    }
    if (body === null) {
        body = root !== null || repository !== null
            ? await buildReleaseNotes({ root, repository, sha: plan.sha, previousTag: plan.base_tag,
                ...normalizeReleaseNotes(notes) })
            : '';
    }
    if (typeof body !== 'string' || Buffer.byteLength(body) > 20480
            || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body)) {
        throw new Error('The release body must contain at most 20480 UTF-8 bytes without control characters.');
    }
    await requireParent(plan, client);
    if (!sha) {
        if (!plan.create_tag) {
            throw new Error('The existing release tag is missing remotely.');
        }
        await beforeMutation('tag');
        await client.request('POST', '/git/refs', { ref: `refs/tags/${plan.tag}`, sha: plan.sha }, 201);
        if ((await client.tag(plan.tag)) !== plan.sha) {
            throw new Error('The new tag does not match the release commit.');
        }
    }
    if (!release) {
        await beforeMutation('draft');
        release = await client.request(
            'POST',
            '/releases',
            {
                tag_name: plan.tag,
                target_commitish: plan.sha,
                name: `${title} ${plan.version}`,
                body,
                draft: true,
                prerelease: false,
                make_latest: 'false',
                generate_release_notes: false,
            },
            201,
        );
    }
    if ((await requireDraft(release, client)).body !== body) {
        await beforeMutation('notes');
        await requireDraft(release, client);
        await client.request('PATCH', `/releases/${release.id}`, { body });
        if ((await requireDraft(release, client)).body !== body) {
            throw new Error('GitHub did not confirm the prepared release notes.');
        }
    }
    const remote = matchAssets(local, await client.assets(release), false);
    for (const asset of local) {
        const existing = remote.get(asset.name);
        if (
            existing?.state === 'uploaded' &&
            existing.size === asset.size &&
            existing.digest === `sha256:${asset.sha256}`
        ) {
            continue;
        }
        await requireDraft(release, client);
        if (existing) {
            if (!Number.isSafeInteger(existing.id) || existing.id < 1) {
                throw new Error('Invalid draft asset identifier.');
            }
            await client.request('DELETE', `/releases/assets/${existing.id}`, undefined, 204);
        }
        await client.upload(release, asset);
    }
    verifiedAssets(local, await client.assets(release));
    if ((await client.tag(plan.tag)) !== plan.sha) {
        throw new Error('The release tag changed before publication.');
    }
    await requireParent(plan, client);
    if ((await requireDraft(release, client)).body !== body) {
        throw new Error('The draft release notes changed before publication.');
    }
    const latest = await client.request('GET', '/releases/latest');
    if (latest && (latest.draft !== false || latest.prerelease !== false || !latest.tag_name?.startsWith('v'))) {
        throw new Error('Invalid latest stable release.');
    }
    const makeLatest = !latest || compareVersions(plan.version, latest.tag_name.slice(1)) >= 0;
    await beforeMutation('publish');
    const published = await client.request('PATCH', `/releases/${release.id}`, {
        draft: false,
        prerelease: false,
        make_latest: makeLatest ? 'true' : 'false',
    });
    if (
        published.id !== release.id ||
        published.draft !== false ||
        published.prerelease !== false ||
        published.tag_name !== plan.tag
    ) {
        throw new Error('GitHub did not confirm the stable release publication.');
    }
    return { complete: true, published: true, version: plan.version };
}

async function main() {
    const [planPath, directory] = process.argv.slice(2);
    if (!planPath || !directory || process.argv.length !== 4 || process.env.GITHUB_REF !== 'refs/heads/master') {
        throw new Error('Usage: publish.mjs <plan.json> <assets-directory> on the master workflow ref.');
    }
    const plan = JSON.parse((await fileBytes(resolve(planPath), 65536)).toString('utf8'));
    const current = await planVersion({ version: plan.version });
    if (JSON.stringify(current) !== JSON.stringify(plan)) {
        throw new Error('The release plan no longer matches the checkout.');
    }
    const client = createGitHubClient({
        repository: process.env.GITHUB_REPOSITORY,
        token: process.env.GITHUB_TOKEN,
    });
    const result = await publishAssets({
        plan,
        directory,
        client,
        root: process.cwd(),
        repository: process.env.GITHUB_REPOSITORY,
        notes: normalizeReleaseNotes({ mode: process.env.RELEASE_NOTES_MODE || 'auto',
            message: process.env.RELEASE_NOTES || '' }),
        title: process.env.GITHUB_REPOSITORY.split('/')[1],
    });
    process.stdout.write(JSON.stringify(result) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`Publication failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}
