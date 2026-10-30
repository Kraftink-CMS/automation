import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    governRepositories,
    governanceFailureMessage,
    parseArguments,
    protectionsReady,
} from './govern-repositories.mjs';
import { selectPolicies, validateConfiguration } from './protect-repositories.mjs';
import { requestWorkflow } from './provision-release-workflow.mjs';

const repository = 'Kraftink-CMS/Market';
const source = 'a'.repeat(40);
const appSlug = 'kraftink-automation';

test('the governance CLI reports a safe setup error without echoing its credentials', () => {
    const secret = 'fixture-private-credential-never-print';
    const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('./govern-repositories.mjs', import.meta.url)), '--check'],
        {
            encoding: 'utf8',
            timeout: 10000,
            env: {
                ...process.env,
                KRAFTINK_AUTOMATION_APP_ID: 'invalid-fixture-id',
                KRAFTINK_AUTOMATION_PRIVATE_KEY: secret,
                KRAFTINK_CENTRAL_DISPATCH_TOKEN: secret,
            },
        },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /KRAFTINK_AUTOMATION_APP_ID must be a positive numeric GitHub App ID/);
    assert.ok(!result.stderr.includes(secret));
    assert.ok(!result.stderr.includes('invalid-fixture-id'));
});

test('unexpected governance errors retain a generic diagnostic instead of leaking raw exception details', () => {
    const message = governanceFailureMessage(new Error('fixture-private-credential-never-print'));
    assert.equal(
        message,
        'Repository governance failed. Check the central App configuration, permissions and repository policies.\n',
    );
});

test('master protection readiness follows stable profile identities independently of display names', () => {
    const anchors = ['common', 'automated-promotions'].map((policy) => ({
        policy,
        ruleset: `Renamed ${policy}`,
        action: 'unchanged',
        configured: true,
        confirmed: true,
    }));
    assert.equal(
        protectionsReady([
            ...anchors,
            { ruleset: 'Feature branches', action: 'unchanged', configured: true, confirmed: false },
        ]),
        true,
    );
    assert.equal(protectionsReady(anchors.slice(1)), false);
    assert.equal(
        protectionsReady([
            ...anchors,
            { ruleset: 'Broken profile', action: 'failed', configured: false, confirmed: false },
        ]),
        false,
    );
    assert.equal(protectionsReady(anchors.map((entry) => ({ ...entry, confirmed: false }))), false);
});

