import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const organization = 'Kraftink-CMS';
const responseLimit = 8388608;
const pageLimit = 100;
const pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const plainObject = (value) =>
    value !== null &&
    typeof value === 'object' &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validSha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const validName = (value) =>
    typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value) && !['.', '..'].includes(value);
const sameName = (left, right) => typeof left === 'string' && left.toLowerCase() === right.toLowerCase();

class ProtectionError extends Error {}

function canonical(value) {
    if (Array.isArray(value)) {
        return value
            .map(canonical)
            .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    }
    if (plainObject(value)) {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, canonical(value[key])]),
        );
    }
    return value;
}

function equal(left, right) {
    return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function keys(value, names, optional = []) {
    return (
        plainObject(value) &&
        names.every((name) => Object.hasOwn(value, name)) &&
        Object.keys(value).every((name) => names.includes(name) || optional.includes(name))
    );
}

function boundedJson(value, depth = 0, budget = { remaining: 10000 }) {
    if (depth > 10 || --budget.remaining < 0) return false;
    if (value === null || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value === 'string') return value.length <= 8192 && !value.includes('\0');
    if (Array.isArray(value))
        return value.length <= 1000 && value.every((item) => boundedJson(item, depth + 1, budget));
    return (
        plainObject(value) &&
        Object.entries(value).every(
            ([name, item]) =>
                name.length <= 100 &&
                !['__proto__', 'prototype', 'constructor'].includes(name) &&
                boundedJson(item, depth + 1, budget),
        )
    );
}

function strings(value, valid, { empty = true, maximum = 1000 } = {}) {
    return (
        Array.isArray(value) &&
        value.length <= maximum &&
        (empty || value.length > 0) &&
        value.every(valid) &&
        new Set(value).size === value.length
    );
}

const selector = (value) =>
    typeof value === 'string' && /^[A-Za-z0-9_.*?-]{1,100}$/.test(value) && !['.', '..'].includes(value);
const refPattern = (value, target) =>
    typeof value === 'string' &&
    value.length <= 255 &&
    !/[\x00-\x20\x7f]/.test(value) &&
    ((target === 'branch' && value.startsWith('refs/heads/') && value.length > 11) ||
        (target === 'tag' && value.startsWith('refs/tags/') && value.length > 10) ||
        value === '~ALL' ||
        (target === 'branch' && value === '~DEFAULT_BRANCH'));
const rulesetName = (value) =>
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= 100 &&
    !/[\x00-\x1f\x7f]/.test(value);

function validateRuleset(value) {
    if (
        !keys(
            value,
            ['name', 'target', 'enforcement', 'bypass_actors', 'conditions', 'rules'],
            ['previous_names'],
        ) ||
        !rulesetName(value.name) ||
        (value.previous_names !== undefined &&
            (!strings(value.previous_names, rulesetName, { maximum: 32 }) ||
                new Set(value.previous_names.map((name) => name.toLowerCase())).size !==
                    value.previous_names.length ||
                value.previous_names.some((name) => sameName(name, value.name)))) ||
        !['branch', 'tag'].includes(value.target) ||
        !['active', 'disabled'].includes(value.enforcement) ||
        !Array.isArray(value.bypass_actors) ||
        value.bypass_actors.length > 100 ||
        !value.bypass_actors.every(
            (actor) =>
                keys(actor, ['actor_id', 'actor_type', 'bypass_mode']) &&
                (validId(actor.actor_id) ||
                    actor.actor_id === null ||
                    (actor.actor_id === '${APP_ID}' && actor.actor_type === 'Integration')) &&
                typeof actor.actor_type === 'string' &&
                /^[A-Za-z]{1,40}$/.test(actor.actor_type) &&
                typeof actor.bypass_mode === 'string' &&
                /^[a-z_]{1,40}$/.test(actor.bypass_mode) &&
                (value.target !== 'tag' || actor.bypass_mode !== 'pull_request'),
        ) ||
        !keys(value.conditions, ['ref_name']) ||
        !keys(value.conditions.ref_name, ['include', 'exclude']) ||
        !strings(value.conditions.ref_name.include, (ref) => refPattern(ref, value.target), {
            empty: false,
            maximum: 100,
        }) ||
        !strings(value.conditions.ref_name.exclude, (ref) => refPattern(ref, value.target), {
            maximum: 100,
        }) ||
        !Array.isArray(value.rules) ||
        value.rules.length > 100 ||
        !value.rules.every(
            (rule) =>
                keys(rule, ['type'], ['parameters']) &&
                typeof rule.type === 'string' &&
                /^[a-z][a-z0-9_]{0,79}$/.test(rule.type) &&
                (rule.parameters === undefined || plainObject(rule.parameters)),
        ) ||
        new Set(value.rules.map((rule) => rule.type)).size !== value.rules.length ||
        !boundedJson(value)
    )
        throw new ProtectionError('A policy contains an invalid native branch or tag ruleset payload.');
}

export function validateConfiguration(config, { appId, requireBindings = false } = {}) {
    if (
        !plainObject(config) ||
        Object.keys(config).sort().join(',') !== 'excluded_repositories,organization,policies,schema' ||
        config.schema !== 1 ||
        !sameName(config.organization, organization) ||
        !Array.isArray(config.excluded_repositories) ||
        config.excluded_repositories.length > 1000 ||
        !config.excluded_repositories.every(validName) ||
        new Set(config.excluded_repositories.map((name) => name.toLowerCase())).size !==
            config.excluded_repositories.length ||
        !Array.isArray(config.policies) ||
        config.policies.length > 64 ||
        !boundedJson(config)
    ) {
        throw new ProtectionError(
            'The policy configuration must target Kraftink-CMS with valid repository exclusions and profiles.',
        );
    }
    const ids = new Set();
    for (const policy of config.policies) {
        if (
            !keys(policy, ['id', 'repositories', 'rulesets'], ['release_workflow', 'validated_releases']) ||
            (policy.release_workflow !== undefined && typeof policy.release_workflow !== 'boolean') ||
            (policy.validated_releases !== undefined && typeof policy.validated_releases !== 'boolean') ||
            typeof policy.id !== 'string' ||
            !/^[a-z][a-z0-9-]{0,63}$/.test(policy.id) ||
            ids.has(policy.id) ||
            !keys(policy.repositories, ['include', 'exclude']) ||
            !strings(policy.repositories.include, selector, { empty: false, maximum: 100 }) ||
            !strings(policy.repositories.exclude, selector, { maximum: 100 }) ||
            !Array.isArray(policy.rulesets) ||
            policy.rulesets.length > 32
        ) {
            throw new ProtectionError(
                'A policy profile has an invalid identity, selector or declarative configuration.',
            );
        }
        ids.add(policy.id);
        policy.rulesets.forEach(validateRuleset);
    }
    let binding = null;
    if (appId !== undefined) {
        binding = typeof appId === 'string' && /^\d+$/.test(appId) ? Number(appId) : appId;
        if (!validId(binding))
            throw new ProtectionError('The GitHub App ID binding must be a positive safe integer.');
    }
    const resolved = structuredClone(config);
    for (const policy of resolved.policies) {
        for (const ruleset of policy.rulesets) {
            for (const actor of ruleset.bypass_actors) {
                if (actor.actor_id !== '${APP_ID}') continue;
                if (binding !== null) actor.actor_id = binding;
                else if (requireBindings)
                    throw new ProtectionError(
                        'The GitHub App ID binding is required before applying protection.',
                    );
            }
        }
    }
    return resolved;
}

function glob(pattern, value) {
    const expression = [...pattern]
        .map((character) =>
            character === '*'
                ? '.*'
                : character === '?'
                  ? '.'
                  : character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'),
        )
        .join('');
    return new RegExp(`^${expression}$`, 'i').test(value);
}

export function selectPolicies(config, repository) {
    config = validateConfiguration(config);
    if (!validName(repository))
        throw new ProtectionError('A valid repository name is required to select policy profiles.');
    if (config.excluded_repositories.some((excluded) => sameName(excluded, repository))) return [];
    const selected = config.policies.filter(
        (policy) =>
            policy.repositories.include.some((pattern) => glob(pattern, repository)) &&
            !policy.repositories.exclude.some((pattern) => glob(pattern, repository)),
    );
    const names = selected.flatMap((policy) =>
        policy.rulesets.flatMap((ruleset) =>
            [ruleset.name, ...(ruleset.previous_names ?? [])].map((name) => name.toLowerCase()),
        ),
    );
    if (new Set(names).size !== names.length)
        throw new ProtectionError(
            'Selected policy profiles contain duplicate managed ruleset names or aliases.',
        );
    return selected;
}

async function responseJson(response, limit = responseLimit) {
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
        await response.body?.cancel();
        throw new ProtectionError('The GitHub response exceeds its size limit.');
    }
    let size = 0;
    const chunks = [];
    if (response.body) {
        for await (const chunk of response.body) {
            size += chunk.length;
            if (size > limit) {
                throw new ProtectionError('The GitHub response exceeds its size limit.');
            }
            chunks.push(Buffer.from(chunk));
        }
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw new ProtectionError('GitHub returned invalid JSON.');
    }
}

