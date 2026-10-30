import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { reconcileReleaseWorkflow } from './provision-release-workflow.mjs';
import { requestWorkflow } from './provision-release-workflow.mjs';

const repository = 'Kraftink-CMS/Plugin-Sample';
const appSlug = 'kraftink-automation';
const filename = '.github/workflows/release.yml';
const hash = (value) => createHash('sha1').update(value).digest('hex');
const blob = (value) => hash(Buffer.concat([Buffer.from(`blob ${Buffer.byteLength(value)}\0`), Buffer.from(value)]));
const httpError = (status) => Object.assign(new Error(`Fixture HTTP ${status}`), { status });

function fixture({ name = 'Plugin-Sample', masterFile, devFile = masterFile, dev = true, empty = false, before, after } = {}) {
    const repository = `Kraftink-CMS/${name}`;
    const state = {
        metadata: {
            id: 7,
            name,
            full_name: repository,
            owner: { login: 'Kraftink-CMS', type: 'Organization' },
            private: false,
            visibility: 'public',
            archived: false,
            disabled: false,
        },
        refs: new Map(),
        commits: new Map(),
        pulls: [],
        calls: [],
        blocked: false,
        sequence: 0,
    };
    state.addCommit = (files, parents = []) => {
        const tree = hash(JSON.stringify(Object.entries(files).sort()));
        const sha = hash(JSON.stringify({ files, parents, sequence: state.sequence++ }));
        state.commits.set(sha, {
            sha,
            tree: { sha: tree },
            parents: parents.map((parent) => ({ sha: parent })),
            files: { ...files },
        });
        return sha;
    };
    if (!empty) {
        const base = {
            'README.md': 'Original master content\n',
            'LICENSE': 'Original license\n',
            ...(masterFile === undefined ? {} : { [filename]: masterFile }),
        };
        state.refs.set('master', state.addCommit(base));
        if (dev) {
            state.refs.set(
                'dev',
                state.addCommit(
                    {
                        ...base,
                        'source.php': '<?php return "development";',
                        ...(devFile === undefined ? {} : { [filename]: devFile }),
                    },
                    [state.refs.get('master')],
                ),
            );
        }
    }
    state.refValue = (branch) => ({
        ref: `refs/heads/${branch}`,
        object: { type: 'commit', sha: state.refs.get(branch) },
    });
    state.pullValue = (pull) => ({
        ...pull,
        head: { ...pull.head, sha: state.refs.get(pull.head.ref) ?? pull.head.sha },
    });
    state.mergePull = (number) => {
        const pull = state.pulls.find((value) => value.number === number);
        const source = state.refs.get(pull.head.ref);
        const base = state.refs.get(pull.base.ref);
        const sha = state.addCommit(state.commits.get(source).files, [base, source]);
        state.refs.set(pull.base.ref, sha);
        pull.head.sha = source;
        pull.state = 'closed';
        pull.merged_at = '2026-10-27T16:00:00Z';
        pull.merge_commit_sha = sha;
        return { merged: true, sha };
    };
    const client = {
        async request(method, path, content, expected = 200) {
            const target = new URL(`https://api.github.com${path}`);
            const suffix = target.pathname.slice(`/repos/${repository}`.length);
            assert.ok(target.pathname.startsWith(`/repos/${repository}`));
            const call = { method, path, suffix, content, expected, query: target.searchParams };
            state.calls.push(call);
            const override = await before?.(call, state);
            if (override !== undefined) return override;
            let value;
            if (method === 'GET' && suffix === '') value = structuredClone(state.metadata);
            else if (method === 'GET' && suffix === '/git/matching-refs/heads/automation/release-request-')
                value = [...state.refs.keys()].filter((branch) => branch.startsWith('automation/release-request-')).map(state.refValue);
            else if (method === 'GET' && suffix.startsWith('/git/ref/heads/')) {
                const branch = suffix.slice('/git/ref/heads/'.length);
                if (!state.refs.has(branch)) throw httpError(empty ? 409 : 404);
                value = state.refValue(branch);
            } else if (method === 'GET' && suffix.startsWith('/contents/')) {
                assert.equal(suffix, `/contents/${filename}`);
                const sha = target.searchParams.get('ref');
                const files = state.commits.get(sha)?.files;
                assert.ok(files, 'Contents must be read at an immutable commit.');
                if (!Object.hasOwn(files, filename)) throw httpError(404);
                value = {
                    type: 'file',
                    path: filename,
                    encoding: 'base64',
                    content: Buffer.from(files[filename]).toString('base64'),
                    sha: blob(files[filename]),
                };
            } else if (method === 'GET' && suffix.startsWith('/git/commits/')) {
                const stored = state.commits.get(suffix.split('/').at(-1));
                assert.ok(stored);
                const { files, ...record } = stored;
                value = structuredClone(record);
            } else if (method === 'GET' && suffix.startsWith('/compare/')) {
                const [base, head] = suffix.slice('/compare/'.length).split('...');
                const ancestors = new Set();
                const pending = [head];
                while (pending.length) {
                    const sha = pending.pop();
                    if (ancestors.has(sha)) continue;
                    ancestors.add(sha);
                    pending.push(...state.commits.get(sha).parents.map((parent) => parent.sha));
                }
                value = { status: base === head ? 'identical' : ancestors.has(base) ? 'ahead' : 'diverged',
                    base_commit: { sha: base }, merge_base_commit: { sha: ancestors.has(base) ? base : head } };
            } else if (method === 'DELETE' && suffix.startsWith('/git/refs/heads/automation/release-request-')) {
                assert.equal(expected, 204);
                assert.equal(content, undefined);
                const branch = suffix.slice('/git/refs/heads/'.length);
                assert.match(branch, /^automation\/release-request-(?:master|dev)-[a-f0-9]{12}-[a-f0-9]{12}$/);
                assert.ok(state.refs.delete(branch));
                value = null;
            } else if (method === 'POST' && suffix === '/git/refs') {
                assert.equal(expected, 201);
                const branch = content.ref.slice('refs/heads/'.length);
                assert.ok(
                    branch === 'dev' ||
                        /^automation\/release-request-(?:master|dev)-[a-f0-9]{12}-[a-f0-9]{12}$/.test(branch),
                );
                assert.ok(!state.refs.has(branch));
                assert.ok(state.commits.has(content.sha));
                state.refs.set(branch, content.sha);
                value = state.refValue(branch);
            } else if (method === 'PUT' && suffix === `/contents/${filename}`) {
                assert.match(content.branch, /^automation\/release-request-(?:master|dev)-[a-f0-9]{12}-[a-f0-9]{12}$/);
                assert.equal(content.message, 'chore: configure extension release');
                assert.equal(Buffer.from(content.content, 'base64').toString(), requestWorkflow);
                const parent = state.refs.get(content.branch);
                const old = state.commits.get(parent).files;
                if (Object.hasOwn(old, filename)) {
                    assert.equal(content.sha, blob(old[filename]));
                    assert.equal(expected, 200);
                } else {
                    assert.equal(content.sha, undefined);
                    assert.equal(expected, 201);
                }
                const sha = state.addCommit({ ...old, [filename]: requestWorkflow }, [parent]);
                state.refs.set(content.branch, sha);
                value = { content: { path: filename, sha: blob(requestWorkflow) }, commit: { sha } };
            } else if (suffix === '/pulls' && method === 'GET') {
                assert.ok(['open', 'closed'].includes(target.searchParams.get('state')));
                const head = target.searchParams.get('head')?.split(':')[1];
                const page = Number(target.searchParams.get('page'));
                const selected = state.pulls.filter(
                    (pull) =>
                        pull.state === target.searchParams.get('state') &&
                        (!target.searchParams.has('base') || pull.base.ref === target.searchParams.get('base')) &&
                        (head === undefined || pull.head.ref === head),
                );
                value = selected.slice((page - 1) * 100, page * 100).map(state.pullValue);
            } else if (suffix === '/pulls' && method === 'POST') {
                assert.equal(expected, 201);
                assert.equal(content.title, 'chore: configure extension release');
                assert.ok(['master', 'dev'].includes(content.base));
                assert.match(
                    content.head,
                    new RegExp(`^automation/release-request-${content.base}-[a-f0-9]{12}-[a-f0-9]{12}$`),
                );
                assert.equal(
                    content.body,
                    'Configure the managed Release button. This pull request changes only .github/workflows/release.yml.',
                );
                const repo = { id: state.metadata.id, full_name: repository };
                const pull = {
                    number: state.pulls.length + 1,
                    state: 'open',
                    merged_at: null,
                    merge_commit_sha: null,
                    mergeable: true,
                    mergeable_state: 'clean',
                    draft: false,
                    user: { login: `${appSlug}[bot]`, type: 'Bot' },
                    head: { ref: content.head, sha: state.refs.get(content.head), repo },
                    base: { ref: content.base, sha: state.refs.get(content.base), repo },
                };
                state.pulls.push(pull);
                value = state.pullValue(pull);
            } else if (/^\/pulls\/\d+\/files$/.test(suffix) && method === 'GET') {
                const pull = state.pulls.find((entry) => entry.number === Number(suffix.split('/')[2]));
                const original = state.commits.get(pull.base.sha).files;
                const updated = state.commits.get(state.refs.get(pull.head.ref) ?? pull.head.sha).files;
                const paths = [...new Set([...Object.keys(original), ...Object.keys(updated)])];
                value = paths
                    .filter((path) => original[path] !== updated[path])
                    .map((path) => ({
                        filename: path,
                        status:
                            original[path] === undefined
                                ? 'added'
                                : updated[path] === undefined
                                  ? 'removed'
                                  : 'modified',
                        sha: blob(updated[path] ?? ''),
                    }));
            } else if (/^\/pulls\/\d+$/.test(suffix) && method === 'PATCH') {
                assert.deepEqual(content, { state: 'closed' });
                const pull = state.pulls.find((entry) => entry.number === Number(suffix.split('/')[2]));
                assert.ok(pull);
                assert.equal(pull.state, 'open');
                assert.equal(pull.merged_at, null);
                pull.state = 'closed';
                value = state.pullValue(pull);
            } else if (/^\/pulls\/\d+$/.test(suffix) && method === 'GET') {
                const pull = state.pulls.find((entry) => entry.number === Number(suffix.split('/')[2]));
                assert.ok(pull);
                value = state.pullValue(pull);
            } else if (/^\/pulls\/\d+\/merge$/.test(suffix) && method === 'PUT') {
                assert.deepEqual(Object.keys(content).sort(), ['merge_method', 'sha']);
                assert.equal(content.merge_method, 'merge');
                const pull = state.pulls.find((entry) => entry.number === Number(suffix.split('/')[2]));
                assert.equal(content.sha, state.refs.get(pull.head.ref));
                if (state.blocked) throw httpError(state.blocked === true ? 405 : state.blocked);
                value = state.mergePull(pull.number);
            } else throw new Error(`Unexpected fixture operation ${method} ${path}`);
            return (await after?.(call, value, state)) ?? value;
        },
    };
    const execute = (options = {}) =>
        reconcileReleaseWorkflow({ client, repository, appSlug, wait: async () => {}, ...options });
    return { client, state, execute };
}

