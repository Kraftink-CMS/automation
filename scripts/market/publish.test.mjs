import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
    authorizeMarketRefresh,
    createMarketClient,
    parseMarketArguments,
    reconcileMarket,
    validateMarketEnvironment,
} from './publish.mjs';

const repository = 'Kraftink-CMS/Market';
const prefix = `/repos/${repository}`;
const appId = 77;
const appSlug = 'kraftink-automation';
const token = `opaque-installation.${'a'.repeat(8192)}`;
const digest = (value) => createHash('sha1').update(value).digest('hex');
const blob = (bytes) => digest(Buffer.concat([Buffer.from(`blob ${Buffer.byteLength(bytes)}\0`), Buffer.from(bytes)]));
const encode = (value) => JSON.stringify(value, null, 4) + '\n';

function treeHash(entries) {
    const bytes = Buffer.concat(
        [...entries]
            .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
            .flatMap((entry) => [Buffer.from(`${entry.mode} ${entry.path}\0`), Buffer.from(entry.sha, 'hex')]),
    );
    return digest(Buffer.concat([Buffer.from(`tree ${bytes.length}\0`), bytes]));
}

function metadata(entry) {
    const repo = entry.repository.replace('https://github.com/', '');
    const [owner, name] = repo.split('/');
    const slug = name.slice('Plugin-'.length).toLowerCase();
    const resource = {
        id: `${owner}/${slug}`,
        slug,
        type: 'plugin',
        name: { en: slug },
        description: { en: 'A published resource.' },
        author: { id: owner, name: owner },
        repository: `https://github.com/${repo}`,
        commercial: { kind: 'free' },
    };
    const version = {
        version: '1.0.0',
        requirements: { cms: '>=0.0.1', php: '^8.3' },
        download: {
            url: `${resource.repository}/releases/download/v1.0.0/${slug}-1.0.0.zip`,
            sha256: 'a'.repeat(64),
        },
    };
    return { schema_version: 1, slug, type: 'plugin', resource, ...version, versions: [version] };
}

