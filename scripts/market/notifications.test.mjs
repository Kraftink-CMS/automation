import assert from 'node:assert/strict';
import test from 'node:test';
import { notifyMarketRelease, refreshSiteCache } from './notifications.mjs';

const repository = 'Kraftink-CMS/Plugin-Example';
const token = 'private-refresh-token';
const commit = 'a'.repeat(40);
const secret = 'b'.repeat(64);

function fixture({ registered = true, automatic = true, conclusion = 'success', registryStatus = 200, dispatchStatus = 200 } = {}) {
    const calls = [];
    let polls = 0;
    const transport = async (request) => {
        calls.push(request);
        const json = (value, status = 200) => ({ status, body: Buffer.from(JSON.stringify(value)) });
        if (request.method === 'GET' && request.url.includes('/contents/resources.json?ref=dev'))
            return json({ schema_version: 1, repositories: registered ? [{ repository, auto_update: automatic }] : [], resources: [] }, registryStatus);
        if (request.method === 'POST' && request.url.endsWith('/refresh-market.yml/dispatches'))
            return json({ workflow_run_id: 42, html_url: 'https://github.com/Kraftink-CMS/automation/actions/runs/42' }, dispatchStatus);
        if (request.method === 'GET' && request.url.endsWith('/actions/runs/42'))
            return json({ id: 42, path: '.github/workflows/refresh-market.yml', head_branch: 'master', event: 'workflow_dispatch',
                status: polls++ === 0 ? 'in_progress' : 'completed', conclusion });
        throw new Error('Unexpected request');
    };
    return { calls, execute: (options = {}) => notifyMarketRelease({ repository,
        environment: { KRAFTINK_MARKET_REFRESH_TOKEN: token }, transport, wait: async () => {}, ...options }) };
}

test('only registered automatic releases dispatch the central refresh and wait for completion', async () => {
    const data = fixture();
    assert.equal((await data.execute()).action, 'refreshed');
    assert.equal(data.calls.length, 4);
    assert.equal(data.calls[0].headers.Authorization, undefined);
    assert(data.calls.slice(1).every((request) => request.headers.Authorization === `Bearer ${token}`));
    assert.deepEqual(JSON.parse(data.calls[1].body), { ref: 'master', inputs: { scope: 'automatic', repository, dry_run: false } });
});

test('manual and unregistered resources skip without requesting a dispatch credential', async () => {
    for (const options of [{ registered: false }, { automatic: false }]) {
        const data = fixture(options);
        assert.equal((await data.execute({ environment: {} })).action, 'skipped');
        assert.equal(data.calls.length, 1);
    }
});

test('registry, credentials, dispatch and central failures never claim a refreshed catalogue', async () => {
    await assert.rejects(fixture({ registryStatus: 503 }).execute(), /registry could not be checked/);
    await assert.rejects(fixture().execute({ environment: {} }), /KRAFTINK_MARKET_REFRESH_TOKEN/);
    await assert.rejects(fixture({ dispatchStatus: 403 }).execute(), /request failed \(403\)/);
    await assert.rejects(fixture({ conclusion: 'failure' }).execute(), /Market refresh failed/);
});

test('cache refresh posts only the verified commit to the fixed authenticated endpoint', async () => {
    const calls = [];
    const result = await refreshSiteCache({ commit, secret, transport: async (url, options) => {
        calls.push({ url, options });
        return Response.json({ ok: true, commit });
    } });
    assert.deepEqual(result, { refreshed: true, commit });
    assert.equal(calls[0].url, 'https://kraftink.com/api/internal/market/refresh');
    assert.equal(calls[0].options.headers.Authorization, `Bearer ${secret}`);
    assert.equal(calls[0].options.redirect, 'error');
    assert.deepEqual(JSON.parse(calls[0].options.body), { commit });
});

test('cache refresh retries failures and rejects mismatched acknowledgements without leaking its secret', async () => {
    let calls = 0;
    assert.equal((await refreshSiteCache({ commit, secret, wait: async () => {}, transport: async () => {
        calls++;
        return calls === 1 ? new Response('', { status: 503 }) : Response.json({ ok: true, commit });
    } })).refreshed, true);
    assert.equal(calls, 2);
    calls = 0;
    await assert.rejects(refreshSiteCache({ commit, secret, wait: async () => {}, transport: async () => {
        calls++;
        return Response.json({ ok: true, commit: 'c'.repeat(40) });
    } }), (error) => error.message.includes('site cache refresh failed') && !error.message.includes(secret));
    assert.equal(calls, 3);
    await assert.rejects(refreshSiteCache({ commit: '../../wrong', secret }), /verified Market commit/);
    await assert.rejects(refreshSiteCache({ commit, secret: 'short' }), /KRAFTINK_SITE_CACHE_SECRET/);
});
