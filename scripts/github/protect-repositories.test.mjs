import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { requestWorkflow } from './provision-release-workflow.mjs';
import {
    createGitHubClient,
    protectRepositories,
    selectPolicies,
    summaryMarkdown,
    validateConfiguration,
} from './protect-repositories.mjs';

const organization = 'Kraftink-CMS';
const fullName = (name) => `${organization}/${name}`;

function baselineRuleset() {
    return {
        name: 'Protect master',
        target: 'branch',
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
                    dismiss_stale_reviews_on_push: false,
                    required_reviewers: [],
                    require_code_owner_review: false,
                    require_last_push_approval: false,
                    required_review_thread_resolution: false,
                    require_extra_approval_for_unattributed_changes: false,
                    allowed_merge_methods: ['merge'],
                },
            },
        ],
    };
}

function configuration(excluded = ['Website']) {
    return {
        schema: 1,
        organization,
        excluded_repositories: excluded,
        policies: [
            { id: 'baseline', repositories: { include: ['*'], exclude: [] }, rulesets: [baselineRuleset()] },
        ],
    };
}

function repository(name = 'Plugin-Sample', changes = {}) {
    return {
        name,
        full_name: fullName(name),
        owner: { login: organization },
        visibility: 'public',
        private: false,
        archived: false,
        disabled: false,
        fork: false,
        allow_merge_commit: true,
        ...changes,
    };
}

function ruleset(name = 'Plugin-Sample', changes = {}) {
    return {
        ...baselineRuleset(),
        id: 7,
        source_type: 'Repository',
        source: fullName(name),
        ...changes,
    };
}

function api({ repositories = [repository()], states = {}, token = 'fixture-admin-token', override } = {}) {
    const calls = [];
    const stored = new Map(
        repositories.map((repo) => [
            repo.name,
            {
                metadata: structuredClone(repo),
                rulesets: [],
                ...structuredClone(states[repo.name] ?? {}),
            },
        ]),
    );
    const client = createGitHubClient({
        token,
        transport: async (url, options) => {
            const target = new URL(url);
            const path = target.pathname;
            const body = options.body === undefined ? undefined : JSON.parse(options.body);
            const call = { method: options.method, path, query: target.searchParams, body };
            calls.push(call);
            assert.equal(target.origin, 'https://api.github.com');
            assert.equal(options.redirect, 'error');
            assert.equal(options.headers['X-GitHub-Api-Version'], '2022-11-28');
            assert.equal(options.headers.Authorization, token ? `Bearer ${token}` : undefined);
            const match = /^\/repos\/[^/]+\/([^/]+)(.*)$/.exec(path);
            const state = match ? stored.get(match[1]) : null;
            const changed = await override?.({ ...call, state, calls, client });
            if (changed !== undefined) return changed;
            const page = Number(target.searchParams.get('page')) || 1;
            const slice = (values) => values.slice((page - 1) * 100, page * 100);
            if (/^\/orgs\/[^/]+\/repos$/.test(path)) {
                assert.equal(options.method, 'GET');
                assert.equal(target.searchParams.get('type'), 'public');
                return Response.json(slice(repositories));
            }
            assert.ok(state, `Unexpected fixture repository ${path}`);
            const suffix = match[2];
            if (suffix === '') {
                if (options.method === 'GET') return Response.json(state.metadata);
                assert.equal(options.method, 'PATCH');
                assert.deepEqual(body, { allow_merge_commit: true });
                state.metadata.allow_merge_commit = true;
                return Response.json(state.metadata);
            }
            if (suffix === '/actions/permissions/workflow') {
                state.workflowPermissions ??= { default_workflow_permissions: 'read', can_approve_pull_request_reviews: true };
                if (options.method === 'GET') return Response.json(state.workflowPermissions);
                assert.equal(options.method, 'PUT');
                assert.deepEqual(body, { can_approve_pull_request_reviews: true });
                state.workflowPermissions.can_approve_pull_request_reviews = true;
                return new Response(null, { status: 204 });
            }
            if (suffix === '/git/ref/heads/dev')
                return Response.json({ ref: 'refs/heads/dev', object: { type: 'commit', sha: 'a'.repeat(40) } });
            if (suffix === '/contents/.github/workflows/release.yml') {
                if (!state.devWorkflow) return Response.json({}, { status: 404 });
                return Response.json(state.devWorkflow);
            }
            if (suffix === '/rulesets' && options.method === 'GET') {
                assert.equal(target.searchParams.get('includes_parents'), 'false');
                return Response.json(slice(state.rulesets));
            }
            if (/^\/rulesets\/\d+$/.test(suffix) && options.method === 'GET') {
                assert.equal(target.searchParams.get('includes_parents'), 'false');
                const current = state.rulesets.find((value) => value.id === Number(suffix.split('/').at(-1)));
                if (!current) return Response.json({}, { status: 404 });
                const detail = structuredClone(current);
                if (state.hideBypass) delete detail.bypass_actors;
                return Response.json(detail);
            }
            if (suffix.startsWith('/rules/branches/')) {
                assert.equal(options.method, 'GET');
                const ref = `refs/heads/${decodeURIComponent(suffix.slice('/rules/branches/'.length))}`;
                const active = state.rulesets
                    .filter(
                        (value) =>
                            value.enforcement === 'active' &&
                            value.conditions.ref_name.include.includes(ref) &&
                            !value.conditions.ref_name.exclude.includes(ref),
                    )
                    .flatMap((value) =>
                        value.rules.map((rule) => ({
                            ...rule,
                            ruleset_id: value.id,
                            ruleset_source_type: value.source_type,
                            ruleset_source: value.source,
                        })),
                    );
                return Response.json(slice(active));
            }
            if (['POST', 'PUT'].includes(options.method)) {
                assert.equal(Object.hasOwn(body, 'id'), false);
                assert.equal(Object.hasOwn(body, 'source'), false);
                assert.equal(Object.hasOwn(body.conditions, 'repository_name'), false);
                const id =
                    options.method === 'POST'
                        ? Math.max(0, ...state.rulesets.map((value) => value.id)) + 1
                        : Number(suffix.split('/').at(-1));
                const current = ruleset(match[1], { ...body, id });
                const index = state.rulesets.findIndex((value) => value.id === id);
                if (index < 0) state.rulesets.push(current);
                else state.rulesets[index] = current;
                return Response.json(current, { status: options.method === 'POST' ? 201 : 200 });
            }
            throw new Error(`Unexpected fixture request ${options.method} ${path}`);
        },
    });
    return { client, calls, stored };
}

const run = (transport, options = {}) =>
    protectRepositories({
        config: configuration(),
        client: transport.client,
        wait: async () => {},
        ...options,
    });
const writes = (transport) => transport.calls.filter((call) => call.method !== 'GET');

function checksRuleset(changes = {}) {
    return {
        name: 'Required CI',
        target: 'branch',
        enforcement: 'active',
        bypass_actors: [],
        conditions: { ref_name: { include: ['refs/heads/dev'], exclude: [] } },
        rules: [
            {
                type: 'required_status_checks',
                parameters: {
                    strict_required_status_checks_policy: true,
                    do_not_enforce_on_create: false,
                    required_status_checks: [{ context: 'validate', integration_id: 123 }],
                },
            },
        ],
        ...changes,
    };
}

const profile = (id, rulesets, include = ['*'], exclude = []) => ({
    id,
    repositories: { include, exclude },
    rulesets,
});