function fixture({ frozen = false, before, after, large = false } = {}) {
    const state = {
        calls: [],
        fetched: [],
        blobs: new Map(),
        trees: new Map(),
        commits: new Map(),
        refs: new Map(),
        pulls: [],
        sequence: 0,
        blocked: null,
        metadata: {
            id: 9,
            full_name: repository,
            name: 'Market',
            owner: { login: 'Kraftink-CMS', type: 'Organization' },
            private: false,
            visibility: 'public',
            archived: false,
            disabled: false,
        },
    };
    state.addTree = (files) => {
        const tree = Object.entries(files).map(([path, bytes]) => {
            const sha = blob(bytes);
            state.blobs.set(sha, bytes);
            return { path, mode: '100644', type: 'blob', sha };
        });
        const sha = treeHash(tree);
        state.trees.set(sha, tree);
        return sha;
    };
    state.addCommit = (files, parents = []) => {
        const tree = state.addTree(files);
        const sha = digest(JSON.stringify({ tree, parents, sequence: state.sequence++ }));
        state.commits.set(sha, {
            sha,
            tree: { sha: tree },
            parents: parents.map((sha) => ({ sha })),
            files: { ...files },
        });
        return sha;
    };
    const source = {
        schema_version: 1,
        repositories: [
            { repository: 'community/Plugin-First', auto_update: !frozen },
            { repository: 'community/Plugin-Second', auto_update: true },
        ],
        resources: [],
        ...(large ? { note: 'x'.repeat(1100000) } : {}),
    };
    const master = state.addCommit({
        'README.md': 'Approved documentation\n',
        'catalogue.json': encode({ schema_version: 1, resources: [] }),
    });
    const dev = state.addCommit(
        {
            'resources.json': encode(source),
            'README.md': 'Unpublished dev documentation\n',
            'unreviewed.mjs': 'throw new Error("Never execute Market source with App access");',
        },
        [master],
    );
    state.refs.set('master', master);
    state.refs.set('dev', dev);
    state.rulesets = [
        {
            id: 1,
            name: 'Protect master',
            target: 'branch',
            source_type: 'Repository',
            source: repository,
            enforcement: 'active',
            bypass_actors: [],
            conditions: { ref_name: { include: ['refs/heads/master'], exclude: [] } },
            rules: [
                { type: 'deletion' },
                { type: 'non_fast_forward' },
                {
                    type: 'pull_request',
                    parameters: {
                        required_approving_review_count: 0,
                        allowed_merge_methods: ['merge'],
                        required_reviewers: [],
                        dismissal_restriction: { enabled: false, allowed_actors: [] },
                        ignore_approvals_from_contributors: false,
                    },
                },
            ],
        },
        {
            id: 2,
            name: 'App-only master merges',
            target: 'branch',
            source_type: 'Repository',
            source: repository,
            enforcement: 'active',
            bypass_actors: [{ actor_id: appId, actor_type: 'Integration', bypass_mode: 'pull_request' }],
            conditions: { ref_name: { include: ['refs/heads/master'], exclude: [] } },
            rules: [{ type: 'update', parameters: { update_allows_fetch_and_merge: false } }],
        },
    ];
    const client = createMarketClient({
        token,
        wait: async () => {},
        transport: async (url, request) => {
            const target = new URL(url);
            assert.equal(target.origin, 'https://api.github.com');
            assert.equal(request.redirect, 'error');
            assert.equal(request.headers.Authorization, `Bearer ${token}`);
            assert.equal(request.headers['X-GitHub-Api-Version'], '2022-11-28');
            const suffix = target.pathname.slice(prefix.length);
            const call = {
                method: request.method,
                path: target.pathname,
                suffix,
                query: target.searchParams,
                body: request.body === undefined ? undefined : JSON.parse(request.body),
            };
            state.calls.push(call);
            const override = await before?.(call, state);
            if (override) return override;
            let value;
            let status = 200;
            const foundPull = () => state.pulls.find((pull) => pull.number === Number(suffix.split('/')[2]));
            if (call.method === 'GET' && suffix === '') value = state.metadata;
            else if (call.method === 'GET' && suffix.startsWith('/git/ref/heads/')) {
                const branch = suffix.slice('/git/ref/heads/'.length);
                const sha = state.refs.get(branch);
                if (!sha) {
                    status = 404;
                    value = {};
                } else value = { ref: `refs/heads/${branch}`, object: { type: 'commit', sha } };
            } else if (call.method === 'GET' && suffix.startsWith('/contents/')) {
                const path = suffix.slice('/contents/'.length);
                const bytes = state.commits.get(target.searchParams.get('ref'))?.files[path];
                if (bytes === undefined) {
                    status = 404;
                    value = {};
                } else
                    value = {
                        type: 'file',
                        path,
                        sha: blob(bytes),
                        size: Buffer.byteLength(bytes),
                        encoding: large && Buffer.byteLength(bytes) > 1000000 ? 'none' : 'base64',
                        content:
                            large && Buffer.byteLength(bytes) > 1000000 ? '' : Buffer.from(bytes).toString('base64'),
                    };
            } else if (call.method === 'GET' && suffix.startsWith('/git/blobs/')) {
                const sha = suffix.split('/').at(-1);
                const bytes = state.blobs.get(sha);
                value = {
                    sha,
                    size: Buffer.byteLength(bytes),
                    encoding: 'base64',
                    content: Buffer.from(bytes).toString('base64'),
                };
            } else if (call.method === 'GET' && suffix.startsWith('/git/commits/')) {
                const stored = state.commits.get(suffix.split('/').at(-1));
                assert.ok(stored);
                const { files, ...commit } = stored;
                value = commit;
            } else if (call.method === 'GET' && suffix.startsWith('/git/trees/')) {
                const sha = suffix.split('/').at(-1);
                value = { sha, truncated: false, tree: state.trees.get(sha) };
            } else if (call.method === 'GET' && suffix === '/rulesets') value = state.rulesets;
            else if (call.method === 'GET' && /^\/rulesets\/\d+$/.test(suffix))
                value = state.rulesets.find((entry) => entry.id === Number(suffix.split('/').at(-1)));
            else if (call.method === 'GET' && suffix === '/rules/branches/master')
                value = state.rulesets.flatMap((entry) =>
                    entry.rules.map((rule) => ({
                        ...rule,
                        ruleset_id: entry.id,
                        ruleset_source_type: 'Repository',
                        ruleset_source: repository,
                    })),
                );
            else if (call.method === 'POST' && suffix === '/git/trees') {
                const files = Object.fromEntries(
                    state.trees.get(call.body.base_tree).map((entry) => [entry.path, state.blobs.get(entry.sha)]),
                );
                for (const entry of call.body.tree) files[entry.path] = entry.content;
                value = { sha: state.addTree(files) };
                status = 201;
            } else if (call.method === 'POST' && suffix === '/git/commits') {
                const files = Object.fromEntries(
                    state.trees.get(call.body.tree).map((entry) => [entry.path, state.blobs.get(entry.sha)]),
                );
                const sha = state.addCommit(files, call.body.parents);
                const { files: ignored, ...commit } = state.commits.get(sha);
                value = commit;
                status = 201;
            } else if (call.method === 'POST' && suffix === '/git/refs') {
                const branch = call.body.ref.slice('refs/heads/'.length);
                assert.ok(!state.refs.has(branch));
                state.refs.set(branch, call.body.sha);
                value = { ref: call.body.ref, object: { type: 'commit', sha: call.body.sha } };
                status = 201;
            } else if (call.method === 'GET' && suffix === '/pulls') {
                const head = target.searchParams.get('head')?.split(':')[1];
                value = state.pulls.filter((pull) => pull.state === 'open' && pull.head.ref === head);
            } else if (call.method === 'POST' && suffix === '/pulls') {
                const repo = { id: 9, full_name: repository };
                const pull = {
                    number: state.pulls.length + 1,
                    body: call.body.body,
                    state: 'open',
                    merged_at: null,
                    merge_commit_sha: null,
                    draft: false,
                    mergeable: true,
                    user: { login: `${appSlug}[bot]`, type: 'Bot' },
                    head: { ref: call.body.head, sha: state.refs.get(call.body.head), repo },
                    base: { ref: 'master', sha: state.refs.get('master'), repo },
                };
                state.pulls.push(pull);
                value = pull;
                status = 201;
            } else if (call.method === 'GET' && /^\/pulls\/\d+\/files$/.test(suffix)) {
                const pull = foundPull();
                const old = state.commits.get(pull.base.sha).files;
                const next = state.commits.get(state.refs.get(pull.head.ref)).files;
                value = [...new Set([...Object.keys(old), ...Object.keys(next)])]
                    .filter((path) => old[path] !== next[path])
                    .map((filename) => ({
                        filename,
                        status:
                            old[filename] === undefined
                                ? 'added'
                                : next[filename] === undefined
                                  ? 'removed'
                                  : 'modified',
                        sha: blob(next[filename] ?? ''),
                    }));
            } else if (call.method === 'GET' && /^\/pulls\/\d+$/.test(suffix)) value = foundPull();
            else if (call.method === 'PUT' && /^\/pulls\/\d+\/merge$/.test(suffix)) {
                if (state.blocked) {
                    status = state.blocked;
                    value = {};
                } else {
                    const pull = foundPull();
                    assert.deepEqual(call.body, { sha: pull.head.sha, merge_method: 'merge' });
                    const sha = state.addCommit(state.commits.get(pull.head.sha).files, [
                        state.refs.get('master'),
                        pull.head.sha,
                    ]);
                    state.refs.set('master', sha);
                    pull.state = 'closed';
                    pull.merged_at = '2026-10-28T12:00:00Z';
                    pull.merge_commit_sha = sha;
                    value = { merged: true, sha };
                }
            } else throw new Error(`Unexpected request ${call.method} ${suffix}`);
            return (await after?.(call, structuredClone(value), state)) ?? Response.json(value, { status });
        },
    });
    const options = {
        client,
        appId,
        appSlug,
        wait: async () => {},
        fetchMetadata: async (entry) => {
            state.fetched.push(entry.repository);
            return metadata(entry);
        },
    };
    return {
        state,
        options,
        execute: (overrides = {}) => reconcileMarket({ ...options, ...overrides }),
        master,
        dev,
        source,
    };
}