const writes = (state) => state.calls.filter((call) => call.method !== 'GET');
const merges = (state) => state.calls.filter((call) => call.method === 'PUT' && call.suffix.endsWith('/merge'));
const fileAt = (state, branch) => state.commits.get(state.refs.get(branch)).files[filename];

function supersedeSetup(state, { legacy = false } = {}) {
    const pull = state.pulls[0];
    const oldTemplate = requestWorkflow.replace('Kraftink-CMS/automation/', 'Kraftink-CMS/extension-tools/');
    assert.notEqual(oldTemplate, requestWorkflow);
    const originalBranch = pull.head.ref;
    const prefix = originalBranch.replace(/-[a-f0-9]{12}$/, '');
    const branch = legacy ? prefix : `${prefix}-${blob(oldTemplate).slice(0, 12)}`;
    const head = state.addCommit({ ...state.commits.get(pull.base.sha).files, [filename]: oldTemplate }, [
        pull.base.sha,
    ]);
    state.refs.delete(originalBranch);
    state.refs.set(branch, head);
    pull.head = { ...pull.head, ref: branch, sha: head };
    return pull;
}

test('installs the exact managed workflow on master and dev through separate App-owned single-file pull requests', async () => {
    const { state, execute } = fixture();
    const original = new Map([...state.refs].map(([branch, sha]) => [branch, { ...state.commits.get(sha).files }]));
    const reports = await execute();
    assert.deepEqual(
        reports.map((entry) => [entry.branch, entry.action]),
        [
            ['master', 'configured'],
            ['dev', 'configured'],
        ],
    );
    assert.equal(state.pulls.length, 2);
    assert.deepEqual(
        state.pulls.map((pull) => pull.base.ref),
        ['master', 'dev'],
    );
    for (const branch of ['master', 'dev']) {
        assert.equal(fileAt(state, branch), requestWorkflow);
        const files = { ...state.commits.get(state.refs.get(branch)).files };
        delete files[filename];
        assert.deepEqual(files, original.get(branch));
    }
    assert.equal(merges(state).length, 2);
    assert.ok(writes(state).every((call) => !/releases|actions\/workflows|delete|force/i.test(call.suffix)));
    assert.ok(state.calls.every((call) => call.method !== 'PATCH'));
    assert.equal(state.calls.filter((call) => call.method === 'DELETE').length, 2);
    assert.deepEqual([...state.refs.keys()].sort(), ['dev', 'master']);
});