test('profile configuration accepts multiple exclusions and rejects unsafe API scope or payload shapes', () => {
    for (const excluded of [[], ['Website'], ['Website', 'Sandbox', 'Docs']]) {
        assert.deepEqual(validateConfiguration(configuration(excluded)), configuration(excluded));
    }
    const invalid = [
        { ...configuration(), organization: 'another-org' },
        configuration(['Website', 'website']),
        configuration(['../Website']),
        configuration(['Plugin-*']),
        { ...configuration(), schema: 2 },
    ];
    for (const change of [
        { id: 7 },
        { source_type: 'Organization' },
        { bypass_actors: [{ actor_id: '${APP_ID}', actor_type: 'User', bypass_mode: 'always' }] },
        { conditions: { ref_name: { include: ['https://elsewhere.invalid'], exclude: [] } } },
        {
            conditions: {
                ref_name: { include: ['refs/heads/master'], exclude: [] },
                repository_name: { include: ['*'] },
            },
        },
        { enforcement: 'evaluate' },
        { target: 'tag' },
        { rules: [{ type: 'https://elsewhere.invalid' }] },
        { rules: [{ type: 'required_status_checks', parameters: { execute: () => 'never execute' } }] },
    ]) {
        const config = configuration();
        config.policies[0].rulesets[0] = { ...baselineRuleset(), ...change };
        invalid.push(config);
    }
    for (const config of invalid) assert.throws(() => validateConfiguration(config));
    for (const field of ['release_workflow', 'validated_releases']) {
        for (const value of [true, false]) {
            const config = configuration();
            config.policies[0][field] = value;
            assert.equal(validateConfiguration(config).policies[0][field], value);
        }
        for (const value of [null, 1, 'true', []]) {
            const config = configuration();
            config.policies[0][field] = value;
            assert.throws(() => validateConfiguration(config));
        }
    }
    const retired = configuration();
    retired.policies[0].pull_requests = [];
    assert.throws(() => validateConfiguration(retired));
});

test('ruleset rename aliases reject invalid names, self aliases and case-insensitive duplicates', () => {
    const config = configuration();
    config.policies[0].rulesets[0].previous_names = ['Previous master protection'];
    assert.deepEqual(validateConfiguration(config), config);
    for (const previous_names of [
        null,
        'Previous master protection',
        [123],
        [''],
        [' Legacy protection'],
        ['Legacy\nprotection'],
        ['x'.repeat(101)],
        ['PROTECT MASTER'],
        ['Legacy', 'legacy'],
        Array.from({ length: 33 }, (_, index) => `Legacy ${index}`),
    ]) {
        const invalid = structuredClone(config);
        invalid.policies[0].rulesets[0].previous_names = previous_names;
        assert.throws(() => validateConfiguration(invalid));
    }
});

test('repository selectors use cumulative case-insensitive globs with exact global exclusions', () => {
    const config = configuration(['Website', 'Plugin-Z']);
    config.policies.push(profile('plugins', [checksRuleset()], ['Plugin-?'], ['Plugin-X']));
    config.policies.push(profile('docs', [checksRuleset({ name: 'Docs checks' })], ['Docs.v?']));
    assert.deepEqual(
        selectPolicies(config, 'pLuGiN-a').map((value) => value.id),
        ['baseline', 'plugins'],
    );
    assert.deepEqual(
        selectPolicies(config, 'Plugin-X').map((value) => value.id),
        ['baseline'],
    );
    assert.deepEqual(
        selectPolicies(config, 'Plugin-Long').map((value) => value.id),
        ['baseline'],
    );
    assert.deepEqual(
        selectPolicies(config, 'Docs.v1').map((value) => value.id),
        ['baseline', 'docs'],
    );
    assert.deepEqual(
        selectPolicies(config, 'DocsXv1').map((value) => value.id),
        ['baseline'],
    );
    assert.deepEqual(selectPolicies(config, 'WEBSITE'), []);
    assert.deepEqual(selectPolicies(config, 'plugin-z'), []);
    const invalid = configuration();
    invalid.policies[0].repositories.include = ['https://elsewhere.invalid'];
    assert.throws(() => validateConfiguration(invalid));
    invalid.policies[0].repositories.include = ['Plugin-[A-Z]'];
    assert.throws(() => validateConfiguration(invalid));
});

test('profiles add native approvals and checks without changing the engine or unrelated repositories', async () => {
    const approvals = baselineRuleset();
    approvals.name = 'Reviewed releases';
    approvals.rules.find((rule) => rule.type === 'pull_request').parameters.required_approving_review_count =
        2;
    const config = configuration();
    config.policies.push(profile('plugin-quality', [checksRuleset(), approvals], ['Plugin-*']));
    const transport = api({ repositories: [repository(), repository('Theme-Sample')] });
    const report = await run(transport, { config });
    assert.equal(report.failed, 0);
    assert.deepEqual(
        report.results.map((result) => [result.repository, result.policy, result.ruleset]),
        [
            [fullName('Plugin-Sample'), 'baseline', 'Protect master'],
            [fullName('Plugin-Sample'), 'plugin-quality', 'Required CI'],
            [fullName('Plugin-Sample'), 'plugin-quality', 'Reviewed releases'],
            [fullName('Theme-Sample'), 'baseline', 'Protect master'],
        ],
    );
    assert.ok(report.results.every((result) => result.confirmed));
    assert.ok(transport.calls.some((call) => call.path.endsWith('/rules/branches/dev')));
    const again = await run(transport, { config });
    assert.ok(again.results.every((result) => result.action === 'unchanged'));
    assert.equal(writes(transport).length, 4);
});

test('colliding selected ruleset names fail before all repository mutations', async () => {
    const config = configuration();
    config.policies.push(profile('collision', [baselineRuleset()], ['Plugin-*']));
    assert.throws(() => selectPolicies(config, 'Plugin-Sample'), /duplicate managed ruleset/);
    const transport = api({ repositories: [repository('Plugin-Sample', { allow_merge_commit: false })] });
    const report = await run(transport, { config });
    assert.equal(report.failed, 1);
    assert.equal(writes(transport).length, 0);
    assert.equal(
        transport.calls.some((call) => call.path.startsWith('/repos/')),
        false,
    );
    const duplicateLater = configuration();
    duplicateLater.policies.push(profile('quality', [checksRuleset()]));
    const ambiguous = api({
        states: {
            'Plugin-Sample': {
                rulesets: [
                    ruleset('Plugin-Sample', { ...checksRuleset(), id: 10 }),
                    ruleset('Plugin-Sample', { ...checksRuleset(), id: 11 }),
                ],
            },
        },
    });
    assert.equal((await run(ambiguous, { config: duplicateLater })).failed, 1);
    assert.equal(writes(ambiguous).length, 0);
});

test('selected alias collisions with current names or other aliases fail before repository API access', async () => {
    for (const alias of ['PROTECT MASTER', 'legacy master guard']) {
        const config = configuration();
        config.policies[0].rulesets[0].previous_names = ['Legacy master guard'];
        config.policies.push(profile('quality', [checksRuleset({ previous_names: [alias] })]));
        assert.throws(() => selectPolicies(config, 'Plugin-Sample'), /duplicate managed ruleset/);
        const transport = api({ repositories: [repository('Plugin-Sample', { allow_merge_commit: false })] });
        const report = await run(transport, { config });
        assert.equal(report.failed, 1);
        assert.deepEqual(writes(transport), []);
        assert.ok(transport.calls.every((call) => !call.path.startsWith('/repos/')));
    }
});

