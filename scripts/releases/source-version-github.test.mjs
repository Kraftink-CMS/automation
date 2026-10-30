import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { advanceDevelopmentVersion, planSourceVersion, updateSourceVersion,
    verifyPreparedSourceVersion } from './source-version-github.mjs';

const repository = 'Kraftink-CMS/Example';
const prefix = `/repos/${repository}`;
const digest = (value) => createHash('sha1').update(JSON.stringify(value)).digest('hex');

function fixture(version = '1.0.0-dev', metadataPath = 'manifest.json') {
    const trees = new Map();
    const blobs = new Map();
    const commits = new Map();
    const heads = {};
    const calls = [];
    const tags = [];
    const files = new Map();
    function treeFor(content) {
        const entries = Object.entries(content).map(([path, value]) => {
            const sha = digest(value);
            const bytes = Buffer.from(value);
            blobs.set(sha, { sha, encoding: 'base64', size: bytes.length, content: bytes.toString('base64') });
            return { path, sha, mode: '100644', type: 'blob', size: bytes.length };
        });
        const sha = digest(entries);
        trees.set(sha, { sha, truncated: false, tree: entries });
        files.set(sha, content);
        return sha;
    }
    function addCommit(content, parents = [], message = 'fix: update package') {
        const tree = treeFor(content);
        const sha = digest({ tree, parents, message });
        commits.set(sha, { sha, tree: { sha: tree }, parents: parents.map((sha) => ({ sha })), message });
        return sha;
    }
    const original = addCommit({ [metadataPath]: `{\r\n    "version": "${version}",\r\n    "name": "Sample"\r\n}\r\n`,
        'code.php': '<?php echo "initial";\n' });
    heads.dev = original;
    heads.master = original;
    const content = (sha) => ({ ...files.get(commits.get(sha).tree.sha) });
    const ancestor = (base, head) => base === head || commits.get(head)?.parents.some((parent) => ancestor(base, parent.sha));
    const client = { async request(method, endpoint, body) {
        calls.push({ method, endpoint, body });
        assert.ok(endpoint.startsWith(prefix + '/'));
        const path = endpoint.slice(prefix.length);
        if (method === 'GET' && path.startsWith('/git/ref/heads/')) {
            const branch = path.slice('/git/ref/heads/'.length);
            return { ref: `refs/heads/${branch}`, object: { type: 'commit', sha: heads[branch] } };
        }
        if (method === 'GET' && path.startsWith('/git/commits/')) return commits.get(path.slice('/git/commits/'.length));
        if (method === 'GET' && path.startsWith('/git/trees/')) return trees.get(path.slice('/git/trees/'.length));
        if (method === 'GET' && path.startsWith('/git/blobs/')) return blobs.get(path.slice('/git/blobs/'.length));
        if (method === 'GET' && path.startsWith('/tags?')) return tags;
        if (method === 'GET' && path.startsWith('/compare/')) {
            const [base, head] = path.slice('/compare/'.length).split('?')[0].split('...');
            const matches = [];
            const visit = (sha) => {
                if (sha === base || matches.some((entry) => entry.sha === sha)) return;
                const entry = commits.get(sha);
                matches.push({ sha, commit: { message: entry.message } });
                for (const parent of entry.parents) visit(parent.sha);
            };
            visit(head);
            return { status: ancestor(base, head) ? 'ahead' : 'diverged', base_commit: { sha: base },
                merge_base_commit: { sha: base }, total_commits: matches.length, commits: matches };
        }
        if (method === 'POST' && path === '/git/trees') {
            const result = { ...files.get(body.base_tree) };
            for (const entry of body.tree) result[entry.path] = entry.content;
            return { sha: treeFor(result) };
        }
        if (method === 'POST' && path === '/git/commits') {
            const sha = addCommit(files.get(body.tree), body.parents, body.message);
            return commits.get(sha);
        }
        if (method === 'POST' && path.startsWith('/statuses/')) return structuredClone(body);
        if (method === 'PATCH' && path.startsWith('/git/refs/heads/')) {
            const branch = path.slice('/git/refs/heads/'.length);
            assert.equal(body.force, false);
            if (!ancestor(heads[branch], body.sha)) throw new Error('Non-fast-forward update rejected.');
            heads[branch] = body.sha;
            return { ref: `refs/heads/${branch}`, object: { type: 'commit', sha: body.sha } };
        }
        throw new Error(`Unexpected ${method} ${path}`);
    } };
    return { client, calls, heads, commits, trees, blobs, tags, original, content, addCommit };
}

