import { appendFile, lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectCustomAssets } from './context.mjs';
import { createGitHubClient, publishAssets } from './publish.mjs';
import { normalizeReleaseNotes } from './notes.mjs';
import { inspectSourceVersion } from './source-version.mjs';
import { advanceDevelopmentVersion } from './source-version-github.mjs';
import { git, planVersion, stableVersion } from './version.mjs';

export async function planArtifactVersion({ root, initialVersion = '1.0.0', bump = 'auto', version = null }) {
    const tracked = git(root, ['ls-tree', '--name-only', 'HEAD', '--', 'manifest.json', 'pom.xml']);
    const metadata = tracked ? await inspectSourceVersion({ root, sha: git(root, ['rev-parse', 'HEAD']) }) : null;
    if (metadata) {
        stableVersion(metadata.version);
        if (version && version !== metadata.version)
            throw new Error('The requested version differs from the stable source. Prepare it through Release on dev.');
        version = metadata.version;
    }
    const initial = (metadata?.version || initialVersion).replace(/-(?:dev|SNAPSHOT)$/, '');
    stableVersion(initial);
    const plan = await planVersion({ root, bump, version,
        policy: { schema: 1, initial_version: initial, default_bump: 'patch', next_version: null } });
    const parents = git(root, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ');
    return { plan, source_sha: parents.length === 3 ? parents[2] : plan.sha, source_version: Boolean(metadata) };
}

async function main() {
    const operation = process.env.RELEASE_OPERATION;
    if (!['plan', 'publish'].includes(operation)) throw new Error('Choose the plan or publish release operation.');
    const root = resolve(process.env.GITHUB_WORKSPACE || process.cwd(), process.env.RELEASE_WORKING_DIRECTORY || '.');
    const planPath = resolve(root, process.env.RELEASE_PLAN_PATH || resolve(process.env.RUNNER_TEMP, 'kraftink-release-plan.json'));
    const repository = process.env.GITHUB_REPOSITORY;
    const notes = normalizeReleaseNotes({ mode: process.env.RELEASE_NOTES_MODE || 'auto',
        message: process.env.RELEASE_NOTES || '' });
    const verifyContext = () => {
        if (process.env.GITHUB_REF !== 'refs/heads/master'
                || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')
                || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(process.env.GITHUB_SHA ?? '')
                || git(root, ['rev-parse', '--verify', 'HEAD^{commit}']) !== process.env.GITHUB_SHA) {
            throw new Error('Stable publication requires the selected master commit.');
        }
    };
    verifyContext();
    let version;
    if (operation === 'plan') {
        const selected = await planArtifactVersion({ root, initialVersion: process.env.RELEASE_INITIAL_VERSION || '1.0.0',
            bump: process.env.RELEASE_BUMP || 'auto', version: process.env.RELEASE_VERSION || null });
        await writeFile(planPath, JSON.stringify({ ...selected, repository }) + '\n', { flag: 'wx', mode: 0o600 });
        version = selected.plan.version;
    } else {
        const context = await lstat(planPath);
        if (!context.isFile() || context.isSymbolicLink() || context.size < 1 || context.size > 65536) {
            throw new Error('The release plan must be a bounded regular file.');
        }
        const saved = JSON.parse(await readFile(planPath, 'utf8'));
        const { plan } = saved;
        if (saved.repository !== repository || plan.sha !== process.env.GITHUB_SHA) {
            throw new Error('The build does not match the planned repository and commit.');
        }
        if (!process.env.RELEASE_ARTIFACTS_PATH) throw new Error('Choose the directory containing the release assets.');
        const directory = resolve(root, process.env.RELEASE_ARTIFACTS_PATH);
        const assets = await collectCustomAssets(directory);
        const bundle = JSON.stringify({ version: plan.version, sha: plan.sha, assets }) + '\n';
        const bundlePath = resolve(directory, 'bundle.json');
        try {
            await writeFile(bundlePath, bundle, { flag: 'wx', mode: 0o600 });
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const existing = await lstat(bundlePath);
            if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== Buffer.byteLength(bundle)
                    || await readFile(bundlePath, 'utf8') !== bundle) {
                throw new Error('The existing release bundle does not match the built assets.');
            }
        }
        const client = createGitHubClient({ repository, token: process.env.GITHUB_TOKEN });
        const result = await publishAssets({
            plan,
            directory,
            client,
            root,
            repository,
            notes,
            title: repository.split('/')[1],
        });
        if (result.complete !== true) throw new Error('The stable publication has not been verified.');
        if (saved.source_version) {
            const prefix = `/repos/${repository}`;
            await advanceDevelopmentVersion({
                client: { request: (method, path, body, expected) => {
                    if (!path.startsWith(prefix + '/')) throw new Error('Unexpected source version repository.');
                    return client.request(method, path.slice(prefix.length), body, expected);
                } },
                repository, version: plan.version, releaseSha: plan.sha, sourceSha: saved.source_sha,
                validationContext: 'checks / Validate changes',
            });
        }
        version = result.version;
        process.stdout.write(JSON.stringify(result) + '\n');
    }
    await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\nplan-path=${planPath}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`Release operation failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}
