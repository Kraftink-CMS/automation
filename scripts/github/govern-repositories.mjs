import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppAuthError, createAppClient } from './app-auth.mjs';
import {
    createGitHubClient,
    protectRepositories,
    selectPolicies,
    summaryMarkdown,
    validateConfiguration,
} from './protect-repositories.mjs';
import { reconcileReleaseWorkflow } from './provision-release-workflow.mjs';

export function protectionsReady(entries) {
    const anchors = ['common', 'automated-promotions'];
    return (
        entries.length > 0 &&
        entries.every(
            (entry) => !['failed', 'excluded', 'skipped'].includes(entry.action) && entry.configured === true,
        ) &&
        anchors.every((policy) =>
            entries.some((entry) => entry.policy === policy && entry.confirmed === true),
        )
    );
}

export function parseArguments(args) {
    if (args.length === 0) return { check: false };
    if (args.length === 1 && args[0] === '--check') return { check: true };
    throw new Error('Usage: govern-repositories.mjs [--check]');
}

function publicRepository(repo, config, name) {
    return (
        repo?.private === false &&
        repo.visibility === 'public' &&
        repo.archived === false &&
        repo.disabled === false &&
        repo.owner?.login?.toLowerCase() === config.organization.toLowerCase() &&
        repo.full_name?.toLowerCase() === name.toLowerCase() &&
        !config.excluded_repositories.some((entry) => entry.toLowerCase() === repo.name?.toLowerCase())
    );
}

export async function governRepositories({ config, client, appId, appSlug, check = false, wait }) {
    config = validateConfiguration(config, { appId, requireBindings: true });
    const protections = await protectRepositories({ config, client, appId, check, wait });
    const workflows = [];
    const repositories = [...new Set(protections.results
        .filter((entry) => !['failed', 'excluded', 'skipped'].includes(entry.action))
        .map((entry) => entry.repository))];
    for (const repository of repositories) {
        const policies = selectPolicies(config, repository.split('/')[1]);
        if (!policies.some((policy) => policy.release_workflow === true)) continue;
        const entries = protections.results.filter((entry) => entry.repository === repository);
        if (!protectionsReady(entries)) {
            workflows.push({ repository, action: 'pending',
                note: 'Repository protections must be verified before configuring the Release workflow.' });
            continue;
        }
        try {
            const metadata = await client.request('GET', `/repos/${repository}`);
            if (!publicRepository(metadata, config, repository))
                throw new Error('Repository eligibility changed before configuring the Release workflow.');
            workflows.push(...await reconcileReleaseWorkflow({ client, repository, appSlug, check, wait }));
        } catch (error) {
            workflows.push({ repository, action: 'failed', note: error.message });
        }
    }
    return { protections, workflows,
        failed: protections.failed + workflows.filter((entry) => entry.action === 'failed').length };
}

export function governanceSummary(report) {
    const escape = (value) => String(value).replaceAll('|', '\\|').replaceAll(/[\r\n]/g, ' ');
    return `${summaryMarkdown(report.protections)}\n| Repository | Branch | Release workflow | Detail |\n| --- | --- | --- | --- |\n${report.workflows.map((entry) => `| ${escape(entry.repository)} | ${escape(entry.branch ?? '')} | ${entry.action} | ${escape(entry.note ?? '')} |`).join('\n')}\n\n${report.failed} total operation(s) failed.\n`;
}

export function governanceFailureMessage(error) {
    const detail = error instanceof AppAuthError
        ? error.message : 'Check the central App configuration, permissions and repository policies.';
    return `Repository governance failed. ${detail}\n`;
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    const bytes = await readFile(new URL('../../.github/repository-protection.json', import.meta.url));
    if (bytes.length > 65536) throw new Error('The repository policy configuration is too large.');
    const config = JSON.parse(bytes.toString('utf8'));
    validateConfiguration(config);
    const app = await createAppClient();
    const client = createGitHubClient({ token: app.token });
    const report = await governRepositories({ config, client, appId: app.appId, appSlug: app.appSlug, ...options });
    const summary = governanceSummary(report);
    process.stdout.write(summary);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
    if (report.failed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(governanceFailureMessage(error));
        process.exitCode = 1;
    });
}
