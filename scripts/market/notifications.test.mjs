import assert from 'node:assert/strict';
import test from 'node:test';
import { MarketNotificationError, notifyMarketRelease, refreshSiteCache } from './notifications.mjs';

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

test('cache refresh recovers from a transient failure using the scheduled retry delays', async () => {
    let calls = 0;
    const waits = [];
    assert.deepEqual(await refreshSiteCache({ commit, secret, wait: async (delay) => waits.push(delay), transport: async () => {
        calls++;
        return calls < 3
            ? Response.json({ error: { code: 'catalogue_upstream_unavailable' } }, { status: 503 })
            : Response.json({ ok: true, commit });
    } }), { refreshed: true, commit });
    assert.equal(calls, 3);
    assert.deepEqual(waits, [5000, 15000]);
});

test('cache refresh reports exhausted transient HTTP failures without rejecting the published catalogue', async (t) => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
        await t.test(`HTTP ${status}`, async () => {
            let calls = 0;
            const waits = [];
            const result = await refreshSiteCache({ commit, secret, wait: async (delay) => waits.push(delay), transport: async () => {
                calls++;
                return Response.json({ error: { code: 'catalogue_upstream_unavailable', message: secret } }, { status });
            } });
            assert.deepEqual(result, { refreshed: false, commit, status, code: 'catalogue_upstream_unavailable' });
            assert.equal(calls, 3);
            assert.deepEqual(waits, [5000, 15000]);
            assert(!JSON.stringify(result).includes(secret));
        });
    }
});

test('cache refresh keeps authentication and permanent HTTP failures fatal', async (t) => {
    for (const status of [401, 403, 404, 422]) {
        await t.test(`HTTP ${status}`, async () => {
            let calls = 0;
            await assert.rejects(refreshSiteCache({ commit, secret, wait: async () => assert.fail('Permanent failures must not wait'), transport: async () => {
                calls++;
                return Response.json({ error: { code: 'authentication_required', message: secret } }, { status });
            } }), (error) => error instanceof MarketNotificationError && error.message.includes(`HTTP ${status}`)
                && error.message.includes('authentication_required') && !error.message.includes(secret));
            assert.equal(calls, 1);
        });
    }
});

test('cache refresh treats unavailable configuration as fatal even when the Worker returns HTTP 503', async (t) => {
    for (const code of ['cache_refresh_unavailable', 'catalogue_source_unavailable']) {
        await t.test(code, async () => {
            let calls = 0;
            await assert.rejects(refreshSiteCache({ commit, secret, wait: async () => assert.fail('Configuration failures must not wait'), transport: async () => {
                calls++;
                return Response.json({ error: { code, message: secret } }, { status: 503 });
            } }), (error) => error instanceof MarketNotificationError && error.message.includes(code) && !error.message.includes(secret));
            assert.equal(calls, 1);
        });
    }
});

test('cache refresh never accepts an invalid successful acknowledgement', async (t) => {
    for (const body of [JSON.stringify({ ok: true, commit: 'c'.repeat(40) }), JSON.stringify({ ok: false, commit }),
        JSON.stringify({ ok: true }), JSON.stringify({ ok: true, commit, extra: 'x'.repeat(4096) }), '{invalid JSON']) {
        await t.test(body.slice(0, 80), async () => {
            let calls = 0;
            await assert.rejects(refreshSiteCache({ commit, secret, wait: async () => assert.fail('An invalid acknowledgement must not wait'), transport: async () => {
                calls++;
                return new Response(body, { status: 200 });
            } }), (error) => error instanceof MarketNotificationError && /invalid acknowledgement/.test(error.message)
                && !error.message.includes(secret));
            assert.equal(calls, 1);
        });
    }
});

test('cache refresh validates configuration before making any request', async () => {
    const transport = async () => assert.fail('Invalid configuration must not make requests');
    await assert.rejects(refreshSiteCache({ commit: '../../wrong', secret, transport }), /verified Market commit/);
    await assert.rejects(refreshSiteCache({ commit, secret: 'short', transport }), /KRAFTINK_SITE_CACHE_SECRET/);
});

test('cache refresh exposes only safe diagnostic codes and never logs upstream bodies or network errors', async (t) => {
    const logs = [];
    for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, (...values) => logs.push(values.join(' ')));
    const privateMessage = `Never expose ${secret} or ${token}`;
    const scenarios = [
        { code: 'network_error', status: null, transport: async () => { throw new Error(privateMessage); } },
        { code: 'http_error', status: 503, transport: async () => Response.json({ error: { code: privateMessage, message: privateMessage } }, { status: 503 }) },
        { code: 'http_error', status: 503, transport: async () => new Response(`<html>${privateMessage}</html>`, { status: 503 }) },
        { code: 'http_error', status: 503, transport: async () => new Response(privateMessage.repeat(100), { status: 503 }) },
        { code: 'http_error', status: 503, transport: async () => new Response(new ReadableStream({
            start(controller) { controller.error(new Error(privateMessage)); },
        }), { status: 503 }) },
        { code: 'catalogue_refresh_conflict', status: 503, transport: async () => Response.json({ error: { code: 'catalogue_refresh_conflict', message: privateMessage } }, { status: 503 }) },
    ];
    for (const scenario of scenarios) {
        const result = await refreshSiteCache({ commit, secret, transport: scenario.transport, wait: async () => {} });
        assert.deepEqual(result, { refreshed: false, commit, status: scenario.status, code: scenario.code });
        assert(!JSON.stringify(result).includes(secret));
        assert(!JSON.stringify(result).includes(token));
    }
    assert(logs.every((message) => !message.includes(secret) && !message.includes(token)));
});

test('cache refresh respects Retry-After seconds without waiting less than its normal delay', async (t) => {
    for (const [header, delay] of [['1', 5000], ['10', 10000], ['60', 60000]]) {
        await t.test(`Retry-After ${header}`, async () => {
            let calls = 0;
            const waits = [];
            const result = await refreshSiteCache({ commit, secret, wait: async (value) => waits.push(value), transport: async () => {
                calls++;
                return calls === 1
                    ? Response.json({ error: { code: 'service_unavailable' } }, { status: 429, headers: { 'Retry-After': header } })
                    : Response.json({ ok: true, commit });
            } });
            assert.deepEqual(result, { refreshed: true, commit });
            assert.deepEqual(waits, [delay]);
            assert.equal(calls, 2);
        });
    }
});

test('cache refresh respects an HTTP-date Retry-After header', async (t) => {
    const timestamp = Date.parse('2026-10-31T05:40:00Z');
    t.mock.method(Date, 'now', () => timestamp);
    const waits = [];
    let calls = 0;
    const result = await refreshSiteCache({ commit, secret, wait: async (delay) => waits.push(delay), transport: async () => {
        calls++;
        return calls === 1
            ? new Response('', { status: 503, headers: { 'Retry-After': new Date(timestamp + 30000).toUTCString() } })
            : Response.json({ ok: true, commit });
    } });
    assert.deepEqual(result, { refreshed: true, commit });
    assert.deepEqual(waits, [30000]);
});

test('cache refresh defers a rate limit longer than sixty seconds to the next cron without retrying early', async () => {
    let calls = 0;
    const result = await refreshSiteCache({ commit, secret, wait: async () => assert.fail('A long rate limit must not hold the job open'), transport: async () => {
        calls++;
        return Response.json({ error: { code: 'catalogue_upstream_unavailable' } }, { status: 429, headers: { 'Retry-After': '61' } });
    } });
    assert.equal(calls, 1);
    assert.deepEqual(result, { refreshed: false, commit, status: 429, code: 'catalogue_upstream_unavailable' });
});