test('source preparation updates only the version and is idempotent', async () => {
    const state = fixture();
    const result = await updateSourceVersion({ ...state, repository, branch: 'dev', version: '1.0.0', expectedSha: state.original });
    assert.equal(result.changed, true);
    assert.deepEqual(state.content(result.sha), { ...state.content(state.original),
        'manifest.json': state.content(state.original)['manifest.json'].replace('1.0.0-dev', '1.0.0') });
    assert.deepEqual(state.commits.get(result.sha).parents, [{ sha: state.original }]);
    await verifyPreparedSourceVersion({ ...state, repository, originSha: state.original, preparedSha: result.sha, version: '1.0.0' });
    const count = state.commits.size;
    assert.equal((await updateSourceVersion({ ...state, repository, branch: 'dev', version: '1.0.0' })).changed, false);
    assert.equal(state.commits.size, count);
});

test('version metadata validation precedes the dev ref update and does not approve a release', async () => {
    const state = fixture();
    const result = await updateSourceVersion({ ...state, repository, branch: 'dev', version: '1.0.0',
        validationContext: 'checks / Validate changes' });
    const status = state.calls.findIndex((call) => call.endpoint === `${prefix}/statuses/${result.sha}`);
    const update = state.calls.findIndex((call) => call.method === 'PATCH');
    assert.ok(status >= 0 && status < update);
    assert.deepEqual(state.calls[status].body, { state: 'success', context: 'checks / Validate changes',
        description: 'Only validated source version metadata changed.' });
    assert.equal(state.calls.some((call) => call.body?.context === 'Release validated source'), false);
    assert.equal(state.content(result.sha)['code.php'], state.content(state.original)['code.php']);
});

test('a failed metadata status never updates dev or silently bypasses its check', async () => {
    const state = fixture();
    const original = state.client.request.bind(state.client);
    state.client.request = async (method, path, body) => {
        if (method === 'POST' && path.includes('/statuses/')) return { state: 'failure', context: body.context };
        return original(method, path, body);
    };
    await assert.rejects(updateSourceVersion({ ...state, repository, branch: 'dev', version: '1.0.0',
        validationContext: 'checks / Validate changes' }), /metadata validation/);
    assert.equal(state.heads.dev, state.original);
    assert.equal(state.calls.some((call) => call.method === 'PATCH'), false);
});

test('preparation rejects unrelated source changes and a different parent', async () => {
    const state = fixture();
    const changed = state.addCommit({ ...state.content(state.original), 'code.php': '<?php echo "tampered";' }, [state.original]);
    await assert.rejects(verifyPreparedSourceVersion({ ...state, repository,
        originSha: state.original, preparedSha: changed, version: '1.0.0' }), /version-only/);
    const stable = { ...state.content(state.original), 'manifest.json': '{"version":"1.0.0"}\n' };
    const detached = state.addCommit(stable, []);
    await assert.rejects(verifyPreparedSourceVersion({ ...state, repository,
        originSha: state.original, preparedSha: detached, version: '1.0.0' }), /version-only/);
});

test('a concurrent dev change is rejected without forcing or losing source', async () => {
    const state = fixture();
    state.heads.dev = state.addCommit({ ...state.content(state.original), 'code.php': '<?php echo "new";' }, [state.original]);
    await assert.rejects(updateSourceVersion({ ...state, repository, branch: 'dev', version: '1.1.0-dev',
        expectedSha: state.original }), /advanced/);
    assert.equal(state.calls.some((call) => call.method !== 'GET'), false);
});

