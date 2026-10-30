import { appendFile, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { manifestFor, previousVersions } from './build.mjs';
import { collectCustomAssets, verifyBuiltAssets } from './context.mjs';
import { createGitHubClient, publishAssets } from './publish.mjs';
import { inspectSourceVersion } from './source-version.mjs';
import { buildReleaseNotes, normalizeReleaseNotes } from './notes.mjs';
import { advanceDevelopmentVersion, updateSourceVersion, verifyPreparedSourceVersion } from './source-version-github.mjs';
import { git, planVersion, stableVersion } from './version.mjs';

const validSha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const same = (left, right) => typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();
const pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

function runIdentity(environment) {
    if (!/^Kraftink-CMS\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/i.test(environment.GITHUB_REPOSITORY ?? '')
            || environment.GITHUB_EVENT_NAME !== 'workflow_dispatch'
            || !['refs/heads/master', 'refs/heads/dev'].includes(environment.GITHUB_REF)
            || !validId(Number(environment.GITHUB_RUN_ID)) || !validId(Number(environment.GITHUB_RUN_ATTEMPT)))
        throw new Error('Use Release from master or dev in a public organization repository.');
    return { repository: environment.GITHUB_REPOSITORY, run_id: Number(environment.GITHUB_RUN_ID),
        run_attempt: Number(environment.GITHUB_RUN_ATTEMPT) };
}

function absoluteClient(client, repository) {
    const prefix = `/repos/${repository}`;
    return { request: (method, path, body, expected) => {
        if (path !== prefix && !path.startsWith(prefix + '/')) throw new Error('Unexpected release repository.');
        return client.request(method, path.slice(prefix.length), body, expected);
    } };
}

async function authorizeActors({ client, repository, actors }) {
    const verified = [];
    for (const actor of actors) {
        const login = typeof actor === 'string' ? actor : actor?.login;
        if (typeof login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(login))
            throw new Error('Release initiators must be human users with repository write access.');
        const permission = await client.request('GET', `/repos/${repository}/collaborators/${login}/permission`);
        const user = permission?.user;
        if (user?.type !== 'User' || !validId(user.id) || typeof user.login !== 'string'
                || !/^[A-Za-z0-9-]{1,39}$/.test(user.login) || !same(user.login, login)
                || !['write', 'maintain', 'admin'].includes(permission.permission)
                || typeof actor !== 'string' && actor.id !== user.id)
            throw new Error('A release initiator no longer has write access to this repository.');
        verified.push({ login: user.login, id: user.id });
    }
    if (verified.length !== 2) throw new Error('Both the original and triggering release actors are required.');
    return verified;
}

async function access(client, environment, context = null) {
    const identity = runIdentity(environment);
    const metadata = await client.request('GET', '');
    if (!same(metadata?.full_name, identity.repository) || !same(metadata.owner?.login, 'Kraftink-CMS')
            || metadata.owner.type !== 'Organization' || metadata.private !== false || metadata.visibility !== 'public'
            || metadata.archived !== false || metadata.disabled !== false || metadata.fork !== false || !validId(metadata.id)
            || metadata.default_branch !== 'master' || context && context.repository_id !== metadata.id)
        throw new Error('The release repository must remain public, active and use master by default.');
    const scoped = absoluteClient(client, identity.repository);
    const actors = await authorizeActors({ client: scoped, repository: identity.repository,
        actors: [environment.GITHUB_ACTOR, environment.KRAFTINK_TRIGGERING_ACTOR || environment.GITHUB_TRIGGERING_ACTOR] });
    if (context) await authorizeActors({ client: scoped, repository: identity.repository, actors: context.actors });
    return { ...identity, repository_id: metadata.id, actors };
}

async function reference(client, branch) {
    const result = await client.request('GET', `/git/ref/heads/${branch}`);
    if (result?.ref !== `refs/heads/${branch}` || result.object?.type !== 'commit' || !validSha(result.object.sha))
        throw new Error('A release branch is missing or invalid.');
    return result.object.sha;
}

async function commit(client, sha) {
    if (!validSha(sha)) throw new Error('A valid release commit is required.');
    const result = await client.request('GET', `/git/commits/${sha}`);
    if (result?.sha !== sha || !validSha(result.tree?.sha) || !Array.isArray(result.parents)
            || result.parents.some((parent) => !validSha(parent.sha)))
        throw new Error('The release commit is invalid.');
    return result;
}

function checkout(root, sha) {
    git(root, ['fetch', '--no-tags', 'origin', sha]);
    git(root, ['checkout', '--detach', sha]);
}

function sourceDetails(root, sha) {
    const custom = git(root, ['ls-tree', sha, '--', '.github/actions/build/action.yml']);
    if (custom) {
        if (!/^100(?:644|755) blob [a-f0-9]{40}\t\.github\/actions\/build\/action\.yml$/.test(custom))
            throw new Error('The custom build action must be a regular committed file.');
        return { kind: 'custom', manifest: null };
    }
    const manifest = manifestFor(git(root, ['show', `${sha}:manifest.json`]));
    if (manifest.builtin === true) throw new Error('Bundled extensions are published with the CMS.');
    return { kind: 'extension', manifest };
}

export async function describeSource(root) {
    const sha = git(root, ['rev-parse', 'HEAD']);
    const { version } = await inspectSourceVersion({ root, sha });
    const tests = git(root, ['ls-tree', sha, '--', '.github/actions/test/action.yml']);
    if (tests && !/^100(?:644|755) blob [a-f0-9]{40}\t\.github\/actions\/test\/action\.yml$/.test(tests))
        throw new Error('The optional test action must be a regular committed file.');
    return { kind: sourceDetails(root, sha).kind, version, tests: Boolean(tests) };
}

function sourcePolicy(root, sha, version) {
    const file = git(root, ['ls-tree', sha, '--', '.github/release-policy.json']);
    return file ? JSON.parse(git(root, ['show', `${sha}:.github/release-policy.json`]))
        : { schema: 1, initial_version: version.replace(/-(?:dev|SNAPSHOT)$/, ''), default_bump: 'patch', next_version: null };
}

async function jsonFile(path, limit = 1048576) {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > limit)
        throw new Error('Release context must contain bounded regular JSON files.');
    const bytes = await readFile(path);
    if (bytes.length !== stat.size) throw new Error('A release context file changed while reading.');
    return JSON.parse(bytes.toString('utf8'));
}