test('a legacy App merge gate becomes a validated release gate on its existing ID and remains unchanged', async () => {
    const config = JSON.parse(
        await readFile(new URL('../../.github/repository-protection.json', import.meta.url), 'utf8'),
    );
    const baseline = config.policies.find((policy) => policy.id === 'common').rulesets[0];
    const configured = config.policies.find((policy) => policy.id === 'automated-promotions').rulesets[0];
    const original = structuredClone(config);
    const { previous_names, ...gate } = configured;
    const old = ruleset('Plugin-Sample', {
        ...gate,
        id: 18,
        name: previous_names[0],
        bypass_actors: [{ actor_id: 123, actor_type: 'Integration', bypass_mode: 'pull_request' }],
    });
    const transport = api({
        states: { 'Plugin-Sample': { rulesets: [ruleset('Plugin-Sample', baseline), old] } },
    });
    const plan = await run(transport, { config, appId: 123, check: true });
    assert.equal(plan.failed, 0);
    assert.equal(plan.results.find((entry) => entry.ruleset === 'Validated master releases').action, 'update');
    assert.deepEqual(writes(transport), []);
    const applied = await run(transport, { config, appId: 123 });
    assert.equal(applied.failed, 0);
    assert.ok(applied.results.every((entry) => entry.confirmed));
    assert.deepEqual(
        writes(transport).map((call) => `${call.method} ${call.path}`),
        ['POST /repos/Kraftink-CMS/Plugin-Sample/rulesets', 'PUT /repos/Kraftink-CMS/Plugin-Sample/rulesets/18'],
    );
    assert.equal(Object.hasOwn(writes(transport)[0].body, 'previous_names'), false);
    const stored = transport.stored.get('Plugin-Sample').rulesets;
    assert.equal(stored.length, 3);
    assert.equal(stored.find((entry) => entry.id === old.id).name, 'Validated master releases');
    assert.ok(stored.every((entry) => entry.name !== old.name));
    const again = await run(transport, { config, appId: 123 });
    assert.ok(again.results.every((entry) => entry.action === 'unchanged'));
    assert.equal(writes(transport).length, 2);
    assert.deepEqual(config, original);
});

test('simultaneous old and current names or multiple matching aliases fail before any writes', async () => {
    const config = configuration();
    config.policies[0].rulesets[0].previous_names = ['Previous guard', 'Earlier guard'];
    for (const names of [
        ['Protect master', 'Previous guard'],
        ['Previous guard', 'Earlier guard'],
    ]) {
        const transport = api({
            repositories: [repository('Plugin-Sample', { allow_merge_commit: false })],
            states: {
                'Plugin-Sample': {
                    rulesets: names.map((name, index) => ruleset('Plugin-Sample', { name, id: index + 1 })),
                },
            },
        });
        const report = await run(transport, { config });
        assert.equal(report.failed, 1);
        assert.match(report.results[0].error, /ambiguous/);
        assert.deepEqual(writes(transport), []);
    }
});

test('inherited rename aliases are preserved while new repository payloads omit local metadata', async () => {
    const config = configuration();
    config.policies[0].rulesets[0].previous_names = ['Previous guard'];
    const inherited = ruleset('Plugin-Sample', {
        id: 18,
        name: 'Previous guard',
        source_type: 'Organization',
        source: organization,
    });
    const transport = api({ states: { 'Plugin-Sample': { rulesets: [inherited] } } });
    const report = await run(transport, { config });
    assert.equal(report.failed, 0);
    assert.equal(report.results[0].action, 'create');
    assert.deepEqual(
        writes(transport).map((call) => call.method),
        ['POST'],
    );
    assert.deepEqual(writes(transport)[0].body, baselineRuleset());
    assert.deepEqual(transport.stored.get('Plugin-Sample').rulesets[0], inherited);
});

test('GitHub App bindings are restricted to Integration bypass IDs and resolved before any apply request', async () => {
    const gate = baselineRuleset();
    gate.name = 'Central merger';
    gate.rules = [{ type: 'update' }];
    gate.bypass_actors = [{ actor_id: '${APP_ID}', actor_type: 'Integration', bypass_mode: 'pull_request' }];
    const config = configuration();
    config.policies.push({
        ...profile('master-gate', [gate]),
        release_workflow: false,
    });
    const resolved = validateConfiguration(config, { appId: '123' });
    assert.equal(resolved.policies[1].rulesets[0].bypass_actors[0].actor_id, 123);
    assert.equal(config.policies[1].rulesets[0].bypass_actors[0].actor_id, '${APP_ID}');
    assert.equal(resolved.policies[1].release_workflow, false);
    const missing = api();
    await assert.rejects(run(missing, { config }), /App ID binding is required/);
    assert.equal(missing.calls.length, 0);
    const transport = api();
    const report = await run(transport, { config, appId: 123 });
    assert.equal(report.failed, 0);
    assert.ok(report.results.every((result) => result.confirmed));
    assert.deepEqual(writes(transport).at(-1).body.bypass_actors, [
        { actor_id: 123, actor_type: 'Integration', bypass_mode: 'pull_request' },
    ]);
    const plan = await run(api({ token: '' }), { config, check: true });
    assert.match(plan.results.at(-1).note, /binding is unresolved/);
    assert.equal(plan.results.at(-1).confirmed, false);
    assert.throws(() => validateConfiguration(config, { appId: '123; execute' }), /positive safe integer/);
    const tampered = structuredClone(config);
    tampered.policies[1].rulesets[0].bypass_actors[0].actor_type = 'User';
    assert.throws(() => validateConfiguration(tampered), /invalid native branch or tag/);
});

test('the saved configuration applies product protections without touching excluded repositories', async () => {
    const config = JSON.parse(
        await readFile(new URL('../../.github/repository-protection.json', import.meta.url), 'utf8'),
    );
    const excluded = config.excluded_repositories;
    assert.ok(!excluded.some((name) => name.toLowerCase() === 'kraftink.com'));
    const appId = 987654;
    const transport = api({
        repositories: [
            repository('Plugin-Integration'),
            ...excluded.map((name) => repository(name)),
            repository('Market'),
        ],
    });
    const report = await run(transport, { config, appId });
    assert.equal(report.failed, 0);
    const expected = ['Plugin-Integration', 'Market'].flatMap((name) => [
        ...(name === 'Plugin-Integration' ? [[fullName(name), 'Validate dev changes']] : []),
        ...selectPolicies(config, name).flatMap((policy) =>
            policy.rulesets.map((value) => [fullName(name), name === 'Plugin-Integration' && value.name === 'App-only master merges'
                ? 'Validated master releases' : value.name]),
        ),
    ]);
    assert.deepEqual(
        report.results
            .filter((result) => result.action !== 'excluded')
            .map((result) => [result.repository, result.ruleset]),
        expected,
    );
    for (const name of ['Plugin-Integration', 'Market']) {
        const stored = transport.stored.get(name).rulesets;
        assert.ok(stored.some((value) => value.name === 'Protect master'));
        const gate = stored.find((value) => value.name === (name === 'Plugin-Integration' ? 'Validated master releases' : 'App-only master merges'));
        assert.deepEqual(gate.bypass_actors, [
            { actor_id: appId, actor_type: 'Integration', bypass_mode: 'pull_request' },
        ]);
        assert.equal(gate.rules[0].type, name === 'Plugin-Integration' ? 'required_status_checks' : 'update');
    }
    assert.equal(selectPolicies(config, 'Market').some((policy) => policy.release_workflow === true), false);
    assert.deepEqual(
        report.results.filter((result) => result.action === 'excluded').map((result) => result.repository),
        excluded.map(fullName),
    );
    for (const name of excluded) {
        assert.deepEqual(transport.stored.get(name).rulesets, []);
        assert.ok(transport.calls.every((call) => !call.path.startsWith(`/repos/${fullName(name)}`)));
    }
    const written = writes(transport).length;
    assert.ok(
        report.results
            .filter((result) => result.action !== 'excluded')
            .every((result) => result.configured && result.confirmed),
    );
    const again = await run(transport, { config, appId });
    assert.equal(again.failed, 0);
    assert.ok(
        again.results
            .filter((result) => result.action !== 'excluded')
            .every((result) => result.action === 'unchanged'),
    );
    assert.equal(writes(transport).length, written);
});