const writes = (state) => state.calls.filter((call) => call.method !== 'GET');

test('full reconciliation publishes only the source README and generated catalogue through an App merge and then becomes a no-op', async () => {
    const data = fixture();
    const result = await data.execute();
    assert.equal(result.action, 'configured');
    const output = data.state.commits.get(data.state.refs.get('master')).files;
    assert.equal(output['resources.json'], undefined);
    assert.equal(JSON.parse(output['catalogue.json']).resources.length, 2);
    assert.equal(output['README.md'], 'Unpublished dev documentation\n');
    assert.deepEqual(Object.keys(output).sort(), ['README.md', 'catalogue.json']);
    assert.equal(data.state.commits.get(data.dev).files['catalogue.json'], undefined);
    assert.equal(data.state.commits.get(data.dev).files['resources.json'], encode(data.source));
    assert.ok(
        data.state.calls
            .filter((call) => call.suffix === '/contents/resources.json')
            .every((call) => call.query.get('ref') === data.dev),
    );
    assert.equal(output['unreviewed.mjs'], undefined);
    assert.equal(data.state.refs.get('dev'), data.dev);
    assert.equal(data.state.pulls.length, 1);
    assert.ok(writes(data.state).every((call) => ['POST', 'PUT'].includes(call.method)));
    assert.ok(
        writes(data.state)
            .filter((call) => call.suffix === '/git/refs')
            .every((call) => call.body.ref.startsWith('refs/heads/automation/market-')),
    );
    const before = writes(data.state).length;
    assert.equal((await data.execute()).action, 'unchanged');
    assert.equal(writes(data.state).length, before);
});