function releaseBody(context) {
    const intent = { repository: context.repository, run_id: context.run_id, pull_number: context.pull_number || 0,
        version: context.plan.version, source_sha: context.source_sha };
    return `Release ${intent.version}\n\nSource: ${intent.source_sha}\nRun: ${intent.run_id}\n\n<!-- kraftink-release:${JSON.stringify(intent)} -->`;
}

function releaseIntent(pull, identity) {
    const match = /\n\n<!-- kraftink-release:(\{[^\n]+\}) -->$/.exec(pull.body || '');
    let intent;
    try { intent = JSON.parse(match?.[1] || 'null'); } catch {}
    if (!intent || !same(intent.repository, identity.repository) || intent.run_id !== identity.run_id
            || intent.pull_number !== pull.number || !validSha(intent.source_sha))
        throw new Error('Only the original Release run can resume its own open pull request.');
    stableVersion(intent.version);
    if (pull.body !== releaseBody({ ...intent, plan: { version: intent.version } }))
        throw new Error('The original release pull request intent changed.');
    return intent;
}

async function openRelease(client, repository) {
    const pulls = await client.request('GET', `/pulls?state=open&base=master&head=${encodeURIComponent(`${repository.split('/')[0]}:dev`)}&per_page=100`);
    if (!Array.isArray(pulls) || pulls.length > 1 || pulls.some((pull) => !validId(pull?.number)))
        throw new Error('The open release pull request inventory is ambiguous.');
    return pulls.length ? await client.request('GET', `/pulls/${pulls[0].number}`) : null;
}