test('caller release permissions and the Actions validation requirement are limited to managed release repositories', async () => {
    const config = JSON.parse(await readFile(new URL('../../.github/repository-protection.json', import.meta.url), 'utf8'));
    config.policies.find((policy) => policy.id === 'cms').id = 'independent-publisher';
    const file = (source) => {
        const bytes = Buffer.from(source);
        return { type: 'file', path: '.github/workflows/release.yml', encoding: 'base64',
            content: bytes.toString('base64'),
            sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') };
    };
    for (const [name, enabled, source, fork] of [
        ['Plugin-Sample', true, null, false],
        ['Custom-Release', true, requestWorkflow, false],
        ['kraftink.com', true, requestWorkflow, false],
        ['Custom-OptOut', false, null, false],
        ['Custom-Edited', false, requestWorkflow.replace('contents: write', 'contents: read'), false],
        ['Kraftink', true, null, false],
        ['KraftInk', false, null, true],
        ['Market', false, null, false],
        ['Plugin-Fork', false, null, true],
    ]) {
        const transport = api({ repositories: [repository(name, { fork })], states: {
            [name]: { ...(source ? { devWorkflow: file(source) } : {}),
                workflowPermissions: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false } },
        } });
        const report = await run(transport, { config, appId: 123 });
        assert.equal(report.failed, 0, name);
        assert.equal(transport.calls.some((call) => call.path.endsWith('/actions/permissions/workflow')), enabled, name);
        assert.equal(transport.stored.get(name).workflowPermissions.can_approve_pull_request_reviews, enabled, name);
        if (name.toLowerCase() === 'kraftink')
            assert.equal(transport.calls.some((call) => call.path.includes('/contents/.github/workflows/')), false);
        const gate = transport.stored.get(name).rulesets.find((value) => value.name === (enabled ? 'Validated master releases' : 'App-only master merges'));
        assert.deepEqual(gate.bypass_actors, [
            { actor_id: 123, actor_type: 'Integration', bypass_mode: 'pull_request' },
        ], name);
        assert.deepEqual(gate.rules, enabled ? [{ type: 'required_status_checks', parameters: {
            strict_required_status_checks_policy: false,
            do_not_enforce_on_create: false,
            required_status_checks: [{ context: 'Release validated source', integration_id: 15368 }],
        } }] : [{ type: 'update', parameters: { update_allows_fetch_and_merge: false } }], name);
        const baseline = transport.stored.get(name).rulesets.find((value) => value.name === 'Protect master');
        assert.deepEqual(baseline.bypass_actors, []);
        assert.deepEqual(baseline.rules.map((rule) => rule.type).sort(), ['deletion', 'non_fast_forward', 'pull_request']);
        const development = transport.stored.get(name).rulesets.find((value) => value.name === 'Validate dev changes');
        assert.equal(Boolean(development), enabled, name);
        if (development) {
            assert.deepEqual(development.conditions.ref_name, { include: ['refs/heads/dev'], exclude: [] });
            assert.deepEqual(development.bypass_actors, [
                { actor_id: 2, actor_type: 'RepositoryRole', bypass_mode: 'always' },
                { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' },
                { actor_id: 123, actor_type: 'Integration', bypass_mode: 'always' },
            ]);
            assert.deepEqual(development.rules, [{ type: 'required_status_checks', parameters: {
                strict_required_status_checks_policy: true, do_not_enforce_on_create: true,
                required_status_checks: [{ context: 'checks / Validate changes', integration_id: 15368 }],
            } }]);
        }
    }
});

test('custom release opt-in changes reuse the same gate without leaving concurrent managed rulesets', async () => {
    const config = JSON.parse(await readFile(new URL('../../.github/repository-protection.json', import.meta.url), 'utf8'));
    const bytes = Buffer.from(requestWorkflow);
    const file = { type: 'file', path: '.github/workflows/release.yml', encoding: 'base64',
        content: bytes.toString('base64'), sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') };
    const name = 'Custom-Assets';
    const transport = api({ repositories: [repository(name)], states: { [name]: { devWorkflow: file } } });
    let gateId;
    for (const enabled of [true, false, true]) {
        transport.stored.get(name).devWorkflow = enabled ? file : null;
        assert.equal((await run(transport, { config, appId: 123 })).failed, 0);
        const rulesets = transport.stored.get(name).rulesets;
        assert.equal(rulesets.length, 3);
        const gate = rulesets.find((value) => ['Validated master releases', 'App-only master merges'].includes(value.name));
        assert.equal(rulesets.find((value) => value.name === 'Validate dev changes').enforcement, enabled ? 'active' : 'disabled');
        gateId ??= gate.id;
        assert.equal(gate.id, gateId);
        assert.equal(gate.name, enabled ? 'Validated master releases' : 'App-only master merges');
        assert.equal(gate.rules[0].type, enabled ? 'required_status_checks' : 'update');
        assert.deepEqual(gate.bypass_actors, [{ actor_id: 123, actor_type: 'Integration', bypass_mode: 'pull_request' }]);
    }
});

test('allowing caller PR creation preserves token defaults, supports dry runs and verifies the native setting', async () => {
    const config = JSON.parse(await readFile(new URL('../../.github/repository-protection.json', import.meta.url), 'utf8'));
    for (const permission of ['read', 'write']) {
        const transport = api({ states: { 'Plugin-Sample': {
            workflowPermissions: { default_workflow_permissions: permission, can_approve_pull_request_reviews: false },
        } } });
        assert.equal((await run(transport, { config, appId: 123, check: true })).failed, 0);
        assert.deepEqual(writes(transport), []);
        assert.equal((await run(transport, { config, appId: 123 })).failed, 0);
        const updates = transport.calls.filter((call) => call.path.endsWith('/actions/permissions/workflow') && call.method === 'PUT');
        assert.deepEqual(updates.map((call) => call.body), [{ can_approve_pull_request_reviews: true }]);
        assert.equal(transport.stored.get('Plugin-Sample').workflowPermissions.default_workflow_permissions, permission);
        assert.equal((await run(transport, { config, appId: 123 })).failed, 0);
        assert.equal(transport.calls.filter((call) => call.method === 'PUT' && call.path.endsWith('/actions/permissions/workflow')).length, 1);
    }
    const unconfirmed = api({ states: { 'Plugin-Sample': {
        workflowPermissions: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false },
    } }, override: ({ method, path }) => method === 'PUT' && path.endsWith('/actions/permissions/workflow')
        ? new Response(null, { status: 204 }) : undefined });
    const report = await run(unconfirmed, { config, appId: 123 });
    assert.equal(report.failed, 1);
    assert.match(report.results[0].error, /did not confirm pull request creation/);
    assert.equal(unconfirmed.calls.some((call) => call.path.endsWith('/rulesets')), false);
});

test('excluded master-only repositories never require dev, merge settings or repository API access', async () => {
    const config = configuration(['Docs.Site']);
    const name = 'dOcS.sItE';
    for (const check of [false, true]) {
        const transport = api({
            repositories: [
                repository(name, { default_branch: 'master', allow_merge_commit: false }),
            ],
        });
        const report = await run(transport, { config, appId: 123, check });
        assert.equal(report.failed, 0);
        assert.deepEqual(
            report.results.map((result) => result.action),
            ['excluded'],
        );
        assert.equal(transport.calls.length, 1);
        assert.equal(transport.calls[0].path, '/orgs/Kraftink-CMS/repos');
        assert.equal(transport.calls[0].method, 'GET');
        assert.deepEqual(writes(transport), []);
        assert.deepEqual(transport.stored.get(name).rulesets, []);
        assert.equal(transport.stored.get(name).metadata.allow_merge_commit, false);
    }
});

test('tag rules are confirmed as configuration without querying branch rules or claiming effective tag verification', async () => {
    const tag = {
        name: 'Reserve master branch name',
        target: 'tag',
        enforcement: 'active',
        bypass_actors: [],
        conditions: { ref_name: { include: ['refs/tags/master'], exclude: [] } },
        rules: [
            { type: 'creation' },
            { type: 'update', parameters: { update_allows_fetch_and_merge: false } },
            { type: 'deletion' },
        ],
    };
    const config = { ...configuration(), policies: [profile('reserved-tag', [tag])] };
    assert.deepEqual(validateConfiguration(config), config);
    const transport = api();
    const report = await run(transport, { config });
    assert.equal(report.failed, 0);
    assert.equal(report.results[0].configured, true);
    assert.equal(report.results[0].confirmed, false);
    assert.match(report.results[0].note, /Tag ruleset configuration verified/);
    assert.ok(transport.calls.every((call) => !call.path.includes('/rules/branches/')));
    assert.deepEqual(writes(transport)[0].body, tag);
    const count = writes(transport).length;
    const again = await run(transport, { config, check: true });
    assert.equal(again.results[0].action, 'unchanged');
    assert.equal(again.results[0].configured, true);
    assert.equal(writes(transport).length, count);
    for (const change of [
        { target: 'branch' },
        { conditions: { ref_name: { include: ['refs/heads/master'], exclude: [] } } },
        { conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } } },
        { bypass_actors: [{ actor_id: null, actor_type: 'OrganizationAdmin', bypass_mode: 'pull_request' }] },
    ]) {
        const invalid = structuredClone(config);
        Object.assign(invalid.policies[0].rulesets[0], change);
        assert.throws(() => validateConfiguration(invalid));
    }
});