test('replaces old heavy release workflows without changing author source files or repository settings', async () => {
    const old = 'name: Old package pipeline\non: [push]\njobs: {}\n';
    const { state, execute } = fixture({ masterFile: old, devFile: `${old}# old dev workflow\n` });
    assert.ok((await execute()).every((entry) => entry.action === 'configured'));
    const updates = writes(state).filter((call) => call.suffix.startsWith('/contents/'));
    assert.equal(updates.length, 2);
    assert.ok(updates.every((call) => call.content.sha));
    assert.equal(fileAt(state, 'master'), requestWorkflow);
    assert.equal(fileAt(state, 'dev'), requestWorkflow);
    assert.ok(!writes(state).some((call) => call.suffix === ''));
});

test('an already configured repository is a read-only no-op', async () => {
    const { state, execute } = fixture({ masterFile: requestWorkflow });
    assert.deepEqual(
        (await execute()).map((entry) => entry.action),
        ['unchanged', 'unchanged'],
    );
    assert.equal(writes(state).length, 0);
    assert.equal(state.calls.filter((call) => call.suffix === '/git/matching-refs/heads/automation/release-request-').length, 1);
    assert.equal(state.calls.some((call) => call.suffix === '/pulls'), false);
});

test('a later pass cleans verified merged setup branches even when both wrappers are already current', async () => {
    let hold = true;
    const { state, execute } = fixture({ before(call) {
        if (hold && call.method === 'DELETE') throw httpError(503);
    } });
    assert.ok((await execute()).every((entry) => entry.action === 'configured'));
    assert.equal([...state.refs.keys()].filter((branch) => branch.startsWith('automation/')).length, 2);
    hold = false;
    const result = await execute();
    assert.deepEqual(result.map((entry) => entry.action), ['unchanged', 'unchanged']);
    assert.match(result[0].note, /Removed 2 merged setup branches/);
    assert.deepEqual([...state.refs.keys()].sort(), ['dev', 'master']);
    assert.equal(state.commits.get(state.refs.get('master')).files.LICENSE, 'Original license\n');
    assert.equal(state.commits.get(state.refs.get('dev')).files.LICENSE, 'Original license\n');
    const calls = state.calls.length;
    await execute();
    assert.equal(state.calls.slice(calls).some((call) => call.suffix === '/pulls'), false);
});