async function requestArrival(client, identity) {
    const run = await client.request('GET', `/actions/runs/${identity.run_id}`);
    const created = Date.parse(run?.created_at);
    if (run?.id !== identity.run_id || run.event !== 'workflow_dispatch' || !Number.isFinite(created)
            || run.repository?.id !== identity.repository_id || run.head_repository?.id !== identity.repository_id
            || !same(run.repository.full_name, identity.repository) || !same(run.head_repository.full_name, identity.repository))
        throw new Error('The original Release request time or repository identity is invalid.');
    return created;
}

async function guardArrival(client, identity, arrival, ownNumber = null) {
    let previous = Infinity;
    for (let page = 1; page <= 10; page++) {
        const pulls = await client.request('GET', `/pulls?state=all&base=master&head=${encodeURIComponent(`${identity.repository.split('/')[0]}:dev`)}&sort=updated&direction=desc&per_page=100&page=${page}`);
        if (!Array.isArray(pulls) || pulls.length > 100) throw new Error('The release pull request history is invalid.');
        for (const pull of pulls) {
            const created = Date.parse(pull?.created_at);
            const updated = Date.parse(pull?.updated_at);
            const closed = pull?.closed_at === null ? null : Date.parse(pull?.closed_at);
            if (!validId(pull?.number) || !Number.isFinite(created) || !Number.isFinite(updated)
                    || updated < created || updated > previous || !['open', 'closed'].includes(pull.state)
                    || pull.state === 'closed' && (!Number.isFinite(closed) || closed < created || closed > updated))
                throw new Error('The release pull request history or timestamps are invalid.');
            previous = updated;
            if (pull.number !== ownNumber && (pull.state === 'open' || created <= arrival && arrival < closed))
                blockedRelease(identity.repository, pull.number);
        }
        if (pulls.length < 100 || previous < arrival) return;
    }
    throw new Error('The release pull request history exceeds its verification limit.');
}

function blockedRelease(repository, number) {
    throw new Error(`An open release pull request already exists: https://github.com/${repository}/pull/${number}. Resume its original run or close it before starting another Release.`);
}

async function previousPublication(root, client) {
    const master = await reference(client, 'master');
    git(root, ['fetch', '--no-tags', 'origin', master]);
    if (!git(root, ['ls-tree', '--name-only', master, '--', 'manifest.json', 'pom.xml'])) return;
    const metadata = await inspectSourceVersion({ root, sha: master });
    if (metadata.version.endsWith('-dev') || metadata.version.endsWith('-SNAPSHOT')) return;
    stableVersion(metadata.version);
    const tag = `v${metadata.version}`;
    const release = await client.release(tag);
    if (!release || release.tag_name !== tag || release.draft !== false || release.prerelease !== false)
        throw new Error('The previous stable promotion has not finished publication. Resume its original Release run.');
}

