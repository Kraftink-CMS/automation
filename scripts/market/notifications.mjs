import { appendFile } from 'node:fs/promises';
import { githubTransport } from '../releases/github-client.mjs';
import { repositoryName, sourceResources } from './catalogue.mjs';

const central = 'https://api.github.com/repos/Kraftink-CMS/automation';
const pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'KraftInk-Market',
    'X-GitHub-Api-Version': '2026-03-10',
};
const cacheErrorCodes = new Set([
    'authentication_required', 'invalid_commit', 'cache_refresh_unavailable', 'catalogue_source_unavailable',
    'catalogue_upstream_unavailable', 'catalogue_upstream_invalid', 'catalogue_commit_outdated',
    'catalogue_refresh_failed', 'catalogue_refresh_conflict', 'service_unavailable', 'origin_invalid',
]);

export class MarketNotificationError extends Error {}

export async function notifyMarketRelease({ repository, environment = process.env, transport = githubTransport, wait = pause }) {
    const target = repositoryName(repository);
    const registry = await transport({
        method: 'GET',
        url: 'https://api.github.com/repos/Kraftink-CMS/Market/contents/resources.json?ref=dev',
        headers: { ...headers, Accept: 'application/vnd.github.raw+json' },
        limit: 2097152,
    });
    if (registry.status !== 200) throw new Error('The Market registry could not be checked after publication.');
    const registrations = sourceResources(JSON.parse(registry.body.toString('utf8'))).repositories;
    const registration = registrations.find((entry) => repositoryName(entry.repository).toLowerCase() === target.toLowerCase());
    if (!registration || !registration.auto_update) {
        return { action: 'skipped', reason: registration ? 'automatic_updates_disabled' : 'repository_not_registered' };
    }
    const token = environment.KRAFTINK_MARKET_REFRESH_TOKEN;
    if (typeof token !== 'string' || !token || /[^\x21-\x7e]/.test(token))
        throw new Error('Configure KRAFTINK_MARKET_REFRESH_TOKEN for registered automatic resource releases.');
    const request = async (method, path, body) => {
        const response = await transport({
            method,
            url: central + path,
            headers: { ...headers, Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: Buffer.from(JSON.stringify(body)) } : {}),
            limit: 1048576,
        });
        if (response.status !== 200) throw new Error(`Central Market ${method} request failed (${response.status}).`);
        return JSON.parse(response.body.toString('utf8'));
    };
    const dispatch = await request('POST', '/actions/workflows/refresh-market.yml/dispatches', {
        ref: 'master',
        inputs: { scope: 'automatic', repository: target, dry_run: false },
    });
    const id = dispatch.workflow_run_id;
    if (!Number.isSafeInteger(id) || id < 1 || dispatch.html_url !== `https://github.com/Kraftink-CMS/automation/actions/runs/${id}`)
        throw new Error('GitHub did not identify the central Market refresh run.');
    if (process.env.GITHUB_STEP_SUMMARY)
        await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n[Market catalogue refresh](${dispatch.html_url})\n`);
    for (let attempt = 0; attempt < 90; attempt++) {
        const run = await request('GET', `/actions/runs/${id}`);
        if (run.id !== id || run.head_branch !== 'master' || run.event !== 'workflow_dispatch'
                || run.path !== '.github/workflows/refresh-market.yml')
            throw new Error('The central Market refresh run does not match its dispatch.');
        if (run.status === 'completed') {
            if (run.conclusion !== 'success') throw new Error(`Market refresh failed. Inspect ${dispatch.html_url}.`);
            return { action: 'refreshed', run_id: id, url: dispatch.html_url };
        }
        await wait(10000);
    }
    throw new Error(`Market refresh timed out. Inspect ${dispatch.html_url}.`);
}

export async function refreshSiteCache({ commit, secret, transport = fetch, wait = pause }) {
    if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit))
        throw new MarketNotificationError('A verified Market commit is required to refresh the site cache.');
    if (typeof secret !== 'string' || !/^[a-f0-9]{64}$/.test(secret))
        throw new MarketNotificationError('Configure KRAFTINK_SITE_CACHE_SECRET in the central repository environment.');
    let failure = { status: null, code: 'network_error' };
    for (let attempt = 0; attempt < 3; attempt++) {
        let response;
        try {
            response = await transport('https://kraftink.com/api/internal/market/refresh', {
                method: 'POST',
                headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ commit }),
                redirect: 'error',
                signal: AbortSignal.timeout(15000),
            });
        } catch {
            failure = { status: null, code: 'network_error' };
        }
        let delay = attempt === 0 ? 5000 : 15000;
        if (response) {
            const data = await cacheResponse(response);
            if (response.status === 200) {
                if (data?.ok === true && data.commit === commit) return { refreshed: true, commit };
                throw new MarketNotificationError('The site cache refresh returned an invalid acknowledgement (HTTP 200).');
            }
            failure = {
                status: response.status,
                code: cacheErrorCodes.has(data?.error?.code) ? data.error.code : 'http_error',
            };
            if (![408, 425, 429].includes(response.status) && response.status < 500
                    || ['cache_refresh_unavailable', 'catalogue_source_unavailable'].includes(failure.code))
                throw new MarketNotificationError(`The site cache refresh failed (HTTP ${failure.status}, ${failure.code}). Check its configuration.`);
            const retryAfter = response.headers.get('Retry-After');
            if (retryAfter) {
                const milliseconds = /^\d+$/.test(retryAfter)
                    ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
                if (Number.isFinite(milliseconds)) delay = Math.max(delay, milliseconds);
            }
        }
        if (attempt < 2 && delay <= 60000) await wait(delay);
        else break;
    }
    return { refreshed: false, commit, ...failure };
}

async function cacheResponse(response) {
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks = [];
    let length = 0;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            length += value.length;
            if (length > 4096) {
                await reader.cancel();
                return null;
            }
            chunks.push(value);
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
        }
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return null;
    } finally {
        reader.releaseLock();
    }
}