test('cleanup proves an older wrapper merge before removing its original setup branch', async () => {
    const { state, execute } = fixture();
    state.blocked = true;
    await execute();
    const older = supersedeSetup(state);
    const branch = older.head.ref;
    state.mergePull(older.number);
    state.blocked = false;
    assert.ok((await execute()).every((entry) => entry.action === 'configured'));
    assert.equal(state.refs.has(branch), false);
    assert.equal(state.pulls.find((pull) => pull.number === older.number).merged_at !== null, true);
    assert.equal(fileAt(state, 'master'), requestWorkflow);
    assert.equal(state.commits.get(state.refs.get('master')).files.LICENSE, 'Original license\n');
});

test('cleanup retains unmerged, repurposed or still referenced setup branches', async (context) => {
    for (const kind of ['unmerged', 'human', 'foreign', 'moved', 'extra-file', 'ancestry', 'open-head', 'open-base', 'last-read-race']) {
        await context.test(kind, async () => {
            let hold = true;
            let guardedBranch;
            let reads = 0;
            const { state, execute } = fixture({ before(call, state) {
                if (hold && call.method === 'DELETE') throw httpError(503);
                if (!hold && kind === 'last-read-race' && call.suffix === `/git/ref/heads/${guardedBranch}`
                        && ++reads === 2) {
                    const previous = state.refs.get(guardedBranch);
                    state.refs.set(guardedBranch, state.addCommit({ ...state.commits.get(previous).files, 'human.txt': 'Keep me' }, [previous]));
                }
            }, after(call, value) {
                if (!hold && kind === 'extra-file' && call.suffix === '/pulls/1/files')
                    return [...value, { filename: 'human.txt', status: 'added', sha: 'f'.repeat(40) }];
            } });
            await execute();
            const pull = state.pulls[0];
            guardedBranch = pull.head.ref;
            const previous = state.refs.get(guardedBranch);
            if (kind === 'unmerged') pull.merged_at = null;
            if (kind === 'human') pull.user = { login: 'maintainer', type: 'User' };
            if (kind === 'foreign') pull.head.repo = { id: 99, full_name: 'Other/Project' };
            if (kind === 'moved')
                state.refs.set(guardedBranch, state.addCommit({ ...state.commits.get(previous).files, 'human.txt': 'Keep me' }, [previous]));
            if (kind === 'ancestry')
                state.refs.set('master', state.addCommit(state.commits.get(state.refs.get('master')).files));
            if (kind.startsWith('open-')) state.pulls.push({ number: 99, state: 'open', merged_at: null,
                head: { ref: kind === 'open-head' ? guardedBranch : 'human-feature' },
                base: { ref: kind === 'open-base' ? guardedBranch : 'dev' } });
            const start = state.calls.length;
            hold = false;
            const result = await execute();
            assert.ok(result.every((entry) => entry.action === 'unchanged'));
            assert.match(result[0].note, /retained for manual review/);
            assert.equal(state.refs.has(guardedBranch), true);
            assert.equal(state.calls.slice(start).some((call) => call.method === 'DELETE'
                && call.suffix === `/git/refs/heads/${guardedBranch}`), false);
        });
    }
});

test('a custom repository opts in with the exact dev wrapper and bootstraps only that workflow on master', async () => {
    const { state, execute } = fixture({ name: 'Custom-Assets', devFile: requestWorkflow });
    const dev = state.refs.get('dev');
    const original = { ...state.commits.get(state.refs.get('master')).files };
    const reports = await execute();
    assert.deepEqual(reports.map((entry) => [entry.branch, entry.action]), [
        ['master', 'configured'], ['dev', 'unchanged'],
    ]);
    assert.equal(state.refs.get('dev'), dev);
    assert.equal(state.pulls.length, 1);
    assert.equal(state.pulls[0].base.ref, 'master');
    assert.equal(fileAt(state, 'master'), requestWorkflow);
    const master = { ...state.commits.get(state.refs.get('master')).files };
    delete master[filename];
    assert.deepEqual(master, original);
    assert.ok(writes(state).every((call) => !/releases|actions\/workflows|dispatches|delete|force/i.test(call.suffix)));
    const count = writes(state).length;
    assert.ok((await execute()).every((entry) => entry.action === 'unchanged'));
    assert.equal(writes(state).length, count);
});

