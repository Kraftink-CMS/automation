import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const requestWorkflow = readFileSync(new URL('../../templates/workflow-templates/extension-release.yml', import.meta.url), 'utf8');

const filename = '.github/workflows/release.yml';
const message = 'chore: configure extension release';
const body = 'Configure the managed Release button. This pull request changes only .github/workflows/release.yml.';
const expected = Buffer.from(requestWorkflow);
const previousWorkflowBlob = '5aa9f4195e73d0efb84acdaea907cd6f78dde669';
const expectedBlob = createHash('sha1').update(`blob ${expected.length}\0`).update(expected).digest('hex');
const validSha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const sameName = (left, right) =>
    typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();
const pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

class ProvisionError extends Error {}

function repositoryName(value) {
    if (
        typeof value !== 'string' ||
        !/^Kraftink-CMS\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/i.test(value) ||
        value.split('/')[1].length > 100
    ) {
        throw new ProvisionError(
            'Only safely named public Kraftink-CMS repositories can receive the release workflow.',
        );
    }
    return value;
}

async function identity(client, repository, id = null) {
    const value = await client.request('GET', `/repos/${repository}`);
    if (
        !validId(value?.id) ||
        (id !== null && value.id !== id) ||
        !sameName(value.full_name, repository) ||
        !sameName(value.owner?.login, 'Kraftink-CMS') ||
        value.owner.type !== 'Organization' ||
        !sameName(value.name, repository.split('/')[1]) ||
        value.private !== false ||
        value.visibility !== 'public' ||
        value.archived !== false ||
        value.disabled !== false
    ) {
        throw new ProvisionError('The repository identity or public organization eligibility changed.');
    }
    return value.id;
}

async function optional(client, path, empty = false) {
    try {
        return await client.request('GET', path);
    } catch (error) {
        if (error.status === 404 || (empty && error.status === 409)) return null;
        throw error;
    }
}

async function reference(client, repository, branch, empty = false) {
    const value = await optional(client, `/repos/${repository}/git/ref/heads/${branch}`, empty);
    if (value === null) return null;
    if (value?.ref !== `refs/heads/${branch}` || value.object?.type !== 'commit' || !validSha(value.object.sha)) {
        throw new ProvisionError('GitHub returned an invalid branch reference.');
    }
    return value.object.sha;
}

async function contents(client, repository, sha) {
    const value = await optional(client, `/repos/${repository}/contents/${filename}?ref=${sha}`);
    if (value === null) return null;
    if (
        value?.type !== 'file' ||
        value.path !== filename ||
        value.encoding !== 'base64' ||
        !validSha(value.sha) ||
        typeof value.content !== 'string' ||
        value.content.length > 360000 ||
        !/^[A-Za-z0-9+/=\r\n]*$/.test(value.content)
    ) {
        throw new ProvisionError('The existing release workflow is not a bounded regular GitHub file.');
    }
    const encoded = value.content.replace(/[\r\n]/g, '');
    const bytes = Buffer.from(encoded, 'base64');
    const shaValue = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (bytes.length > 262144 || bytes.toString('base64') !== encoded || value.sha !== shaValue) {
        throw new ProvisionError('The release workflow contents do not match their Git blob.');
    }
    return { sha: value.sha, matches: bytes.equals(expected), managed: bytes.equals(expected) || value.sha === previousWorkflowBlob };
}

export async function managedReleaseOptIn({ client, repository }) {
    repositoryName(repository);
    const sha = await reference(client, repository, 'dev');
    return sha && (await contents(client, repository, sha))?.managed ? sha : null;
}

async function commit(client, repository, sha) {
    const value = await client.request('GET', `/repos/${repository}/git/commits/${sha}`);
    if (
        value?.sha !== sha ||
        !validSha(value.tree?.sha) ||
        !Array.isArray(value.parents) ||
        value.parents.length > 2 ||
        !value.parents.every((parent) => validSha(parent?.sha))
    ) {
        throw new ProvisionError('GitHub returned an invalid setup commit.');
    }
    return value;
}

async function sourceCommit(client, repository, sha, base) {
    const value = await commit(client, repository, sha);
    if (
        value.parents.length !== 1 ||
        value.parents[0].sha !== base ||
        !(await contents(client, repository, sha))?.matches
    ) {
        throw new ProvisionError('The setup branch contains changes outside the expected source commit.');
    }
    return value;
}

async function assertCurrent({ client, repository, id, branch, base, headBranch = null, head = null, optInSha = null }) {
    await identity(client, repository, id);
    if (
        (await reference(client, repository, branch)) !== base ||
        (headBranch && (await reference(client, repository, headBranch)) !== head) ||
        (optInSha && (await reference(client, repository, 'dev')) !== optInSha)
    ) {
        throw new ProvisionError('A branch moved while preparing the release workflow. Retry the central workflow.');
    }
}