export function createGitHubClient({ token = '', transport = fetch } = {}) {
    if (typeof token !== 'string' || /[\r\n]/.test(token)) {
        throw new ProtectionError('The repository administration token is invalid.');
    }
    const credential = token.trim();
    return {
        authenticated: credential.length > 0,
        async request(method, path, body, expected = 200) {
            const target = new URL(path, 'https://api.github.com');
            const inventory = /^\/orgs\/Kraftink-CMS\/repos$/i.test(target.pathname);
            const repository =
                /^\/repos\/Kraftink-CMS\/[A-Za-z0-9_.-]+(?:\/(rulesets(?:\/\d+)?|rules\/branches\/[^/]+|pulls(?:\/\d+(?:\/merge|\/files)?)?|compare\/[a-f0-9]{40}\.\.\.[a-f0-9]{40}|collaborators\/[A-Za-z0-9-]+\/permission|contents\/\.github\/workflows\/release\.yml|actions\/permissions\/workflow|git\/commits\/[a-f0-9]{40}|git\/matching-refs\/heads\/automation\/release-request-|git\/refs|git\/refs?\/heads\/(?:dev|master|automation\/release-request-(?:master|dev)-[a-f0-9]{12}(?:-[a-f0-9]{12})?)))?$/i.test(
                    target.pathname,
                );
            const write = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
            const deleteSetupRef = /\/git\/refs\/heads\/automation\/release-request-(?:master|dev)-[a-f0-9]{12}-[a-f0-9]{12}$/.test(target.pathname)
                && !target.search && body === undefined;
            const settings = /^\/repos\/Kraftink-CMS\/[A-Za-z0-9_.-]+$/i.test(target.pathname);
            const merge =
                /\/pulls\/[1-9]\d*\/merge$/.test(target.pathname) &&
                keys(body, ['sha', 'merge_method']) &&
                typeof body.sha === 'string' &&
                /^[a-f0-9]{40}$/.test(body.sha) &&
                body.merge_method === 'merge';
            const pullBody = typeof body?.body === 'string' && Buffer.byteLength(body.body) <= 65536;
            const openPull =
                /\/pulls$/.test(target.pathname) &&
                keys(body, ['title', 'head', 'base', 'body']) &&
                body.title === 'chore: configure extension release' &&
                /^automation\/release-request-(?:master|dev)-[a-f0-9]{12}(?:-[a-f0-9]{12})?$/.test(body.head) &&
                ['master', 'dev'].includes(body.base) &&
                pullBody;
            const updatePull =
                /\/pulls\/[1-9]\d*$/.test(target.pathname) &&
                ((keys(body, ['body']) && pullBody) || (keys(body, ['state']) && body.state === 'closed'));
            const createRef =
                /\/git\/refs$/.test(target.pathname) &&
                keys(body, ['ref', 'sha']) &&
                /^refs\/heads\/(?:dev|automation\/release-request-(?:master|dev)-[a-f0-9]{12}(?:-[a-f0-9]{12})?)$/.test(
                    body.ref,
                ) &&
                /^[a-f0-9]{40}$/.test(body.sha);
            const workflowFile =
                /\/contents\/\.github\/workflows\/release\.yml$/.test(target.pathname) &&
                keys(body, ['message', 'content', 'branch'], ['sha']) &&
                body.message === 'chore: configure extension release' &&
                typeof body.content === 'string' &&
                /^[A-Za-z0-9+/]+={0,2}$/.test(body.content) &&
                body.content.length <= 8192 &&
                /^automation\/release-request-(?:master|dev)-[a-f0-9]{12}(?:-[a-f0-9]{12})?$/.test(
                    body.branch,
                ) &&
                (body.sha === undefined || /^[a-f0-9]{40}$/.test(body.sha));
            const workflowPermissions = /\/actions\/permissions\/workflow$/.test(target.pathname) && !target.search
                && keys(body, ['can_approve_pull_request_reviews']) && body.can_approve_pull_request_reviews === true;
            const comparison = /\/compare\/[a-f0-9]{40}\.\.\.[a-f0-9]{40}$/.test(target.pathname);
            const comparisonQuery = comparison
                ? !target.search || /^\?per_page=100&page=(?:[1-9]\d?|100)$/.test(target.search)
                : !target.search;
            if (
                target.origin !== 'https://api.github.com' ||
                target.username ||
                target.password ||
                target.hash ||
                path !== target.pathname + target.search ||
                (!inventory && !repository) ||
                (method !== 'GET' && !write) ||
                (write && (!credential || !repository)) ||
                (method === 'DELETE' && !deleteSetupRef) ||
                (method === 'POST' && !/\/rulesets$/.test(target.pathname) && !openPull && !createRef) ||
                (method === 'PUT' && !/\/rulesets\/\d+$/.test(target.pathname) && !merge && !workflowFile && !workflowPermissions) ||
                (method === 'PATCH' &&
                    !(settings && equal(body, { allow_merge_commit: true })) &&
                    !updatePull) ||
                (method === 'GET' && comparison && !comparisonQuery) ||
                (/\/git\/matching-refs\//.test(target.pathname) && (method !== 'GET' || target.search)) ||
                (method === 'GET' && body !== undefined)
            ) {
                throw new ProtectionError(
                    'The GitHub request falls outside repository protection administration.',
                );
            }
            let response;
            try {
                response = await transport(target.href, {
                    method,
                    headers: {
                        Accept: 'application/vnd.github+json',
                        'Content-Type': 'application/json',
                        'User-Agent': 'KraftInk-Repository-Protection',
                        'X-GitHub-Api-Version': '2022-11-28',
                        ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
                    },
                    body: body === undefined ? undefined : JSON.stringify(body),
                    redirect: 'error',
                    signal: AbortSignal.timeout(20000),
                });
            } catch {
                throw new ProtectionError('The GitHub network request failed.');
            }
            if (response.status !== expected) {
                let detail = '';
                if (response.status === 422 && /\/rulesets(?:\/\d+)?$/.test(target.pathname)) {
                    try {
                        const value = await responseJson(response, 16384);
                        const clean = (text) => typeof text === 'string'
                            ? (credential ? text.split(credential).join('[redacted]') : text)
                                .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240)
                            : undefined;
                        const message = clean(value?.message);
                        const errors = Array.isArray(value?.errors) ? value.errors.slice(0, 6).map((entry) =>
                            typeof entry === 'string' ? clean(entry) : Object.fromEntries(
                                ['field', 'code', 'message'].map((field) => [field, clean(entry?.[field])])
                                    .filter(([, text]) => text)))
                            .filter((entry) => typeof entry === 'string' ? entry.length : Object.keys(entry).length) : [];
                        if (message || errors.length)
                            detail = ` ${JSON.stringify({ ...(message ? { message } : {}), ...(errors.length ? { errors } : {}) })}`;
                    } catch {
                        await response.body?.cancel().catch(() => {});
                    }
                } else await response.body?.cancel();
                const error = new ProtectionError(
                    `GitHub ${method} request failed with status ${response.status}.${detail}`,
                );
                error.status = response.status;
                throw error;
            }
            if (expected === 204) {
                await response.body?.cancel();
                return null;
            }
            try {
                return await responseJson(response);
            } catch (error) {
                if (error instanceof ProtectionError) throw error;
                throw new ProtectionError('The GitHub response could not be read.');
            }
        },
    };
}

