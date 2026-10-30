import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAppClient } from './app-auth.mjs';

const repository = 'Kraftink-CMS/kraftink.com';
const expected = {
    dev: '5337fd6dfb2ffac2b337c1642951bbb6af95e577',
    master: 'a39f8e2df2a08661ab43562b64006bf66843b9bc',
};
const target = {
    dev: 'e923afaf3133788bfedc3181747599c1405c436c',
    master: '61b1aa4ac433ecf53bc5f04c55b9d84c284f6190',
};
const rulesetIds = [26228819, 26228820];
const allRulesetIds = [26228813, 26228819, 26228820];
const releases = [
    { id: 429570758, tag: 'v1.0.1' },
    { id: 429548396, tag: 'v1.0.0' },
];
const maintenanceBranch = 'maintenance/clean-start-20261031';
const prefix = `/repos/${repository}`;
const proofDirectory = join(process.env.RUNNER_TEMP ?? '', 'kraftink-clean-start');
const proof = { repository, expected, target, releasedVersionsRemoved: [], protectionsRestored: false, success: false };
let app;
let credential;

function git(directory, args) {
    try {
        return execFileSync('git', args, {
            cwd: directory,
            encoding: 'utf8',
            windowsHide: true,
            timeout: 120000,
            maxBuffer: 8388608,
            env: {
                ...process.env,
                GIT_TERMINAL_PROMPT: '0',
                GCM_INTERACTIVE: 'Never',
                GIT_CONFIG_COUNT: '3',
                GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
                GIT_CONFIG_VALUE_0: `Authorization: basic ${credential}`,
                GIT_CONFIG_KEY_1: 'http.followRedirects',
                GIT_CONFIG_VALUE_1: 'false',
                GIT_CONFIG_KEY_2: 'credential.helper',
                GIT_CONFIG_VALUE_2: '',
            },
        }).trim();
    } catch {
        throw new Error(`Git ${args[0]} failed. No further destructive operation was attempted.`);
    }
}

async function request(method, path, body, status = 200) {
    assert(path === prefix || path.startsWith(`${prefix}/`), 'The request must stay in the website repository.');
    const response = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${app.token}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2022-11-28',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
    });
    if (response.status !== status) {
        await response.body?.cancel();
        throw new Error(`GitHub ${method} ${path.split('?')[0]} returned ${response.status}.`);
    }
    if (status === 204) {
        await response.body?.cancel();
        return null;
    }
    const bytes = await response.text();
    assert(Buffer.byteLength(bytes) <= 8388608, 'GitHub returned an oversized operation response.');
    return JSON.parse(bytes);
}

function rulePayload(rule, enforcement = rule.enforcement) {
    return {
        name: rule.name,
        target: rule.target,
        enforcement,
        bypass_actors: rule.bypass_actors,
        conditions: rule.conditions,
        rules: rule.rules,
    };
}

async function refsMatch(values) {
    for (const branch of ['dev', 'master']) {
        const ref = await request('GET', `${prefix}/git/ref/heads/${branch}`);
        assert.equal(ref.ref, `refs/heads/${branch}`);
        assert.equal(ref.object.type, 'commit');
        assert.equal(ref.object.sha, values[branch], `${branch} changed outside this operation.`);
    }
}