test('a published custom wrapper is upgraded with release note choices while preserving its source', async () => {
    const legacy = `name: Release
on:
  workflow_dispatch:
    inputs:
      bump:
        description: Version level
        type: choice
        options: [auto, patch, minor, major]
        default: auto
permissions:
  contents: write
  pull-requests: write
  statuses: write
  actions: read
jobs:
  release:
    uses: Kraftink-CMS/automation/.github/workflows/request-extension-release.yml@master
    with:
      bump: \${{ inputs.bump }}
`;
    const { state, execute } = fixture({ name: 'Custom-Assets', masterFile: legacy, devFile: legacy });
    const before = Object.fromEntries(['master', 'dev'].map((branch) => {
        const files = { ...state.commits.get(state.refs.get(branch)).files };
        delete files[filename];
        return [branch, files];
    }));
    assert.deepEqual((await execute()).map((entry) => entry.action), ['configured', 'configured']);
    for (const branch of ['master', 'dev']) {
        assert.equal(fileAt(state, branch), requestWorkflow);
        const files = { ...state.commits.get(state.refs.get(branch)).files };
        delete files[filename];
        assert.deepEqual(files, before[branch]);
    }
    assert.equal([...state.refs.keys()].some((ref) => ref.startsWith('automation/')), false);
});

test('custom repositories without an exact dev opt-in keep their own workflows and branches untouched', async () => {
    for (const options of [
        {},
        { dev: false },
        { devFile: requestWorkflow + '\n' },
        { devFile: requestWorkflow.replace('contents: write', 'contents: read') },
    ]) {
        const { state, execute } = fixture({ name: 'Custom-Assets', ...options });
        const refs = [...state.refs];
        assert.deepEqual((await execute()).map((entry) => entry.action), ['unchanged']);
        assert.deepEqual([...state.refs], refs);
        assert.deepEqual(writes(state), []);
    }
});

test('custom bootstrapping refuses a human setup PR and a dev opt-in that moves before mutation', async () => {
    const human = fixture({ name: 'Custom-Assets', devFile: requestWorkflow });
    human.state.blocked = true;
    assert.equal((await human.execute())[0].action, 'pending');
    const attempts = merges(human.state).length;
    human.state.pulls[0].user = { login: 'maintainer', type: 'User' };
    human.state.blocked = false;
    assert.equal((await human.execute())[0].action, 'failed');
    assert.equal(merges(human.state).length, attempts);
    const changed = fixture({ name: 'Custom-Assets', devFile: requestWorkflow,
        before(call, state) {
            if (call.method !== 'GET' || call.suffix !== '/git/ref/heads/master') return;
            const previous = state.refs.get('dev');
            state.refs.set('dev', state.addCommit({ ...state.commits.get(previous).files,
                [filename]: requestWorkflow + '\n' }, [previous]));
        },
    });
    assert.equal((await changed.execute())[0].action, 'failed');
    assert.deepEqual(writes(changed.state), []);
});

test('a custom opt-in dev branch removed after the master bootstrap is never recreated', async () => {
    const { state, execute } = fixture({ name: 'Custom-Assets', devFile: requestWorkflow,
        after(call, value, state) {
            if (call.method === 'PUT' && call.suffix.endsWith('/merge')) state.refs.delete('dev');
        },
    });
    const reports = await execute();
    assert.deepEqual(reports.map((entry) => [entry.branch, entry.action]), [
        ['master', 'configured'], ['dev', 'pending'],
    ]);
    assert.equal(state.refs.has('dev'), false);
    assert.equal(state.calls.some((call) => call.method === 'POST' && call.content?.ref === 'refs/heads/dev'), false);
});

test('master and dev are reconciled independently when one workflow is already configured', async (context) => {
    for (const configured of ['master', 'dev']) {
        await context.test(configured, async () => {
            const { state, execute } = fixture({
                masterFile: configured === 'master' ? requestWorkflow : 'old workflow',
                devFile: configured === 'dev' ? requestWorkflow : 'old workflow',
            });
            const reports = await execute();
            assert.equal(reports.find((entry) => entry.branch === configured).action, 'unchanged');
            assert.equal(reports.find((entry) => entry.branch !== configured).action, 'configured');
            assert.equal(state.pulls.length, 1);
            assert.notEqual(state.pulls[0].base.ref, configured);
        });
    }
});

test('a custom workflow under another filename is preserved on both branches', async () => {
    const { state, execute } = fixture();
    const custom = '.github/workflows/custom-deploy.yml';
    const bytes = 'name: Custom deployment\non: [push]\njobs: {}\n';
    for (const branch of ['master', 'dev']) {
        const parent = state.refs.get(branch);
        state.refs.set(branch, state.addCommit({ ...state.commits.get(parent).files, [custom]: bytes }, [parent]));
    }
    assert.ok((await execute()).every((entry) => entry.action === 'configured'));
    for (const branch of ['master', 'dev']) {
        assert.equal(state.commits.get(state.refs.get(branch)).files[custom], bytes);
        assert.equal(fileAt(state, branch), requestWorkflow);
    }
    assert.ok(state.calls.every((call) => call.method !== 'PATCH'));
});

test('check mode describes changes for both branches without creating refs, files or pull requests', async () => {
    for (const dev of [true, false]) {
        const { state, execute } = fixture({ dev });
        assert.deepEqual(
            (await execute({ check: true })).map((entry) => entry.action),
            ['planned', 'planned'],
        );
        assert.equal(writes(state).length, 0);
    }
});

