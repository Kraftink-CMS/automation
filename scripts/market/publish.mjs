import { createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppClient } from '../github/app-auth.mjs';
import { createGitHubClient } from '../github/protect-repositories.mjs';
import { generateCatalogue, sourceResources } from './catalogue.mjs';

const repository = 'Kraftink-CMS/Market';
const prefix = `/repos/${repository}`;
const filename = 'catalogue.json';
const registry = 'resources.json';
const readme = 'README.md';
const limit = 2097152;
const message = 'chore(market): refresh catalogue';
const branchPattern = /^automation\/market-[a-f0-9]{12}-[a-f0-9]{12}$/;
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const id = (value) => Number.isSafeInteger(value) && value > 0;
const same = (left, right) =>
    typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const pause = (duration) => new Promise((done) => setTimeout(done, duration));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const blob = (value) =>
    createHash('sha1')
        .update(`blob ${Buffer.byteLength(value)}\0`)
        .update(value)
        .digest('hex');

class MarketPublicationError extends Error {}

function exact(value, names) {
    return plain(value) && Object.keys(value).sort().join(',') === [...names].sort().join(',');
}

function canonical(value) {
    if (Array.isArray(value))
        return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (plain(value))
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((name) => [name, canonical(value[name])]),
        );
    return value;
}

const equal = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

function sourceName(value) {
    if (typeof value !== 'string') throw new MarketPublicationError('Use a registered owner/repository.');
    const name = value.replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
    if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/.test(name) || name.endsWith('.git'))
        throw new MarketPublicationError('Use a registered owner/repository.');
    return name;
}

async function responseJson(response) {
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
        size += chunk.length;
        if (size > 8388608) throw new MarketPublicationError('The GitHub response exceeds its size limit.');
        chunks.push(Buffer.from(chunk));
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw new MarketPublicationError('GitHub returned invalid Market publication JSON.');
    }
}

function allowedWrite(method, suffix, body) {
    if (method === 'POST' && suffix === '/git/trees')
        return (
            exact(body, ['base_tree', 'tree']) &&
            sha(body.base_tree) &&
            Array.isArray(body.tree) &&
            body.tree.length > 0 &&
            body.tree.length <= 2 &&
            new Set(body.tree.map((entry) => entry.path)).size === body.tree.length &&
            body.tree.every(
                (entry) =>
                    exact(entry, ['path', 'mode', 'type', 'content']) &&
                    [readme, filename].includes(entry.path) &&
                    entry.mode === '100644' &&
                    entry.type === 'blob' &&
                    typeof entry.content === 'string' &&
                    Buffer.byteLength(entry.content) <= (entry.path === readme ? 65536 : limit),
            )
        );
    if (method === 'POST' && suffix === '/git/commits')
        return (
            exact(body, ['message', 'tree', 'parents']) &&
            body.message === message &&
            sha(body.tree) &&
            Array.isArray(body.parents) &&
            body.parents.length === 1 &&
            sha(body.parents[0])
        );
    if (method === 'POST' && suffix === '/git/refs')
        return (
            exact(body, ['ref', 'sha']) &&
            typeof body.ref === 'string' &&
            body.ref.startsWith('refs/heads/') &&
            branchPattern.test(body.ref.slice(11)) &&
            sha(body.sha)
        );
    if (method === 'POST' && suffix === '/pulls')
        return (
            exact(body, ['title', 'head', 'base', 'body']) &&
            body.title === message &&
            branchPattern.test(body.head) &&
            body.base === 'master' &&
            typeof body.body === 'string' &&
            body.body.length <= 16384
        );
    return (
        method === 'PUT' &&
        /^\/pulls\/[1-9][0-9]*\/merge$/.test(suffix) &&
        exact(body, ['sha', 'merge_method']) &&
        sha(body.sha) &&
        body.merge_method === 'merge'
    );
}