test('check-only and disabled profiles do not enable merge commits they never request', async () => {
    for (const desired of [checksRuleset(), { ...baselineRuleset(), enforcement: 'disabled' }]) {
        const config = configuration();
        config.policies = [profile('quality', [desired])];
        const transport = api({ repositories: [repository('Plugin-Sample', { allow_merge_commit: false })] });
        const report = await run(transport, { config });
        assert.equal(report.failed, 0);
        assert.equal(report.results[0].confirmed, true);
        assert.equal(
            writes(transport).some((call) => call.method === 'PATCH'),
            false,
        );
        assert.equal(transport.stored.get('Plugin-Sample').metadata.allow_merge_commit, false);
    }
});

test('literal branch names are encoded and dynamic targets never claim full effective verification', async () => {
    for (const include of [
        ['refs/heads/release/stable'],
        ['refs/heads/master', 'refs/heads/release/*'],
        ['~DEFAULT_BRANCH'],
    ]) {
        const config = configuration();
        config.policies = [
            profile('targets', [checksRuleset({ conditions: { ref_name: { include, exclude: [] } } })]),
        ];
        const transport = api();
        const report = await run(transport, { config });
        const dynamic = include.some((ref) => ref.includes('*') || ref.startsWith('~'));
        assert.equal(report.failed, 0);
        assert.equal(report.results[0].configured, true);
        assert.equal(report.results[0].confirmed, !dynamic);
        if (dynamic) assert.match(report.results[0].note, /cannot receive complete effective/);
        else
            assert.ok(transport.calls.some((call) => call.path.endsWith('/rules/branches/release%2Fstable')));
        if (include.includes('refs/heads/master'))
            assert.ok(transport.calls.some((call) => call.path.endsWith('/rules/branches/master')));
    }
});

test('removed profiles and newly excluded repositories never delete existing GitHub rulesets', async () => {
    const transport = api();
    assert.equal((await run(transport)).failed, 0);
    const before = structuredClone(transport.stored.get('Plugin-Sample').rulesets);
    const removed = configuration();
    removed.policies = [];
    await run(transport, { config: removed });
    await run(transport, { config: configuration(['Website', 'Plugin-Sample']) });
    assert.deepEqual(transport.stored.get('Plugin-Sample').rulesets, before);
    assert.deepEqual(
        writes(transport).map((call) => call.method),
        ['POST'],
    );
});

test('a new public repository receives only the exact local master policy and verifies effective rules', async () => {
    const transport = api();
    const report = await run(transport);
    assert.equal(report.failed, 0);
    assert.equal(report.results[0].action, 'create');
    assert.equal(report.results[0].confirmed, true);
    assert.equal(report.results[0].merge_enabled, true);
    assert.deepEqual(
        writes(transport).map((call) => call.method),
        ['POST'],
    );
    assert.ok(transport.calls.some((call) => call.path.endsWith('/rules/branches/master')));
    assert.equal(
        transport.calls.some((call) => call.path.includes('/branches/master/protection')),
        false,
    );
    assert.deepEqual(writes(transport)[0].body, baselineRuleset());
    const again = await run(transport);
    assert.equal(again.results[0].action, 'unchanged');
    assert.equal(writes(transport).length, 1);
});

test('canonical comparison avoids rewriting reordered rules or default optional parameters', async () => {
    const current = ruleset();
    current.rules.reverse();
    const parameters = current.rules.find((value) => value.type === 'pull_request').parameters;
    delete parameters.required_reviewers;
    delete parameters.require_extra_approval_for_unattributed_changes;
    const transport = api({ states: { 'Plugin-Sample': { rulesets: [current] } } });
    const report = await run(transport);
    assert.equal(report.results[0].action, 'unchanged');
    assert.equal(report.results[0].confirmed, true);
    assert.equal(writes(transport).length, 0);
});

test('GitHub pull request defaults match both stored and effective policy without rewriting configuration', async () => {
    const current = ruleset();
    Object.assign(current.rules.find((rule) => rule.type === 'pull_request').parameters, {
        dismissal_restriction: { enabled: false, allowed_actors: [] },
        ignore_approvals_from_contributors: false,
    });
    const transport = api({ states: { 'Plugin-Sample': { rulesets: [current] } } });
    const report = await run(transport);
    assert.equal(report.failed, 0);
    assert.equal(report.results[0].action, 'unchanged');
    assert.equal(report.results[0].confirmed, true);
    assert.ok(transport.calls.some((call) => call.path.endsWith('/rulesets/7')));
    assert.ok(transport.calls.some((call) => call.path.endsWith('/rules/branches/master')));
    assert.equal(writes(transport).length, 0);
});

test('nondefault dismissal restrictions and contributor approval policy remain detectable drift', async (context) => {
    for (const parameters of [
        { ignore_approvals_from_contributors: true },
        { dismissal_restriction: { enabled: true, allowed_actors: [] } },
        { dismissal_restriction: { enabled: false, allowed_actors: [{ id: 123, type: 'Team' }] } },
    ]) {
        await context.test(JSON.stringify(parameters), async () => {
            const current = ruleset();
            Object.assign(current.rules.find((rule) => rule.type === 'pull_request').parameters, parameters);
            const transport = api({ states: { 'Plugin-Sample': { rulesets: [current] } } });
            const report = await run(transport);
            assert.equal(report.failed, 0);
            assert.equal(report.results[0].action, 'update');
            assert.equal(report.results[0].confirmed, true);
            assert.deepEqual(
                writes(transport).map((call) => call.method),
                ['PUT'],
            );
            assert.deepEqual(writes(transport)[0].body, baselineRuleset());
        });
    }
});

test('native update defaults and nullable status integrations do not create reconciliation drift', async () => {
    const config = configuration();
    config.policies[0].rulesets[0].rules.push(
        { type: 'update', parameters: { update_allows_fetch_and_merge: false } },
        {
            type: 'required_status_checks',
            parameters: {
                required_status_checks: [{ context: 'validation' }],
                strict_required_status_checks_policy: false,
                do_not_enforce_on_create: false,
            },
        },
    );
    const current = ruleset('Plugin-Sample', {
        rules: structuredClone(config.policies[0].rulesets[0].rules),
    });
    delete current.rules.find((rule) => rule.type === 'update').parameters;
    current.rules.find(
        (rule) => rule.type === 'required_status_checks',
    ).parameters.required_status_checks[0].integration_id = null;
    const transport = api({ states: { 'Plugin-Sample': { rulesets: [current] } } });
    const report = await run(transport, { config });
    assert.equal(report.failed, 0);
    assert.equal(report.results[0].action, 'unchanged');
    assert.equal(report.results[0].confirmed, true);
    assert.equal(writes(transport).length, 0);
});