test('creates a missing dev branch only from master after its exact managed workflow was merged', async () => {
    const { state, execute } = fixture({ dev: false });
    assert.deepEqual(
        (await execute()).map((entry) => entry.action),
        ['configured', 'configured'],
    );
    assert.equal(state.refs.get('dev'), state.refs.get('master'));
    assert.equal(fileAt(state, 'dev'), requestWorkflow);
    assert.equal(state.pulls.length, 1);
    const creation = writes(state).findIndex((call) => call.content?.ref === 'refs/heads/dev');
    const merged = writes(state).findIndex((call) => call.suffix.endsWith('/merge'));
    assert.ok(creation > merged);
});

test('empty repositories remain untouched until a first master commit exists', async () => {
    const { state, execute } = fixture({ empty: true });
    const reports = await execute();
    assert.deepEqual(
        reports.map((entry) => entry.action),
        ['pending', 'pending'],
    );
    assert.match(reports[0].note, /first commit/);
    assert.equal(writes(state).length, 0);
    assert.equal(state.refs.size, 0);
});

test('does not invent master or change the default branch for an existing repository', async () => {
    const { state, execute } = fixture();
    state.refs.set('main', state.refs.get('master'));
    state.refs.delete('master');
    state.metadata.default_branch = 'main';
    assert.deepEqual(
        (await execute()).map((entry) => entry.action),
        ['pending', 'pending'],
    );
    assert.equal(writes(state).length, 0);
    assert.equal(state.metadata.default_branch, 'main');
});

test('required review or protection failures keep the master setup PR open and postpone dev', async (context) => {
    for (const status of [403, 405, 409, 422]) {
        await context.test(String(status), async () => {
            const { state, execute } = fixture();
            state.blocked = status;
            assert.deepEqual(
                (await execute()).map((entry) => entry.action),
                ['pending', 'pending'],
            );
            assert.equal(state.pulls.length, 1);
            assert.equal(state.pulls[0].state, 'open');
            assert.equal(fileAt(state, 'master'), undefined);
            assert.ok(!writes(state).some((call) => call.content.branch?.includes('-dev-')));
        });
    }
});

test('a later pass reuses the pending setup PR and commit before continuing to dev', async () => {
    const { state, execute } = fixture();
    state.blocked = true;
    await execute();
    const firstHead = state.pulls[0].head.sha;
    const writesBefore = writes(state).length;
    state.blocked = false;
    assert.deepEqual(
        (await execute()).map((entry) => entry.action),
        ['configured', 'configured'],
    );
    assert.equal(state.pulls.length, 2);
    assert.equal(state.pulls[0].head.sha, firstHead);
    assert.equal(
        writes(state)
            .slice(writesBefore)
            .filter((call) => call.method === 'POST' && call.suffix === '/pulls').length,
        1,
    );
});

test('a newer template supersedes an old App setup PR without rewriting or deleting its branch', async (context) => {
    for (const legacy of [true, false]) {
        await context.test(legacy ? 'legacy branch name' : 'template-specific branch name', async () => {
            const { state, execute } = fixture();
            state.blocked = true;
            await execute();
            const obsolete = supersedeSetup(state, { legacy });
            const previousBranch = obsolete.head.ref;
            const previousHead = state.refs.get(previousBranch);
            state.blocked = false;
            assert.deepEqual(
                (await execute()).map((entry) => entry.action),
                ['configured', 'configured'],
            );
            assert.equal(obsolete.state, 'closed');
            assert.equal(obsolete.merged_at, null);
            assert.equal(state.refs.get(previousBranch), previousHead);
            assert.ok(state.pulls.slice(1).every((pull) => pull.merged_at));
            assert.equal(fileAt(state, 'master'), requestWorkflow);
            assert.equal(fileAt(state, 'dev'), requestWorkflow);
            assert.equal(state.calls.filter((call) => call.method === 'PATCH').length, 1);
            assert.ok(!state.calls.some((call) => call.method === 'DELETE' && call.suffix.endsWith(previousBranch)));
            const before = writes(state).length;
            assert.deepEqual(
                (await execute()).map((entry) => entry.action),
                ['unchanged', 'unchanged'],
            );
            assert.equal(writes(state).length, before);
        });
    }
});

test('check mode leaves an obsolete setup PR and its branch untouched', async () => {
    const { state, execute } = fixture();
    state.blocked = true;
    await execute();
    const obsolete = supersedeSetup(state, { legacy: true });
    const before = writes(state).length;
    assert.deepEqual(
        (await execute({ check: true })).map((entry) => entry.action),
        ['planned', 'planned'],
    );
    assert.equal(writes(state).length, before);
    assert.equal(obsolete.state, 'open');
});