export async function prepareRelease({ root, client, environment = process.env, bump = 'auto', directory }) {
    if (!['auto', 'patch', 'minor', 'major'].includes(bump)) throw new Error('Invalid release version choice.');
    const notes = normalizeReleaseNotes({ mode: environment.RELEASE_NOTES_MODE || 'auto',
        message: environment.RELEASE_NOTES || '' });
    const identity = await access(client, environment);
    let pull = await openRelease(client, identity.repository);
    let intent = null;
    if (identity.run_attempt === 1 && pull) blockedRelease(identity.repository, pull.number);
    if (identity.run_attempt > 1) {
        if (!pull) throw new Error('The original open release pull request is required to rerun all jobs. Start a new Release for another cycle.');
        intent = releaseIntent(pull, identity);
        pullIdentity(pull, { ...identity, source_sha: pull.head?.sha });
    }
    const arrival = await requestArrival(client, identity);
    await guardArrival(client, identity, arrival, intent ? pull.number : null);
    await previousPublication(root, client);
    const origin = await reference(client, 'dev');
    checkout(root, origin);
    git(root, ['update-ref', 'refs/remotes/origin/dev', origin]);
    const metadata = await inspectSourceVersion({ root, sha: origin });
    if (intent && metadata.version.replace(/-(?:dev|SNAPSHOT)$/, '') !== intent.version)
        throw new Error('The open release version must be preserved. Close its pull request to select another version.');
    const policy = sourcePolicy(root, origin, metadata.version);
    const selected = await planVersion({ root, sourceBranch: 'dev', bump, policy, version: intent?.version || null });
    const releaseNotesBody = await buildReleaseNotes({ root, repository: identity.repository, sha: origin,
        previousTag: selected.base_tag, ...notes });
    await access(client, environment);
    const current = await openRelease(client, identity.repository);
    if (intent) {
        if (!current || current.number !== pull.number || current.body !== pull.body)
            throw new Error('The original open release pull request changed before preparation.');
        pullIdentity(current, { ...identity, source_sha: origin });
    } else if (current) blockedRelease(identity.repository, current.number);
    const prepared = await updateSourceVersion({ client: absoluteClient(client, identity.repository),
        repository: identity.repository, branch: 'dev', version: selected.version, expectedSha: origin,
        validationContext: 'checks / Validate changes' });
    checkout(root, prepared.sha);
    git(root, ['update-ref', 'refs/remotes/origin/dev', prepared.sha]);
    const details = sourceDetails(root, prepared.sha);
    const plan = await planVersion({ root, sourceBranch: 'dev', bump, version: selected.version, policy });
    const history = details.kind === 'extension'
        ? await previousVersions({ plan, repository: identity.repository, manifest: details.manifest, client }) : [];
    const context = { schema: 1, ...identity, origin_sha: origin, source_sha: prepared.sha,
        source_tree_sha: prepared.tree_sha, bump, policy, plan, history, notes, release_body: releaseNotesBody, ...details };
    await access(client, environment, context);
    if (!pull) {
        const existing = await openRelease(client, identity.repository);
        if (existing) blockedRelease(identity.repository, existing.number);
        pull = await client.request('POST', '/pulls', { title: `Release ${plan.version}`, body: releaseBody(context),
            base: 'master', head: 'dev' }, 201);
    } else pull = await client.request('GET', `/pulls/${pull.number}`);
    pullIdentity(pull, context);
    context.pull_number = pull.number;
    const body = releaseBody(context);
    if (pull.body !== body) pull = pullIdentity(await client.request('PATCH', `/pulls/${pull.number}`, { body }), context);
    if (pull.body !== body) throw new Error('GitHub did not preserve the release pull request intent.');
    const source = await realpath(root);
    await mkdir(directory, { recursive: true });
    const destination = await realpath(directory);
    if (destination === source || destination.startsWith(source + sep))
        throw new Error('The release context must stay outside the source checkout.');
    for (const [name, value] of Object.entries({ context, plan, history }))
        await writeFile(resolve(destination, `${name}.json`), JSON.stringify(value, null, 4) + '\n', { flag: 'wx', mode: 0o600 });
    return { source_sha: prepared.sha, kind: details.kind, version: plan.version, pull_number: pull.number };
}