test('a notification fetches only its selected repository and publishes only catalogue.json', async () => {
    const data = fixture();
    const result = await data.execute({ repository: 'community/Plugin-First' });
    assert.equal(result.action, 'configured');
    assert.deepEqual(data.state.fetched, ['https://github.com/community/Plugin-First']);
    const output = data.state.commits.get(data.state.refs.get('master')).files;
    assert.equal(output['resources.json'], undefined);
    assert.equal(output['README.md'], 'Approved documentation\n');
    assert.ok(!data.state.calls.some((call) => call.suffix === '/contents/README.md'));
    const tree = writes(data.state).find((call) => call.suffix === '/git/trees');
    assert.deepEqual(
        tree.body.tree.map((entry) => entry.path),
        ['catalogue.json'],
    );
});

test('a targeted manual refresh preserves master documentation and never copies the dev registry', async () => {
    const data = fixture({ frozen: true });
    assert.equal((await data.execute({ repository: 'community/Plugin-First', force: true })).action, 'configured');
    const output = data.state.commits.get(data.state.refs.get('master')).files;
    assert.deepEqual(Object.keys(output).sort(), ['README.md', 'catalogue.json']);
    assert.equal(output['README.md'], 'Approved documentation\n');
    assert.ok(!data.state.calls.some((call) => call.suffix === '/contents/README.md'));
    assert.ok(
        data.state.calls
            .filter((call) => call.suffix === '/contents/resources.json')
            .every((call) => call.query.get('ref') === data.dev),
    );
});

test('global publication accepts bounded UTF-8 README bytes and never executes or normalizes their contents', async () => {
    const data = fixture();
    const header = '# Café\n```js\nthrow new Error("Documentation is never executed");\n```\n';
    const readme = header + 'x'.repeat(65536 - Buffer.byteLength(header));
    const dev = data.state.addCommit({ ...data.state.commits.get(data.dev).files, 'README.md': readme }, [data.dev]);
    data.state.refs.set('dev', dev);
    assert.equal((await data.execute()).action, 'configured');
    const output = data.state.commits.get(data.state.refs.get('master')).files;
    assert.equal(output['README.md'], readme);
    assert.equal(Buffer.byteLength(output['README.md']), 65536);
    assert.deepEqual(Object.keys(output).sort(), ['README.md', 'catalogue.json']);
});

test('invalid README size, type, hash or UTF-8 fails global publication before metadata fetching or mutation', async (context) => {
    for (const kind of ['size', 'type', 'hash', 'utf8', 'nul', 'missing']) {
        await context.test(kind, async () => {
            const data = fixture({
                after: (call, value) => {
                    if (call.suffix !== '/contents/README.md' || call.query.get('ref') !== data.dev) return;
                    if (kind === 'size') return Response.json({ ...value, size: 65537 });
                    if (kind === 'type') return Response.json({ ...value, type: 'symlink' });
                    if (kind === 'hash') return Response.json({ ...value, sha: 'f'.repeat(40) });
                    if (kind === 'missing') return Response.json({}, { status: 404 });
                    const bytes = Buffer.from(kind === 'utf8' ? [255] : [0]);
                    return Response.json({
                        ...value,
                        size: bytes.length,
                        sha: blob(bytes),
                        content: bytes.toString('base64'),
                    });
                },
            });
            assert.equal((await data.execute()).action, 'failed');
            assert.equal(data.state.fetched.length, 0);
            assert.equal(writes(data.state).length, 0);
            assert.equal(data.state.refs.get('master'), data.master);
        });
    }
});

test('unregistered and frozen notifications skip successfully without metadata fetches, protections or writes', async () => {
    for (const target of ['community/Plugin-Missing', 'community/Plugin-First']) {
        const data = fixture({ frozen: true });
        data.state.rulesets = [];
        const result = await data.execute({ repository: target });
        assert.equal(result.action, 'skipped');
        assert.equal(data.state.fetched.length, 0);
        assert.equal(writes(data.state).length, 0);
        assert.ok(!data.state.calls.some((call) => call.suffix.startsWith('/rules')));
    }
});