test('superseding setup preserves unrelated or unverifiable pull requests and still configures the repository', async (context) => {
    for (const kind of ['human', 'other-app', 'repository', 'namespace', 'foreign-file', 'parents', 'close-denied']) {
        await context.test(kind, async () => {
            const { state, execute } = fixture({
                before: (call) => {
                    if (kind === 'close-denied' && call.method === 'PATCH') throw httpError(403);
                },
            });
            state.blocked = true;
            await execute();
            const obsolete = supersedeSetup(state);
            if (kind === 'human') obsolete.user = { login: 'contributor', type: 'User' };
            if (kind === 'other-app') obsolete.user = { login: 'other-app[bot]', type: 'Bot' };
            if (kind === 'repository') obsolete.head.repo = { ...obsolete.head.repo, id: 88 };
            if (kind === 'namespace') {
                const previous = obsolete.head.ref;
                obsolete.head.ref = 'custom-release-workflow';
                state.refs.set(obsolete.head.ref, state.refs.get(previous));
                state.refs.delete(previous);
            }
            if (['foreign-file', 'parents'].includes(kind)) {
                const source = state.commits.get(obsolete.head.sha);
                const head = state.addCommit(
                    { ...source.files, ...(kind === 'foreign-file' ? { 'custom.php': '<?php custom();' } : {}) },
                    [kind === 'parents' ? state.refs.get('dev') : obsolete.base.sha],
                );
                state.refs.set(obsolete.head.ref, head);
                obsolete.head.sha = head;
            }
            state.blocked = false;
            const reports = await execute();
            assert.deepEqual(
                reports.map((entry) => entry.action),
                ['configured', 'configured'],
            );
            assert.equal(obsolete.state, 'open');
            assert.equal(obsolete.merged_at, null);
            assert.equal(state.calls.filter((call) => call.method === 'PATCH').length, kind === 'close-denied' ? 1 : 0);
            if (['foreign-file', 'parents', 'close-denied'].includes(kind))
                assert.match(reports[0].note, /could not be closed safely/);
        });
    }
});

test('rejects an existing setup pull request authored by a person or another App', async (context) => {
    for (const user of [
        { login: 'contributor', type: 'User' },
        { login: 'other-app[bot]', type: 'Bot' },
    ]) {
        await context.test(user.login, async () => {
            const { state, execute } = fixture();
            state.blocked = true;
            await execute();
            state.pulls[0].user = user;
            state.blocked = false;
            const count = merges(state).length;
            assert.deepEqual(
                (await execute()).map((entry) => entry.action),
                ['failed', 'pending'],
            );
            assert.equal(merges(state).length, count);
        });
    }
});

test('rejects setup branches with unrelated parents, foreign files or a modified managed template', async (context) => {
    for (const tamper of ['parents', 'foreign-file', 'workflow']) {
        await context.test(tamper, async () => {
            const { state, execute } = fixture();
            state.blocked = true;
            await execute();
            const pull = state.pulls[0];
            const source = state.commits.get(pull.head.sha);
            const changed = { ...source.files };
            if (tamper === 'foreign-file') changed['foreign.php'] = '<?php malicious();';
            if (tamper === 'workflow') changed[filename] = requestWorkflow.replace('contents: write', 'contents: read');
            const head = state.addCommit(changed, [tamper === 'parents' ? state.refs.get('dev') : pull.base.sha]);
            state.refs.set(pull.head.ref, head);
            state.blocked = false;
            const count = merges(state).length;
            assert.equal((await execute())[0].action, 'failed');
            assert.equal(merges(state).length, count);
        });
    }
});

test('rejects ambiguous setup pull requests and invalid changed-file inventories', async (context) => {
    for (const kind of ['duplicate', 'file-name', 'blob', 'rename', 'extra', 'unbounded']) {
        await context.test(kind, async () => {
            let enabled = false;
            const { state, execute } = fixture({
                after: (call, value) => {
                    if (!enabled) return;
                    if (kind === 'duplicate' && call.method === 'GET' && call.suffix === '/pulls')
                        return [...value, ...value];
                    if (!call.suffix.endsWith('/files')) return;
                    const first = { ...value[0] };
                    if (kind === 'file-name') first.filename = 'other.yml';
                    if (kind === 'blob') first.sha = 'f'.repeat(40);
                    if (kind === 'rename') first.previous_filename = 'old.yml';
                    if (kind === 'extra') return [first, { ...first, filename: 'another.php' }];
                    if (kind === 'unbounded') return Array.from({ length: 100 }, () => first);
                    return [first];
                },
            });
            state.blocked = true;
            await execute();
            enabled = true;
            state.blocked = false;
            const count = merges(state).length;
            assert.equal((await execute())[0].action, 'failed');
            assert.equal(merges(state).length, count);
        });
    }
});

test('rereads public repository ownership before mutations and never follows a changed identity', async (context) => {
    for (const changes of [
        { id: 88 },
        { private: true, visibility: 'private' },
        { owner: { login: 'Other', type: 'Organization' } },
        { archived: true },
        { disabled: true },
    ]) {
        await context.test(JSON.stringify(changes), async () => {
            let reads = 0;
            const { state, execute } = fixture({
                after: (call, value) => {
                    if (call.suffix === '' && ++reads === 2) return { ...value, ...changes };
                },
            });
            assert.deepEqual(
                (await execute()).map((entry) => entry.action),
                ['failed', 'pending'],
            );
            assert.equal(writes(state).length, 0);
        });
    }
});