async function readContext({ root, client, environment, directory }) {
    const identity = runIdentity(environment);
    const context = await jsonFile(resolve(directory, 'context.json'));
    if (context.schema !== 1 || !same(context.repository, identity.repository) || context.run_id !== identity.run_id
            || !validId(context.run_attempt) || context.run_attempt > identity.run_attempt || !validId(context.pull_number)
            || !validSha(context.origin_sha) || !validSha(context.source_sha) || !validSha(context.source_tree_sha)
            || !Array.isArray(context.actors) || context.actors.length !== 2
            || !['auto', 'patch', 'minor', 'major'].includes(context.bump)
            || !['extension', 'custom'].includes(context.kind) || !Array.isArray(context.history) || context.history.length > 100
            || context.plan?.schema !== 1 || context.plan.mode !== 'stable' || context.plan.branch !== 'master'
            || context.plan.sha !== context.source_sha || context.plan.tag !== `v${context.plan.version}`
            || typeof context.plan.create_tag !== 'boolean')
        throw new Error('The prepared context does not belong to this release run.');
    stableVersion(context.plan.version);
    const notes = normalizeReleaseNotes({ mode: environment.RELEASE_NOTES_MODE || 'auto',
        message: environment.RELEASE_NOTES || '' });
    if (!isDeepStrictEqual(context.notes, notes) || context.release_body !== await buildReleaseNotes({
        root, repository: context.repository, sha: context.origin_sha, previousTag: context.plan.base_tag, ...notes }))
        throw new Error('The release notes differ from the original request or prepared source.');
    if (!isDeepStrictEqual(await jsonFile(resolve(directory, 'plan.json')), context.plan)
            || !isDeepStrictEqual(await jsonFile(resolve(directory, 'history.json')), context.history))
        throw new Error('The build inputs differ from the prepared release context.');
    if (git(root, ['rev-parse', 'HEAD']) !== context.source_sha || git(root, ['rev-parse', 'HEAD^{tree}']) !== context.source_tree_sha
            || !isDeepStrictEqual(sourceDetails(root, context.source_sha), { kind: context.kind, manifest: context.manifest })
            || (await inspectSourceVersion({ root, sha: context.source_sha })).version !== context.plan.version)
        throw new Error('The selected source does not match the prepared release.');
    const prepared = await verifyPreparedSourceVersion({ client: absoluteClient(client, identity.repository),
        repository: identity.repository, originSha: context.origin_sha, preparedSha: context.source_sha, version: context.plan.version });
    if (prepared.tree_sha !== context.source_tree_sha) throw new Error('The prepared release tree changed.');
    await access(client, environment, context);
    return context;
}

function pullIdentity(pull, context, merged = false) {
    if (!validId(pull?.number) || pull.user?.type !== 'Bot' || pull.user.login !== 'github-actions[bot]'
            || !validSha(pull.head?.sha) || context.pull_number && pull.number !== context.pull_number
            || pull.head?.ref !== 'dev' || pull.head.sha !== context.source_sha || pull.base?.ref !== 'master'
            || pull.head.repo?.id !== context.repository_id || pull.base.repo?.id !== context.repository_id
            || !same(pull.head.repo.full_name, context.repository) || !same(pull.base.repo.full_name, context.repository)
            || pull.draft !== false || !['open', 'closed'].includes(pull.state)
            || merged !== null && (merged ? pull.state !== 'closed' || !pull.merged_at : pull.state !== 'open' || pull.merged_at))
        throw new Error('The release pull request must be the exact same-repository GitHub Actions promotion.');
    return pull;
}

function mergeIdentity(value, sha, context, base = null) {
    if (value?.sha !== sha || value.tree?.sha !== context.source_tree_sha || value.parents?.length !== 2
            || value.parents[1]?.sha !== context.source_sha || base && value.parents[0]?.sha !== base)
        throw new Error('The merge must preserve the exact validated source tree and both parents.');
}