test('custom repositories bootstrap their wrapper while independent validated publishers keep only native protection', async () => {
    const saved = JSON.parse(await readFile(new URL('../../.github/repository-protection.json', import.meta.url), 'utf8'));
    const configured = validateConfiguration(saved, { appId: 123 });
    for (const name of ['Custom-Assets', 'KraftInk']) {
        const repository = `Kraftink-CMS/${name}`;
        const metadata = { id: 88, name, full_name: repository, owner: { login: 'Kraftink-CMS', type: 'Organization' },
            private: false, visibility: 'public', archived: false, disabled: false, fork: false, allow_merge_commit: true };
        const rulesets = selectPolicies(configured, name).flatMap((policy) => policy.rulesets).map((desired, index) => {
            const { previous_names, ...ruleset } = desired;
            if (ruleset.name === 'App-only master merges') {
                ruleset.name = 'Validated master releases';
                ruleset.rules = [{ type: 'required_status_checks', parameters: {
                    strict_required_status_checks_policy: false,
                    do_not_enforce_on_create: false,
                    required_status_checks: [{ context: 'Release validated source', integration_id: 15368 }],
                } }];
            }
            return { ...ruleset, id: index + 1, source_type: 'Repository', source: repository };
        });
        rulesets.push({ id: 3, name: 'Validate dev changes', target: 'branch', enforcement: 'active',
            source_type: 'Repository', source: repository,
            bypass_actors: [
                { actor_id: 2, actor_type: 'RepositoryRole', bypass_mode: 'always' },
                { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' },
                { actor_id: 123, actor_type: 'Integration', bypass_mode: 'always' },
            ],
            conditions: { ref_name: { include: ['refs/heads/dev'], exclude: [] } },
            rules: [{ type: 'required_status_checks', parameters: {
                strict_required_status_checks_policy: true, do_not_enforce_on_create: true,
                required_status_checks: [{ context: 'checks / Validate changes', integration_id: 15368 }],
            } }],
        });
        const bytes = Buffer.from(requestWorkflow);
        const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        const calls = [];
        const client = { authenticated: true, async request(method, path) {
            calls.push(path);
            assert.equal(method, 'GET');
            const target = new URL(path, 'https://api.github.com');
            if (target.pathname === '/orgs/Kraftink-CMS/repos') return [metadata];
            if (target.pathname === `/repos/${repository}`) return metadata;
            if (target.pathname === `/repos/${repository}/rulesets`) return rulesets;
            if (target.pathname === `/repos/${repository}/actions/permissions/workflow`)
                return { default_workflow_permissions: 'read', can_approve_pull_request_reviews: true };
            const selected = rulesets.find((ruleset) => target.pathname === `/repos/${repository}/rulesets/${ruleset.id}`);
            if (selected) return selected;
            if (target.pathname.startsWith(`/repos/${repository}/rules/branches/`))
                return rulesets.filter((ruleset) => ruleset.conditions.ref_name.include
                    .includes('refs/heads/' + target.pathname.split('/').at(-1)))
                    .flatMap((ruleset) => ruleset.rules.map((rule) => ({ ...rule, ruleset_id: ruleset.id,
                    ruleset_source_type: 'Repository', ruleset_source: repository })));
            if (target.pathname === `/repos/${repository}/pulls`) return [];
            if (target.pathname === `/repos/${repository}/actions/runs`) return { workflow_runs: [] };
            if (target.pathname === `/repos/${repository}/git/ref/heads/dev`)
                return { ref: 'refs/heads/dev', object: { type: 'commit', sha: source } };
            if (target.pathname === `/repos/${repository}/git/ref/heads/master`)
                return { ref: 'refs/heads/master', object: { type: 'commit', sha: 'b'.repeat(40) } };
            if (target.pathname === `/repos/${repository}/contents/.github/workflows/release.yml`) {
                if (target.searchParams.get('ref') !== source)
                    throw Object.assign(new Error('No managed master wrapper.'), { status: 404 });
                return { type: 'file', path: '.github/workflows/release.yml', encoding: 'base64',
                    content: bytes.toString('base64'), sha: blob };
            }
            throw new Error(`Unexpected ${method} ${path}`);
        } };
        const report = await governRepositories({ config: saved, client, appId: 123, appSlug,
            check: true });
        assert.equal(report.failed, 0);
        if (name === 'Custom-Assets') {
            assert.equal(calls.some((path) => path.includes('/git/ref/heads/dev')), true);
            assert.equal(report.workflows.find((entry) => entry.branch === 'master')?.action, 'planned');
        } else {
            assert.deepEqual(report.workflows, []);
            assert.equal(calls.some((path) => path.includes('/git/ref/heads/') || path.includes('/contents/') || path.includes('/pulls')), false);
        }
        assert.equal(calls.some((path) => path.includes('/actions/runs')), false);
    }
});
test('the governance CLI only previews or reconciles rules and workflow provisioning', () => {
    assert.deepEqual(parseArguments([]), { check: false });
    assert.deepEqual(parseArguments(['--check']), { check: true });
    for (const args of [['--promote', 'Market'], ['--check', '--check'], ['--anything']])
        assert.throws(() => parseArguments(args));
});

test('the excluded master-only automation repository receives no rules or bootstrap requests', async () => {
    const saved = JSON.parse(
        await readFile(new URL('../../.github/repository-protection.json', import.meta.url), 'utf8'),
    );
    const metadata = {
        name: 'automation',
        full_name: 'Kraftink-CMS/automation',
        owner: { login: 'Kraftink-CMS' },
        private: false,
        visibility: 'public',
        archived: false,
        disabled: false,
        allow_merge_commit: true,
    };
    const calls = [];
    const client = {
        authenticated: true,
        async request(method, path) {
            calls.push({ method, path });
            assert.equal(method, 'GET');
            if (path.startsWith('/orgs/Kraftink-CMS/repos?')) return [metadata];
            throw new Error(`Unexpected request ${path}`);
        },
    };
    const options = { config: saved, client, appId: 123, appSlug, check: true };
    const report = await governRepositories(options);
    assert.equal(report.failed, 0);
    assert.equal(report.protections.results.length, 1);
    assert.equal(report.protections.results[0].action, 'excluded');
    assert.deepEqual(report.workflows, []);
    assert.ok(calls.every((call) => call.path.startsWith('/orgs/Kraftink-CMS/repos?')));
});