export function createMarketClient({ token, transport = fetch, wait = pause }) {
    if (typeof token !== 'string' || !token || /[^\x21-\x7e]/.test(token))
        throw new MarketPublicationError('A valid GitHub App installation token is required.');
    return {
        async request(method, path, body, expected = 200) {
            if (typeof path !== 'string')
                throw new MarketPublicationError('The Market API request is outside its scope.');
            const target = new URL(path, 'https://api.github.com');
            const suffix = target.pathname.startsWith(prefix) ? target.pathname.slice(prefix.length) : null;
            const readable =
                suffix !== null &&
                /^(?:|\/git\/ref\/heads\/(?:master|dev|automation\/market-[a-f0-9]{12}-[a-f0-9]{12})|\/git\/(?:commits|trees|blobs)\/[a-f0-9]{40}|\/contents\/(?:(?:resources|catalogue)\.json|README\.md)|\/rulesets(?:\/[1-9][0-9]*)?|\/rules\/branches\/master|\/pulls(?:\/[1-9][0-9]*(?:\/files)?)?)$/.test(
                    suffix,
                );
            const query = [...target.searchParams].every(([name, value]) =>
                name === 'ref'
                    ? sha(value)
                    : name === 'per_page'
                      ? value === '100'
                      : name === 'page'
                        ? /^[1-9][0-9]?$/.test(value)
                        : name === 'includes_parents'
                          ? value === 'false'
                          : name === 'state'
                            ? value === 'open'
                            : name === 'base'
                              ? value === 'master'
                              : name === 'head'
                                ? value.startsWith('Kraftink-CMS:') && branchPattern.test(value.slice(13))
                                : false,
            );
            if (
                target.origin !== 'https://api.github.com' ||
                target.hash ||
                suffix === null ||
                !query ||
                (method === 'GET'
                    ? !readable || body !== undefined
                    : target.search || !allowedWrite(method, suffix, body))
            )
                throw new MarketPublicationError('The Market API request is outside its scope.');
            for (let attempt = 0; attempt < 3; attempt++) {
                let response;
                try {
                    response = await transport(target.href, {
                        method,
                        headers: {
                            Accept: 'application/vnd.github+json',
                            Authorization: `Bearer ${token}`,
                            'Content-Type': 'application/json',
                            'X-GitHub-Api-Version': '2022-11-28',
                            'User-Agent': 'KraftInk-Market-Publisher',
                        },
                        body: body === undefined ? undefined : JSON.stringify(body),
                        redirect: 'error',
                        signal: AbortSignal.timeout(20000),
                    });
                } catch {
                    if (method === 'GET' && attempt < 2) {
                        await wait(1000);
                        continue;
                    }
                    throw new MarketPublicationError('The GitHub Market request could not reach GitHub.');
                }
                if (response.status === expected) return responseJson(response);
                await response.body?.cancel();
                if (method === 'GET' && attempt < 2 && (response.status === 429 || response.status >= 500)) {
                    await wait(1000);
                    continue;
                }
                const error = new MarketPublicationError(
                    `GitHub rejected the Market ${method} request with HTTP ${response.status}.`,
                );
                error.status = response.status;
                throw error;
            }
        },
    };
}

async function optional(client, path) {
    try {
        return await client.request('GET', path);
    } catch (error) {
        if (error.status === 404) return null;
        throw error;
    }
}