async function mergedSource(client, context, sha, number = null, wait = pause) {
    if (await reference(client, 'master') !== sha) throw new Error('master changed after the release promotion.');
    if (sha === context.source_sha) return 0;
    mergeIdentity(await commit(client, sha), sha, context);
    for (let attempt = 0; attempt < 60; attempt++) {
        if (number === null) {
            const pulls = await client.request('GET', `/commits/${sha}/pulls?per_page=100`);
            if (!Array.isArray(pulls) || pulls.length > 100) throw new Error('The merged release pull request inventory is invalid.');
            const matches = pulls.filter((pull) => pull.merge_commit_sha === sha && pull.head?.sha === context.source_sha);
            if (matches.length > 1) throw new Error('The merged release pull request is ambiguous.');
            if (matches.length) number = matches[0].number;
        }
        if (number !== null) {
            if (!validId(number)) throw new Error('The merged release pull request number is invalid.');
            const found = await client.request('GET', `/pulls/${number}`);
            if (found) {
                const pull = pullIdentity(found, context, null);
                if (pull.state === 'closed' && pull.merged_at && validSha(pull.merge_commit_sha)) {
                    if (pull.merge_commit_sha !== sha) throw new Error('The promotion merge changed.');
                    return pull.number;
                }
            }
        }
        if (attempt < 59) await wait(1000);
    }
    throw new Error('GitHub has not confirmed the exact merged release pull request. Rerun the failed jobs.');
}

export async function promoteRelease({ root, client, environment = process.env, directory, wait = pause }) {
    const context = await readContext({ root, client, environment, directory });
    const master = await reference(client, 'master');
    if (master === context.source_sha || (await commit(client, master)).parents[1]?.sha === context.source_sha)
        return { merge_sha: master, pull_number: await mergedSource(client, context, master, context.pull_number, wait) };
    if (await reference(client, 'dev') !== context.source_sha)
        throw new Error('dev advanced after preparation. Rerun all jobs of the original Release to validate its updated source.');
    git(root, ['fetch', '--no-tags', 'origin', master]);
    if (git(root, ['merge-tree', '--write-tree', master, context.source_sha]) !== context.source_tree_sha)
        throw new Error('The proposed promotion would retain unvalidated master changes.');
    const body = releaseBody(context);
    let pull = pullIdentity(await client.request('GET', `/pulls/${context.pull_number}`), context);
    let validated = false;
    for (let attempt = 0; attempt < 150; attempt++) {
        pull = pullIdentity(await client.request('GET', `/pulls/${pull.number}`), context);
        if (pull.body !== body || await reference(client, 'dev') !== context.source_sha
                || await reference(client, 'master') !== master || pull.base.sha !== master)
            throw new Error('The release pull request or a branch changed before merging.');
        if (pull.mergeable === true && validSha(pull.merge_commit_sha)) {
            mergeIdentity(await commit(client, pull.merge_commit_sha), pull.merge_commit_sha, context, master);
            await access(client, environment, context);
            if (!validated) {
                const status = await client.request('POST', `/statuses/${context.source_sha}`, {
                    state: 'success', context: 'Release validated source',
                    target_url: `https://github.com/${context.repository}/actions/runs/${context.run_id}`,
                    description: 'The prepared source passed release build and promotion validation.',
                }, 201);
                if (status?.state !== 'success' || status.context !== 'Release validated source')
                    throw new Error('GitHub did not confirm the validated release source status.');
                validated = true;
            }
            let result;
            try {
                result = await client.request('PUT', `/pulls/${pull.number}/merge`, { sha: context.source_sha, merge_method: 'merge' });
            } catch (error) {
                if (![405, 409, 422].includes(error.status)) throw error;
            }
            if (result?.merged === true && validSha(result.sha)) {
                mergeIdentity(await commit(client, result.sha), result.sha, context, master);
                return { merge_sha: result.sha, pull_number: await mergedSource(client, context, result.sha, pull.number, wait) };
            }
        }
        if (attempt < 149) await wait(2000);
    }
    throw new Error('The release pull request could not merge before its checks and rules deadline. Rerun the failed jobs.');
}

async function customBundle(context, directory, sha) {
    return { version: context.plan.version, sha, assets: await collectCustomAssets(directory) };
}

