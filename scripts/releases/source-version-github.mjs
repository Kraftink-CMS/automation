import { inspectSourceVersion, nextDevelopmentVersion, sourceVersionChanges } from './source-version.mjs';
import { compareVersions, selectVersion, stableVersion } from './version.mjs';

const validSha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const validRepository = (value) => typeof value === 'string'
    && /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/.test(value);

function options(client, repository) {
    if (typeof client?.request !== 'function' || !validRepository(repository))
        throw new Error('A repository and authenticated GitHub client are required.');
    return `/repos/${repository}`;
}

async function commit(client, path, sha) {
    if (!validSha(sha)) throw new Error('A valid source commit is required.');
    const result = await client.request('GET', `${path}/git/commits/${sha}`);
    if (result?.sha !== sha || !validSha(result.tree?.sha) || !Array.isArray(result.parents)
            || result.parents.some((parent) => !validSha(parent.sha)))
        throw new Error('The source commit or tree is invalid.');
    return result;
}

async function branchHead(client, path, branch) {
    if (typeof branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/.test(branch)
            || branch.includes('..') || branch.includes('//') || branch.endsWith('/') || branch.endsWith('.lock'))
        throw new Error('The version branch is invalid.');
    const ref = await client.request('GET', `${path}/git/ref/heads/${branch}`);
    if (ref?.ref !== `refs/heads/${branch}` || ref.object?.type !== 'commit' || !validSha(ref.object.sha))
        throw new Error('The version branch does not identify a commit.');
    return ref.object.sha;
}

