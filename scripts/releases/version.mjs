import { execFileSync } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function stableVersion(value) {
    if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
        throw new Error('Expected a stable X.Y.Z version.');
    }
    const parts = value.split('.').map(Number);
    if (parts.some((part) => !Number.isSafeInteger(part))) {
        throw new Error('Version is outside the supported range.');
    }
    return parts;
}

export function compareVersions(left, right) {
    const a = stableVersion(left);
    const b = stableVersion(right);
    for (let index = 0; index < 3; index++) {
        if (a[index] !== b[index]) {
            return a[index] < b[index] ? -1 : 1;
        }
    }
    return 0;
}

export function recommendedBump(messages, fallback = 'patch') {
    let result = null;
    const rank = { patch: 1, minor: 2, major: 3 };
    if (!rank[fallback]) {
        throw new Error('Invalid default version bump.');
    }
    for (const message of messages) {
        const header = /^([a-z][a-z0-9-]*)(?:\([^()\n]+\))?(!)?: [^\n]+/i.exec(message);
        if (!header) {
            continue;
        }
        const level =
            header[2] || /^BREAKING(?: CHANGE|-CHANGE):\s+\S/m.test(message)
                ? 'major'
                : header[1].toLowerCase() === 'feat'
                  ? 'minor'
                  : 'patch';
        if (result === null || rank[level] > rank[result]) {
            result = level;
        }
    }
    return result ?? fallback;
}

export function git(root, args, optional = false) {
    try {
        return execFileSync('git', ['--no-pager', '-C', root, ...args], {
            encoding: 'utf8',
            windowsHide: true,
            shell: false,
            timeout: 20000,
            stdio: ['ignore', 'pipe', 'pipe'],
            maxBuffer: 8 * 1024 * 1024,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        }).trimEnd();
    } catch (error) {
        if (optional && error.status === 1) {
            return null;
        }
        throw new Error(`Git failed while reading ${args[0]}.`);
    }
}

export function selectVersion({ sha, tags, messages = [], bump = 'auto', version = null, policy }) {
    if (!['auto', 'patch', 'minor', 'major'].includes(bump) || policy?.schema !== 1
            || !['patch', 'minor', 'major'].includes(policy.default_bump)) {
        throw new Error('The release policy or version bump is invalid.');
    }
    stableVersion(policy.initial_version);
    if (policy.next_version != null) stableVersion(policy.next_version);
    if (version !== null) stableVersion(version);
    tags.forEach((tag) => stableVersion(tag.version));
    const sorted = tags.filter((tag) => tag.ancestor).sort((a, b) => compareVersions(b.version, a.version));
    const existing = tags.filter((tag) => tag.sha === sha);
    if (existing.length > 1 || (existing[0] && version !== null && version !== existing[0].version)) {
        throw new Error('This commit already has a different or ambiguous stable version.');
    }
    const base = sorted.find((tag) => tag.sha !== sha) ?? null;
    let next = existing[0]?.version ?? policy.initial_version;
    if (!existing.length && base) {
        const level = bump === 'auto' ? recommendedBump(messages, policy.default_bump) : bump;
        const parts = stableVersion(base.version);
        const index = ['major', 'minor', 'patch'].indexOf(level);
        parts[index]++;
        for (let offset = index + 1; offset < parts.length; offset++) parts[offset] = 0;
        const planned = policy.next_version && compareVersions(policy.next_version, base.version) > 0
            ? policy.next_version : null;
        next = version ?? (bump === 'auto' ? planned : null) ?? parts.join('.');
    } else if (!existing.length && version !== null && version !== policy.initial_version) {
        throw new Error('The first release must match initial_version.');
    }
    stableVersion(next);
    if (base && compareVersions(next, base.version) <= 0) {
        throw new Error('The next version must exceed the previous release.');
    }
    const tag = `v${next}`;
    if (tags.some((entry) => entry.tag === tag && entry.sha !== sha)) {
        throw new Error('The release tag points to another commit.');
    }
    return { schema: 1, mode: 'stable', branch: 'master', sha, version: next, tag,
        base_tag: base?.tag ?? null, create_tag: !existing.length };
}

export async function planVersion({
    root = process.cwd(),
    bump = 'auto',
    version = null,
    branch = 'master',
    sourceBranch = 'master',
    policy: suppliedPolicy = null,
} = {}) {
    if (
        branch !== 'master' ||
        !['master', 'dev'].includes(sourceBranch) ||
        !['auto', 'patch', 'minor', 'major'].includes(bump)
    ) {
        throw new Error('Stable releases require master and a supported version bump.');
    }
    const repository = await realpath(root);
    if (repository !== (await realpath(git(repository, ['rev-parse', '--show-toplevel'])))) {
        throw new Error('Run the release tool from the independent repository root.');
    }
    if (git(repository, ['rev-parse', '--is-shallow-repository']) !== 'false') {
        throw new Error('A complete Git history is required.');
    }
    if (git(repository, ['status', '--porcelain', '--untracked-files=normal'])) {
        throw new Error('Publication requires a clean working tree.');
    }
    const policy =
        suppliedPolicy ?? JSON.parse(await readFile(resolve(repository, '.github/release-policy.json'), 'utf8'));
    if (policy.schema !== 1 || !['patch', 'minor', 'major'].includes(policy.default_bump)) {
        throw new Error('The release policy is invalid.');
    }
    stableVersion(policy.initial_version);
    if (policy.next_version !== null && policy.next_version !== undefined) {
        stableVersion(policy.next_version);
    }
    if (version !== null) {
        stableVersion(version);
    }
    const attached = git(repository, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true);
    if (attached && attached !== sourceBranch) {
        throw new Error(
            sourceBranch === 'master'
                ? 'Stable publication requires the master branch.'
                : 'Stable planning requires the dev source branch.',
        );
    }
    const sha = git(repository, ['rev-parse', '--verify', 'HEAD^{commit}']);
    const verified = [`refs/heads/${sourceBranch}`, `refs/remotes/origin/${sourceBranch}`].some((ref) => {
        const head = git(repository, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], true);
        return head && git(repository, ['merge-base', '--is-ancestor', sha, head], true) !== null;
    });
    if (!verified) {
        throw new Error(`The release commit must belong to ${sourceBranch}.`);
    }
    const names = git(repository, ['tag', '--list'])
        .split('\n')
        .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
    if (names.length > 10000) {
        throw new Error('Too many release tags.');
    }
    const tags = names.map((tag) => ({
        tag,
        version: tag.slice(1),
        sha: git(repository, ['rev-parse', '--verify', `${tag}^{commit}`]),
    }));
    tags.forEach((tag) => stableVersion(tag.version));
    const ancestors = new Set(git(repository, ['tag', '--merged', 'HEAD']).split('\n'));
    const base = tags.filter((tag) => ancestors.has(tag.tag) && tag.sha !== sha)
        .sort((a, b) => compareVersions(b.version, a.version))[0];
    const messages = base ? git(repository, ['log', '--format=%B%x00', `${base.tag}..HEAD`, '--'])
        .split('\0').map((message) => message.trim()) : [];
    return selectVersion({ sha, tags: tags.map((tag) => ({ ...tag, ancestor: ancestors.has(tag.tag) })),
        messages, bump, version, policy });
}

async function main() {
    const [command, bump = 'auto', exact = ''] = process.argv.slice(2);
    if (command !== 'plan' || process.argv.length > 5) {
        throw new Error('Usage: version.mjs plan [auto|patch|minor|major] [X.Y.Z]');
    }
    const plan = await planVersion({ bump, version: exact || null });
    process.stdout.write(JSON.stringify(plan) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`Version planning failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}