export async function publishRelease({ root, client, environment = process.env, directory, assetsDirectory,
    publish = publishAssets, advance = advanceDevelopmentVersion, wait = pause }) {
    const context = await readContext({ root, client, environment, directory });
    const sha = environment.RELEASE_MERGE_SHA;
    if (!validSha(sha)) throw new Error('The confirmed promotion SHA is required.');
    const number = Number(environment.RELEASE_PULL_NUMBER);
    if (!validId(number) && !(number === 0 && sha === context.source_sha))
        throw new Error('The confirmed promotion pull request number is required.');
    await mergedSource(client, context, sha, number, wait);
    const assets = await lstat(assetsDirectory);
    if (!assets.isDirectory() || assets.isSymbolicLink()) throw new Error('The build artifact must be a regular directory.');
    try {
        const existing = await lstat(resolve(assetsDirectory, 'bundle.json'));
        if (!existing.isFile() || existing.isSymbolicLink() || existing.size > 65536)
            throw new Error('The asset bundle must be a bounded regular file.');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    let bundle;
    if (context.kind === 'extension') {
        bundle = await jsonFile(resolve(assetsDirectory, 'bundle.json'), 65536);
        if (![context.source_sha, sha].includes(bundle.sha)) throw new Error('The built assets belong to another source.');
        await verifyBuiltAssets({ plan: { ...context.plan, sha: bundle.sha }, manifest: context.manifest,
            history: context.history, repository: context.repository, directory: assetsDirectory });
        bundle.sha = sha;
    } else {
        bundle = await customBundle(context, assetsDirectory, sha);
    }
    await writeFile(resolve(assetsDirectory, 'bundle.json'), JSON.stringify(bundle, null, 4) + '\n');
    const result = await publish({ plan: { ...context.plan, sha }, directory: assetsDirectory, client,
        title: context.manifest?.name || context.repository.split('/')[1], body: context.release_body, beforeMutation: async () => {
            await access(client, environment, context);
            await mergedSource(client, context, sha, number, wait);
        } });
    if (result.complete !== true) throw new Error('Stable publication has not been verified.');
    await access(client, environment, context);
    await advance({ client: absoluteClient(client, context.repository), repository: context.repository,
        version: context.plan.version, releaseSha: sha, sourceSha: context.source_sha,
        validationContext: 'checks / Validate changes' });
    return result;
}

async function main() {
    const [operation, directory, argument] = process.argv.slice(2);
    if (operation === 'describe' && process.argv.length === 3) {
        const result = await describeSource(resolve(process.env.RELEASE_ROOT || process.cwd()));
        if (process.env.GITHUB_OUTPUT)
            await appendFile(process.env.GITHUB_OUTPUT, Object.entries(result).map(([name, value]) => `${name}=${value}\n`).join(''));
        process.stdout.write(JSON.stringify(result) + '\n');
        return;
    }
    if (!directory || !['prepare', 'promote', 'publish'].includes(operation)
            || process.argv.length > 5 || operation === 'publish' && !argument)
        throw new Error('Usage: workflow.mjs prepare <context-directory> [bump] | promote <context-directory> | publish <context-directory> <assets-directory>');
    const options = { root: resolve(process.env.RELEASE_ROOT || process.env.GITHUB_WORKSPACE || process.cwd()),
        client: createGitHubClient({ repository: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN }),
        environment: process.env, directory: resolve(directory) };
    const result = operation === 'prepare' ? await prepareRelease({ ...options, bump: argument || 'auto' })
        : operation === 'promote' ? await promoteRelease(options)
            : await publishRelease({ ...options, assetsDirectory: resolve(argument) });
    if (process.env.GITHUB_OUTPUT)
        await appendFile(process.env.GITHUB_OUTPUT, Object.entries(result).map(([name, value]) => `${name}=${value}\n`).join(''));
    process.stdout.write(JSON.stringify(result) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
    process.stderr.write(`Release ${process.argv[2] || 'workflow'} failed: ${error.message}\n`);
    process.exitCode = 1;
});