async function inventory(client, path) {
    const result = [];
    for (let page = 1; page <= pageLimit; page++) {
        const entries = await client.request(
            'GET',
            `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
        );
        if (!Array.isArray(entries) || entries.length > 100) {
            throw new ProtectionError('GitHub returned an invalid inventory.');
        }
        result.push(...entries);
        if (entries.length < 100) return result;
    }
    throw new ProtectionError('The GitHub inventory exceeds its pagination limit.');
}

function repositoryIdentity(repo, config) {
    if (!plainObject(repo) || !validName(repo.name)) {
        throw new ProtectionError('GitHub returned an invalid repository identity.');
    }
    const name = `${config.organization}/${repo.name}`;
    if (!sameName(repo.owner?.login, config.organization)) {
        return { repository: name, action: 'skipped', note: 'Repository owner is outside Kraftink-CMS.' };
    }
    if (!sameName(repo.full_name, name)) {
        throw new ProtectionError('GitHub returned an inconsistent repository owner and name.');
    }
    if (repo.private !== false || repo.visibility !== 'public') {
        return { repository: name, action: 'skipped', note: 'Repository is not public.' };
    }
    if (config.excluded_repositories.some((excluded) => sameName(excluded, repo.name))) {
        return { repository: name, action: 'excluded', note: 'Repository is excluded from this policy.' };
    }
    if (typeof repo.archived !== 'boolean' || typeof repo.disabled !== 'boolean') {
        throw new ProtectionError('GitHub did not identify whether the repository is archived or disabled.');
    }
    if (repo.archived === true || repo.disabled === true) {
        return { repository: name, action: 'skipped', note: 'Repository is archived or disabled.' };
    }
    return { repository: name };
}

async function emptyRepository(client, repository, metadata) {
    if (metadata.size !== 0) return false;
    const branch = metadata.default_branch;
    if (typeof branch !== 'string' || !/^[A-Za-z0-9_.\/-]{1,200}$/.test(branch)
            || branch.split('/').some((part) => !part || part === '.' || part === '..'))
        throw new ProtectionError('The repository default branch is invalid.');
    try {
        const head = await client.request('GET', `/repos/${repository}/git/ref/heads/${branch}`);
        if (head?.ref !== `refs/heads/${branch}` || head.object?.type !== 'commit' || !validSha(head.object.sha))
            throw new ProtectionError('The repository default branch reference is invalid.');
        return false;
    } catch (error) {
        if (error.status === 404 || error.status === 409) return true;
        throw error;
    }
}

function localRuleset(value, repository, name, expectedId = null) {
    if (
        !plainObject(value) ||
        !validId(value.id) ||
        (expectedId !== null && value.id !== expectedId) ||
        !sameName(value.name, name) ||
        value.source_type !== 'Repository' ||
        !sameName(value.source, repository)
    ) {
        throw new ProtectionError('The managed ruleset is not owned by this repository.');
    }
    return value;
}

function ruleValues(rules) {
    if (!Array.isArray(rules)) return null;
    return rules.map((rule) => {
        if (!plainObject(rule) || typeof rule.type !== 'string') return null;
        const value = { type: rule.type };
        if (rule.type === 'pull_request' && plainObject(rule.parameters)) {
            value.parameters = {
                dismissal_restriction: { enabled: false, allowed_actors: [] },
                ignore_approvals_from_contributors: false,
                required_reviewers: [],
                require_extra_approval_for_unattributed_changes: false,
                ...rule.parameters,
            };
        } else if (rule.type === 'update') {
            value.parameters = { update_allows_fetch_and_merge: false, ...rule.parameters };
        } else if (rule.type === 'required_status_checks' && plainObject(rule.parameters)) {
            value.parameters = {
                ...rule.parameters,
                required_status_checks: Array.isArray(rule.parameters.required_status_checks)
                    ? rule.parameters.required_status_checks.map((check) => ({
                          integration_id: null,
                          ...check,
                      }))
                    : rule.parameters.required_status_checks,
            };
        } else if (rule.parameters !== undefined && rule.parameters !== null && !equal(rule.parameters, {})) {
            value.parameters = rule.parameters;
        }
        return value;
    });
}

function policyValues(ruleset) {
    return {
        name: ruleset.name,
        target: ruleset.target,
        enforcement: ruleset.enforcement,
        bypass_actors: ruleset.bypass_actors,
        conditions: ruleset.conditions,
        rules: ruleValues(ruleset.rules),
    };
}

function matchingPolicy(current, desired, check) {
    const observed = policyValues(current);
    const hidden = !Object.hasOwn(current, 'bypass_actors');
    if (hidden && !check) {
        throw new ProtectionError(
            'GitHub hid bypass actors. Repository Administration write access is required to verify this policy.',
        );
    }
    if (hidden) observed.bypass_actors = desired.bypass_actors;
    return { matches: equal(observed, policyValues(desired)), hidden };
}

async function confirmPolicy({ client, repository, id, desired, wait, check = false }) {
    const prefix = desired.target === 'tag' ? 'refs/tags/' : 'refs/heads/';
    const literal = (value) =>
        value.startsWith(prefix) &&
        !/[\x00-\x20~^:?*[\]\\]/.test(value) &&
        !value.includes('..') &&
        !value.includes('@{') &&
        !value.includes('//') &&
        !value.endsWith('/') &&
        !value.endsWith('.') &&
        !value.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'));
    const refs = desired.conditions.ref_name;
    const dynamic = ![...refs.include, ...refs.exclude].every(literal);
    for (let attempt = 0; attempt < 3; attempt++) {
        let current;
        try {
            current = localRuleset(
                await client.request('GET', `/repos/${repository}/rulesets/${id}?includes_parents=false`),
                repository,
                desired.name,
                id,
            );
        } catch (error) {
            if (error.status !== 404 || attempt === 2) throw error;
            await wait(1200);
            continue;
        }
        const policy = matchingPolicy(current, desired, check);
        let effective = policy.matches;
        const verifiable = refs.exclude.every(literal) ? refs.include.filter(literal) : [];
        if (effective && desired.target === 'branch')
            for (const ref of verifiable) {
                const branch = encodeURIComponent(ref.slice('refs/heads/'.length));
                const active = await inventory(client, `/repos/${repository}/rules/branches/${branch}`);
                const owned = active.filter((rule) => rule?.ruleset_id === id);
                const expected =
                    desired.enforcement === 'active' && !refs.exclude.includes(ref) ? desired.rules : [];
                effective &&=
                    owned.every(
                        (rule) =>
                            rule.ruleset_source_type === 'Repository' &&
                            sameName(rule.ruleset_source, repository),
                    ) && equal(ruleValues(owned), ruleValues(expected));
            }
        if (policy.matches && effective) {
            return {
                configured: true,
                confirmed: !policy.hidden && !dynamic && desired.target === 'branch',
                hidden: policy.hidden,
                ...(desired.target === 'tag'
                    ? {
                          note: 'Tag ruleset configuration verified. GitHub does not expose effective tag rules through the branch policy endpoint.',
                      }
                    : dynamic
                      ? {
                            note: 'Ruleset configuration verified. Pattern or dynamic branch targets cannot receive complete effective branch verification.',
                        }
                      : {}),
            };
        }
        if (attempt < 2) await wait(1200);
    }
    throw new ProtectionError(
        'GitHub did not confirm the configured ruleset and effective branch policy after bounded verification.',
    );
}

async function planRuleset({ client, repository, desired, check, policy, entries }) {
    const { previous_names = [], ...native } = desired;
    const names = [native.name, ...previous_names];
    const matches = entries.filter(
        (value) =>
            names.some((name) => sameName(value?.name, name)) &&
            value.source_type === 'Repository' &&
            sameName(value.source, repository),
    );
    if (matches.length > 1) {
        throw new ProtectionError('Multiple repository rulesets with a managed name are ambiguous.');
    }
    let id = null;
    let action = 'create';
    let hidden = false;
    if (matches.length) {
        const listed = localRuleset(matches[0], repository, matches[0].name);
        const current = localRuleset(
            await client.request('GET', `/repos/${repository}/rulesets/${listed.id}?includes_parents=false`),
            repository,
            listed.name,
            listed.id,
        );
        id = current.id;
        const comparison = matchingPolicy(current, native, check);
        hidden = comparison.hidden;
        action = comparison.matches ? 'unchanged' : 'update';
    }
    return { repository, policy, ruleset: native.name, id, desired: native, action, hidden };
}

async function reconcileRuleset({ client, plan, check, wait }) {
    const { repository, policy, ruleset, desired, action, hidden } = plan;
    let { id } = plan;
    const result = { repository, policy, ruleset, action };
    const unresolved = desired.bypass_actors.some((actor) => actor.actor_id === '${APP_ID}');
    const notes = [
        hidden ? 'Public inspection cannot verify hidden bypass actors.' : null,
        unresolved ? 'The GitHub App ID binding is unresolved in this read-only plan.' : null,
    ].filter(Boolean);
    if (check) {
        if (action === 'unchanged') {
            const confirmation = await confirmPolicy({ client, repository, id, desired, wait, check: true });
            return {
                ...result,
                ...confirmation,
                confirmed: confirmation.confirmed && !unresolved,
                ...([...notes, confirmation.note].filter(Boolean).length
                    ? { note: [...notes, confirmation.note].filter(Boolean).join(' ') }
                    : {}),
            };
        }
        return {
            ...result,
            configured: false,
            confirmed: false,
            ...(notes.length ? { note: notes.join(' ') } : {}),
        };
    }
    if (action !== 'unchanged') {
        const written = localRuleset(
            await client.request(
                action === 'create' ? 'POST' : 'PUT',
                `/repos/${repository}/rulesets${id === null ? '' : `/${id}`}`,
                structuredClone(desired),
                action === 'create' ? 201 : 200,
            ),
            repository,
            desired.name,
            id,
        );
        id = written.id;
    }
    const confirmation = await confirmPolicy({ client, repository, id, desired, wait });
    return { ...result, ...confirmation };
}

async function prepareMergeMethod({ client, repo, repository, config, check }) {
    if (typeof repo.allow_merge_commit !== 'boolean') {
        if (check)
            return { merge_enabled: null, note: 'Public inspection cannot verify the merge commit setting.' };
        throw new ProtectionError(
            'GitHub hid the merge commit setting. Repository Administration write access is required.',
        );
    }
    if (repo.allow_merge_commit) return { merge_enabled: true };
    if (check)
        return { merge_enabled: false, note: 'Merge commits will be enabled when this plan is applied.' };
    let updated = await client.request('PATCH', `/repos/${repository}`, { allow_merge_commit: true });
    for (let attempt = 0; attempt < 2; attempt++) {
        const identity = repositoryIdentity(updated, config);
        if (identity.repository !== repository || identity.action) {
            throw new ProtectionError(
                'The repository is no longer eligible after updating its merge commit setting.',
            );
        }
        if (updated.allow_merge_commit === true) {
            return { merge_enabled: true, merge_changed: true, note: 'Merge commits enabled.' };
        }
        if (attempt === 0) updated = await client.request('GET', `/repos/${repository}`);
    }
    throw new ProtectionError('GitHub did not confirm that merge commits are enabled.');
}

async function managesCallerRelease(client, repository, policies) {
    if (policies.some((policy) => policy.validated_releases === true)) return true;
    if (!policies.some((policy) => policy.release_workflow === true)) return false;
    if (/^Kraftink-CMS\/(?:Plugin|Theme|Game)-[A-Za-z0-9_.-]+$/i.test(repository)) return true;
    const { managedReleaseOptIn } = await import('./provision-release-workflow.mjs');
    return Boolean(await managedReleaseOptIn({ client, repository }));
}

async function allowCallerPullRequests({ client, repository, config, check }) {
    const path = `/repos/${repository}/actions/permissions/workflow`;
    const current = await client.request('GET', path);
    if (!current || !['read', 'write'].includes(current.default_workflow_permissions)
            || typeof current.can_approve_pull_request_reviews !== 'boolean')
        throw new ProtectionError('The repository workflow permissions are invalid.');
    if (current.can_approve_pull_request_reviews) return 'unchanged';
    if (check) return 'planned';
    const metadata = await client.request('GET', `/repos/${repository}`);
    const latest = repositoryIdentity(metadata, config);
    if (latest.repository !== repository || latest.action || metadata.fork !== false)
        throw new ProtectionError('The repository is no longer eligible for its release workflow permissions.');
    await client.request('PUT', path, { can_approve_pull_request_reviews: true }, 204);
    const confirmed = await client.request('GET', path);
    if (confirmed?.can_approve_pull_request_reviews !== true
            || confirmed.default_workflow_permissions !== current.default_workflow_permissions)
        throw new ProtectionError('GitHub did not confirm pull request creation without changing default workflow permissions.');
    return 'configured';
}

export async function protectRepositories({ config, client, appId, check = false, wait = pause }) {
    config = validateConfiguration(config, { appId, requireBindings: !check });
    if (!check && client.authenticated !== true) {
        throw new ProtectionError(
            'Authenticated repository administration access is required to apply protection.',
        );
    }
    const repositories = await inventory(client, `/orgs/${config.organization}/repos?type=public`);
    const results = [];
    const seen = new Set();
    for (const repo of repositories) {
        let name = 'Invalid repository';
        let merge = {};
        try {
            const identity = repositoryIdentity(repo, config);
            name = identity.repository;
            if (identity.action) {
                results.push({ ...identity, confirmed: false });
                continue;
            }
            if (seen.has(name.toLowerCase())) {
                throw new ProtectionError('The repository inventory contains a duplicate identity.');
            }
            seen.add(name.toLowerCase());
            const selected = selectPolicies(config, repo.name);
            if (!selected.some((policy) => policy.rulesets.length)) {
                results.push({
                    repository: name,
                    action: 'skipped',
                    confirmed: false,
                    note: 'No repository rulesets match this repository.',
                });
                continue;
            }
            const metadata = await client.request('GET', `/repos/${name}`);
            const fresh = repositoryIdentity(metadata, config);
            if (fresh.repository !== name || fresh.action) {
                results.push({
                    ...fresh,
                    action: fresh.action ?? 'skipped',
                    confirmed: false,
                    note: 'Repository eligibility changed before reconciliation.',
                });
                continue;
            }
            if (await emptyRepository(client, name, metadata)) {
                results.push({ repository: name, action: 'skipped', confirmed: false,
                    note: 'Waiting for the first commit. No repository settings or files are created.' });
                continue;
            }
            const callerRelease = metadata.fork === false && await managesCallerRelease(client, name, selected);
            if (callerRelease)
                merge.workflow_permissions = await allowCallerPullRequests({ client, repository: name, config, check });
            const entries = await inventory(client, `/repos/${name}/rulesets?includes_parents=false`);
            const plans = [];
            if (callerRelease || entries.some((ruleset) => ruleset.name === 'Validate dev changes')) {
                const apps = selected.flatMap((policy) => policy.rulesets)
                    .filter((ruleset) => ruleset.name === 'App-only master merges')
                    .flatMap((ruleset) => ruleset.bypass_actors)
                    .filter((actor) => actor.actor_type === 'Integration')
                    .map((actor) => ({ ...actor, bypass_mode: 'always' }));
                plans.push(await planRuleset({ client, repository: name, check, entries,
                    policy: 'development-checks', desired: {
                        name: 'Validate dev changes', target: 'branch', enforcement: callerRelease ? 'active' : 'disabled',
                        bypass_actors: [
                            { actor_id: 2, actor_type: 'RepositoryRole', bypass_mode: 'always' },
                            { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' },
                            ...apps,
                        ],
                        conditions: { ref_name: { include: ['refs/heads/dev'], exclude: [] } },
                        rules: [{ type: 'required_status_checks', parameters: {
                            strict_required_status_checks_policy: true,
                            do_not_enforce_on_create: true,
                            required_status_checks: [{ context: 'checks / Validate changes', integration_id: 15368 }],
                        } }],
                    } }));
            }
            for (const policy of selected)
                for (const configured of policy.rulesets) {
                    let desired = configured;
                    if (policy.id === 'automated-promotions' && configured.name === 'App-only master merges')
                        desired = callerRelease
                            ? { ...configured, name: 'Validated master releases',
                                previous_names: [configured.name, ...(configured.previous_names ?? [])],
                                rules: [{ type: 'required_status_checks', parameters: {
                                    strict_required_status_checks_policy: false,
                                    do_not_enforce_on_create: false,
                                    required_status_checks: [{ context: 'Release validated source', integration_id: 15368 }],
                                } }] }
                            : { ...configured, previous_names: [...(configured.previous_names ?? []), 'Validated master releases'] };
                    plans.push(
                        await planRuleset({
                            client,
                            repository: name,
                            desired,
                            check,
                            policy: policy.id,
                            entries,
                        }),
                    );
                }
            const needsMerge = plans.some(
                ({ desired }) =>
                    desired.enforcement === 'active' &&
                    desired.rules.some(
                        (rule) =>
                            rule.type === 'pull_request' &&
                            rule.parameters?.allowed_merge_methods?.includes('merge'),
                    ),
            );
            if (check && needsMerge)
                merge = await prepareMergeMethod({ client, repo: metadata, repository: name, config, check });
            for (const plan of plans) {
                try {
                    if (!check) {
                        const latest = await client.request('GET', `/repos/${name}`);
                        const eligible = repositoryIdentity(latest, config);
                        if (eligible.repository !== name || eligible.action)
                            throw new ProtectionError(
                                'The repository is no longer eligible immediately before applying protection.',
                            );
                        if (needsMerge)
                            merge = {
                                ...merge,
                                ...(await prepareMergeMethod({
                                    client,
                                    repo: latest,
                                    repository: name,
                                    config,
                                    check,
                                })),
                            };
                    }
                    const protection = await reconcileRuleset({ client, plan, check, wait });
                    const notes = [merge.note, protection.note].filter(Boolean);
                    results.push({
                        ...merge,
                        ...protection,
                        confirmed: protection.confirmed && (!needsMerge || merge.merge_enabled === true),
                        ...(notes.length ? { note: notes.join(' ') } : {}),
                    });
                } catch (error) {
                    results.push({
                        repository: name,
                        policy: plan.policy,
                        ruleset: plan.ruleset,
                        action: 'failed',
                        confirmed: false,
                        ...merge,
                        error:
                            error instanceof ProtectionError
                                ? error.message
                                : 'The GitHub repository operation failed.',
                    });
                }
            }
        } catch (error) {
            results.push({
                repository: name,
                action: 'failed',
                confirmed: false,
                ...merge,
                error:
                    error instanceof ProtectionError
                        ? error.message
                        : 'The GitHub repository operation failed.',
            });
        }
    }
    return { check, results, failed: results.filter((result) => result.action === 'failed').length };
}

export function summaryMarkdown(report) {
    const lines = [
        report.check ? 'Repository protection plan (read only).' : 'Repository protection reconciliation.',
        '',
        '| Repository | Profile and ruleset | Action | Verification |',
        '| --- | --- | --- | --- |',
    ];
    for (const result of report.results) {
        const detail =
            result.error ??
            ([result.confirmed ? 'Ruleset and literal branch policy verified.' : null, result.note]
                .filter(Boolean)
                .join(' ') ||
                'Planned.');
        const escape = (value) =>
            value
                .replaceAll('&', '&amp;')
                .replaceAll('<', '&lt;')
                .replaceAll('>', '&gt;')
                .replaceAll('|', '\\|')
                .replaceAll(/[\r\n]/g, ' ');
        lines.push(
            `| ${result.repository} | ${escape([result.policy, result.ruleset].filter(Boolean).join(' / '))} | ${result.action} | ${escape(detail)} |`,
        );
    }
    lines.push('', `${report.failed} repository operation(s) failed.`, '');
    return lines.join('\n');
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
        throw new ProtectionError('Usage: protect-repositories.mjs [--check]');
    }
    if (args[0] !== '--check') {
        throw new ProtectionError(
            'Apply repository policies through the central GitHub App governance workflow. Use --check for a public read-only plan.',
        );
    }
    const bytes = await readFile(new URL('../../.github/repository-protection.json', import.meta.url));
    if (bytes.length > 262144)
        throw new ProtectionError('The repository protection configuration is too large.');
    let config;
    try {
        config = JSON.parse(bytes.toString('utf8'));
    } catch {
        throw new ProtectionError('The repository protection configuration is invalid JSON.');
    }
    const report = await protectRepositories({
        config,
        check: true,
        appId: process.env.KRAFTINK_AUTOMATION_APP_ID,
        client: createGitHubClient(),
    });
    const summary = summaryMarkdown(report);
    process.stdout.write(summary);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
    if (report.failed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(async (error) => {
        const message =
            error instanceof ProtectionError
                ? error.message
                : 'Repository protection could not be completed.';
        process.stderr.write(`${message}\n`);
        if (process.env.GITHUB_STEP_SUMMARY) {
            await appendFile(process.env.GITHUB_STEP_SUMMARY, `Repository protection failed: ${message}\n`);
        }
        process.exitCode = 1;
    });
}
