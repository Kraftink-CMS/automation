import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { describeSource, prepareRelease, promoteRelease, publishRelease } from './workflow.mjs';

const repository = 'Kraftink-CMS/Example';

async function fixture(t, kind = 'custom') {
    const parent = await mkdtemp(resolve(tmpdir(), 'kraftink-release-workflow-'));
    t.after(() => rm(parent, { recursive: true, force: true }));
    const root = resolve(parent, 'source');
    const directory = resolve(parent, 'context');
    const assetsDirectory = resolve(parent, 'assets');
    await mkdir(root);
    await mkdir(assetsDirectory);
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'] }).trimEnd();
    git('init', '-b', 'master');
    git('config', 'user.name', 'Release fixture');
    git('config', 'user.email', 'release@example.invalid');
    if (kind === 'custom' || kind === 'node') {
        if (kind === 'node') {
            await writeFile(resolve(root, 'package.json'), JSON.stringify({ name: 'example-website', version: '1.0.0-dev', private: true }) + '\n');
            await mkdir(resolve(root, '.github/workflows'), { recursive: true });
            await writeFile(resolve(root, '.github/workflows/deploy.yml'), 'name: Deploy\non:\n  repository_dispatch:\n    types: [kraftink-release-published]\njobs: {}\n');
        } else {
            await writeFile(resolve(root, 'pom.xml'), '<project><modelVersion>4.0.0</modelVersion><groupId>example</groupId><artifactId>example</artifactId><version>1.0.0-dev</version></project>\n');
        }
        await mkdir(resolve(root, '.github/actions/build'), { recursive: true });
        await writeFile(resolve(root, '.github/actions/build/action.yml'), 'name: Build\nruns:\n  using: composite\n  steps: []\n');
    } else {
        await writeFile(resolve(root, 'manifest.json'), JSON.stringify({ id: 'example', type: 'plugin', name: 'Example',
            description: 'Example plugin', version: '1.0.0-dev', requires: { cms: '>=0.0.1', php: '^8.4' } }) + '\n');
    }
    await writeFile(resolve(root, 'code.txt'), 'original\n');
    git('add', '.');
    git('commit', '-m', 'feat: initial project');
    git('branch', 'dev');
    const remote = resolve(parent, 'remote.git');
    git('clone', '--bare', root, remote);
    git('remote', 'add', 'origin', remote);
    git('fetch', 'origin');
    const serverGit = (...args) => execFileSync('git', ['-C', remote, ...args], { encoding: 'utf8', windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'] }).trimEnd();
    const serverInput = (args, bytes) => execFileSync('git', ['-C', remote, ...args], { input: bytes, encoding: 'utf8',
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trimEnd();
    serverGit('config', 'user.name', 'Release fixture');
    serverGit('config', 'user.email', 'release@example.invalid');
    const original = git('rev-parse', 'HEAD');
    const state = { calls: [], permissions: { writer: 'write', rerunner: 'maintain' }, pull: null, before: null,
        pulls: [], arrivals: {}, releases: new Map(),
        mergeFailures: 0, wrongMergeTree: false, indexEmpty: 0, pullNotReady: 0, pullNullSha: 0, nextPull: 1,
        metadata: { id: 10, full_name: repository, owner: { login: 'Kraftink-CMS', type: 'Organization' },
            private: false, visibility: 'public', fork: false, archived: false, disabled: false, default_branch: 'master' } };
    const commit = (sha) => {
        const lines = serverGit('cat-file', '-p', sha).split('\n');
        return { sha, tree: { sha: lines.find((line) => line.startsWith('tree ')).slice(5) },
            parents: lines.filter((line) => line.startsWith('parent ')).map((line) => ({ sha: line.slice(7) })) };
    };
    const createCommit = (tree, parents) => serverInput(['commit-tree', tree, ...parents.flatMap((sha) => ['-p', sha])], 'Release fixture\n');
    const client = { async request(method, path, body) {
        const git = serverGit;
        const input = serverInput;
        state.calls.push({ method, path, body });
        if (state.before) await state.before(method, path, body);
        if (method === 'GET' && path === '') return structuredClone(state.metadata);
        const run = path.match(/^\/actions\/runs\/(\d+)$/);
        if (method === 'GET' && run) return { id: Number(run[1]), event: 'workflow_dispatch',
            created_at: state.arrivals[run[1]] || '2026-10-28T12:00:00Z',
            repository: { id: 10, full_name: repository }, head_repository: { id: 10, full_name: repository } };
        const permission = path.match(/^\/collaborators\/([^/]+)\/permission$/);
        if (method === 'GET' && permission) return { permission: state.permissions[permission[1]] || 'none',
            user: { login: permission[1], type: 'User', id: permission[1] === 'writer' ? 11 : 12 } };
        const reference = path.match(/^\/git\/refs?\/heads\/(.+)$/);
        if (reference && method === 'GET') return { ref: `refs/heads/${reference[1]}`,
            object: { type: 'commit', sha: git('rev-parse', `refs/heads/${reference[1]}`) } };
        if (reference && method === 'PATCH') {
            assert.equal(body.force, false);
            git('merge-base', '--is-ancestor', `refs/heads/${reference[1]}`, body.sha);
            git('update-ref', `refs/heads/${reference[1]}`, body.sha);
            return { ref: `refs/heads/${reference[1]}`, object: { type: 'commit', sha: body.sha } };
        }
        if (method === 'GET' && path.startsWith('/git/commits/')) return commit(path.slice('/git/commits/'.length));
        if (method === 'GET' && path.startsWith('/compare/')) {
            const [base, head] = path.slice('/compare/'.length).split('?')[0].split('...');
            const common = git('merge-base', base, head);
            return { status: common === base ? 'ahead' : common === head ? 'behind' : 'diverged',
                base_commit: { sha: base }, merge_base_commit: { sha: common }, total_commits: 1,
                commits: [{ sha: head, commit: { message: 'Release fixture' } }] };
        }
        if (method === 'GET' && path.startsWith('/git/trees/')) {
            const sha = path.slice('/git/trees/'.length);
            return { sha, truncated: false, tree: git('ls-tree', '-l', '-z', sha).split('\0').filter(Boolean).map((entry) => {
                const [header, file] = entry.split('\t');
                const [mode, type, object, size] = header.trim().split(/\s+/);
                return { mode, type, sha: object, size: Number(size), path: file };
            }) };
        }
        if (method === 'GET' && path.startsWith('/git/blobs/')) {
            const sha = path.slice('/git/blobs/'.length);
            const bytes = Buffer.from(execFileSync('git', ['-C', remote, 'cat-file', 'blob', sha]));
            return { sha, encoding: 'base64', size: bytes.length, content: bytes.toString('base64') };
        }
        if (method === 'POST' && path === '/git/trees') {
            const files = new Map(git('ls-tree', body.base_tree).split('\n').map((entry) => [entry.split('\t')[1], entry]));
            for (const file of body.tree) {
                const sha = input(['hash-object', '-w', '--stdin'], file.content);
                files.set(file.path, `${file.mode} blob ${sha}\t${file.path}`);
            }
            return { sha: input(['mktree'], [...files.values()].join('\n') + '\n') };
        }
        if (method === 'POST' && path === '/git/commits') return commit(createCommit(body.tree, body.parents));
        if (method === 'POST' && path.startsWith('/statuses/')) return structuredClone(body);
        if (method === 'GET' && path.startsWith('/pulls?')) return structuredClone(
            (path.includes('state=all') ? state.pulls : state.pulls.filter((pull) => pull.state === 'open'))
                .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at)));
        if (method === 'GET' && path.startsWith('/releases/tags/')) return state.releases.get(path.slice('/releases/tags/'.length)) || null;
        if (method === 'POST' && path === '/pulls') {
            const source = git('rev-parse', 'dev');
            const base = git('rev-parse', 'master');
            state.merge = createCommit(commit(state.wrongMergeTree ? base : source).tree.sha, [base, source]);
            state.pull = { number: state.nextPull++, user: { login: 'github-actions[bot]', type: 'Bot', id: 41898282 }, body: body.body,
                created_at: '2026-10-28T12:00:01Z', updated_at: '2026-10-28T12:00:01Z', closed_at: null,
                state: 'open', draft: false, merged_at: null, mergeable: true, mergeable_state: 'clean', merge_commit_sha: state.merge,
                head: { ref: 'dev', sha: source, repo: { id: 10, full_name: repository } },
                base: { ref: 'master', sha: base, repo: { id: 10, full_name: repository } } };
            state.pulls.push(state.pull);
            return structuredClone(state.pull);
        }
        if (method === 'GET' && path === `/pulls/${state.pull?.number}`) {
            if (state.pull.state === 'open') {
                const source = git('rev-parse', 'dev');
                const base = git('rev-parse', 'master');
                if (source !== state.pull.head.sha || base !== state.pull.base.sha || state.wrongMergeTree !== state.mergeWrong) {
                    state.merge = createCommit(commit(state.wrongMergeTree ? base : source).tree.sha, [base, source]);
                    state.pull.head.sha = source;
                    state.pull.base.sha = base;
                    state.pull.merge_commit_sha = state.merge;
                    state.mergeWrong = state.wrongMergeTree;
                }
            }
            if (state.pull.state === 'closed' && state.pullNotReady-- > 0)
                return { ...structuredClone(state.pull), state: 'open', merged_at: null };
            if (state.pull.state === 'closed' && state.pullNullSha-- > 0)
                return { ...structuredClone(state.pull), merge_commit_sha: null };
            return structuredClone(state.pull);
        }
        if (method === 'PATCH' && path === `/pulls/${state.pull?.number}`) {
            state.pull.body = body.body;
            return structuredClone(state.pull);
        }
        if (method === 'PUT' && path === `/pulls/${state.pull?.number}/merge`) {
            if (state.mergeFailures-- > 0) throw Object.assign(new Error('Checks pending'), { status: 405 });
            assert.equal(body.sha, git('rev-parse', 'dev'));
            git('update-ref', 'refs/heads/master', state.merge);
            state.pull.state = 'closed';
            state.pull.merged_at = '2026-10-28T12:00:00Z';
            state.pull.closed_at = '2026-10-28T12:02:00Z';
            state.pull.updated_at = state.pull.closed_at;
            return { merged: true, sha: state.merge };
        }
        if (method === 'GET' && /^\/commits\/[a-f0-9]{40}\/pulls\?/.test(path))
            return state.indexEmpty-- > 0 ? [] : [structuredClone(state.pull)];
        if (method === 'POST' && path === '/dispatches') return null;
        throw new Error(`Unexpected ${method} ${path}`);
    }, release(tag) { return this.request('GET', `/releases/tags/${tag}`); } };
    const environment = { GITHUB_REPOSITORY: repository, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/dev',
        GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', GITHUB_ACTOR: 'writer', GITHUB_TRIGGERING_ACTOR: 'rerunner' };
    const options = { root, directory, assetsDirectory, client, environment, wait: async () => {} };
    return { ...options, state, git, serverGit, original, commit, createCommit, prepare: () => prepareRelease(options),
        promote: () => promoteRelease(options), context: async () => JSON.parse(await readFile(resolve(directory, 'context.json'), 'utf8')) };
}

test('read-only checks discover extension and custom source versions without requiring a release token', async (t) => {
    for (const kind of ['custom', 'extension']) {
        const data = await fixture(t, kind);
        assert.deepEqual(await describeSource(data.root), { kind, version: '1.0.0-dev', tests: false });
        assert.deepEqual(data.state.calls, []);
    }
});

test('optional test actions are selected only from the committed source for extensions and custom builds', async (t) => {
    for (const kind of ['custom', 'extension']) {
        const data = await fixture(t, kind);
        const descriptor = resolve(data.root, '.github/actions/test/action.yml');
        await mkdir(resolve(data.root, '.github/actions/test'), { recursive: true });
        await writeFile(descriptor, 'name: Test\nruns:\n  using: composite\n  steps: []\n');
        assert.equal((await describeSource(data.root)).tests, false);
        data.git('add', '.github/actions/test/action.yml');
        data.git('commit', '-m', 'test: add the optional test action');
        assert.deepEqual(await describeSource(data.root), { kind, version: '1.0.0-dev', tests: true });
        await rm(descriptor);
        assert.equal((await describeSource(data.root)).tests, true);
        assert.deepEqual(data.state.calls, []);
    }
});

test('optional test actions refuse symlink and directory descriptors without depending on filesystem symlink support', async (t) => {
    for (const mode of ['symlink', 'directory']) {
        const data = await fixture(t);
        const descriptor = '.github/actions/test/action.yml';
        if (mode === 'symlink') {
            const blob = data.git('rev-parse', 'HEAD:.github/actions/build/action.yml');
            data.git('update-index', '--add', '--cacheinfo', `120000,${blob},${descriptor}`);
        } else {
            await mkdir(resolve(data.root, descriptor), { recursive: true });
            await writeFile(resolve(data.root, descriptor, 'nested.yml'), 'name: Test\n');
            data.git('add', descriptor);
        }
        data.git('commit', '-m', 'test: reject a nonregular test action');
        await assert.rejects(describeSource(data.root), /test action must be a regular committed file/);
        assert.deepEqual(data.state.calls, []);
    }
});

test('one local Release prepares stable metadata, merges its exact tree and publishes before opening the next cycle', async (t) => {
    const data = await fixture(t);
    const selected = await data.prepare();
    assert.equal(selected.kind, 'custom');
    assert.equal(selected.version, '1.0.0');
    assert.equal(data.git('rev-parse', 'refs/heads/dev'), data.original);
    assert.equal(data.git('rev-parse', 'refs/remotes/origin/dev'), selected.source_sha);
    assert.equal(data.serverGit('rev-parse', 'refs/heads/dev'), selected.source_sha);
    assert.notEqual(selected.source_sha, data.original);
    assert.deepEqual(data.commit(selected.source_sha).parents, [{ sha: data.original }]);
    assert.equal(data.git('show', `${selected.source_sha}:code.txt`), 'original');
    assert.match(data.git('show', `${selected.source_sha}:pom.xml`), /<version>1\.0\.0<\/version>/);
    data.state.mergeFailures = 1;
    const promoted = await data.promote();
    assert.deepEqual(data.commit(promoted.merge_sha).parents, [{ sha: data.original }, { sha: selected.source_sha }]);
    assert.equal(data.commit(promoted.merge_sha).tree.sha, data.commit(selected.source_sha).tree.sha);
    assert.equal(data.state.calls.filter((call) => call.method === 'PUT').length, 2);
    const statuses = data.state.calls.filter((call) => call.body?.context === 'Release validated source');
    assert.deepEqual(statuses, [{ method: 'POST', path: `/statuses/${selected.source_sha}`, body: {
        state: 'success', context: 'Release validated source',
        target_url: `https://github.com/${repository}/actions/runs/100`,
        description: 'The prepared source passed release build and promotion validation.',
    } }]);
    assert.ok(data.state.calls.indexOf(statuses[0]) < data.state.calls.findIndex((call) => call.method === 'PUT'));
    assert.deepEqual(await data.promote(), promoted);
    await writeFile(resolve(data.assetsDirectory, 'application.txt'), 'built from the prepared source\n');
    const order = [];
    const result = await publishRelease({ ...data, environment: { ...data.environment,
        RELEASE_MERGE_SHA: promoted.merge_sha, RELEASE_PULL_NUMBER: promoted.pull_number },
        publish: async ({ plan, beforeMutation }) => {
            assert.equal(plan.sha, promoted.merge_sha);
            const bundle = JSON.parse(await readFile(resolve(data.assetsDirectory, 'bundle.json'), 'utf8'));
            assert.equal(bundle.sha, promoted.merge_sha);
            assert.equal(bundle.assets[0].name, 'application.txt');
            await beforeMutation('publish');
            order.push('published');
            return { complete: true, version: plan.version };
        }, advance: async ({ releaseSha, sourceSha }) => {
            assert.equal(releaseSha, promoted.merge_sha);
            assert.equal(sourceSha, selected.source_sha);
            order.push('development');
        } });
    assert.equal(result.complete, true);
    assert.deepEqual(order, ['published', 'development']);
    assert.ok(data.state.calls.every((call) => call.path === '' || call.path.startsWith('/') && !call.path.startsWith('/repos/')));
});

test('release messages stay attached to the prepared source and reach publication unchanged', async (t) => {
    for (const mode of ['append', 'replace']) {
        await t.test(mode, async (t) => {
            const data = await fixture(t);
            const message = '## New version\n\nUseful changes with **Markdown** and $(literal text).';
            data.environment.RELEASE_NOTES_MODE = mode;
            data.environment.RELEASE_NOTES = message;
            await data.prepare();
            const context = await data.context();
            assert.deepEqual(context.notes, { mode, message });
            assert.ok(context.release_body.startsWith(message));
            if (mode === 'replace') assert.equal(context.release_body, message);
            else assert.match(context.release_body, /feat: initial project/);
            const promoted = await data.promote();
            await writeFile(resolve(data.assetsDirectory, 'application.txt'), 'validated asset\n');
            await publishRelease({ ...data, environment: { ...data.environment,
                RELEASE_MERGE_SHA: promoted.merge_sha, RELEASE_PULL_NUMBER: promoted.pull_number },
                publish: async ({ body }) => {
                    assert.equal(body, context.release_body);
                    return { complete: true };
                }, advance: async () => {} });
            const changed = { ...context, release_body: context.release_body + '\nUnexpected message' };
            await writeFile(resolve(data.directory, 'context.json'), JSON.stringify(changed));
            await assert.rejects(publishRelease({ ...data, environment: { ...data.environment,
                RELEASE_MERGE_SHA: promoted.merge_sha, RELEASE_PULL_NUMBER: promoted.pull_number },
                publish: async () => { throw new Error('Unexpected publication'); } }), /release notes differ/);
        });
    }
});

test('invalid note choices fail before preparing a version or opening a pull request', async (t) => {
    const data = await fixture(t);
    for (const [mode, message] of [['unknown', ''], ['append', ''], ['replace', ''], ['auto', 'Ignored text']]) {
        data.environment.RELEASE_NOTES_MODE = mode;
        data.environment.RELEASE_NOTES = message;
        await assert.rejects(data.prepare());
        assert.equal(data.serverGit('rev-parse', 'dev'), data.original);
        assert.equal(data.state.calls.some((call) => call.method !== 'GET'), false);
    }
});

test('extension selection is based on its manifest while custom builds require a committed action', async (t) => {
    const data = await fixture(t, 'extension');
    assert.equal((await data.prepare()).kind, 'extension');
    const context = await data.context();
    assert.equal(context.manifest.version, '1.0.0');
    assert.deepEqual(context.history, []);
});

test('verified publication advances dev through the real version helper while preserving the stable master source', async (t) => {
    const data = await fixture(t);
    const selected = await data.prepare();
    const promoted = await data.promote();
    await writeFile(resolve(data.assetsDirectory, 'application.txt'), 'built\n');
    await publishRelease({ ...data, environment: { ...data.environment,
        RELEASE_MERGE_SHA: promoted.merge_sha, RELEASE_PULL_NUMBER: promoted.pull_number },
        publish: async ({ beforeMutation }) => {
            await beforeMutation('publish');
            return { complete: true, version: '1.0.0' };
        } });
    const next = data.serverGit('rev-parse', 'dev');
    assert.match(data.serverGit('show', `${next}:pom.xml`), /<version>1\.0\.1-dev<\/version>/);
    assert.match(data.serverGit('show', 'master:pom.xml'), /<version>1\.0\.0<\/version>/);
    assert.deepEqual(data.commit(next).parents, [{ sha: selected.source_sha }, { sha: promoted.merge_sha }]);
});

test('Node custom releases dispatch their optional deployment only after verified publication and development advancement', async (t) => {
    const data = await fixture(t, 'node');
    assert.deepEqual(await describeSource(data.root), { kind: 'custom', version: '1.0.0-dev', tests: false });
    const selected = await data.prepare();
    const context = await data.context();
    assert.equal(context.deployment, 'deploy.yml');
    const promoted = await data.promote();
    await writeFile(resolve(data.assetsDirectory, 'site.tar.gz'), 'validated custom deployment bytes\n');
    const options = { ...data, environment: { ...data.environment,
        RELEASE_MERGE_SHA: promoted.merge_sha, RELEASE_PULL_NUMBER: promoted.pull_number } };
    await assert.rejects(publishRelease({ ...options, publish: async () => ({ complete: false }) }), /publication has not been verified/);
    assert.equal(data.state.calls.some((call) => call.path === '/dispatches'), false);
    assert.equal(data.serverGit('rev-parse', 'dev'), selected.source_sha);
    let interrupted = true;
    data.state.before = async (method, path) => {
        if (method === 'POST' && path === '/dispatches' && interrupted) {
            interrupted = false;
            throw new Error('Deployment notification unavailable');
        }
    };
    const publish = async ({ beforeMutation }) => { await beforeMutation('publish'); return { complete: true }; };
    await assert.rejects(publishRelease({ ...options, publish }), /Deployment notification unavailable/);
    const next = data.serverGit('rev-parse', 'dev');
    assert.equal(JSON.parse(data.serverGit('show', `${next}:package.json`)).version, '1.0.1-dev');
    assert.equal(JSON.parse(data.serverGit('show', 'master:package.json')).version, '1.0.0');
    assert.equal((await publishRelease({ ...options, publish })).complete, true);
    assert.equal(data.serverGit('rev-parse', 'dev'), next);
    const notifications = data.state.calls.filter((call) => call.method === 'POST' && call.path === '/dispatches');
    assert.equal(notifications.length, 2);
    for (const notification of notifications) assert.deepEqual(notification.body, {
        event_type: 'kraftink-release-published', client_payload: { commit: promoted.merge_sha, tag: 'v1.0.0' },
    });
});

test('an untracked deployment workflow cannot enable notifications and changed deployment opt-in invalidates prepared context', async (t) => {
    const data = await fixture(t);
    await mkdir(resolve(data.root, '.github/workflows'), { recursive: true });
    await writeFile(resolve(data.root, '.github/workflows/deploy.yml'), 'untracked opt-in');
    assert.equal((await describeSource(data.root)).kind, 'custom');
    await rm(resolve(data.root, '.github/workflows/deploy.yml'));
    await data.prepare();
    const context = await data.context();
    assert.equal(context.deployment, undefined);
    await writeFile(resolve(data.directory, 'context.json'), JSON.stringify({ ...context, deployment: 'deploy.yml' }));
    await assert.rejects(data.promote(), /source does not match the prepared release/);
    assert.equal(data.state.calls.some((call) => call.path === '/dispatches'), false);
});

test('both human repository writers and active public identity are required before preparing source changes', async (t) => {
    for (const change of [
        (data) => data.state.permissions.rerunner = 'read',
        (data) => data.state.metadata.private = true,
        (data) => data.state.metadata.fork = true,
        (data) => data.state.metadata.default_branch = 'dev',
        (data) => data.environment.GITHUB_EVENT_NAME = 'pull_request',
    ]) {
        const data = await fixture(t);
        change(data);
        await assert.rejects(data.prepare());
        assert.ok(!data.state.calls.some((call) => call.method !== 'GET'));
    }
});

test('contexts from another run, changed build plans and a moved dev branch cannot be promoted', async (t) => {
    for (const change of [
        async (data) => data.environment.GITHUB_RUN_ID = '101',
        async (data) => writeFile(resolve(data.directory, 'plan.json'), '{}\n'),
        async (data) => data.serverGit('update-ref', 'refs/heads/dev', data.original),
    ]) {
        const data = await fixture(t);
        await data.prepare();
        await change(data);
        await assert.rejects(data.promote());
        assert.ok(!data.state.calls.some((call) => call.method === 'PUT'));
        assert.ok(!data.state.calls.some((call) => call.body?.context === 'Release validated source'));
    }
});

test('a synthetic merge containing master-only changes is rejected before merging', async (t) => {
    const data = await fixture(t);
    await data.prepare();
    data.state.wrongMergeTree = true;
    await assert.rejects(data.promote(), /exact validated source tree/);
    assert.ok(!data.state.calls.some((call) => call.method === 'PUT'));
    assert.ok(!data.state.calls.some((call) => call.body?.context === 'Release validated source'));
});

test('permission revocation after merge simulation is detected immediately before the merge', async (t) => {
    const data = await fixture(t);
    await data.prepare();
    data.state.before = async (method, path) => {
        if (method === 'GET' && path === `/git/commits/${data.state.merge}`) data.state.permissions.writer = 'read';
    };
    await assert.rejects(data.promote(), /write access/);
    assert.ok(!data.state.calls.some((call) => call.method === 'PUT'));
    assert.ok(!data.state.calls.some((call) => call.body?.context === 'Release validated source'));
});

test('publication rechecks rights and master immediately before publishing and never advances an incomplete release', async (t) => {
    for (const mode of ['revoked', 'master', 'incomplete']) {
        const data = await fixture(t);
        await data.prepare();
        const promoted = await data.promote();
        await writeFile(resolve(data.assetsDirectory, 'application.txt'), 'built\n');
        let advanced = false;
        await assert.rejects(publishRelease({ ...data,
            environment: { ...data.environment, RELEASE_MERGE_SHA: promoted.merge_sha, RELEASE_PULL_NUMBER: promoted.pull_number },
            publish: async ({ beforeMutation }) => {
                if (mode === 'revoked') data.state.permissions.rerunner = 'read';
                if (mode === 'master') data.serverGit('update-ref', 'refs/heads/master', data.original);
                await beforeMutation('publish');
                return { complete: false };
            }, advance: async () => advanced = true,
        }));
        assert.equal(advanced, false);
    }
});

test('a failed-job rerun can reuse its original prepare artifact but another repository cannot', async (t) => {
    const data = await fixture(t);
    await data.prepare();
    data.environment.GITHUB_RUN_ATTEMPT = '2';
    assert.equal((await data.promote()).pull_number, 1);
    const calls = data.state.calls.length;
    await assert.rejects(data.prepare(), /original open release pull request/);
    assert.ok(data.state.calls.slice(calls).every((call) => call.method === 'GET'));
    data.environment.GITHUB_REPOSITORY = 'Kraftink-CMS/Another';
    await assert.rejects(data.promote(), /this release run/);
});

test('the known promotion number survives delayed merge visibility without relying on the commit index', async (t) => {
    const data = await fixture(t);
    await data.prepare();
    data.state.indexEmpty = 10;
    data.state.pullNotReady = 20;
    data.state.pullNullSha = 1;
    let mergedReads = 0;
    data.state.before = async (method, path) => {
        if (method === 'GET' && path === '/pulls/1' && data.state.pull.state === 'closed') mergedReads++;
    };
    const promoted = await data.promote();
    assert.equal(promoted.pull_number, 1);
    assert.equal(mergedReads, 22);
    const indexed = () => data.state.calls.filter((call) => /^\/commits\/.+\/pulls\?/.test(call.path)).length;
    assert.equal(indexed(), 0);
    data.state.indexEmpty = 1;
    assert.deepEqual(await data.promote(), promoted);
    assert.equal(indexed(), 0);
    await writeFile(resolve(data.assetsDirectory, 'application.txt'), 'built\n');
    data.state.indexEmpty = 10;
    await publishRelease({ ...data, environment: { ...data.environment,
        RELEASE_MERGE_SHA: promoted.merge_sha, RELEASE_PULL_NUMBER: promoted.pull_number },
        publish: async ({ beforeMutation }) => { await beforeMutation('publish'); return { complete: true }; },
        advance: async () => {},
    });
    assert.equal(indexed(), 0);
    data.state.pull.merge_commit_sha = 'f'.repeat(40);
    await assert.rejects(publishRelease({ ...data, environment: { ...data.environment,
        RELEASE_MERGE_SHA: promoted.merge_sha, RELEASE_PULL_NUMBER: promoted.pull_number },
        publish: async () => { throw new Error('Unreachable publication'); },
    }), /The promotion merge changed/);
    data.state.pull.merge_commit_sha = promoted.merge_sha;
    data.state.pull.head.repo.id = 999;
    await assert.rejects(publishRelease({ ...data, environment: { ...data.environment,
        RELEASE_MERGE_SHA: promoted.merge_sha, RELEASE_PULL_NUMBER: promoted.pull_number },
        publish: async () => { throw new Error('Unreachable publication'); },
    }), /exact same-repository/);
});

test('the prepared PR survives a failed build and blocks every new request before source mutations', async (t) => {
    const data = await fixture(t);
    const selected = await data.prepare();
    assert.equal(selected.pull_number, 1);
    assert.equal(data.state.pull.state, 'open');
    assert.equal((await data.context()).pull_number, 1);
    assert.ok(!data.state.calls.some((call) => call.body?.context === 'Release validated source'));
    for (const actor of ['writer', 'rerunner']) {
        const calls = data.state.calls.length;
        await assert.rejects(prepareRelease({ ...data, directory: resolve(data.directory, '../new-context'),
            environment: { ...data.environment, GITHUB_RUN_ID: '101', GITHUB_ACTOR: actor } }),
        /https:\/\/github\.com\/Kraftink-CMS\/Example\/pull\/1/);
        assert.ok(data.state.calls.slice(calls).every((call) => call.method === 'GET'));
        assert.equal(data.serverGit('rev-parse', 'dev'), selected.source_sha);
    }
    data.state.pull.state = 'closed';
    data.state.pull.closed_at = '2026-10-28T12:02:00Z';
    data.state.pull.updated_at = data.state.pull.closed_at;
    data.state.arrivals['101'] = '2026-10-28T12:03:00Z';
    const next = await prepareRelease({ ...data, directory: resolve(data.directory, '../closed-restart'),
        environment: { ...data.environment, GITHUB_RUN_ID: '101' } });
    assert.equal(next.pull_number, 2);
});

test('rerunning all jobs of the original run refreezes a fixed PR without changing its release version or old artifacts', async (t) => {
    const data = await fixture(t);
    const initial = await data.prepare();
    const oldContext = await readFile(resolve(data.directory, 'context.json'), 'utf8');
    const tree = await data.client.request('POST', '/git/trees', { base_tree: data.commit(initial.source_sha).tree.sha,
        tree: [{ path: 'code.txt', mode: '100644', type: 'blob', content: 'fixed build\n' }] });
    const fixed = await data.client.request('POST', '/git/commits', { tree: tree.sha, parents: [initial.source_sha] });
    data.serverGit('update-ref', 'refs/heads/dev', fixed.sha);
    data.environment.GITHUB_RUN_ATTEMPT = '2';
    await assert.rejects(data.promote(), /Rerun all jobs/);
    const directory = resolve(data.directory, '../second-attempt');
    const resumed = await prepareRelease({ ...data, directory });
    assert.equal(resumed.version, initial.version);
    assert.equal(resumed.pull_number, initial.pull_number);
    assert.equal(resumed.source_sha, fixed.sha);
    assert.equal(await readFile(resolve(data.directory, 'context.json'), 'utf8'), oldContext);
    assert.equal(data.state.calls.filter((call) => call.method === 'POST' && call.path === '/pulls').length, 1);
    assert.equal((await promoteRelease({ ...data, directory })).pull_number, initial.pull_number);
});

test('rerunning all jobs refuses a different run, a changed intent or a human-owned PR before writing versions', async (t) => {
    for (const change of [
        (data) => data.environment.GITHUB_RUN_ID = '101',
        (data) => data.state.pull.body += '\nChanged intent',
        (data) => data.state.pull.user = { login: 'writer', type: 'User', id: 11 },
    ]) {
        const data = await fixture(t);
        await data.prepare();
        data.environment.GITHUB_RUN_ATTEMPT = '2';
        change(data);
        const calls = data.state.calls.length;
        await assert.rejects(prepareRelease({ ...data, directory: resolve(data.directory, '../rejected-attempt') }));
        assert.ok(data.state.calls.slice(calls).every((call) => call.method === 'GET'));
    }
});

test('a queued request submitted during an open PR stays rejected after that PR closes', async (t) => {
    const data = await fixture(t);
    await data.prepare();
    data.state.pull.state = 'closed';
    data.state.pull.closed_at = '2026-10-28T12:02:00Z';
    data.state.pull.updated_at = data.state.pull.closed_at;
    data.state.arrivals['101'] = '2026-10-28T12:01:00Z';
    const calls = data.state.calls.length;
    await assert.rejects(prepareRelease({ ...data, directory: resolve(data.directory, '../queued-request'),
        environment: { ...data.environment, GITHUB_RUN_ID: '101' } }), /open release pull request already exists/);
    assert.ok(data.state.calls.slice(calls).every((call) => call.method === 'GET'));
});

test('a merged source still awaiting publication blocks another release before version writes', async (t) => {
    const data = await fixture(t);
    await data.prepare();
    await data.promote();
    data.state.arrivals['101'] = '2026-10-28T12:03:00Z';
    const calls = data.state.calls.length;
    await assert.rejects(prepareRelease({ ...data, directory: resolve(data.directory, '../unpublished-request'),
        environment: { ...data.environment, GITHUB_RUN_ID: '101' } }), /previous stable promotion has not finished publication/);
    assert.ok(data.state.calls.slice(calls).every((call) => call.method === 'GET'));
});

test('custom asset directories and reserved bundles cannot redirect writes through links', async (t) => {
    const data = await fixture(t);
    await data.prepare();
    const promoted = await data.promote();
    await writeFile(resolve(data.assetsDirectory, 'application.txt'), 'built\n');
    const target = resolve(data.root, 'code.txt');
    try {
        await symlink(target, resolve(data.assetsDirectory, 'bundle.json'));
    } catch (error) {
        if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('The current Windows user cannot create file symlinks.'); return; }
        throw error;
    }
    await assert.rejects(publishRelease({ ...data,
        environment: { ...data.environment, RELEASE_MERGE_SHA: promoted.merge_sha,
            RELEASE_PULL_NUMBER: promoted.pull_number } }), /bounded regular file/);
    assert.equal(await readFile(target, 'utf8'), 'original\n');
});
