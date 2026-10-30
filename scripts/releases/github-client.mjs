import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';

const archiveLimit = 536870912;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
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

async function responseBytes(response, limit) {
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
        throw new Error('GitHub response exceeds its size limit.');
    }
    const chunks = [];
    let size = 0;
    if (response.body) {
        for await (const chunk of response.body) {
            size += chunk.length;
            if (size > limit) {
                throw new Error('GitHub response exceeds its size limit.');
            }
            chunks.push(Buffer.from(chunk));
        }
    }
    return Buffer.concat(chunks);
}

export async function githubTransport({ method, url, headers, body, limit = 8388608, binary = false }) {
    let target = new URL(url);
    if (
        target.protocol !== 'https:' ||
        target.port ||
        target.username ||
        target.password ||
        !['api.github.com', 'uploads.github.com'].includes(target.hostname)
    ) {
        throw new Error('Only public GitHub API endpoints are allowed.');
    }
    let requestHeaders = { ...headers };
    for (let redirects = 0; redirects <= 3; redirects++) {
        const response = await fetch(target, {
            method,
            headers: requestHeaders,
            body,
            redirect: 'manual',
            signal: AbortSignal.timeout(60000),
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel();
            if (!binary || method !== 'GET' || redirects === 3) {
                throw new Error('Unexpected GitHub redirect.');
            }
            const location = response.headers.get('location');
            const next = new URL(location ?? '', target);
            if (
                !location ||
                next.protocol !== 'https:' ||
                next.port ||
                next.username ||
                next.password ||
                ![
                    'github.com',
                    'objects.githubusercontent.com',
                    'release-assets.githubusercontent.com',
                    'github-releases.githubusercontent.com',
                ].includes(next.hostname)
            ) {
                throw new Error('Unsafe GitHub download redirect.');
            }
            requestHeaders = {
                Accept: 'application/octet-stream',
                'User-Agent': 'KraftInk-Release',
            };
            target = next;
            continue;
        }
        return {
            status: response.status,
            body: await responseBytes(response, limit),
        };
    }
    throw new Error('Too many GitHub redirects.');
}

export function createGitHubClient({ repository, token, transport = githubTransport }) {
    if (
        typeof repository !== 'string' ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
        repository.split('/').some((part) => part === '.' || part === '..')
    ) {
        throw new Error('GITHUB_REPOSITORY must identify one GitHub repository.');
    }
    if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) {
        throw new Error('GITHUB_TOKEN is required.');
    }
    const base = `https://api.github.com/repos/${repository}`;
    const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'KraftInk-Release',
        'X-GitHub-Api-Version': '2022-11-28',
    };
    const request = async (method, path, json, expected = 200) => {
        const response = await transport({
            method,
            url: base + path,
            headers: {
                ...headers,
                ...(json ? { 'Content-Type': 'application/json' } : {}),
            },
            body: json ? Buffer.from(JSON.stringify(json)) : undefined,
        });
        if (response.status === 404 && method === 'GET') {
            return null;
        }
        if (response.status !== expected) {
            const error = new Error(`GitHub ${method} request failed with status ${response.status}.`);
            error.status = response.status;
            throw error;
        }
        if (expected === 204) {
            return null;
        }
        try {
            return JSON.parse(response.body.toString('utf8'));
        } catch {
            throw new Error('GitHub returned invalid JSON.');
        }
    };
    return {
        request,
        async tag(tag) {
            const ref = await request('GET', `/git/ref/tags/${encodeURIComponent(tag)}`);
            if (!ref) {
                return null;
            }
            if (ref.ref !== `refs/tags/${tag}`) {
                throw new Error('GitHub returned an unexpected tag reference.');
            }
            let object = ref.object;
            for (let depth = 0; object?.type === 'tag' && depth < 8; depth++) {
                if (!validSha(object.sha)) {
                    throw new Error('Invalid GitHub annotated tag.');
                }
                object = (await request('GET', `/git/tags/${object.sha}`))?.object;
            }
            if (object?.type !== 'commit' || !validSha(object.sha)) {
                throw new Error('GitHub tag does not resolve to a commit.');
            }
            return object.sha;
        },
        async release(tag) {
            const direct = await request('GET', `/releases/tags/${encodeURIComponent(tag)}`);
            if (direct) {
                return direct;
            }
            for (let page = 1; page <= 100; page++) {
                const releases = await request('GET', `/releases?per_page=100&page=${page}`);
                if (!Array.isArray(releases)) {
                    throw new Error('Invalid GitHub release inventory.');
                }
                const matching = releases.filter((release) => release.tag_name === tag);
                if (matching.length > 1) {
                    throw new Error('Multiple GitHub releases use the same tag.');
                }
                if (matching.length === 1) {
                    return matching[0];
                }
                if (releases.length < 100) {
                    return null;
                }
            }
            throw new Error('GitHub release inventory exceeds its size limit.');
        },
        async assets(release) {
            if (!Number.isSafeInteger(release.id) || release.id < 1) {
                throw new Error('Invalid GitHub release identifier.');
            }
            const result = [];
            for (let page = 1; page <= 100; page++) {
                const assets = await request('GET', `/releases/${release.id}/assets?per_page=100&page=${page}`);
                if (!Array.isArray(assets)) {
                    throw new Error('Invalid GitHub asset inventory.');
                }
                result.push(...assets);
                if (assets.length < 100) {
                    return result;
                }
            }
            throw new Error('GitHub asset inventory exceeds its size limit.');
        },
        async bytes(asset, limit) {
            assertAsset(asset);
            const response = await transport({
                method: 'GET',
                url: `${base}/releases/assets/${asset.id}`,
                headers: { ...headers, Accept: 'application/octet-stream' },
                limit,
                binary: true,
            });
            if (
                response.status !== 200 ||
                response.body.length > limit ||
                response.body.length !== asset.size ||
                `sha256:${hash(response.body)}` !== asset.digest
            ) {
                throw new Error('GitHub asset bytes do not match their declared digest.');
            }
            return response.body;
        },
        async upload(release, asset) {
            const body = await fileBytes(asset.path, archiveLimit);
            if (body.length !== asset.size || hash(body) !== asset.sha256) {
                throw new Error('Local release asset changed before upload.');
            }
            const response = await transport({
                method: 'POST',
                url: `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`,
                headers: {
                    ...headers,
                    'Content-Type': asset.name.endsWith('.zip') ? 'application/zip' : 'application/octet-stream',
                    'Content-Length': String(body.length),
                },
                body,
            });
            if (response.status !== 201) {
                throw new Error(`GitHub asset upload failed with status ${response.status}.`);
            }
            let remote;
            try {
                remote = JSON.parse(response.body.toString('utf8'));
            } catch {
                throw new Error('GitHub returned invalid upload metadata.');
            }
            assertAsset(remote);
            if (
                remote.name !== asset.name ||
                remote.size !== asset.size ||
                remote.digest !== `sha256:${asset.sha256}`
            ) {
                throw new Error('Uploaded GitHub asset digest does not match the local file.');
            }
            return remote;
        },
    };
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
