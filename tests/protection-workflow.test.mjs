import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

const root = new URL('../', import.meta.url);
const workflow = parse(await readFile(new URL('.github/workflows/protect-repositories.yml', root), 'utf8'));

function allowed(overrides = {}) {
    const github = {
        repository: 'Kraftink-CMS/automation',
        event: { repository: { fork: false } },
        ref: 'refs/heads/master',
        workflow_ref: 'Kraftink-CMS/automation/.github/workflows/protect-repositories.yml@refs/heads/master',
        event_name: 'schedule',
        ...overrides,
    };
    return new Function(
        'github',
        `return (${workflow.jobs.protect.if.replace(/^\$\{\{\s*|\s*\}\}$/g, '')});`,
    )(github);
}

test('organization credentials are exposed only to the central master push, schedule and manual action', () => {
    assert.equal(allowed(), true);
    assert.equal(allowed({ event_name: 'workflow_dispatch' }), true);
    assert.equal(allowed({ event_name: 'push' }), true);
    for (const overrides of [
        { repository: 'Somebody/automation' },
        { event: { repository: { fork: true } } },
        { ref: 'refs/heads/dev' },
        { workflow_ref: 'Kraftink-CMS/automation/.github/workflows/other.yml@refs/heads/master' },
        { event_name: 'pull_request' },
    ])
        assert.equal(allowed(overrides), false);
    assert.deepEqual(Object.keys(workflow.on).sort(), ['push', 'schedule', 'workflow_dispatch']);
    assert.deepEqual(workflow.on.push.branches, ['master']);
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.equal(workflow.jobs.protect.environment, 'repository-administration');
    const steps = workflow.jobs.protect.steps;
    assert.equal(steps[0].with['persist-credentials'], false);
    assert.equal(steps[0].with.ref, '${{ github.sha }}');
    assert.equal(
        steps.filter((step) =>
            Object.values(step.env ?? {}).some((value) => String(value).includes('secrets.')),
        ).length,
        1,
    );
    const execution = steps.at(-1);
    assert.equal(
        execution.env.KRAFTINK_AUTOMATION_PRIVATE_KEY,
        '${{ secrets.KRAFTINK_AUTOMATION_PRIVATE_KEY }}',
    );
    assert.match(execution.run, /--check/);
    assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ['dry_run']);
    assert.doesNotMatch(execution.run, /--promote|PROMOTE_REPOSITORY/);
    assert.doesNotMatch(execution.run, /\$\{\{/);
    assert.doesNotMatch(execution.run, /git (?:clone|checkout)|npm |composer |eval\b/);
    assert.equal(Object.hasOwn(execution.env, 'KRAFTINK_CENTRAL_DISPATCH_TOKEN'), false);
    assert.equal(workflow.concurrency['cancel-in-progress'], false);
});