test('refuses to merge when the branch base advances during setup preparation', async () => {
    let moved = false;
    const { state, execute } = fixture({
        before: (call, current) => {
            if (!moved && call.method === 'GET' && call.suffix === '/git/ref/heads/master' && current.pulls.length) {
                moved = true;
                const sha = current.addCommit(
                    { ...current.commits.get(current.refs.get('master')).files, 'new.txt': 'Concurrent source' },
                    [current.refs.get('master')],
                );
                current.refs.set('master', sha);
            }
        },
    });
    assert.deepEqual(
        (await execute()).map((entry) => entry.action),
        ['failed', 'pending'],
    );
    assert.equal(merges(state).length, 0);
    assert.equal(state.commits.get(state.refs.get('master')).files['new.txt'], 'Concurrent source');
});

test('rejects a different pull request number returned during a setup refresh', async () => {
    const { state, execute } = fixture({
        after: (call, value) =>
            /^\/pulls\/\d+$/.test(call.suffix) ? { ...value, number: value.number + 10 } : undefined,
    });
    assert.deepEqual(
        (await execute()).map((entry) => entry.action),
        ['failed', 'pending'],
    );
    assert.equal(merges(state).length, 0);
});

test('a merge is confirmed only when its exact parents, tree and branch ref preserve the setup commit', async (context) => {
    for (const kind of ['parents', 'tree', 'branch']) {
        await context.test(kind, async () => {
            const { execute } = fixture({
                after: (call, value, state) => {
                    if (call.method !== 'PUT' || !call.suffix.endsWith('/merge')) return;
                    const merge = state.commits.get(value.sha);
                    if (kind === 'parents') merge.parents.reverse();
                    if (kind === 'tree') merge.tree.sha = 'f'.repeat(40);
                    if (kind === 'branch') state.refs.set('master', merge.parents[0].sha);
                },
            });
            assert.deepEqual(
                (await execute()).map((entry) => entry.action),
                ['failed', 'pending'],
            );
        });
    }
});

test('mergeability checks use at most two short waits before leaving the PR pending', async () => {
    const { state, execute } = fixture({
        after: (call, value) => (/^\/pulls\/\d+$/.test(call.suffix) ? { ...value, mergeable: null } : undefined),
    });
    const waits = [];
    assert.deepEqual(
        (await execute({ wait: async (duration) => waits.push(duration) })).map((entry) => entry.action),
        ['pending', 'pending'],
    );
    assert.deepEqual(waits, [1000, 1000]);
    assert.equal(merges(state).length, 0);
});

test('reconciles a concurrent legitimate App merge after a merge API conflict', async () => {
    const { execute } = fixture({
        before: (call, state) => {
            if (call.method === 'PUT' && call.suffix.endsWith('/merge')) {
                state.mergePull(Number(call.suffix.split('/')[2]));
                throw httpError(405);
            }
        },
    });
    assert.deepEqual(
        (await execute()).map((entry) => entry.action),
        ['configured', 'configured'],
    );
});

test('a closed setup PR waits for its merge SHA before checking the immutable merge proof', async () => {
    let settling = true;
    const { execute } = fixture({ after(call, value) {
        if (settling && call.method === 'GET' && /^\/pulls\/\d+$/.test(call.suffix)
                && value.state === 'closed' && value.merged_at) {
            settling = false;
            return { ...value, merge_commit_sha: null };
        }
    } });
    assert.ok((await execute()).every((entry) => entry.action === 'configured'));
    assert.equal(settling, false);
});

test('setup merge confirmation tolerates twenty-one stale open PR reads before the merged state appears', async () => {
    let staleReads = 0;
    const waits = [];
    const { state, execute } = fixture({ after(call, value) {
        if (call.method === 'GET' && call.suffix === '/pulls/1'
                && value.state === 'closed' && value.merged_at && staleReads < 21) {
            staleReads++;
            return { ...value, state: 'open', merged_at: null };
        }
    } });
    assert.ok((await execute({ wait: async (duration) => waits.push(duration) }))
        .every((entry) => entry.action === 'configured'));
    assert.equal(staleReads, 21);
    assert.deepEqual(waits, Array(21).fill(1000));
    assert.equal(merges(state).length, 2);
});

test('malformed file contents and secret-bearing transport failures fail safely', async (context) => {
    for (const kind of ['base64', 'blob', 'network']) {
        await context.test(kind, async () => {
            const { state, execute } = fixture({
                masterFile: 'old workflow',
                after: (call, value) => {
                    if (!call.suffix.startsWith('/contents/')) return;
                    if (kind === 'network') throw new Error('private-key-and-token-must-not-leak');
                    return { ...value, ...(kind === 'base64' ? { content: '@@@' } : { sha: 'f'.repeat(40) }) };
                },
            });
            const reports = await execute();
            assert.equal(reports[0].action, 'failed');
            assert.ok(!JSON.stringify(reports).includes('private-key-and-token-must-not-leak'));
            assert.equal(writes(state).length, 0);
        });
    }
});

test('rejects foreign organizations and unsafe names before any API request', async () => {
    const { state, execute } = fixture();
    for (const name of [
        'Other/Plugin-Sample',
        'Kraftink-CMS/../Plugin-Sample',
        'Kraftink-CMS/Plugin-Sample?ref=dev',
    ]) {
        await assert.rejects(execute({ repository: name }), /public Kraftink-CMS repositories/);
    }
    assert.equal(state.calls.length, 0);
});