test('a manual targeted refresh imports the first frozen release without changing its registration', async () => {
    const data = fixture({ frozen: true });
    assert.equal((await data.execute({ repository: 'community/Plugin-First', force: true })).action, 'configured');
    assert.deepEqual(data.state.fetched, ['https://github.com/community/Plugin-First']);
    assert.equal(data.source.repositories[0].auto_update, false);
    assert.equal(
        JSON.parse(data.state.commits.get(data.state.refs.get('master')).files['catalogue.json']).resources.length,
        1,
    );
    assert.equal((await fixture().execute({ repository: 'community/Plugin-Missing', force: true })).action, 'skipped');
});

test('manual all scope refreshes active and paused registrations without enabling their automatic updates', async () => {
    const data = fixture({ frozen: true });
    const source = structuredClone(data.source);
    assert.equal((await data.execute({ force: true })).action, 'configured');
    assert.deepEqual(data.state.fetched, [
        'https://github.com/community/Plugin-First',
        'https://github.com/community/Plugin-Second',
    ]);
    const output = data.state.commits.get(data.state.refs.get('master')).files;
    assert.equal(JSON.parse(output['catalogue.json']).resources.length, 2);
    assert.equal(output['resources.json'], undefined);
    assert.equal(data.state.commits.get(data.dev).files['resources.json'], encode(source));
    assert.deepEqual(data.source, source);
    assert.equal(data.state.refs.get('dev'), data.dev);
    const automatic = fixture({ frozen: true });
    assert.equal((await automatic.execute()).action, 'configured');
    assert.deepEqual(automatic.state.fetched, ['https://github.com/community/Plugin-Second']);
    assert.equal(
        JSON.parse(automatic.state.commits.get(automatic.state.refs.get('master')).files['catalogue.json']).resources
            .length,
        1,
    );
});

test('a dry manual all plan performs no mutation and a blocked all import is resumed by the same manual mode', async () => {
    const preview = fixture({ frozen: true });
    assert.equal((await preview.execute({ force: true, check: true })).action, 'planned');
    assert.equal(writes(preview.state).length, 0);
    assert.equal(preview.state.fetched.length, 2);
    const data = fixture({ frozen: true });
    data.state.blocked = 405;
    const pending = await data.execute({ force: true });
    assert.equal(pending.action, 'pending');
    assert.match(
        pending.reason,
        /Rerun Refresh Market manually with scope all.*automatic refreshes preserve paused registrations/,
    );
    const before = writes(data.state).length;
    data.state.blocked = null;
    assert.equal((await data.execute({ force: true })).action, 'configured');
    assert.equal(data.state.pulls.length, 1);
    assert.deepEqual(
        writes(data.state)
            .slice(before)
            .map((call) => call.method),
        ['PUT'],
    );
});

test('dry run validates the plan without creating any branch, tree, commit, PR or merge', async () => {
    const data = fixture();
    const result = await data.execute({ check: true });
    assert.equal(result.action, 'planned');
    assert.equal(writes(data.state).length, 0);
    assert.equal(data.state.refs.get('master'), data.master);
});

test('both protection anchors and their effective repository rules must be exact before mutation', async (context) => {
    for (const kind of ['missing', 'bypass', 'squash', 'app', 'gate-bypass', 'fetch-merge', 'effective']) {
        await context.test(kind, async () => {
            const data = fixture({
                after: (call, value) =>
                    kind === 'effective' && call.suffix === '/rules/branches/master'
                        ? Response.json(value.filter((rule) => rule.type !== 'deletion'))
                        : undefined,
            });
            if (kind === 'missing') data.state.rulesets.pop();
            if (kind === 'bypass')
                data.state.rulesets[0].bypass_actors = [
                    { actor_id: 1, actor_type: 'RepositoryRole', bypass_mode: 'always' },
                ];
            if (kind === 'squash')
                data.state.rulesets[0].rules
                    .find((rule) => rule.type === 'pull_request')
                    .parameters.allowed_merge_methods.push('squash');
            if (kind === 'app') data.state.rulesets[1].bypass_actors[0].actor_id++;
            if (kind === 'gate-bypass') data.state.rulesets[1].bypass_actors[0].bypass_mode = 'always';
            if (kind === 'fetch-merge') data.state.rulesets[1].rules[0].parameters.update_allows_fetch_and_merge = true;
            assert.equal((await data.execute()).action, 'failed');
            assert.equal(writes(data.state).length, 0);
        });
    }
});