function pullIdentity(pull, { repository, id, branch, setupBranch, head, appSlug, base, number, closed = false }) {
    const checks = {
        number: validId(pull?.number) && (number === undefined || pull.number === number),
        'base.ref': pull?.base?.ref === branch,
        'head.ref': pull?.head?.ref === setupBranch,
        'head.sha': pull?.head?.sha === head,
        'base.repo.full_name': sameName(pull?.base?.repo?.full_name, repository),
        'head.repo.full_name': sameName(pull?.head?.repo?.full_name, repository),
        'base.repo.id': pull?.base?.repo?.id === id,
        'head.repo.id': pull?.head?.repo?.id === id,
        'user.login': pull?.user?.login === `${appSlug}[bot]`,
        'user.type': pull?.user?.type === 'Bot',
        state: closed ? pull?.state === 'closed' : pull?.state === 'open',
        merged_at: closed && closed !== 'superseded' ? Boolean(pull?.merged_at) : !pull?.merged_at,
        'base.sha': closed && closed !== 'superseded' || pull?.base?.sha === base,
        merge_commit_sha: closed !== true || validSha(pull?.merge_commit_sha),
    };
    const mismatches = Object.entries(checks).filter(([, valid]) => !valid).map(([field]) => field);
    if (mismatches.length)
        throw new ProvisionError(`The setup pull request does not match this App and its exact source branches: ${mismatches.join(', ')}.`);
    return pull;
}