async function main() {
    assert.equal(process.env.GITHUB_REPOSITORY, 'Kraftink-CMS/automation');
    assert.equal(process.env.GITHUB_EVENT_NAME, 'push');
    assert.equal(process.env.GITHUB_REF, 'refs/heads/master');
    assert.equal(process.env.GITHUB_WORKFLOW_REF, 'Kraftink-CMS/automation/.github/workflows/reset-kraftink-site.yml@refs/heads/master');
    assert(process.env.RUNNER_TEMP, 'A runner temporary directory is required.');
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
    assert.equal(event.repository.full_name, 'Kraftink-CMS/automation');
    assert.equal(event.repository.fork, false);
    assert.equal(event.ref, 'refs/heads/master');
    assert.equal(event.deleted, false);
    assert.equal(event.after, process.env.GITHUB_SHA);
    const plan = JSON.parse(await readFile('.github/reset-kraftink-site-plan.json', 'utf8'));
    assert.equal(plan.repository, repository);
    assert.equal(plan.version, '1.0.0-dev');
    assert.equal(plan.maintenanceBranch, maintenanceBranch);
    assert.deepEqual(plan.expected, expected);
    assert.deepEqual(plan.target, target);
    assert.deepEqual(plan.rulesetIds, rulesetIds);
    assert.deepEqual(plan.releases, releases);
    assert.deepEqual(plan.tags, ['v1.0.0', 'v1.0.1']);
    await mkdir(proofDirectory, { recursive: true, mode: 0o700 });
    app = await createAppClient();
    credential = Buffer.from(`x-access-token:${app.token}`).toString('base64');
    process.stdout.write(`::add-mask::${app.token}\n::add-mask::${credential}\n`);
    const metadata = await request('GET', prefix);
    assert.equal(metadata.full_name, repository);
    assert.equal(metadata.private, false);
    assert.equal(metadata.fork, false);
    assert.equal(metadata.archived, false);
    assert.equal(metadata.default_branch, 'master');
    await refsMatch(expected);
    const inventory = await request('GET', `${prefix}/rulesets?includes_parents=false`);
    assert.deepEqual(inventory.map(rule => rule.id).sort((a, b) => a - b), allRulesetIds);
    assert(inventory.every(rule => rule.enforcement === 'active'));
    const snapshots = [];
    for (const id of rulesetIds) {
        const rule = await request('GET', `${prefix}/rulesets/${id}`);
        assert.equal(rule.source_type, 'Repository');
        assert.equal(rule.source, repository);
        assert.equal(rule.target, 'branch');
        assert.equal(rule.enforcement, 'active');
        assert.deepEqual(rule.conditions.ref_name, { include: ['refs/heads/master'], exclude: [] });
        assert(Array.isArray(rule.rules) && Array.isArray(rule.bypass_actors));
        snapshots.push({ id, payload: rulePayload(rule) });
    }
    await writeFile(join(proofDirectory, 'rules-before.json'), `${JSON.stringify(snapshots, null, 2)}\n`, { mode: 0o600 });
    const actualReleases = await request('GET', `${prefix}/releases?per_page=100`);
    assert.deepEqual(actualReleases.map(release => ({ id: release.id, tag: release.tag_name })), releases);
    const tags = await request('GET', `${prefix}/git/matching-refs/tags/`);
    assert.deepEqual(tags.map(ref => ref.ref).sort(), plan.tags.map(tag => `refs/tags/${tag}`));
    const source = await request('GET', `${prefix}/git/ref/heads/${maintenanceBranch}`);
    assert.equal(source.object.type, 'commit');
    const sourceCommit = await request('GET', `${prefix}/git/commits/${source.object.sha}`);
    assert.deepEqual(sourceCommit.parents.map(parent => parent.sha), [target.dev]);
    const checkout = join(proofDirectory, 'source');
    await mkdir(checkout, { mode: 0o700 });
    git(checkout, ['init', '--quiet']);
    git(checkout, ['remote', 'add', 'origin', 'https://github.com/Kraftink-CMS/kraftink.com.git']);
    git(checkout, ['fetch', '--quiet', '--no-tags', '--depth=3', 'origin', `refs/heads/${maintenanceBranch}`]);
    assert.equal(git(checkout, ['rev-parse', 'FETCH_HEAD']), source.object.sha);
    assert.equal(git(checkout, ['rev-list', '--count', target.master]), '1');
    assert.equal(git(checkout, ['rev-list', '--count', target.dev]), '2');
    assert.equal(git(checkout, ['rev-parse', `${target.dev}^`]), target.master);
    assert.equal(JSON.parse(git(checkout, ['show', `${target.dev}:package.json`])).version, '1.0.0-dev');
    assert.equal(git(checkout, ['ls-tree', '-r', '--name-only', target.master]), '.github/workflows/release.yml');
    await refsMatch(expected);
    let restoreRequired = false;
    try {
        restoreRequired = true;
        for (const snapshot of snapshots) {
            await request('PUT', `${prefix}/rulesets/${snapshot.id}`, { ...snapshot.payload, enforcement: 'disabled' });
            assert.equal((await request('GET', `${prefix}/rulesets/${snapshot.id}`)).enforcement, 'disabled');
        }
        const leases = [
            `--force-with-lease=refs/heads/master:${expected.master}`,
            `--force-with-lease=refs/heads/dev:${expected.dev}`,
            ...tags.map(ref => `--force-with-lease=${ref.ref}:${ref.object.sha}`),
        ];
        git(checkout, [
            'push', '--atomic', ...leases, 'origin',
            `${target.master}:refs/heads/master`, `${target.dev}:refs/heads/dev`,
            ...tags.map(ref => `:${ref.ref}`),
        ]);
        await refsMatch(target);
        assert.deepEqual(await request('GET', `${prefix}/git/matching-refs/tags/`), []);
        proof.atomicRefsReplaced = true;
        proof.oldTagsRemoved = tags.map(ref => ref.ref);
        for (const release of releases) {
            const current = await request('GET', `${prefix}/releases/${release.id}`);
            assert.equal(current.tag_name, release.tag);
            assert.equal(current.id, release.id);
            await request('DELETE', `${prefix}/releases/${release.id}`, undefined, 204);
            proof.releasedVersionsRemoved.push(release.tag);
        }
        assert.deepEqual(await request('GET', `${prefix}/releases?per_page=100`), []);
    } finally {
        if (restoreRequired) {
            const failures = [];
            for (const snapshot of snapshots) {
                try {
                    await request('PUT', `${prefix}/rulesets/${snapshot.id}`, snapshot.payload);
                    const restored = await request('GET', `${prefix}/rulesets/${snapshot.id}`);
                    assert.deepEqual(rulePayload(restored), snapshot.payload);
                } catch {
                    failures.push(snapshot.id);
                }
            }
            const after = await request('GET', `${prefix}/rulesets?includes_parents=false`);
            await writeFile(join(proofDirectory, 'rules-after.json'), `${JSON.stringify(after, null, 2)}\n`, { mode: 0o600 });
            proof.protectionsRestored = failures.length === 0 && after.length === 3 && after.every(rule => rule.enforcement === 'active');
            assert(proof.protectionsRestored, `Protection restoration must be completed for rules: ${failures.join(', ')}.`);
        }
    }
    await refsMatch(target);
    proof.completedAt = new Date().toISOString();
    proof.success = true;
}

try {
    await main();
} catch (error) {
    proof.error = error instanceof Error ? error.message : 'The reset failed.';
    process.exitCode = 1;
} finally {
    if (process.env.RUNNER_TEMP) {
        await mkdir(proofDirectory, { recursive: true, mode: 0o700 });
        await writeFile(join(proofDirectory, 'reset-proof.json'), `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
    }
    console.log(JSON.stringify(proof));
}