test('native merge refusals leave one reusable App PR pending and never bypass requirements', async (context) => {
    for (const status of [403, 405, 409, 422])
        await context.test(String(status), async () => {
            const data = fixture();
            data.state.blocked = status;
            assert.equal((await data.execute()).action, 'pending');
            assert.equal(data.state.refs.get('master'), data.master);
            const before = writes(data.state).length;
            data.state.blocked = null;
            assert.equal((await data.execute()).action, 'configured');
            assert.equal(data.state.pulls.length, 1);
            assert.deepEqual(
                writes(data.state)
                    .slice(before)
                    .map((call) => call.method),
                ['PUT'],
            );
        });
});

test('targeted and global plans with identical catalogue bytes use different branches for their different JSON trees', async () => {
    const data = fixture();
    const source = structuredClone(data.source);
    source.repositories.pop();
    const files = { ...data.state.commits.get(data.dev).files, 'resources.json': encode(source) };
    data.state.refs.set('dev', data.state.addCommit(files, [data.dev]));
    data.state.blocked = 405;
    assert.equal((await data.execute({ repository: 'community/Plugin-First' })).action, 'pending');
    assert.equal((await data.execute()).action, 'pending');
    assert.equal(data.state.pulls.length, 2);
    assert.notEqual(data.state.pulls[0].head.ref, data.state.pulls[1].head.ref);
    assert.equal(data.state.refs.get('master'), data.master);
});

test('unknown merge readiness waits at most thirty seconds and a frozen manual refresh reports its manual retry', async () => {
    const data = fixture({
        frozen: true,
        after: (call, value) =>
            call.method === 'GET' && /^\/pulls\/\d+$/.test(call.suffix)
                ? Response.json({ ...value, mergeable: null })
                : undefined,
    });
    const waits = [];
    const result = await data.execute({
        repository: 'community/Plugin-First',
        force: true,
        wait: async (duration) => waits.push(duration),
    });
    assert.equal(result.action, 'pending');
    assert.match(
        result.reason,
        /Rerun Refresh Market manually with scope repository and community\/Plugin-First.*automatic refreshes preserve paused registrations/,
    );
    assert.match(result.pull_request, /^https:\/\/github\.com\/Kraftink-CMS\/Market\/pull\/1$/);
    assert.deepEqual(waits, Array(6).fill(5000));
    assert.ok(!writes(data.state).some((call) => call.method === 'PUT'));
});

test('source, identity, staged branch and pull-request races prevent an unverified merge', async (context) => {
    for (const kind of ['dev', 'private', 'branch', 'author', 'body', 'extra-file', 'merge-tree', 'retarget'])
        await context.test(kind, async () => {
            const data = fixture({
                after: (call, value, state) => {
                    if (call.method === 'POST' && call.suffix === '/pulls') {
                        if (kind === 'dev')
                            state.refs.set(
                                'dev',
                                state.addCommit(state.commits.get(state.refs.get('dev')).files, [
                                    state.refs.get('dev'),
                                ]),
                            );
                        if (kind === 'private') state.metadata.private = true;
                        if (kind === 'author') {
                            state.pulls[0].user = { login: 'human', type: 'User' };
                            return Response.json(state.pulls[0], { status: 201 });
                        }
                        if (kind === 'body') {
                            state.pulls[0].body = 'Changed plan';
                            return Response.json(state.pulls[0], { status: 201 });
                        }
                    }
                    if (kind === 'branch' && call.method === 'POST' && call.suffix === '/git/refs') {
                        const branch = call.body.ref.slice(11);
                        state.refs.set(
                            branch,
                            state.addCommit(
                                {
                                    ...state.commits.get(call.body.sha).files,
                                    'foreign.php': '<?php unsafe();',
                                },
                                [call.body.sha],
                            ),
                        );
                    }
                    if (kind === 'extra-file' && call.suffix.endsWith('/files'))
                        return Response.json([
                            ...value,
                            { filename: 'README.md', status: 'modified', sha: 'f'.repeat(40) },
                        ]);
                    if (kind === 'merge-tree' && call.method === 'PUT')
                        state.commits.get(value.sha).tree.sha = state.commits.get(data.master).tree.sha;
                    if (kind === 'retarget' && call.method === 'GET' && /^\/pulls\/\d+$/.test(call.suffix)) {
                        state.pullReads = (state.pullReads ?? 0) + 1;
                        if (state.pullReads === 2) {
                            state.pulls[0].base.ref = 'dev';
                            return Response.json(state.pulls[0]);
                        }
                    }
                },
            });
            assert.equal((await data.execute()).action, 'failed');
            if (kind !== 'merge-tree') assert.equal(data.state.refs.get('master'), data.master);
        });
});

