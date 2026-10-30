import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

const workflow = parse(
    await readFile(new URL('../.github/workflows/refresh-market.yml', import.meta.url), 'utf8'),
);
const validation = parse(
    await readFile(new URL('../.github/workflows/validate-market.yml', import.meta.url), 'utf8'),
);
const evaluate = new Function('github', `return Boolean(${workflow.jobs.refresh.if.slice(3, -2)});`);
const github = {
    repository: 'Kraftink-CMS/automation',
    ref: 'refs/heads/master',
    workflow_ref: 'Kraftink-CMS/automation/.github/workflows/refresh-market.yml@refs/heads/master',
    event_name: 'repository_dispatch',
    event: {
        repository: { fork: false },
        action: 'extension-published',
        client_payload: { repository: 'Kraftink-CMS/Plugin-Example' },
    },
};

test('Market writes use the trusted central master environment and reject forks and unrelated events', () => {
    assert.equal(evaluate(github), true);
    for (const event_name of ['schedule', 'workflow_dispatch'])
        assert.equal(evaluate({ ...github, event_name }), true);
    for (const change of [
        { repository: 'Someone/automation' },
        { ref: 'refs/heads/dev' },
        { ref: 'refs/tags/master' },
        { workflow_ref: 'Kraftink-CMS/automation/.github/workflows/other.yml@refs/heads/master' },
        { event_name: 'pull_request' },
        { event_name: 'push' },
        { event: { ...github.event, repository: { fork: true } } },
        { event: { ...github.event, action: 'other' } },
        { event: { ...github.event, client_payload: null } },
        { event: { ...github.event, client_payload: { repository: '' } } },
    ])
        assert.equal(evaluate({ ...github, ...change }), false);
    const job = workflow.jobs.refresh;
    assert.equal(job.environment, 'repository-administration');
    assert.equal(job.concurrency.group, 'kraftink-master-mutations');
    assert.equal(job.concurrency['cancel-in-progress'], false);
    assert.equal(job.concurrency.queue, 'max');
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout.with.ref, '${{ github.sha }}');
    assert.equal(checkout.with['persist-credentials'], false);
});

test('release notifications retain their repository selector as quoted data without granting runner write permissions', () => {
    assert.deepEqual(workflow.on.repository_dispatch.types, ['extension-published']);
    const step = workflow.jobs.refresh.steps.find((step) => step.run);
    assert.equal(
        step.env.REQUESTED_REPOSITORY,
        "${{ github.event_name == 'repository_dispatch' && github.event.client_payload.repository || inputs.repository || '' }}",
    );
    assert.equal(step.env.KRAFTINK_AUTOMATION_PRIVATE_KEY, '${{ secrets.KRAFTINK_AUTOMATION_PRIVATE_KEY }}');
    assert.equal(
        step.env.REFRESH_SCOPE,
        "${{ github.event_name == 'workflow_dispatch' && inputs.scope || github.event_name == 'repository_dispatch' && 'notification' || 'automatic' }}",
    );
    assert.match(step.run, /args=\(--scope "\$REFRESH_SCOPE" "\$REQUESTED_REPOSITORY"\)/);
    assert.match(step.run, /node scripts\/market\/publish\.mjs "\$\{args\[@\]\}"/);
    assert.ok(!step.run.includes('${{'));
    assert.equal(step['continue-on-error'], undefined);
    assert.equal(workflow.jobs.refresh.permissions, undefined);
});

test('manual refresh scopes are explicit while release events cannot override the automatic update policy', () => {
    const scope = workflow.on.workflow_dispatch.inputs.scope;
    assert.equal(scope.type, 'choice');
    assert.deepEqual(scope.options, ['automatic', 'repository', 'all']);
    assert.equal(scope.default, 'automatic');
    const selection = workflow.jobs.refresh.steps.find((step) => step.run).env.REFRESH_SCOPE;
    const select = new Function('github', 'inputs', `return (${selection.slice(3, -2)});`);
    for (const scope of ['automatic', 'repository', 'all'])
        assert.equal(select({ event_name: 'workflow_dispatch' }, { scope }), scope);
    assert.equal(select({ event_name: 'schedule' }, {}), 'automatic');
    assert.equal(select({ event_name: 'repository_dispatch' }, { scope: 'all' }), 'notification');
    assert.equal(select({ event_name: 'schedule' }, { scope: 'all' }), 'automatic');
});

test('untrusted Market validation only parses registry data and receives no publication credential', () => {
    assert.ok(Object.hasOwn(validation.on, 'workflow_call'));
    assert.deepEqual(validation.permissions, { contents: 'read' });
    for (const job of Object.values(validation.jobs)) {
        assert.equal(job.environment, undefined);
        assert.equal(job.permissions, undefined);
        for (const step of job.steps) {
            assert.ok(!JSON.stringify(step).includes('secrets.'));
            assert.ok(!JSON.stringify(step).includes('KRAFTINK_AUTOMATION_PRIVATE_KEY'));
            if (step.run) {
                assert.match(
                    step.run,
                    /sourceResources\(JSON\.parse\(await readFile\('catalogue\/resources\.json'/,
                );
                assert.ok(!step.run.includes('catalogue/scripts/'));
            }
            if (step.uses?.startsWith('actions/checkout@'))
                assert.equal(step.with['persist-credentials'], false);
        }
    }
});