test('source files cannot be symbolic links or invalid UTF-8', async () => {
    for (const metadataPath of ['manifest.json', 'package.json']) for (const invalid of ['symlink', 'encoding']) {
        const state = fixture('1.0.0-dev', metadataPath);
        const root = state.trees.get(state.commits.get(state.original).tree.sha);
        const entry = root.tree.find((value) => value.path === metadataPath);
        if (invalid === 'symlink') entry.mode = '120000';
        else {
            const bytes = Buffer.from([255]);
            entry.size = 1;
            state.blobs.set(entry.sha, { sha: entry.sha, encoding: 'base64', size: 1, content: bytes.toString('base64') });
        }
        await assert.rejects(updateSourceVersion({ ...state, repository, branch: 'dev', version: '1.0.0' }),
            invalid === 'symlink' ? /regular files/ : /UTF-8/);
    }
});

test('next development cycle preserves newer code and joins the stable ancestry', async () => {
    const state = fixture();
    const stable = await updateSourceVersion({ ...state, repository, branch: 'dev', version: '1.0.0' });
    const master = state.addCommit(state.content(stable.sha), [state.original, stable.sha], 'Merge release');
    state.heads.master = master;
    const newer = state.addCommit({ ...state.content(stable.sha), 'code.php': '<?php echo "new development";' }, [stable.sha]);
    state.heads.dev = newer;
    const result = await advanceDevelopmentVersion({ ...state, repository, version: '1.0.0',
        releaseSha: master, sourceSha: stable.sha });
    assert.match(state.content(result.sha)['manifest.json'], /1\.0\.1-dev/);
    assert.equal(state.content(result.sha)['code.php'], '<?php echo "new development";');
    assert.deepEqual(state.commits.get(result.sha).parents, [{ sha: newer }, { sha: master }]);
    assert.equal((await advanceDevelopmentVersion({ ...state, repository, version: '1.0.0',
        releaseSha: master, sourceSha: stable.sha })).changed, false);
});

test('development cycle keeps an explicitly prepared higher target', async () => {
    const state = fixture();
    const stable = await updateSourceVersion({ ...state, repository, branch: 'dev', version: '1.0.0' });
    state.heads.master = stable.sha;
    await updateSourceVersion({ ...state, repository, branch: 'dev', version: '2.0.0-dev' });
    const result = await advanceDevelopmentVersion({ ...state, repository, version: '1.0.0',
        releaseSha: stable.sha, sourceSha: stable.sha, target: '1.1.0' });
    assert.equal(result.changed, false);
    assert.match(state.content(result.sha)['manifest.json'], /2\.0\.0-dev/);
});

test('a stable tree containing unrelated changes cannot advance dev', async () => {
    const state = fixture();
    const stable = await updateSourceVersion({ ...state, repository, branch: 'dev', version: '1.0.0' });
    const changed = state.addCommit({ ...state.content(stable.sha), 'code.php': '<?php echo "not tested";' }, [stable.sha]);
    await assert.rejects(advanceDevelopmentVersion({ ...state, repository, version: '1.0.0',
        releaseSha: changed, sourceSha: stable.sha }), /stable source version/);
});

test('a higher prepared dev target still joins master once without changing its files', async () => {
    const state = fixture();
    const stable = await updateSourceVersion({ ...state, repository, branch: 'dev', version: '1.0.0' });
    const master = state.addCommit(state.content(stable.sha), [state.original, stable.sha], 'Merge stable');
    await updateSourceVersion({ ...state, repository, branch: 'dev', version: '2.0.0-dev' });
    const current = state.heads.dev;
    const result = await advanceDevelopmentVersion({ ...state, repository, version: '1.0.0',
        releaseSha: master, sourceSha: stable.sha });
    assert.equal(result.changed, true);
    assert.deepEqual(state.content(result.sha), state.content(current));
    assert.deepEqual(state.commits.get(result.sha).parents, [{ sha: current }, { sha: master }]);
    assert.equal((await advanceDevelopmentVersion({ ...state, repository, version: '1.0.0',
        releaseSha: master, sourceSha: stable.sha })).changed, false);
});