test('large immutable JSON blobs use the Git blob endpoint without exposing tokens in failures', async () => {
    const data = fixture({ large: true });
    assert.equal((await data.execute()).action, 'configured');
    assert.ok(data.state.calls.some((call) => call.suffix.startsWith('/git/blobs/')));
    const failure = await reconcileMarket({
        ...data.options,
        client: {
            request: async () => {
                throw new Error(token);
            },
        },
    });
    assert.equal(failure.action, 'failed');
    assert.ok(!JSON.stringify(failure).includes(token));
});

test('the fixed Market transport rejects arbitrary paths and writes and retries only transient reads', async () => {
    let calls = 0;
    const waits = [];
    const client = createMarketClient({
        token,
        wait: async (value) => waits.push(value),
        transport: async () => {
            calls++;
            if (calls < 3) return Response.json({}, { status: 503 });
            return Response.json({ ok: true });
        },
    });
    assert.deepEqual(await client.request('GET', prefix), { ok: true });
    assert.equal(calls, 3);
    assert.deepEqual(waits, [1000, 1000]);
    for (const [method, path, body] of [
        ['GET', '/repos/attacker/Market'],
        ['GET', 'https://attacker.invalid/repos/Kraftink-CMS/Market'],
        ['POST', `${prefix}/git/refs`, { ref: 'refs/heads/master', sha: 'a'.repeat(40) }],
        ['PUT', `${prefix}/pulls/1/merge`, { sha: 'a'.repeat(40), merge_method: 'squash' }],
        ['DELETE', `${prefix}/git/refs/heads/dev`],
        [
            'POST',
            `${prefix}/git/trees`,
            {
                base_tree: 'a'.repeat(40),
                tree: [{ path: 'resources.json', mode: '100644', type: 'blob', content: '{}' }],
            },
        ],
        [
            'POST',
            `${prefix}/git/trees`,
            {
                base_tree: 'a'.repeat(40),
                tree: [{ path: '.github/workflows/validate.yml', mode: '100644', type: 'blob', content: 'unsafe' }],
            },
        ],
        [
            'POST',
            `${prefix}/git/trees`,
            {
                base_tree: 'a'.repeat(40),
                tree: [{ path: 'README.md', mode: '100644', type: 'blob', content: 'x'.repeat(65537) }],
            },
        ],
        [
            'POST',
            `${prefix}/git/trees`,
            {
                base_tree: 'a'.repeat(40),
                tree: [{ path: 'unsafe.mjs', mode: '100644', type: 'blob', content: 'unsafe' }],
            },
        ],
    ])
        await assert.rejects(client.request(method, path, body), /outside its scope/);
    assert.equal(calls, 3);
    let writes = 0;
    const rejected = createMarketClient({
        token,
        transport: async () => {
            writes++;
            return Response.json({ token }, { status: 503 });
        },
    });
    await assert.rejects(
        rejected.request('POST', `${prefix}/git/refs`, {
            ref: `refs/heads/automation/market-${'a'.repeat(12)}-${'b'.repeat(12)}`,
            sha: 'c'.repeat(40),
        }),
        (error) => error.status === 503 && !error.message.includes(token),
    );
    assert.equal(writes, 1);
});

const environment = {
    GITHUB_REPOSITORY: 'Kraftink-CMS/automation',
    GITHUB_REF: 'refs/heads/master',
    GITHUB_WORKFLOW_REF: 'Kraftink-CMS/automation/.github/workflows/refresh-market.yml@refs/heads/master',
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_ACTOR: 'alice',
    KRAFTINK_TRIGGERING_ACTOR: 'bob',
};