async function inventory(client, path) {
    const result = [];
    for (let page = 1; page <= 10; page++) {
        const values = await client.request('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
        if (!Array.isArray(values) || values.length > 100)
            throw new ProvisionError('The setup pull request inventory is invalid.');
        result.push(...values);
        if (values.length < 100) return result;
    }
    throw new ProvisionError('The setup pull request inventory exceeds its pagination limit.');
}

async function exactChanges(client, repository, pull, expectedSha = expectedBlob) {
    const files = await inventory(client, `/repos/${repository}/pulls/${pull.number}/files`);
    if (
        files.length !== 1 ||
        files[0].filename !== filename ||
        files[0].previous_filename !== undefined ||
        !['added', 'modified'].includes(files[0].status) ||
        !validSha(files[0].sha) ||
        (expectedSha !== null && files[0].sha !== expectedSha)
    ) {
        throw new ProvisionError('A setup pull request may change only the exact managed release workflow.');
    }
    return files[0].sha;
}

async function closeObsoletePulls({ client, repository, settings }) {
    const prefix = `automation/release-request-${settings.branch}-${settings.base.slice(0, 12)}`;
    let pending = 0;
    let pulls;
    try {
        pulls = await inventory(client, `/repos/${repository}/pulls?state=open&base=${settings.branch}`);
    } catch {
        return 1;
    }
    for (const candidate of pulls) {
        const branch = candidate?.head?.ref;
        if (
            typeof branch !== 'string' ||
            branch === settings.setupBranch ||
            !new RegExp(`^${prefix}(?:-[a-f0-9]{12})?$`).test(branch)
        ) {
            continue;
        }
        const previous = { ...settings, setupBranch: branch, head: candidate.head.sha, number: candidate.number };
        try {
            pullIdentity(candidate, previous);
        } catch {
            continue;
        }
        try {
            const pull = pullIdentity(
                await client.request('GET', `/repos/${repository}/pulls/${previous.number}`),
                previous,
            );
            const blob = await exactChanges(client, repository, pull, null);
            const source = await commit(client, repository, previous.head);
            const file = await contents(client, repository, previous.head);
            if (source.parents.length !== 1 || source.parents[0].sha !== settings.base || file?.sha !== blob) {
                pending++;
                continue;
            }
            await assertCurrent({
                client,
                repository,
                id: settings.id,
                branch: settings.branch,
                base: settings.base,
                headBranch: previous.setupBranch,
                head: previous.head,
                optInSha: settings.optInSha,
            });
            pullIdentity(
                await client.request('PATCH', `/repos/${repository}/pulls/${previous.number}`, { state: 'closed' }),
                { ...previous, closed: 'superseded' },
            );
        } catch {
            pending++;
        }
    }
    return pending;
}

async function confirmMerge({ client, repository, settings, source, mergeSha, wait }) {
    for (let attempt = 0; attempt < 60; attempt++) {
        const pull = await client.request('GET', `/repos/${repository}/pulls/${settings.number}`);
        if (pull?.state === 'closed' && pull.merged_at) {
            if (!validSha(pull.merge_commit_sha)) {
                pullIdentity(pull, { ...settings, closed: 'settling' });
                if (attempt < 59) await wait(1000);
                continue;
            }
            pullIdentity(pull, { ...settings, closed: true });
            if (mergeSha && pull.merge_commit_sha !== mergeSha)
                throw new ProvisionError('The confirmed setup merge changed.');
            const merge = await commit(client, repository, pull.merge_commit_sha);
            if (
                merge.parents.length !== 2 ||
                merge.parents[0].sha !== settings.base ||
                merge.parents[1].sha !== settings.head ||
                merge.tree.sha !== source.tree.sha ||
                (await reference(client, repository, settings.branch)) !== merge.sha ||
                !(await contents(client, repository, merge.sha))?.matches
            ) {
                throw new ProvisionError(
                    'The setup merge does not preserve the exact approved file and source history.',
                );
            }
            await identity(client, repository, settings.id);
            return;
        }
        if (attempt < 59) await wait(1000);
    }
    throw new ProvisionError('GitHub has not confirmed the setup merge. Retry the central workflow.');
}

async function cleanupMergedBranches({ client, repository, id, branches, appSlug, check }) {
    let refs;
    try {
        refs = await client.request('GET', `/repos/${repository}/git/matching-refs/heads/automation/release-request-`);
        if (!Array.isArray(refs) || refs.length > 1000)
            throw new ProvisionError('The setup branch inventory is invalid or too large.');
    } catch {
        return 'Merged setup branches could not be inspected safely.';
    }
    let cleaned = 0;
    let retained = 0;
    for (const candidate of refs) {
        const setupBranch = typeof candidate?.ref === 'string' ? candidate.ref.slice('refs/heads/'.length) : null;
        const match = typeof setupBranch === 'string'
            ? /^automation\/release-request-(master|dev)-([a-f0-9]{12})-([a-f0-9]{12})$/.exec(setupBranch) : null;
        if (!match || candidate.ref !== `refs/heads/${setupBranch}` || !branches.includes(match[1])) continue;
        const branch = match[1];
        try {
            const head = await reference(client, repository, setupBranch);
            if (head === null) continue;
            if (candidate.object?.type !== 'commit' || head !== candidate.object.sha)
                throw new ProvisionError('The setup branch reference changed.');
            const source = await commit(client, repository, head);
            if (source.parents.length !== 1 || !source.parents[0].sha.startsWith(match[2]))
                throw new ProvisionError('The setup branch source history changed.');
            const owner = repository.split('/')[0];
            const pulls = await inventory(client, `/repos/${repository}/pulls?state=closed&base=${branch}&head=${encodeURIComponent(`${owner}:${setupBranch}`)}`);
            if (pulls.length !== 1 || !pulls[0].merged_at)
                throw new ProvisionError('The setup branch has no unique merged pull request.');
            const settings = { repository, id, branch, setupBranch, head, appSlug,
                base: source.parents[0].sha, number: pulls[0].number, closed: true };
            const pull = pullIdentity(await client.request('GET', `/repos/${repository}/pulls/${settings.number}`), settings);
            const file = await contents(client, repository, head);
            if (!file || !file.sha.startsWith(match[3]))
                throw new ProvisionError('The setup branch no longer contains its original workflow.');
            await exactChanges(client, repository, pull, file.sha);
            const merged = await commit(client, repository, pull.merge_commit_sha);
            if (merged.parents.length !== 2 || merged.parents[0].sha !== settings.base
                    || merged.parents[1].sha !== head || merged.tree.sha !== source.tree.sha)
                throw new ProvisionError('The setup merge does not preserve its exact source.');
            const target = await reference(client, repository, branch);
            if (!target) throw new ProvisionError('The setup target branch is missing.');
            const ancestry = await client.request('GET', `/repos/${repository}/compare/${merged.sha}...${target}`);
            if (!['ahead', 'identical'].includes(ancestry?.status) || ancestry.base_commit?.sha !== merged.sha
                    || ancestry.merge_base_commit?.sha !== merged.sha)
                throw new ProvisionError('The setup merge is no longer part of its target branch.');
            for (const query of [`head=${encodeURIComponent(`${owner}:${setupBranch}`)}`, `base=${encodeURIComponent(setupBranch)}`])
                if ((await inventory(client, `/repos/${repository}/pulls?state=open&${query}`)).length)
                    throw new ProvisionError('An open pull request still uses the setup branch.');
            if (!check) {
                await identity(client, repository, id);
                const latest = pullIdentity(await client.request('GET', `/repos/${repository}/pulls/${settings.number}`), settings);
                if (latest.merge_commit_sha !== merged.sha || await reference(client, repository, branch) !== target
                        || await reference(client, repository, setupBranch) !== head)
                    throw new ProvisionError('The verified setup branch changed before cleanup.');
                await client.request('DELETE', `/repos/${repository}/git/refs/heads/${setupBranch}`, undefined, 204);
            }
            cleaned++;
        } catch {
            retained++;
        }
    }
    return [cleaned ? `${check ? 'Can remove' : 'Removed'} ${cleaned} merged setup ${cleaned === 1 ? 'branch' : 'branches'}.` : null,
        retained ? `${retained} setup branch(es) retained for manual review.` : null].filter(Boolean).join(' ');
}

async function configureBranch({ client, repository, appSlug, check, wait, id, branch, base, optInSha = null }) {
    const current = await contents(client, repository, base);
    if (current?.matches) return { action: 'unchanged', note: 'The managed Release workflow is already installed.' };
    if (check) return { action: 'planned', note: 'Install the managed Release workflow through an App pull request.' };
    const setupBranch = `automation/release-request-${branch}-${base.slice(0, 12)}-${expectedBlob.slice(0, 12)}`;
    const common = { client, repository, id, branch, base, optInSha };
    let head = await reference(client, repository, setupBranch);
    if (head === null) {
        await assertCurrent(common);
        const created = await client.request(
            'POST',
            `/repos/${repository}/git/refs`,
            { ref: `refs/heads/${setupBranch}`, sha: base },
            201,
        );
        if (
            created?.ref !== `refs/heads/${setupBranch}` ||
            created.object?.type !== 'commit' ||
            created.object.sha !== base
        ) {
            throw new ProvisionError('GitHub did not confirm the setup branch.');
        }
        head = base;
    }
    if (head === base) {
        await assertCurrent({ ...common, headBranch: setupBranch, head });
        const result = await client.request(
            'PUT',
            `/repos/${repository}/contents/${filename}`,
            {
                message,
                branch: setupBranch,
                content: expected.toString('base64'),
                ...(current ? { sha: current.sha } : {}),
            },
            current ? 200 : 201,
        );
        if (
            !validSha(result?.commit?.sha) ||
            result.content?.path !== filename ||
            result.content.sha !== expectedBlob
        ) {
            throw new ProvisionError('GitHub did not confirm the managed workflow commit.');
        }
        head = result.commit.sha;
    }
    if ((await reference(client, repository, setupBranch)) !== head)
        throw new ProvisionError('The setup branch changed after its workflow commit.');
    const source = await sourceCommit(client, repository, head, base);
    const settings = { repository, id, branch, base, setupBranch, head, appSlug, optInSha };
    const pulls = await inventory(
        client,
        `/repos/${repository}/pulls?state=open&base=${branch}&head=${encodeURIComponent(`${repository.split('/')[0]}:${setupBranch}`)}`,
    );
    if (pulls.length > 1) throw new ProvisionError('Multiple setup pull requests are ambiguous.');
    let pull;
    if (pulls.length) pull = pullIdentity(pulls[0], settings);
    else {
        await assertCurrent({ ...common, headBranch: setupBranch, head });
        pull = pullIdentity(
            await client.request(
                'POST',
                `/repos/${repository}/pulls`,
                { title: message, head: setupBranch, base: branch, body },
                201,
            ),
            settings,
        );
    }
    await exactChanges(client, repository, pull);
    settings.number = pull.number;
    const obsolete = await closeObsoletePulls({ client, repository, settings });
    const result = (action, note) => ({
        action,
        note: `${note}${obsolete ? ' An obsolete setup pull request could not be closed safely.' : ''}`,
    });
    for (let attempt = 0; attempt < 3; attempt++) {
        pull = await client.request('GET', `/repos/${repository}/pulls/${settings.number}`);
        if (pull?.state === 'closed' && pull.merged_at) {
            await confirmMerge({ client, repository, settings, source, wait });
            return result('configured', 'The managed Release workflow was merged and verified.');
        }
        pullIdentity(pull, settings);
        if (pull.mergeable !== null || attempt === 2) break;
        await wait(1000);
    }
    if (pull.draft || pull.mergeable !== true)
        return result('pending', 'The setup pull request is waiting for GitHub merge requirements.');
    await exactChanges(client, repository, pull);
    await sourceCommit(client, repository, head, base);
    await assertCurrent({ ...common, headBranch: setupBranch, head });
    let merged;
    try {
        merged = await client.request('PUT', `/repos/${repository}/pulls/${pull.number}/merge`, {
            sha: head,
            merge_method: 'merge',
        });
    } catch (error) {
        if (![403, 405, 409, 422].includes(error.status)) throw error;
        const observed = await client.request('GET', `/repos/${repository}/pulls/${pull.number}`);
        if (!observed?.merged_at) return result('pending', 'GitHub rules or required reviews prevent the setup merge.');
        await confirmMerge({ client, repository, settings, source, wait });
        return result('configured', 'The concurrent setup merge was verified.');
    }
    if (merged?.merged === false) return result('pending', 'GitHub rules or required reviews prevent the setup merge.');
    if (merged?.merged !== true || !validSha(merged.sha))
        throw new ProvisionError('GitHub returned an invalid setup merge confirmation.');
    await confirmMerge({ client, repository, settings, source, mergeSha: merged.sha, wait });
    return result('configured', 'The managed Release workflow was merged and verified.');
}

function failed(error) {
    return {
        action: 'failed',
        note: error instanceof ProvisionError ? error.message : 'The GitHub workflow provisioning operation failed.',
    };
}

export async function reconcileReleaseWorkflow({ client, repository, appSlug, check = false, wait = pause }) {
    repositoryName(repository);
    if (typeof appSlug !== 'string' || !/^[a-z0-9-]+$/.test(appSlug) || typeof check !== 'boolean') {
        throw new ProvisionError('A valid GitHub App identity and check mode are required.');
    }
    const reports = [];
    const record = (branch, result) => reports.push({ repository, branch, ...result });
    let id;
    let master;
    let optInSha = null;
    try {
        id = await identity(client, repository);
        if (!/^Kraftink-CMS\/(?:Plugin|Theme|Game)-[A-Za-z0-9_.-]+$/i.test(repository)) {
            optInSha = await managedReleaseOptIn({ client, repository });
            if (!optInSha) {
                record('dev', { action: 'unchanged', note: 'No exact managed Release workflow on dev enables provisioning.' });
                return reports;
            }
        }
        master = await reference(client, repository, 'master', true);
        if (!master) {
            for (const branch of ['master', 'dev'])
                record(branch, {
                    action: 'pending',
                    note: 'Waiting for the first commit on master. No initial repository files are created.',
                });
            return reports;
        }
        record(
            'master',
            await configureBranch({ client, repository, appSlug, check, wait, id, branch: 'master', base: master, optInSha }),
        );
    } catch (error) {
        record('master', failed(error));
    }
    if (!id || !master || (!check && !['unchanged', 'configured'].includes(reports[0].action))) {
        record('dev', {
            action: 'pending',
            note: 'Configure master successfully before installing the dev release workflow.',
        });
        return reports;
    }
    try {
        const dev = await reference(client, repository, 'dev');
        if (dev)
            record(
                'dev',
                await configureBranch({ client, repository, appSlug, check, wait, id, branch: 'dev', base: dev, optInSha }),
            );
        else if (optInSha)
            record('dev', { action: 'pending', note: 'The dev opt-in branch was removed during setup. No branch is recreated.' });
        else if (check)
            record('dev', {
                action: 'planned',
                note: 'Create dev from master after its managed Release workflow is installed.',
            });
        else {
            master = await reference(client, repository, 'master');
            if (!master || !(await contents(client, repository, master))?.matches)
                throw new ProvisionError('The master Release workflow changed before creating dev.');
            await assertCurrent({ client, repository, id, branch: 'master', base: master });
            const existing = await reference(client, repository, 'dev');
            if (existing)
                throw new ProvisionError('The dev branch was created concurrently. Retry the central workflow.');
            const created = await client.request(
                'POST',
                `/repos/${repository}/git/refs`,
                { ref: 'refs/heads/dev', sha: master },
                201,
            );
            if (
                created?.ref !== 'refs/heads/dev' ||
                created.object?.type !== 'commit' ||
                created.object.sha !== master ||
                (await reference(client, repository, 'dev')) !== master ||
                !(await contents(client, repository, master))?.matches
            ) {
                throw new ProvisionError('GitHub did not confirm dev from the configured master source.');
            }
            record('dev', { action: 'configured', note: 'Created dev from master with the managed Release workflow.' });
        }
    } catch (error) {
        record('dev', failed(error));
    }
    const branches = reports.filter((report) => ['configured', 'unchanged'].includes(report.action)).map((report) => report.branch);
    if (branches.length) {
        const cleanup = await cleanupMergedBranches({ client, repository, id, branches, appSlug, check });
        if (cleanup) reports[0].note = `${reports[0].note} ${cleanup}`;
    }
    return reports;
}