test('drift updates only the repository-owned Protect master ruleset', async () => {
    const desired = ruleset();
    const inherited = ruleset('Plugin-Sample', { id: 8, source_type: 'Organization', source: organization });
    const unrelated = ruleset('Plugin-Sample', { id: 9, name: 'Protect tags', target: 'tag' });
    const transport = api({
        states: {
            'Plugin-Sample': { rulesets: [{ ...desired, enforcement: 'disabled' }, inherited, unrelated] },
        },
    });
    const report = await run(transport);
    assert.equal(report.failed, 0);
    assert.equal(report.results[0].action, 'update');
    assert.deepEqual(
        writes(transport).map((call) => `${call.method} ${call.path}`),
        ['PUT /repos/Kraftink-CMS/Plugin-Sample/rulesets/7'],
    );
    assert.deepEqual(
        transport.stored.get('Plugin-Sample').rulesets.find((value) => value.id === 8),
        inherited,
    );
    assert.deepEqual(
        transport.stored.get('Plugin-Sample').rulesets.find((value) => value.id === 9),
        unrelated,
    );
});

test('inherited policies never become update targets and duplicate local names fail before mutations', async () => {
    const inherited = ruleset('Plugin-Sample', { id: 8, source_type: 'Organization', source: organization });
    const transport = api({ states: { 'Plugin-Sample': { rulesets: [inherited] } } });
    assert.equal((await run(transport)).results[0].action, 'create');
    assert.deepEqual(
        writes(transport).map((call) => call.method),
        ['POST'],
    );
    const duplicate = api({
        repositories: [repository('Plugin-Sample', { allow_merge_commit: false })],
        states: { 'Plugin-Sample': { rulesets: [ruleset(), ruleset('Plugin-Sample', { id: 8 })] } },
    });
    const report = await run(duplicate);
    assert.equal(report.failed, 1);
    assert.match(report.results[0].error, /ambiguous/);
    assert.equal(writes(duplicate).length, 0);
});

test('public check mode plans creates and updates without credentials or any mutations', async () => {
    const repos = [
        repository('Plugin-New', { allow_merge_commit: false }),
        repository('Theme-Drift'),
        repository('Game-Ready'),
    ];
    const transport = api({
        token: '',
        repositories: repos,
        states: {
            'Theme-Drift': { rulesets: [ruleset('Theme-Drift', { enforcement: 'disabled' })] },
            'Game-Ready': { rulesets: [ruleset('Game-Ready')] },
        },
    });
    const report = await run(transport, { check: true });
    assert.equal(report.failed, 0);
    assert.deepEqual(
        report.results.map((result) => result.action),
        ['create', 'update', 'unchanged'],
    );
    assert.equal(report.results[0].merge_enabled, false);
    assert.match(report.results[0].note, /will be enabled/);
    assert.equal(writes(transport).length, 0);
    const missing = api({ token: '' });
    await assert.rejects(run(missing), /Authenticated repository administration/);
    assert.equal(missing.calls.length, 0);
});

test('publicly hidden bypass actors or merge settings are never reported as fully verified', async () => {
    const metadata = repository();
    delete metadata.allow_merge_commit;
    const transport = api({
        token: '',
        states: { 'Plugin-Sample': { metadata, rulesets: [ruleset()], hideBypass: true } },
    });
    const report = await run(transport, { check: true });
    assert.equal(report.failed, 0);
    assert.equal(report.results[0].action, 'unchanged');
    assert.equal(report.results[0].confirmed, false);
    assert.equal(report.results[0].merge_enabled, null);
    assert.match(report.results[0].note, /hidden bypass actors/);
    assert.match(report.results[0].note, /merge commit setting/);
    assert.equal(writes(transport).length, 0);
    const hidden = api({ states: { 'Plugin-Sample': { rulesets: [ruleset()], hideBypass: true } } });
    assert.equal((await run(hidden)).failed, 1);
    assert.equal(writes(hidden).length, 0);
    const mergeOnlyHidden = api({
        token: '',
        states: { 'Plugin-Sample': { metadata, rulesets: [ruleset()] } },
    });
    const incomplete = await run(mergeOnlyHidden, { check: true });
    assert.equal(incomplete.results[0].confirmed, false);
    assert.equal(incomplete.results[0].merge_enabled, null);
});

test('Website and additional exclusions ignore case while future repositories need no local configuration', async () => {
    const repositories = ['wEbSiTe', 'Sandbox', 'DOCS', 'Plugin-Future'].map((name) =>
        repository(name, { allow_merge_commit: false }),
    );
    const transport = api({ repositories });
    const report = await run(transport, { config: configuration(['Website', 'sandbox', 'Docs']) });
    assert.equal(report.failed, 0);
    assert.deepEqual(
        report.results.map((result) => result.action),
        ['excluded', 'excluded', 'excluded', 'create'],
    );
    assert.ok(
        transport.calls
            .filter((call) => call.path.startsWith('/repos/'))
            .every((call) => call.path.includes('/Plugin-Future')),
    );
    assert.deepEqual(
        writes(transport).map((call) => call.method),
        ['PATCH', 'POST'],
    );
    transport.stored.set('Game-Added-Later', { metadata: repository('Game-Added-Later'), rulesets: [] });
    repositories.push(repository('Game-Added-Later'));
    const later = await run(transport, { config: configuration(['Website', 'sandbox', 'Docs']) });
    assert.equal(later.results.at(-1).action, 'create');
});

test('private, foreign, archived and disabled repositories are skipped while organization forks are protected', async () => {
    const repositories = [
        repository('Private', { private: true, visibility: 'private' }),
        repository('Foreign', { owner: { login: 'another-org' }, full_name: 'another-org/Foreign' }),
        repository('Archive', { archived: true }),
        repository('Disabled', { disabled: true }),
        repository('Fork', { fork: true, default_branch: 'dev' }),
    ];
    const transport = api({ repositories });
    const report = await run(transport);
    assert.equal(report.failed, 0);
    assert.deepEqual(
        report.results.map((result) => result.action),
        ['skipped', 'skipped', 'skipped', 'skipped', 'create'],
    );
    assert.ok(
        transport.calls
            .filter((call) => call.path.startsWith('/repos/'))
            .every((call) => call.path.includes('/Fork')),
    );
    assert.equal(report.results.at(-1).confirmed, true);
});

test('fresh metadata prevents settings or rules writes after privatization, transfer, rename or archival', async () => {
    for (const changes of [
        { private: true, visibility: 'private' },
        { owner: { login: 'another-org' }, full_name: 'another-org/Plugin-Sample' },
        { name: 'Website', full_name: fullName('Website') },
        { archived: true },
        { disabled: true },
    ]) {
        const transport = api({
            repositories: [repository('Plugin-Sample', { allow_merge_commit: false })],
            states: {
                'Plugin-Sample': {
                    metadata: repository('Plugin-Sample', { allow_merge_commit: false, ...changes }),
                },
            },
        });
        const report = await run(transport);
        assert.equal(report.failed, 0);
        assert.equal(report.results[0].confirmed, false);
        assert.equal(writes(transport).length, 0);
        assert.equal(
            transport.calls.some((call) => call.path.includes('/rulesets')),
            false,
        );
    }
    let metadataReads = 0;
    const privatizedDuringInspection = api({
        repositories: [repository('Plugin-Sample', { allow_merge_commit: false })],
        override: ({ method, path, state }) => {
            if (method === 'GET' && path === `/repos/${fullName('Plugin-Sample')}` && ++metadataReads === 2) {
                return Response.json({ ...state.metadata, private: true, visibility: 'private' });
            }
        },
    });
    const delayed = await run(privatizedDuringInspection);
    assert.equal(delayed.failed, 1);
    assert.equal(writes(privatizedDuringInspection).length, 0);
});