async function inventory(client, path) {
    const result = [];
    for (let page = 1; page <= 10; page++) {
        const entries = await client.request(
            'GET',
            `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
        );
        if (!Array.isArray(entries) || entries.length > 100)
            throw new MarketPublicationError('The Market API inventory is invalid.');
        result.push(...entries);
        if (entries.length < 100) return result;
    }
    throw new MarketPublicationError('The Market API inventory exceeds its limit.');
}

async function identity(client, expectedId = null) {
    const value = await client.request('GET', prefix);
    if (
        !id(value?.id) ||
        (expectedId !== null && value.id !== expectedId) ||
        !same(value.full_name, repository) ||
        !same(value.owner?.login, 'Kraftink-CMS') ||
        value.owner.type !== 'Organization' ||
        !same(value.name, 'Market') ||
        value.private !== false ||
        value.visibility !== 'public' ||
        value.archived !== false ||
        value.disabled !== false
    )
        throw new MarketPublicationError('The public Market repository identity changed.');
    return value.id;
}

async function reference(client, branch, optionalRef = false) {
    const value = optionalRef
        ? await optional(client, `${prefix}/git/ref/heads/${branch}`)
        : await client.request('GET', `${prefix}/git/ref/heads/${branch}`);
    if (value === null) return null;
    if (value?.ref !== `refs/heads/${branch}` || value.object?.type !== 'commit' || !sha(value.object.sha))
        throw new MarketPublicationError('GitHub returned an invalid Market branch.');
    return value.object.sha;
}

async function file(client, path, commit, optionalFile = false) {
    let value = await optional(client, `${prefix}/contents/${path}?ref=${commit}`);
    if (value === null) {
        if (optionalFile) return null;
        throw new MarketPublicationError('A required Market source file is missing.');
    }
    if (
        value.type !== 'file' ||
        value.path !== path ||
        !sha(value.sha) ||
        !Number.isSafeInteger(value.size) ||
        value.size < 0 ||
        value.size > (path === readme ? 65536 : limit)
    )
        throw new MarketPublicationError('The Market source file is not a bounded regular file.');
    const expectedSha = value.sha;
    const expectedSize = value.size;
    if (value.encoding === 'none') value = await client.request('GET', `${prefix}/git/blobs/${expectedSha}`);
    if (
        value?.sha !== expectedSha ||
        value.encoding !== 'base64' ||
        typeof value.content !== 'string' ||
        value.content.length > 3000000 ||
        !/^[A-Za-z0-9+/=\r\n]*$/.test(value.content)
    )
        throw new MarketPublicationError('The Market JSON blob is invalid.');
    const encoded = value.content.replace(/[\r\n]/g, '');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length !== expectedSize || bytes.toString('base64') !== encoded || blob(bytes) !== expectedSha)
        throw new MarketPublicationError('The Market JSON blob does not match its content hash.');
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
        throw new MarketPublicationError('The Market source file is not valid UTF-8 text.');
    }
    if (path === readme && text.includes('\0'))
        throw new MarketPublicationError('The Market README must contain plain UTF-8 text.');
    return { bytes: text, sha: expectedSha };
}

function rules(values) {
    if (!Array.isArray(values)) throw new MarketPublicationError('The master protection rules are invalid.');
    return values.map((value) => ({
        type: value.type,
        ...(value.type === 'pull_request'
            ? {
                  parameters: {
                      dismissal_restriction: { enabled: false, allowed_actors: [] },
                      ignore_approvals_from_contributors: false,
                      required_reviewers: [],
                      require_extra_approval_for_unattributed_changes: false,
                      ...value.parameters,
                  },
              }
            : value.type === 'update'
              ? { parameters: { update_allows_fetch_and_merge: false, ...value.parameters } }
              : value.parameters && !equal(value.parameters, {})
                ? { parameters: value.parameters }
                : {}),
    }));
}

async function protections(client, appId) {
    const entries = await inventory(client, `${prefix}/rulesets?includes_parents=false`);
    const active = await inventory(client, `${prefix}/rules/branches/master`);
    for (const name of ['Protect master', 'App-only master merges']) {
        const matches = entries.filter(
            (entry) => entry?.name === name && entry.source_type === 'Repository' && same(entry.source, repository),
        );
        if (matches.length !== 1 || !id(matches[0].id))
            throw new MarketPublicationError('The managed Market master protection anchors are missing or ambiguous.');
        const value = await client.request('GET', `${prefix}/rulesets/${matches[0].id}?includes_parents=false`);
        if (
            value?.id !== matches[0].id ||
            value.name !== name ||
            value.target !== 'branch' ||
            value.enforcement !== 'active' ||
            value.source_type !== 'Repository' ||
            !same(value.source, repository) ||
            !equal(value.conditions, { ref_name: { include: ['refs/heads/master'], exclude: [] } })
        )
            throw new MarketPublicationError('The Market master protection does not match its repository and branch.');
        if (name === 'Protect master') {
            const pr = value.rules?.filter((rule) => rule.type === 'pull_request');
            if (
                !equal(value.bypass_actors, []) ||
                pr?.length !== 1 ||
                !equal(pr[0].parameters?.allowed_merge_methods, ['merge']) ||
                !Number.isSafeInteger(pr[0].parameters?.required_approving_review_count) ||
                pr[0].parameters.required_approving_review_count < 0 ||
                !['deletion', 'non_fast_forward'].every(
                    (type) => value.rules.filter((rule) => rule.type === type).length === 1,
                )
            )
                throw new MarketPublicationError(
                    'The common Market policy must require merge-only pull requests and prevent force pushes and deletion without bypass.',
                );
        } else if (
            !equal(value.bypass_actors, [
                { actor_id: appId, actor_type: 'Integration', bypass_mode: 'pull_request' },
            ]) ||
            !equal(rules(value.rules), [{ type: 'update', parameters: { update_allows_fetch_and_merge: false } }])
        )
            throw new MarketPublicationError('The Market update gate must allow only this App through pull requests.');
        const effective = active.filter((rule) => rule?.ruleset_id === value.id);
        if (
            !effective.every(
                (rule) => rule.ruleset_source_type === 'Repository' && same(rule.ruleset_source, repository),
            ) ||
            !equal(rules(effective), rules(value.rules))
        )
            throw new MarketPublicationError('GitHub has not confirmed the effective Market master policy.');
    }
}

async function gitCommit(client, expected) {
    const value = await client.request('GET', `${prefix}/git/commits/${expected}`);
    if (
        value?.sha !== expected ||
        !sha(value.tree?.sha) ||
        !Array.isArray(value.parents) ||
        !value.parents.every((parent) => sha(parent?.sha))
    )
        throw new MarketPublicationError('GitHub returned an invalid Market commit.');
    return value;
}

function treeHash(entries) {
    const ordered = [...entries].sort((a, b) =>
        Buffer.compare(
            Buffer.from(a.path + (a.type === 'tree' ? '/' : '')),
            Buffer.from(b.path + (b.type === 'tree' ? '/' : '')),
        ),
    );
    const bytes = Buffer.concat(
        ordered.flatMap((entry) => [
            Buffer.from(`${entry.mode.replace(/^0/, '')} ${entry.path}\0`),
            Buffer.from(entry.sha, 'hex'),
        ]),
    );
    return createHash('sha1').update(`tree ${bytes.length}\0`).update(bytes).digest('hex');
}

async function gitTree(client, expected) {
    const value = await client.request('GET', `${prefix}/git/trees/${expected}`);
    if (
        value?.sha !== expected ||
        value.truncated !== false ||
        !Array.isArray(value.tree) ||
        value.tree.length > 10000 ||
        new Set(value.tree.map((entry) => entry.path)).size !== value.tree.length ||
        !value.tree.every(
            (entry) =>
                typeof entry.path === 'string' &&
                entry.path &&
                !/[\x00-\x1f\x7f/\\]/.test(entry.path) &&
                sha(entry.sha) &&
                ['100644', '100755', '040000', '120000', '160000'].includes(entry.mode) &&
                { 100644: 'blob', 100755: 'blob', '040000': 'tree', 120000: 'blob', 160000: 'commit' }[entry.mode] ===
                    entry.type,
        ) ||
        treeHash(value.tree) !== expected
    )
        throw new MarketPublicationError('The Market source tree cannot be verified.');
    return value.tree.map(({ path, mode, type, sha }) => ({ path, mode, type, sha }));
}

async function fresh({ client, repositoryId, dev, master }) {
    await identity(client, repositoryId);
    if ((await reference(client, 'dev')) !== dev || (await reference(client, 'master')) !== master)
        throw new MarketPublicationError('Market dev or master advanced. Retry the current catalogue plan.');
}

async function staged(client, head, base, tree, files) {
    const value = await gitCommit(client, head);
    if (value.parents.length !== 1 || value.parents[0].sha !== base || value.tree.sha !== tree)
        throw new MarketPublicationError('The managed Market branch contains unexpected source changes.');
    for (const [path, bytes] of Object.entries(files))
        if ((await file(client, path, head)).bytes !== bytes)
            throw new MarketPublicationError('The managed Market publication files changed after generation.');
}

function pullIdentity(pull, state, closed = false) {
    if (
        !id(pull?.number) ||
        (state.number !== undefined && pull.number !== state.number) ||
        pull.user?.type !== 'Bot' ||
        pull.user.login !== `${state.appSlug}[bot]` ||
        pull.body !== state.body ||
        pull.head?.ref !== state.branch ||
        pull.head.sha !== state.head ||
        pull.base?.ref !== 'master' ||
        pull.head.repo?.id !== state.repositoryId ||
        pull.base.repo?.id !== state.repositoryId ||
        !same(pull.head.repo.full_name, repository) ||
        !same(pull.base.repo.full_name, repository) ||
        (!closed && (pull.state !== 'open' || pull.merged_at || pull.base.sha !== state.master)) ||
        (closed && (pull.state !== 'closed' || !pull.merged_at || !sha(pull.merge_commit_sha)))
    )
        throw new MarketPublicationError(
            'The Market pull request does not match the exact App-owned publication plan.',
        );
    return pull;
}

async function changedFiles(client, pull, expected) {
    const files = await inventory(client, `${prefix}/pulls/${pull.number}/files`);
    if (
        files.length !== Object.keys(expected).length ||
        files.length > 2 ||
        new Set(files.map((entry) => entry.filename)).size !== files.length ||
        !files.every(
            (entry) =>
                Object.hasOwn(expected, entry.filename) &&
                ['added', 'modified'].includes(entry.status) &&
                entry.previous_filename === undefined &&
                entry.sha === expected[entry.filename],
        )
    )
        throw new MarketPublicationError(
            'The Market pull request may change only its exact README and generated catalogue.',
        );
}

async function confirmedMerge(client, state, wait, expectedSha = null) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const pull = await client.request('GET', `${prefix}/pulls/${state.number}`);
        if (pull?.state === 'closed' && pull.merged_at) {
            pullIdentity(pull, state, true);
            const value = await gitCommit(client, pull.merge_commit_sha);
            if (
                (expectedSha && value.sha !== expectedSha) ||
                value.parents.length !== 2 ||
                value.parents[0].sha !== state.master ||
                value.parents[1].sha !== state.head ||
                value.tree.sha !== state.tree ||
                (await reference(client, 'master')) !== value.sha
            )
                throw new MarketPublicationError(
                    'The Market merge does not preserve the exact approved JSON tree and history.',
                );
            await identity(client, state.repositoryId);
            return value.sha;
        }
        if (attempt < 2) await wait(1000);
    }
    throw new MarketPublicationError('GitHub has not confirmed the Market merge. Retry the central refresh.');
}

export async function reconcileMarket({
    client,
    appId,
    appSlug,
    repository: target = null,
    check = false,
    force = false,
    fetchMetadata,
    wait = pause,
}) {
    try {
        if (
            !id(appId) ||
            typeof appSlug !== 'string' ||
            !/^[a-z0-9-]+$/.test(appSlug) ||
            typeof check !== 'boolean' ||
            typeof force !== 'boolean'
        )
            throw new MarketPublicationError('A valid central GitHub App identity is required.');
        const repositoryId = await identity(client);
        const dev = await reference(client, 'dev');
        const source = await file(client, registry, dev);
        const parsed = JSON.parse(source.bytes);
        const registrations = sourceResources(parsed).repositories;
        if (target !== null && target !== '') {
            const requested = sourceName(target);
            const selected = registrations.find((entry) => same(sourceName(entry.repository), requested));
            if (!selected || (!selected.auto_update && !force))
                return {
                    action: 'skipped',
                    reason: selected ? 'automatic_updates_disabled' : 'repository_not_registered',
                };
            target = sourceName(selected.repository);
        } else target = null;
        const sourceReadme = target === null ? await file(client, readme, dev) : null;
        const master = await reference(client, 'master');
        const previous = await file(client, filename, master, true);
        const currentReadme = target === null ? await file(client, readme, master, true) : null;
        const generated = await generateCatalogue({
            source: parsed,
            previous: previous ? JSON.parse(previous.bytes) : { schema_version: 1, resources: [] },
            repository: target,
            force,
            fetchMetadata,
        });
        if (typeof generated.bytes !== 'string' || Buffer.byteLength(generated.bytes) > limit)
            throw new MarketPublicationError('The generated Market catalogue exceeds its size limit.');
        const files = {
            ...(target === null ? { [readme]: sourceReadme.bytes } : {}),
            [filename]: generated.bytes,
        };
        const changes = Object.fromEntries(
            Object.entries(files).filter(
                ([path, bytes]) => (path === readme ? currentReadme?.bytes : previous?.bytes) !== bytes,
            ),
        );
        const result = { repository, checked: generated.checked, failures: generated.failures.length };
        if (!Object.keys(changes).length) return { ...result, action: 'unchanged' };
        if (check) return { ...result, action: 'planned', files: Object.keys(changes) };
        const snapshot = { client, repositoryId, dev, master };
        await protections(client, appId);
        await fresh(snapshot);
        const base = await gitCommit(client, master);
        const baseTree = await gitTree(client, base.tree.sha);
        const hashes = Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, blob(bytes)]));
        const expectedTree = treeHash([
            ...baseTree.filter((entry) => !Object.hasOwn(files, entry.path)),
            ...Object.entries(hashes).map(([path, sha]) => ({ path, sha, mode: '100644', type: 'blob' })),
        ]);
        const branch = `automation/market-${master.slice(0, 12)}-${hash(`${dev}\0${expectedTree}`).slice(0, 12)}`;
        let head = await reference(client, branch, true);
        if (head === null) {
            await fresh(snapshot);
            const tree = await client.request(
                'POST',
                `${prefix}/git/trees`,
                {
                    base_tree: base.tree.sha,
                    tree: Object.entries(files).map(([path, content]) => ({
                        path,
                        mode: '100644',
                        type: 'blob',
                        content,
                    })),
                },
                201,
            );
            if (tree?.sha !== expectedTree)
                throw new MarketPublicationError('GitHub did not preserve the exact Market JSON tree.');
            await fresh(snapshot);
            const commit = await client.request(
                'POST',
                `${prefix}/git/commits`,
                { message, tree: expectedTree, parents: [master] },
                201,
            );
            if (!sha(commit?.sha))
                throw new MarketPublicationError('GitHub did not confirm the generated Market commit.');
            head = commit.sha;
            await staged(client, head, master, expectedTree, files);
            await fresh(snapshot);
            const created = await client.request(
                'POST',
                `${prefix}/git/refs`,
                { ref: `refs/heads/${branch}`, sha: head },
                201,
            );
            if (
                created?.ref !== `refs/heads/${branch}` ||
                created.object?.type !== 'commit' ||
                created.object.sha !== head
            )
                throw new MarketPublicationError('GitHub did not confirm the managed Market branch.');
        }
        await staged(client, head, master, expectedTree, files);
        if ((await reference(client, branch)) !== head)
            throw new MarketPublicationError('The managed Market branch advanced.');
        const body = `Publish the validated Market catalogue from dev \`${dev}\`.\n\n<!-- kraftink-market-plan\n${JSON.stringify({ schema: 1, dev, master, resources_sha256: hash(source.bytes), readme_sha256: sourceReadme ? hash(sourceReadme.bytes) : null, catalogue_sha256: hash(generated.bytes) })}\n-->`;
        const state = { ...snapshot, appSlug, branch, head, tree: expectedTree, body };
        const open = await inventory(
            client,
            `${prefix}/pulls?state=open&base=master&head=${encodeURIComponent(`Kraftink-CMS:${branch}`)}`,
        );
        if (open.length > 1) throw new MarketPublicationError('Multiple Market catalogue pull requests are ambiguous.');
        let pull;
        if (open.length) pull = pullIdentity(open[0], state);
        else {
            await fresh(snapshot);
            pull = pullIdentity(
                await client.request(
                    'POST',
                    `${prefix}/pulls`,
                    { title: message, head: branch, base: 'master', body },
                    201,
                ),
                state,
            );
        }
        state.number = pull.number;
        const expectedFiles = Object.fromEntries(Object.keys(changes).map((path) => [path, hashes[path]]));
        await changedFiles(client, pull, expectedFiles);
        for (let attempt = 0; attempt < 7; attempt++) {
            pull = await client.request('GET', `${prefix}/pulls/${state.number}`);
            if (pull?.state === 'closed' && pull.merged_at) {
                const merge_sha = await confirmedMerge(client, state, wait);
                return {
                    ...result,
                    action: 'configured',
                    merge_sha,
                    pull_request: `https://github.com/${repository}/pull/${state.number}`,
                };
            }
            pullIdentity(pull, state);
            if (pull.mergeable !== null || attempt === 6) break;
            await wait(5000);
        }
        const pending = () => ({
            ...result,
            action: 'pending',
            pull_request: `https://github.com/${repository}/pull/${state.number}`,
            reason: force
                ? `The manual refresh is waiting for GitHub merge requirements. Rerun Refresh Market manually with scope ${target === null ? 'all' : `repository and ${target}`}; automatic refreshes preserve paused registrations.`
                : 'GitHub merge requirements or approvals are pending.',
        });
        if (pull.draft || pull.mergeable !== true) return pending();
        await protections(client, appId);
        await staged(client, head, master, expectedTree, files);
        await changedFiles(client, pull, expectedFiles);
        await fresh(snapshot);
        if ((await reference(client, branch)) !== head)
            throw new MarketPublicationError('The managed Market branch advanced before merging.');
        pull = pullIdentity(await client.request('GET', `${prefix}/pulls/${state.number}`), state);
        if (pull.draft || pull.mergeable !== true) return pending();
        let merged;
        try {
            merged = await client.request('PUT', `${prefix}/pulls/${state.number}/merge`, {
                sha: head,
                merge_method: 'merge',
            });
        } catch (error) {
            if (![403, 405, 409, 422].includes(error.status)) throw error;
            const observed = await client.request('GET', `${prefix}/pulls/${state.number}`);
            if (!observed?.merged_at) return pending();
            const merge_sha = await confirmedMerge(client, state, wait);
            return { ...result, action: 'configured', merge_sha };
        }
        if (merged?.merged === false) return pending();
        if (merged?.merged !== true || !sha(merged.sha))
            throw new MarketPublicationError('GitHub did not confirm the Market merge.');
        const merge_sha = await confirmedMerge(client, state, wait, merged.sha);
        return {
            ...result,
            action: 'configured',
            merge_sha,
            pull_request: `https://github.com/${repository}/pull/${state.number}`,
        };
    } catch (error) {
        return {
            repository,
            action: 'failed',
            reason:
                error instanceof MarketPublicationError
                    ? error.message
                    : 'The central Market publication could not be verified. No unverified source was approved.',
        };
    }
}

export function parseMarketArguments(args) {
    let check = false;
    let scope = 'automatic';
    let scopeSet = false;
    let repository = null;
    for (let index = 0; index < args.length; index++) {
        const value = args[index];
        if (value === '') continue;
        if (value === '--check' && !check) check = true;
        else if (
            value === '--scope' &&
            !scopeSet &&
            ['automatic', 'repository', 'all', 'notification'].includes(args[index + 1])
        ) {
            scope = args[++index];
            scopeSet = true;
        } else if (!value.startsWith('-') && repository === null) repository = sourceName(value);
        else
            throw new MarketPublicationError(
                'Use publish.mjs [--check] --scope automatic|repository|all|notification [owner/repository].',
            );
    }
    if (['repository', 'notification'].includes(scope) ? repository === null : repository !== null)
        throw new MarketPublicationError(
            'Repository and notification scopes require one repository; automatic and all scopes accept none.',
        );
    return { check, force: ['repository', 'all'].includes(scope), repository, scope };
}

export function validateMarketEnvironment(
    environment,
    { scope = 'automatic', force = ['repository', 'all'].includes(scope) } = {},
) {
    const allowedScopes = {
        schedule: ['automatic'],
        repository_dispatch: ['notification'],
        workflow_dispatch: ['automatic', 'repository', 'all'],
    };
    if (
        environment.GITHUB_REPOSITORY !== 'Kraftink-CMS/automation' ||
        environment.GITHUB_REF !== 'refs/heads/master' ||
        environment.GITHUB_WORKFLOW_REF !==
            'Kraftink-CMS/automation/.github/workflows/refresh-market.yml@refs/heads/master' ||
        environment.GITHUB_ACTIONS !== 'true' ||
        !allowedScopes[environment.GITHUB_EVENT_NAME]?.includes(scope) ||
        typeof force !== 'boolean' ||
        force !== ['repository', 'all'].includes(scope) ||
        (force && environment.GITHUB_EVENT_NAME !== 'workflow_dispatch')
    )
        throw new MarketPublicationError('Run the central Refresh Market workflow from master.');
}

export async function authorizeMarketRefresh({ client, environment, scope = 'repository' }) {
    if (!['repository', 'all'].includes(scope))
        throw new MarketPublicationError('Manual refresh authorization requires repository or all scope.');
    validateMarketEnvironment(environment, { force: true, scope });
    for (const actor of [
        environment.GITHUB_ACTOR,
        environment.KRAFTINK_TRIGGERING_ACTOR ?? environment.GITHUB_TRIGGERING_ACTOR,
    ]) {
        if (typeof actor !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(actor))
            throw new MarketPublicationError('A manual Market refresh requires identified human administrators.');
        for (const target of ['Kraftink-CMS/automation', repository]) {
            const value = await client.request('GET', `/repos/${target}/collaborators/${actor}/permission`);
            if (
                value?.user?.type !== 'User' ||
                !same(value.user.login, actor) ||
                !id(value.user.id) ||
                !(target.endsWith('/automation')
                    ? value.permission === 'admin'
                    : ['write', 'maintain', 'admin'].includes(value.permission))
            )
                throw new MarketPublicationError(
                    'A manual Market refresh requires central administration and Market write access for both actors.',
                );
        }
    }
}

async function main() {
    const options = parseMarketArguments(process.argv.slice(2));
    validateMarketEnvironment(process.env, options);
    const app = await createAppClient();
    if (options.force)
        await authorizeMarketRefresh({
            client: createGitHubClient({ token: app.token }),
            environment: process.env,
            scope: options.scope,
        });
    const result = await reconcileMarket({
        ...options,
        client: createMarketClient({ token: app.token }),
        appId: app.appId,
        appSlug: app.appSlug,
    });
    process.stdout.write(JSON.stringify(result) + '\n');
    if (process.env.GITHUB_STEP_SUMMARY)
        await appendFile(
            process.env.GITHUB_STEP_SUMMARY,
            `Market catalogue: **${result.action}**.${result.reason ? ` ${result.reason}` : ''}${result.pull_request ? ` [Pull request](${result.pull_request}).` : ''}\n`,
        );
    if (result.action === 'failed' || (options.force && result.action === 'pending')) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    main().catch(() => {
        process.stderr.write(
            'The central Market refresh failed. Check the App access, repository protections and source registry.\n',
        );
        process.exitCode = 1;
    });