test('remote version planning uses the common conventional-commit selection', async () => {
    const state = fixture('1.0.1-dev');
    state.tags.push({ name: 'v1.0.0', commit: { sha: state.original } });
    const source = state.addCommit(state.content(state.original), [state.original], 'feat: new functionality');
    assert.equal((await planSourceVersion({ ...state, repository, sourceSha: source })).version, '1.1.0');
    assert.equal((await planSourceVersion({ ...state, repository, sourceSha: source, bump: 'major' })).version, '2.0.0');
    const first = fixture('1.0.0-dev');
    assert.equal((await planSourceVersion({ ...first, repository, sourceSha: first.original })).version, '1.0.0');
});

test('an older publication retry cannot alter a newer stable preparation on dev', async () => {
    const state = fixture();
    const stable = await updateSourceVersion({ ...state, repository, branch: 'dev', version: '1.0.0' });
    const master = state.addCommit(state.content(stable.sha), [state.original, stable.sha], 'Merge release');
    await updateSourceVersion({ ...state, repository, branch: 'dev', version: '2.0.0' });
    const pending = state.heads.dev;
    const result = await advanceDevelopmentVersion({ ...state, repository, version: '1.0.0',
        releaseSha: master, sourceSha: stable.sha });
    assert.equal(result.changed, false);
    assert.equal(state.heads.dev, pending);
    assert.match(state.content(pending)['manifest.json'], /"2\.0\.0"/);
});

test('package.json follows common remote planning, exact stable preparation and idempotent dev advancement', async () => {
    const state = fixture('0.0.1-dev', 'package.json');
    const plan = await planSourceVersion({ ...state, repository, sourceSha: state.original });
    assert.equal(plan.version, '0.0.1');
    const before = state.content(state.original)['package.json'];
    const stable = await updateSourceVersion({ ...state, repository, branch: 'dev', version: plan.version,
        expectedSha: state.original, validationContext: 'checks / Validate changes' });
    assert.equal(state.content(stable.sha)['package.json'], before.replace('0.0.1-dev', '0.0.1'));
    assert.equal(state.content(stable.sha)['code.php'], state.content(state.original)['code.php']);
    await verifyPreparedSourceVersion({ ...state, repository, originSha: state.original, preparedSha: stable.sha, version: '0.0.1' });
    const master = state.addCommit(state.content(stable.sha), [state.original, stable.sha], 'Merge release');
    state.heads.master = master;
    const newer = state.addCommit({ ...state.content(stable.sha), 'code.php': '<?php echo "new development";' }, [stable.sha]);
    state.heads.dev = newer;
    const next = await advanceDevelopmentVersion({ ...state, repository, version: '0.0.1', releaseSha: master, sourceSha: stable.sha });
    assert.equal(state.content(next.sha)['package.json'], before.replace('0.0.1-dev', '0.0.2-dev'));
    assert.equal(state.content(next.sha)['code.php'], '<?php echo "new development";');
    assert.deepEqual(state.commits.get(next.sha).parents, [{ sha: newer }, { sha: master }]);
    assert.equal((await advanceDevelopmentVersion({ ...state, repository, version: '0.0.1',
        releaseSha: master, sourceSha: stable.sha })).changed, false);
    assert.equal(state.content(master)['package.json'], before.replace('0.0.1-dev', '0.0.1'));
});

test('package preparation rejects concurrent dev changes and non-version JSON mutations', async () => {
    const state = fixture('0.0.1-dev', 'package.json');
    const stable = await updateSourceVersion({ ...state, repository, branch: 'dev', version: '0.0.1' });
    const altered = state.addCommit({ ...state.content(stable.sha),
        'package.json': state.content(stable.sha)['package.json'].replace('Sample', 'Unreviewed application') }, [state.original]);
    await assert.rejects(verifyPreparedSourceVersion({ ...state, repository,
        originSha: state.original, preparedSha: altered, version: '0.0.1' }), /version-only/);
    const current = state.heads.dev;
    const previousCalls = state.calls.length;
    await assert.rejects(updateSourceVersion({ ...state, repository, branch: 'dev', version: '0.0.2-dev', expectedSha: state.original }), /advanced/);
    assert.equal(state.heads.dev, current);
    assert.equal(state.calls.slice(previousCalls).some((call) => call.method !== 'GET'), false);
});