test('merge commits are enabled with one narrowly scoped settings PATCH and verified before rules writes', async () => {
    const transport = api({
        repositories: [
            repository('Plugin-Sample', {
                allow_merge_commit: false,
                allow_squash_merge: false,
                allow_rebase_merge: true,
            }),
        ],
    });
    const report = await run(transport);
    assert.equal(report.failed, 0);
    assert.equal(report.results[0].merge_enabled, true);
    assert.equal(report.results[0].merge_changed, true);
    assert.deepEqual(
        writes(transport).map((call) => call.method),
        ['PATCH', 'POST'],
    );
    assert.deepEqual(writes(transport)[0].body, { allow_merge_commit: true });
    const metadata = transport.stored.get('Plugin-Sample').metadata;
    assert.equal(metadata.allow_squash_merge, false);
    assert.equal(metadata.allow_rebase_merge, true);
    const again = await run(transport);
    assert.equal(again.results[0].action, 'unchanged');
    assert.equal(writes(transport).filter((call) => call.method === 'PATCH').length, 1);
});

test('hidden or unconfirmed merge settings fail before any ruleset write', async () => {
    const metadata = repository();
    delete metadata.allow_merge_commit;
    const hidden = api({ states: { 'Plugin-Sample': { metadata } } });
    assert.equal((await run(hidden)).failed, 1);
    assert.equal(writes(hidden).length, 0);
    const unconfirmed = api({
        repositories: [repository('Plugin-Sample', { allow_merge_commit: false })],
        override: ({ method, path, state }) =>
            method === 'PATCH' && path === `/repos/${fullName('Plugin-Sample')}`
                ? Response.json(state.metadata)
                : undefined,
    });
    const report = await run(unconfirmed);
    assert.equal(report.failed, 1);
    assert.match(report.results[0].error, /did not confirm that merge/);
    assert.deepEqual(
        writes(unconfirmed).map((call) => call.method),
        ['PATCH'],
    );
});

test('repository and ruleset pagination find later entries and stay bounded', async () => {
    const repositories = Array.from({ length: 101 }, (_, index) =>
        repository(`Repo-${index}`, { archived: index < 100 }),
    );
    const unrelated = Array.from({ length: 100 }, (_, index) =>
        ruleset('Repo-100', { id: index + 1, name: `Unrelated ${index}` }),
    );
    const transport = api({
        repositories,
        states: { 'Repo-100': { rulesets: [...unrelated, ruleset('Repo-100', { id: 101 })] } },
    });
    const report = await run(transport);
    assert.equal(report.failed, 0);
    assert.equal(report.results.at(-1).action, 'unchanged');
    assert.deepEqual(
        transport.calls
            .filter((call) => call.path.startsWith('/orgs/'))
            .map((call) => call.query.get('page')),
        ['1', '2'],
    );
    assert.equal(writes(transport).length, 0);
    let requests = 0;
    const excessive = createGitHubClient({
        transport: async () => {
            requests++;
            return Response.json(Array.from({ length: 100 }, () => repository('Website')));
        },
    });
    await assert.rejects(run({ client: excessive }, { check: true }), /pagination limit/);
    assert.equal(requests, 100);
});

test('eventual effective rules are retried through GET only and cannot be replaced by an inherited rule', async () => {
    let branchReads = 0;
    const waited = [];
    const transport = api({
        override: ({ path }) => {
            if (path.endsWith('/rules/branches/master') && branchReads++ < 2) return Response.json([]);
        },
    });
    const report = await run(transport, { wait: async (milliseconds) => waited.push(milliseconds) });
    assert.equal(report.failed, 0);
    assert.deepEqual(waited, [1200, 1200]);
    assert.deepEqual(
        writes(transport).map((call) => call.method),
        ['POST'],
    );
    const inheritedOnly = api({
        override: ({ path }) =>
            path.endsWith('/rules/branches/master')
                ? Response.json(
                      baselineRuleset().rules.map((rule) => ({
                          ...rule,
                          ruleset_id: 999,
                          ruleset_source_type: 'Organization',
                          ruleset_source: organization,
                      })),
                  )
                : undefined,
    });
    const failed = await run(inheritedOnly);
    assert.equal(failed.failed, 1);
    assert.match(failed.results[0].error, /configured ruleset and effective branch/);
    assert.equal(writes(inheritedOnly).length, 1);
});

test('failed writes are not blindly retried and failures continue with other public repositories without leaking secrets', async () => {
    const secret = 'fixture-admin-token';
    const repositories = [repository('Plugin-Broken'), repository('Theme-Works')];
    const transport = api({
        repositories,
        token: secret,
        override: ({ method, path }) => {
            if (method === 'POST' && path.includes('Plugin-Broken'))
                return Response.json({ message: `bad ${secret}` }, { status: 500 });
        },
    });
    const report = await run(transport);
    assert.equal(report.failed, 1);
    assert.deepEqual(
        report.results.map((result) => result.action),
        ['failed', 'create'],
    );
    assert.equal(writes(transport).filter((call) => call.path.includes('Plugin-Broken')).length, 1);
    assert.equal(JSON.stringify(report).includes(secret), false);
    assert.equal(summaryMarkdown(report).includes(secret), false);
    assert.match(summaryMarkdown(report), /status 500/);
    const leaked = api({
        override: () => {
            throw new Error(`Transport exposed ${secret}`);
        },
    });
    await assert.rejects(
        run(leaked),
        (error) => !error.message.includes(secret) && /network request failed/.test(error.message),
    );
});

test('response and endpoint guards reject redirects, oversized JSON and writes outside the approved API scope', async () => {
    for (const response of [
        () => new Response('invalid json'),
        () => new Response('{}', { headers: { 'content-length': '8388609' } }),
        () => Response.json({}, { status: 302, headers: { location: 'https://elsewhere.invalid' } }),
        () => Response.json({ invalid: 'inventory' }),
    ]) {
        const client = createGitHubClient({ transport: async () => response() });
        await assert.rejects(run({ client }, { check: true }));
    }
    let called = false;
    const client = createGitHubClient({
        token: 'fixture-admin-token',
        transport: async () => {
            called = true;
            return Response.json({});
        },
    });
    for (const [method, path, body] of [
        ['GET', 'https://api.github.com/orgs/Kraftink-CMS/repos'],
        ['GET', '//elsewhere.invalid/orgs/Kraftink-CMS/repos'],
        ['POST', '/repos/another-org/Plugin-Sample/rulesets', {}],
        ['DELETE', '/repos/Kraftink-CMS/Plugin-Sample/rulesets/7'],
        ['PATCH', '/repos/Kraftink-CMS/Plugin-Sample', { private: false }],
        ['PUT', '/repos/Kraftink-CMS/Plugin-Sample/rulesets', {}],
    ])
        await assert.rejects(client.request(method, path, body), /outside repository protection/);
    assert.equal(called, false);
    assert.throws(() => createGitHubClient({ token: 'secret\nnewline' }), /token is invalid/);
});

