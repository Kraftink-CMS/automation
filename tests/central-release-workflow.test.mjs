import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { requestWorkflow } from '../scripts/github/provision-release-workflow.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const callerWorkflow = parse(await readFile(resolve(root, '.github/workflows/request-extension-release.yml'), 'utf8'));
const validationWorkflow = parse(await readFile(resolve(root, '.github/workflows/validate-repository.yml'), 'utf8'));
const actionSteps = (job, name) => job.steps.filter((step) => step.uses?.startsWith(`${name}@`));
const downloads = (job) => actionSteps(job, 'actions/download-artifact');
const uploads = (job) => actionSteps(job, 'actions/upload-artifact');

test('the repository Release workflow requires its shared read-only build before promotion and publication', () => {
    const { prepare, build, promote, publish } = callerWorkflow.jobs;
    assert.deepEqual(Object.keys(callerWorkflow.on), ['workflow_call']);
    assert.deepEqual(Object.keys(callerWorkflow.jobs), ['prepare', 'build', 'promote', 'publish']);
    assert.deepEqual(callerWorkflow.permissions, { contents: 'read' });
    assert.deepEqual(build.permissions, { contents: 'read' });
    assert.deepEqual(prepare.permissions, { contents: 'write', 'pull-requests': 'write', actions: 'read', statuses: 'write' });
    assert.deepEqual(promote.permissions, { contents: 'write', 'pull-requests': 'write', statuses: 'write' });
    assert.deepEqual(publish.permissions, { contents: 'write', 'pull-requests': 'read', statuses: 'write' });
    assert.equal(build.needs, 'prepare');
    assert.equal(build.uses, './.github/workflows/validate-repository.yml');
    assert.deepEqual(build.with, { ref: '${{ needs.prepare.outputs.source_sha }}',
        'context-id': '${{ needs.prepare.outputs.context_id }}', release: true });
    assert.deepEqual(promote.needs, ['prepare', 'build']);
    assert.deepEqual(publish.needs, ['prepare', 'build', 'promote']);
    assert.equal(promote.if, undefined);
    assert.equal(publish.if, undefined);
    assert.equal(callerWorkflow.concurrency, undefined);
    assert.equal(prepare.concurrency.group, 'kraftink-release-${{ github.repository }}');
    assert.equal(prepare.concurrency['cancel-in-progress'], false);
    assert.equal(prepare.concurrency.queue, 'max');
    for (const job of [build, promote, publish]) assert.equal(job.concurrency, undefined);
    for (const [name, job] of Object.entries(callerWorkflow.jobs)) {
        if (name === 'build') continue;
        const checkout = actionSteps(job, 'actions/checkout');
        assert.equal(checkout.length, 1);
        assert.equal(checkout[0].with.path, '.release-source');
        assert.equal(checkout[0].with.ref, name === 'prepare' ? 'dev' : '${{ needs.prepare.outputs.source_sha }}');
        assert.equal(checkout[0].with['persist-credentials'], false);
        assert.equal(job.steps.filter((step) => step.uses === 'Kraftink-CMS/automation@master').length, 1);
        for (const step of uploads(job)) assert.equal(step.with['retention-days'], 7);
        assert.doesNotMatch(JSON.stringify(job), /KRAFTINK_AUTOMATION_PRIVATE_KEY|release-requested/);
        if (name !== 'publish') assert.doesNotMatch(JSON.stringify(job), /secrets\./);
    }
    for (const job of [promote, publish]) {
        const context = downloads(job).filter((step) => step.with.path === '${{ runner.temp }}/release-context');
        assert.equal(context.length, 1);
        assert.equal(context[0].with['artifact-ids'], '${{ needs.prepare.outputs.context_id }}');
    }
    assert.equal(downloads(publish)[1].with['artifact-ids'], '${{ needs.build.outputs.assets_id }}');
    const execution = publish.steps.at(-1);
    assert.equal(execution.env.RELEASE_MERGE_SHA, '${{ needs.promote.outputs.merge_sha }}');
    assert.equal(execution.env.RELEASE_PULL_NUMBER, '${{ needs.promote.outputs.pull_number }}');
    assert.equal(promote.outputs.pull_number, '${{ steps.promote.outputs.pull_number }}');
    assert.match(execution.run, /workflow\.mjs" publish/);
});

test('dev PRs call the same validation as releases with no publication token or retained artifacts', () => {
    const wrapper = parse(requestWorkflow);
    assert.deepEqual(wrapper.on.pull_request.branches, ['dev']);
    assert.deepEqual(wrapper.permissions, { contents: 'read' });
    assert.deepEqual(wrapper.jobs.checks.permissions, { contents: 'read' });
    assert.equal(wrapper.jobs.checks.if, "github.event_name == 'pull_request'");
    assert.equal(wrapper.jobs.release.if, "github.event_name == 'workflow_dispatch'");
    assert.deepEqual(wrapper.jobs.release.secrets, { KRAFTINK_MARKET_REFRESH_TOKEN: '${{ secrets.KRAFTINK_MARKET_REFRESH_TOKEN }}' });
    assert.equal(wrapper.jobs.checks.secrets, undefined);
    assert.deepEqual(callerWorkflow.on.workflow_call.secrets, { KRAFTINK_MARKET_REFRESH_TOKEN: { required: false } });
    const publish = callerWorkflow.jobs.publish.steps.find((step) => step.name === 'Verify and publish the validated files');
    assert.equal(publish.env.KRAFTINK_MARKET_REFRESH_TOKEN, '${{ secrets.KRAFTINK_MARKET_REFRESH_TOKEN }}');
    assert.equal(wrapper.jobs.checks.uses, 'Kraftink-CMS/automation/.github/workflows/validate-repository.yml@master');
    assert.equal(wrapper.jobs.checks.with, undefined);
    assert.equal(validationWorkflow.on.workflow_call.inputs.release.default, false);
    assert.deepEqual(validationWorkflow.permissions, { contents: 'read' });
    assert.deepEqual(Object.keys(validationWorkflow.jobs), ['build']);
    const build = validationWorkflow.jobs.build;
    assert.equal(build.name, 'Validate changes');
    assert.deepEqual(build.permissions, { contents: 'read' });
    assert.equal(build.if, undefined);
    assert.equal(build['continue-on-error'], undefined);
    assert.equal(build.steps[0].with.ref, '${{ inputs.ref || github.sha }}');
    assert.equal(build.steps[0].with['persist-credentials'], false);
    assert.doesNotMatch(JSON.stringify(validationWorkflow), /secrets\.|GITHUB_TOKEN|contents":"write|pull-requests|statuses/);
    for (const step of [...uploads(build), ...downloads(build)]) {
        assert.equal(step.if, 'inputs.release');
        assert.equal(step.with.name?.includes('run_attempt') ?? true, true);
    }
    assert.equal(uploads(build)[0].with['retention-days'], 7);
    assert.equal(downloads(build)[0].with['artifact-ids'], '${{ inputs.context-id }}');
    const validation = build.steps.find((step) => step.name === 'Validate the extension');
    assert.match(validation.run, /build\.mjs" check/);
    assert.equal(validation['continue-on-error'], undefined);
    const hook = build.steps.find((step) => step.uses === './.release-source/.github/actions/build');
    assert.equal(hook.if, "steps.source.outputs.kind == 'custom'");
    assert.deepEqual(hook.with, { version: '${{ steps.source.outputs.version }}',
        'output-directory': '${{ runner.temp }}/release-assets' });
    assert.equal(validationWorkflow.on.workflow_call.outputs.assets_id.value, '${{ jobs.build.outputs.assets_id }}');
});

test('extension PRs validate once and releases build once while both lint PHP before producing artifacts', () => {
    const steps = validationWorkflow.jobs.build.steps;
    const validation = steps.find((step) => step.name === 'Validate the extension');
    const syntax = steps.find((step) => step.run?.includes('php -l'));
    const archive = steps.find((step) => step.run?.includes('build.mjs" build '));
    const upload = uploads(validationWorkflow.jobs.build)[0];
    assert.match(syntax.run, /-not -path '\.\/vendor\/\*'.*-not -path '\.\/node_modules\/\*'.*php -l/);
    assert.equal(syntax['continue-on-error'], undefined);
    assert.ok(steps.indexOf(syntax) < steps.indexOf(archive));
    assert.ok(steps.indexOf(archive) < steps.indexOf(upload));
    for (const release of [false, true]) {
        const context = { inputs: { release }, steps: { source: { outputs: { kind: 'extension' } } } };
        assert.equal(evaluate(validation.if, context), !release);
        assert.equal(evaluate(archive.if, context), release);
        assert.equal(evaluate(syntax.if, context), true);
        assert.equal(evaluate(upload.if, context), release);
    }
    const custom = { inputs: { release: true }, steps: { source: { outputs: { kind: 'custom' } } } };
    for (const step of [validation, syntax, archive]) assert.equal(evaluate(step.if, custom), false);
});

test('optional repository tests run with read permission and block validation and build failures on PRs and releases', () => {
    const build = validationWorkflow.jobs.build;
    const steps = build.steps;
    const hook = steps.find((step) => step.uses === './.release-source/.github/actions/test');
    const tooling = steps.find((step) => step.name === 'Install shared extension build tooling');
    const describe = steps.find((step) => step.run?.includes('workflow.mjs" describe'));
    assert.deepEqual(build.permissions, { contents: 'read' });
    assert.equal(hook['continue-on-error'], undefined);
    assert.equal(hook.env, undefined);
    assert.equal(hook.with, undefined);
    assert.ok(steps.indexOf(describe) < steps.indexOf(hook));
    assert.ok(steps.indexOf(tooling) < steps.indexOf(hook));
    for (const step of steps.filter((step) => step.run?.includes('build.mjs"')
            || step.uses === './.release-source/.github/actions/build')) {
        assert.ok(steps.indexOf(hook) < steps.indexOf(step));
        assert.doesNotMatch(step.if, /always\(|failure\(/);
    }
    for (const kind of ['extension', 'custom'])
        for (const release of [false, true])
            for (const tests of ['true', 'false', ''])
                assert.equal(evaluate(hook.if, { inputs: { release }, steps: { source: { outputs: { kind, tests } } } }), tests === 'true');
});

test('caller release preparation accepts only an organization dispatch on dev or master outside forks', () => {
    const github = { event_name: 'workflow_dispatch', event: { repository: { fork: false } },
        repository_owner: 'Kraftink-CMS', ref: 'refs/heads/master' };
    assert.equal(evaluate(callerWorkflow.jobs.prepare.if, { github }), true);
    assert.equal(evaluate(callerWorkflow.jobs.prepare.if, { github: { ...github, ref: 'refs/heads/dev' } }), true);
    for (const change of [{ event_name: 'push' }, { event_name: 'schedule' }, { repository_owner: 'Other' },
        { ref: 'refs/heads/feature' }, { event: { repository: { fork: true } } }])
        assert.equal(evaluate(callerWorkflow.jobs.prepare.if, { github: { ...github, ...change } }), false);
});

test('release note choices travel through environment values without shell interpolation', () => {
    assert.equal(callerWorkflow.on.workflow_call.inputs.notes_mode.default, 'auto');
    assert.equal(callerWorkflow.on.workflow_call.inputs.notes_mode.type, 'string');
    assert.equal(callerWorkflow.on.workflow_call.inputs.notes.type, 'string');
    assert.deepEqual(callerWorkflow.env, {
        RELEASE_NOTES_MODE: '${{ inputs.notes_mode }}', RELEASE_NOTES: '${{ inputs.notes }}',
    });
    for (const job of Object.values(callerWorkflow.jobs))
        for (const step of job.steps ?? [])
            assert.doesNotMatch(step.run || '', /\$\{\{ inputs\.notes(?:_mode)? \}\}/);
});

function evaluate(value, { github = {}, needs = {}, steps = {}, inputs = {}, cancelled = false } = {}) {
    const source = value
        .replace(/^\$\{\{\s*|\s*\}\}$/g, '')
        .replace(/\.([A-Za-z_][A-Za-z0-9_]*-[A-Za-z0-9_-]+)/g, "['$1']");
    return new Function('github', 'needs', 'steps', 'inputs', 'cancelled', 'always', `return (${source});`)(
        github,
        needs,
        steps,
        inputs,
        () => cancelled,
        () => true,
    );
}