function sourceReader(client, path, treeSha) {
    const trees = new Map();
    return async (file) => {
        let tree = treeSha;
        const parts = file.split('/');
        if (parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\')))
            throw new Error('A source version path is invalid.');
        for (let index = 0; index < parts.length; index++) {
            if (!trees.has(tree)) {
                const result = await client.request('GET', `${path}/git/trees/${tree}`);
                if (result?.sha !== tree || result.truncated !== false || !Array.isArray(result.tree)
                        || result.tree.length > 10000)
                    throw new Error('The source version tree is invalid or too large.');
                trees.set(tree, result.tree);
            }
            const matches = trees.get(tree).filter((entry) => entry.path === parts[index]);
            if (!matches.length) return null;
            if (matches.length !== 1 || !validSha(matches[0].sha))
                throw new Error('A source version path is ambiguous.');
            const entry = matches[0];
            if (index < parts.length - 1) {
                if (entry.type !== 'tree' || entry.mode !== '040000')
                    throw new Error('Source version paths cannot cross links or submodules.');
                tree = entry.sha;
                continue;
            }
            if (entry.type !== 'blob' || entry.mode !== '100644' || !Number.isSafeInteger(entry.size)
                    || entry.size < 1 || entry.size > 1048576)
                throw new Error('Source version files must be bounded regular files.');
            const blob = await client.request('GET', `${path}/git/blobs/${entry.sha}`);
            if (blob?.sha !== entry.sha || blob.encoding !== 'base64' || blob.size !== entry.size
                    || typeof blob.content !== 'string' || blob.content.length > 1500000)
                throw new Error('The source version blob is invalid.');
            const bytes = Buffer.from(blob.content.replaceAll('\n', ''), 'base64');
            const content = bytes.toString('utf8');
            if (bytes.length !== entry.size || !Buffer.from(content).equals(bytes))
                throw new Error('Source version files must contain valid UTF-8.');
            return content;
        }
    };
}

async function preparedTree({ client, path, source, version }) {
    const read = sourceReader(client, path, source.tree.sha);
    const changes = await sourceVersionChanges({ read, version });
    if (!changes.files.length) return { sha: source.tree.sha, changes };
    const tree = await client.request('POST', `${path}/git/trees`, {
        base_tree: source.tree.sha,
        tree: changes.files.map((file) => ({ path: file.path, mode: '100644', type: 'blob', content: file.after })),
    }, 201);
    if (!validSha(tree?.sha)) throw new Error('GitHub did not confirm the version tree.');
    return { sha: tree.sha, changes };
}

export async function updateSourceVersion({ client, repository, branch, version, expectedSha, mergeSha, validationContext = null }) {
    const path = options(client, repository);
    if (validationContext !== null && (typeof validationContext !== 'string'
            || !validationContext.trim() || validationContext.length > 100 || /[\x00-\x1f\x7f]/.test(validationContext)))
        throw new Error('The version validation context is invalid.');
    const sourceSha = await branchHead(client, path, branch);
    if (expectedSha !== undefined && sourceSha !== expectedSha)
        throw new Error('The version branch advanced. Retry from its current source.');
    const source = await commit(client, path, sourceSha);
    if (typeof version === 'function') {
        const current = await inspectSourceVersion({ read: sourceReader(client, path, source.tree.sha) });
        version = version(current.version);
    }
    const tree = await preparedTree({ client, path, source, version });
    const parents = [sourceSha];
    if (mergeSha && mergeSha !== sourceSha) {
        await commit(client, path, mergeSha);
        const history = await comparison(client, path, mergeSha, sourceSha);
        if (!['ahead', 'identical'].includes(history.status)
                || history.base_commit.sha !== mergeSha || history.merge_base_commit.sha !== mergeSha)
            parents.push(mergeSha);
    }
    if (!tree.changes.files.length && parents.length === 1)
        return { sha: sourceSha, tree_sha: source.tree.sha, changed: false, source_sha: sourceSha };
    const result = await client.request('POST', `${path}/git/commits`, {
        message: `chore: set source version to ${version}`,
        tree: tree.sha,
        parents,
    }, 201);
    if (!validSha(result?.sha) || result.tree?.sha !== tree.sha || !Array.isArray(result.parents)
            || result.parents.map((parent) => parent.sha).join(',') !== parents.join(','))
        throw new Error('GitHub did not confirm the exact version commit.');
    if (validationContext !== null) {
        const status = await client.request('POST', `${path}/statuses/${result.sha}`, {
            state: 'success', context: validationContext,
            description: 'Only validated source version metadata changed.',
        }, 201);
        if (status?.state !== 'success' || status.context !== validationContext)
            throw new Error('GitHub did not confirm the version metadata validation.');
    }
    if (await branchHead(client, path, branch) !== sourceSha)
        throw new Error('The version branch advanced before its update. Retry from its current source.');
    const ref = await client.request('PATCH', `${path}/git/refs/heads/${branch}`, { sha: result.sha, force: false });
    if (ref?.ref !== `refs/heads/${branch}` || ref.object?.type !== 'commit' || ref.object.sha !== result.sha)
        throw new Error('GitHub did not confirm the version branch update.');
    return { sha: result.sha, tree_sha: tree.sha, changed: true, source_sha: sourceSha };
}

export async function verifyPreparedSourceVersion({ client, repository, originSha, preparedSha, version }) {
    const path = options(client, repository);
    const source = await commit(client, path, originSha);
    const prepared = preparedSha === originSha ? source : await commit(client, path, preparedSha);
    const tree = await preparedTree({ client, path, source, version });
    if (prepared.tree.sha !== tree.sha || (preparedSha !== originSha
            && (prepared.parents.length !== 1 || prepared.parents[0].sha !== originSha)))
        throw new Error('The prepared source differs from the exact version-only change.');
    return { sha: preparedSha, tree_sha: tree.sha };
}

async function comparison(client, path, base, head) {
    if (!validSha(base) || !validSha(head)) throw new Error('Valid source history commits are required.');
    if (base === head) return { status: 'identical', commits: [], total_commits: 0,
        base_commit: { sha: base }, merge_base_commit: { sha: base } };
    const result = await client.request('GET', `${path}/compare/${base}...${head}?per_page=100&page=1`);
    if (!result || !['ahead', 'behind', 'diverged', 'identical'].includes(result.status)
            || !validSha(result.base_commit?.sha) || !validSha(result.merge_base_commit?.sha)
            || !Array.isArray(result.commits) || !Number.isSafeInteger(result.total_commits)
            || result.total_commits < 0 || result.total_commits > 10000)
        throw new Error('The source history comparison is invalid or too large.');
    return result;
}

export async function advanceDevelopmentVersion({ client, repository, version, releaseSha, sourceSha, target, validationContext = null }) {
    stableVersion(version);
    const path = options(client, repository);
    const current = await branchHead(client, path, 'dev');
    for (const head of [current, releaseSha]) {
        const ancestry = await comparison(client, path, sourceSha, head);
        if (!['ahead', 'identical'].includes(ancestry.status)
                || ancestry.base_commit.sha !== sourceSha || ancestry.merge_base_commit.sha !== sourceSha)
            throw new Error('The release source must remain an ancestor of dev and the stable commit.');
    }
    const released = await commit(client, path, releaseSha);
    const original = await commit(client, path, sourceSha);
    const expected = await preparedTree({ client, path, source: original, version });
    const releasedVersion = await inspectSourceVersion({ read: sourceReader(client, path, released.tree.sha) });
    if (releasedVersion.version !== version || released.tree.sha !== expected.sha)
        throw new Error('The stable source version does not match its published release.');
    const development = await commit(client, path, current);
    const metadata = await inspectSourceVersion({ read: sourceReader(client, path, development.tree.sha) });
    if (!metadata.version.endsWith('-dev') && compareVersions(metadata.version, version) > 0)
        return { sha: current, tree_sha: development.tree.sha, changed: false, source_sha: current };
    return updateSourceVersion({ client, repository, branch: 'dev', expectedSha: current, mergeSha: releaseSha, validationContext,
        version: (value) => {
            const next = nextDevelopmentVersion(version, value);
            const requested = target ? nextDevelopmentVersion(version, target) : next;
            return compareVersions(requested.replace(/-dev$/, ''), next.replace(/-dev$/, '')) > 0 ? requested : next;
        } });
}

export async function planSourceVersion({ client, repository, sourceSha, bump = 'auto' }) {
    const path = options(client, repository);
    const source = await commit(client, path, sourceSha);
    const read = sourceReader(client, path, source.tree.sha);
    if (await read('manifest.json') === null && await read('pom.xml') === null && await read('package.json') === null) return null;
    const metadata = await inspectSourceVersion({ read });
    const initial = metadata.version.replace(/-(?:dev|SNAPSHOT)$/, '');
    stableVersion(initial);
    const policyBytes = await read('.github/release-policy.json');
    const policy = policyBytes === null
        ? { schema: 1, initial_version: initial, default_bump: 'patch', next_version: null }
        : { default_bump: 'patch', next_version: null, ...JSON.parse(policyBytes) };
    const tags = [];
    for (let page = 1; page <= 100; page++) {
        const entries = await client.request('GET', `${path}/tags?per_page=100&page=${page}`);
        if (!Array.isArray(entries) || entries.length > 100) throw new Error('The release tag inventory is invalid.');
        for (const entry of entries) {
            if (!/^v\d+\.\d+\.\d+$/.test(entry?.name ?? '')) continue;
            if (!validSha(entry.commit?.sha)) throw new Error('A release tag does not identify a commit.');
            stableVersion(entry.name.slice(1));
            tags.push({ tag: entry.name, version: entry.name.slice(1), sha: entry.commit.sha, ancestor: false });
        }
        if (entries.length < 100) break;
        if (page === 100) throw new Error('Too many release tags.');
    }
    tags.sort((left, right) => compareVersions(right.version, left.version));
    let base = null;
    let history = null;
    for (const tag of tags) {
        const result = await comparison(client, path, tag.sha, sourceSha);
        tag.ancestor = ['ahead', 'identical'].includes(result.status)
            && result.base_commit.sha === tag.sha && result.merge_base_commit.sha === tag.sha;
        if (tag.ancestor && tag.sha !== sourceSha) { base = tag; history = result; break; }
    }
    const messages = [];
    if (base) {
        for (let page = 1; ; page++) {
            const result = page === 1 ? history : await client.request('GET',
                `${path}/compare/${base.sha}...${sourceSha}?per_page=100&page=${page}`);
            if (!Array.isArray(result?.commits) || result.commits.length > 100)
                throw new Error('The release commit inventory is invalid.');
            for (const entry of result.commits) {
                if (!validSha(entry.sha) || typeof entry.commit?.message !== 'string'
                        || Buffer.byteLength(entry.commit.message) > 1048576)
                    throw new Error('A release commit message is invalid.');
                messages.push(entry.commit.message);
            }
            if (messages.length >= history.total_commits) break;
            if (page >= 100 || !result.commits.length)
                throw new Error('The release commit history is incomplete.');
        }
        if (messages.length !== history.total_commits) throw new Error('The release commit history changed.');
    }
    return selectVersion({ sha: sourceSha, tags, messages, bump, policy });
}