test('manual scope choices map exactly to global automatic, one forced registration and all forced registrations', () => {
    assert.deepEqual(parseMarketArguments(['']), {
        check: false,
        force: false,
        repository: null,
        scope: 'automatic',
    });
    assert.deepEqual(parseMarketArguments(['--check', '']), {
        check: true,
        force: false,
        repository: null,
        scope: 'automatic',
    });
    assert.deepEqual(parseMarketArguments(['--scope', 'automatic', '']), {
        check: false,
        force: false,
        repository: null,
        scope: 'automatic',
    });
    assert.deepEqual(parseMarketArguments(['--scope', 'repository', 'community/Plugin-First']), {
        check: false,
        force: true,
        repository: 'community/Plugin-First',
        scope: 'repository',
    });
    assert.deepEqual(parseMarketArguments(['--check', '--scope', 'all', '']), {
        check: true,
        force: true,
        repository: null,
        scope: 'all',
    });
    assert.deepEqual(parseMarketArguments(['community/Plugin-First', '--scope', 'notification']), {
        check: false,
        force: false,
        repository: 'community/Plugin-First',
        scope: 'notification',
    });
    for (const args of [
        ['--refresh', 'community/Plugin-First'],
        ['--scope'],
        ['--scope', 'invalid'],
        ['--scope', 'repository'],
        ['--scope', 'notification', ''],
        ['--scope', 'automatic', 'community/Plugin-First'],
        ['--scope', 'all', 'community/Plugin-First'],
        ['--scope', 'all', '--scope', 'automatic'],
        ['--scope', 'repository', 'community/Plugin-First', 'community/Plugin-Second'],
        ['--check', '--check'],
    ])
        assert.throws(() => parseMarketArguments(args));
});

test('workflow event gates reject external forced scopes and never use scope values from notification payloads', () => {
    for (const GITHUB_EVENT_NAME of ['schedule', 'repository_dispatch', 'pull_request']) {
        for (const scope of ['repository', 'all'])
            assert.throws(() =>
                validateMarketEnvironment({ ...environment, GITHUB_EVENT_NAME }, { scope, force: true }),
            );
    }
    for (const scope of ['automatic', 'repository', 'all']) validateMarketEnvironment(environment, { scope });
    validateMarketEnvironment({ ...environment, GITHUB_EVENT_NAME: 'schedule' }, { scope: 'automatic' });
    validateMarketEnvironment(
        {
            ...environment,
            GITHUB_EVENT_NAME: 'repository_dispatch',
            payload_scope: 'all',
            FORCE_REFRESH: 'true',
        },
        { scope: 'notification', force: false },
    );
    assert.throws(() => validateMarketEnvironment(environment, { scope: 'notification' }));
    assert.throws(() =>
        validateMarketEnvironment({ ...environment, GITHUB_EVENT_NAME: 'repository_dispatch' }, { scope: 'automatic' }),
    );
    assert.throws(() =>
        validateMarketEnvironment({ ...environment, GITHUB_EVENT_NAME: 'schedule' }, { scope: 'notification' }),
    );
    assert.throws(() => validateMarketEnvironment(environment, { scope: 'all', force: false }));
    assert.throws(() => validateMarketEnvironment(environment, { scope: 'automatic', force: true }));
    assert.throws(() => validateMarketEnvironment(environment, { scope: 'unknown' }));
    for (const changes of [
        { GITHUB_REF: 'refs/heads/dev' },
        { GITHUB_REPOSITORY: 'attacker/automation' },
        { GITHUB_WORKFLOW_REF: environment.GITHUB_WORKFLOW_REF.replace('master', 'dev') },
    ])
        assert.throws(() => validateMarketEnvironment({ ...environment, ...changes }, { scope: 'all' }));
});

test('manual forced refresh requires both human actors to administer central automation and write to Market', async () => {
    const calls = [];
    const client = {
        request: async (method, path) => {
            calls.push(path);
            const login = path.split('/').at(-2);
            return {
                permission: path.includes('/automation/') ? 'admin' : 'write',
                user: { login, id: login === 'alice' ? 1 : 2, type: 'User' },
            };
        },
    };
    await authorizeMarketRefresh({ client, environment });
    assert.equal(calls.length, 4);
    calls.length = 0;
    await authorizeMarketRefresh({ client, environment, scope: 'all' });
    assert.equal(calls.length, 4);
    await assert.rejects(
        authorizeMarketRefresh({ client, environment, scope: 'automatic' }),
        /repository or all scope/,
    );
    await assert.rejects(
        authorizeMarketRefresh({
            environment,
            client: {
                request: async () => ({ permission: 'write', user: { login: 'alice', id: 1, type: 'User' } }),
            },
        }),
        /central administration/,
    );
    await assert.rejects(
        authorizeMarketRefresh({
            client,
            environment: { ...environment, KRAFTINK_TRIGGERING_ACTOR: 'automation[bot]' },
        }),
        /human/,
    );
});