test('ruleset validation errors expose only bounded safe diagnostic fields', async () => {
    const token = 'fixture-installation-secret';
    const client = createGitHubClient({ token, transport: async () => Response.json({
        message: `Validation failed\n${token}`,
        headers: { Authorization: token },
        request: { sensitive: 'request-body-must-not-leak' },
        errors: [`GitHub\nActions actor is not eligible: ${token}`, { field: 'bypass_actors', code: 'invalid', message: 'Integration is not eligible.',
            value: 'private-error-value', resource: 'RepositoryRuleset' },
        ...Array.from({ length: 10 }, () => ({ message: 'x'.repeat(1000) }))],
    }, { status: 422 }) });
    await assert.rejects(client.request('POST', '/repos/Kraftink-CMS/Plugin-Sample/rulesets', baselineRuleset(), 201), (error) => {
        assert.equal(error.status, 422);
        assert.match(error.message, /bypass_actors/);
        assert.match(error.message, /Integration is not eligible/);
        assert.match(error.message, /GitHub Actions actor is not eligible: \[redacted\]/);
        assert.match(error.message, /\[redacted\]/);
        assert.doesNotMatch(error.message, /fixture-installation-secret|private-error-value|request-body-must-not-leak|Authorization|RepositoryRuleset|\n/);
        assert.ok(error.message.length < 2000);
        return true;
    });
    for (const body of ['invalid-json', JSON.stringify({ message: 'x'.repeat(17000) })]) {
        const bounded = createGitHubClient({ token, transport: async () => new Response(body, { status: 422 }) });
        await assert.rejects(bounded.request('POST', '/repos/Kraftink-CMS/Plugin-Sample/rulesets', baselineRuleset(), 201), {
            message: 'GitHub POST request failed with status 422.', status: 422,
        });
    }
    const other = createGitHubClient({ token, transport: async () => Response.json({ message: 'unrelated-diagnostic' }, { status: 422 }) });
    await assert.rejects(other.request('PATCH', '/repos/Kraftink-CMS/Plugin-Sample', { allow_merge_commit: true }), {
        message: 'GitHub PATCH request failed with status 422.', status: 422,
    });
});

test('repository requests preserve classic and long stateless installation tokens as opaque credentials', async () => {
    for (const length of [40, 520, 1024]) {
        const prefix = length === 40 ? 'ghs_' : 'ghs_5506849_header.';
        const suffix = length === 40 ? '' : '.signature-_';
        const token = prefix + 'a'.repeat(length - prefix.length - suffix.length) + suffix;
        let requests = 0;
        const client = createGitHubClient({
            token,
            transport: async (url, options) => {
                requests++;
                assert.equal(options.headers.Authorization, `Bearer ${token}`);
                return Response.json([]);
            },
        });
        await client.request('GET', '/orgs/Kraftink-CMS/repos?type=public');
        assert.equal(requests, 1);
    }
});

test('the scoped App client permits bootstrap and Market authorization but rejects retired release operations', async () => {
    const calls = [];
    const client = createGitHubClient({
        token: 'fixture-installation-token',
        transport: async (url, options) => {
            calls.push({ url, method: options.method });
            return options.method === 'DELETE' || options.method === 'PUT' && url.endsWith('/actions/permissions/workflow')
                ? new Response(null, { status: 204 }) : Response.json({});
        },
    });
    const prefix = '/repos/Kraftink-CMS/Plugin-Sample';
    const sha = 'a'.repeat(40);
    const setupBranch = 'automation/release-request-master-aaaaaaaaaaaa-bbbbbbbbbbbb';
    for (const suffix of [
        '/pulls?state=open', '/pulls/7', '/pulls/7/files?per_page=100&page=1',
        '/actions/permissions/workflow', '/git/commits/' + sha,
        '/compare/' + sha + '...' + 'b'.repeat(40),
        '/compare/' + sha + '...' + 'b'.repeat(40) + '?per_page=100&page=100',
        '/git/ref/heads/dev', '/git/ref/heads/master',
        '/git/matching-refs/heads/automation/release-request-', '/git/ref/heads/' + setupBranch,
        '/contents/.github/workflows/release.yml?ref=' + sha, '/rules/branches/master',
    ]) await client.request('GET', prefix + suffix);
    for (const repository of ['automation', 'Market'])
        await client.request('GET', '/repos/Kraftink-CMS/' + repository + '/collaborators/writer/permission');
    await client.request('PUT', prefix + '/pulls/7/merge', { sha, merge_method: 'merge' });
    await client.request('PUT', prefix + '/actions/permissions/workflow', { can_approve_pull_request_reviews: true }, 204);
    await client.request('POST', prefix + '/git/refs', { ref: 'refs/heads/' + setupBranch, sha });
    await client.request('POST', prefix + '/git/refs', { ref: 'refs/heads/dev', sha });
    await client.request('DELETE', prefix + '/git/refs/heads/' + setupBranch, undefined, 204);
    await client.request('POST', prefix + '/pulls', {
        title: 'chore: configure extension release', head: setupBranch, base: 'master', body: 'Install the Release workflow.',
    });
    await client.request('PATCH', prefix + '/pulls/7', { state: 'closed' });
    await client.request('PUT', prefix + '/contents/.github/workflows/release.yml', {
        message: 'chore: configure extension release', content: Buffer.from('workflow').toString('base64'), branch: setupBranch,
    });
    const before = calls.length;
    for (const [method, suffix, body] of [
        ['POST', '/pulls', { title: 'chore: promote dev to master', head: 'dev', base: 'master', body: 'Old release.' }],
        ['POST', '/dispatches', { event_type: 'release-requested',
            client_payload: { request_run_id: 17, request_run_attempt: 2, expected_sha: sha, bump: 'minor' } }],
        ['POST', '/git/trees', { base_tree: sha, tree: [{ path: 'manifest.json', mode: '100644', type: 'blob', content: '{}' }] }],
        ['POST', '/git/commits', { message: 'chore: set source version to 1.2.3', tree: sha, parents: [sha] }],
        ['PATCH', '/git/refs/heads/dev', { sha, force: false }],
        ['PATCH', '/git/refs/heads/master', { sha, force: false }],
        ['GET', '/actions/runs/17'], ['GET', '/actions/runs/17/artifacts'], ['GET', '/releases/tags/v1.2.3'],
        ['GET', '/git/ref/tags/v1.2.3'], ['GET', '/git/ref/heads/unrelated'],
        ['GET', '/git/matching-refs/heads/automation/release-request-?extra=true'],
        ['GET', '/git/matching-refs/heads/automation/'],
        ['DELETE', '/git/refs/heads/master'], ['DELETE', '/git/refs/heads/dev'],
        ['DELETE', '/git/refs/heads/automation/release-request-master-aaaaaaaaaaaa'],
        ['DELETE', '/git/refs/heads/' + setupBranch + '?extra=true'],
        ['DELETE', '/git/refs/heads/' + setupBranch, { sha }],
        ['PUT', '/actions/permissions/workflow', { can_approve_pull_request_reviews: false }],
        ['PUT', '/actions/permissions/workflow', { can_approve_pull_request_reviews: true, default_workflow_permissions: 'write' }],
        ['PUT', '/actions/permissions/workflow?extra=true', { can_approve_pull_request_reviews: true }],
        ['PATCH', '/actions/permissions/workflow', { can_approve_pull_request_reviews: true }],
        ['GET', '/compare/dev...master'], ['GET', '/compare/' + sha + '..' + sha],
        ['GET', '/compare/' + sha + '...' + sha + '?per_page=100&page=101'],
        ['GET', '/compare/' + sha + '...' + sha + '?per_page=99&page=1'],
        ['PUT', '/pulls/7/merge', { sha, merge_method: 'squash' }],
        ['PUT', '/pulls/7/merge', { sha, merge_method: 'merge', force: true }],
        ['POST', '/pulls', { title: 'Different title', head: setupBranch, base: 'master', body: 'text' }],
        ['PATCH', '/pulls/7', { body: 'text', state: 'closed' }], ['PATCH', '/pulls/7', { state: 'open' }],
        ['PATCH', '/pulls/7', { body: 'x'.repeat(65537) }],
    ]) await assert.rejects(client.request(method, prefix + suffix, body), /outside repository protection/);
    assert.equal(calls.length, before);
});
