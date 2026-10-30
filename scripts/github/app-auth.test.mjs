import assert from 'node:assert/strict';
import { constants, generateKeyPairSync, verify } from 'node:crypto';
import test from 'node:test';
import { AppAuthError, createAppClient } from './app-auth.mjs';

const timestamp = Date.parse('2026-10-27T14:00:00.789Z');
const appId = 123456;
const installationId = 98765;
const appSlug = 'kraftink-automation';
const requiredPermissions = {
    administration: 'write',
    contents: 'write',
    workflows: 'write',
    pull_requests: 'write',
    actions: 'read',
};
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKey = keys.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const environment = { KRAFTINK_AUTOMATION_APP_ID: String(appId), KRAFTINK_AUTOMATION_PRIVATE_KEY: privateKey };
const credential = 'ghs_123456_fixture.jwt.signature';

function installation(changes = {}) {
    return {
        id: installationId,
        app_id: appId,
        account: { login: 'Kraftink-CMS', type: 'Organization' },
        target_type: 'Organization',
        suspended_at: null,
        repository_selection: 'all',
        permissions: { ...requiredPermissions, metadata: 'read' },
        ...changes,
    };
}

function fixture({ app, pages, access, intercept, now = () => timestamp } = {}) {
    const calls = [];
    const options = {
        environment,
        now,
        transport: async (url, request) => {
            const target = new URL(url);
            const call = {
                url,
                path: target.pathname,
                query: target.searchParams,
                request,
                body: request.body === undefined ? undefined : JSON.parse(request.body),
            };
            calls.push(call);
            assert.equal(target.origin, 'https://api.github.com');
            assert.equal(target.hash, '');
            assert.equal(request.redirect, 'error');
            assert.equal(request.headers.Accept, 'application/vnd.github+json');
            assert.equal(request.headers['X-GitHub-Api-Version'], '2022-11-28');
            assert.ok(request.signal instanceof AbortSignal);
            const result = await intercept?.(call, calls);
            if (result !== undefined) return result;
            if (target.pathname === '/app') {
                assert.equal(request.method, 'GET');
                assert.equal(call.body, undefined);
                return Response.json(app ?? { id: appId, slug: appSlug, permissions: { ...requiredPermissions } });
            }
            if (target.pathname === '/app/installations') {
                assert.equal(request.method, 'GET');
                assert.equal(target.searchParams.get('per_page'), '100');
                const page = Number(target.searchParams.get('page'));
                return Response.json(pages?.[page - 1] ?? (page === 1 && !pages ? [installation()] : []));
            }
            assert.equal(target.pathname, `/app/installations/${installationId}/access_tokens`);
            assert.equal(request.method, 'POST');
            return Response.json(
                access ?? {
                    token: credential,
                    expires_at: '2026-10-27T15:00:00Z',
                    permissions: { ...requiredPermissions, metadata: 'read' },
                    repository_selection: 'all',
                },
                { status: 201 },
            );
        },
    };
    return { options, calls };
}

test('authenticates the exact App and all-repository organization installation with a verified short RS256 JWT', async (context) => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const timeouts = [];
    context.mock.method(AbortSignal, 'timeout', (duration) => {
        timeouts.push(duration);
        return timeout(duration);
    });
    const { options, calls } = fixture();
    const result = await createAppClient(options);
    assert.deepEqual(result, {
        token: credential,
        appId,
        appSlug,
        installationId,
        expiresAt: '2026-10-27T15:00:00Z',
    });
    assert.equal(calls.length, 3);
    assert.deepEqual(timeouts, [20000, 20000, 20000]);
    const authorization = calls[0].request.headers.Authorization;
    assert.ok(authorization.startsWith('Bearer '));
    const jwt = authorization.slice('Bearer '.length);
    assert.ok(calls.every((call) => call.request.headers.Authorization === authorization));
    const [header, payload, signature] = jwt.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(payload, 'base64url'));
    const seconds = Math.floor(timestamp / 1000);
    assert.deepEqual(claims, { iat: seconds - 60, exp: seconds + 540, iss: appId });
    assert.equal(claims.exp - claims.iat, 600);
    assert.equal(
        verify(
            'RSA-SHA256',
            Buffer.from(`${header}.${payload}`),
            { key: keys.publicKey, padding: constants.RSA_PKCS1_PADDING },
            Buffer.from(signature, 'base64url'),
        ),
        true,
    );
    assert.deepEqual(calls[2].body, { permissions: requiredPermissions });
    assert.deepEqual(Object.keys(calls[2].body), ['permissions']);
});

test('finds the exact organization on later pages without limiting current or future repository access', async () => {
    const unrelated = Array.from({ length: 100 }, (_, index) =>
        installation({ id: index + 1, account: { login: `unrelated-${index}`, type: 'Organization' } }),
    );
    const { options, calls } = fixture({ pages: [unrelated, [installation()]] });
    const result = await createAppClient(options);
    assert.equal(result.installationId, installationId);
    assert.deepEqual(
        calls.filter((call) => call.path === '/app/installations').map((call) => call.query.get('page')),
        ['1', '2'],
    );
    const tokenRequest = calls.find((call) => call.request.method === 'POST');
    assert.equal(tokenRequest.body.repositories, undefined);
    assert.equal(tokenRequest.body.repository_ids, undefined);
});

test('supports PKCS8 RSA keys and case-insensitive exact organization logins', async () => {
    const { options } = fixture({
        pages: [[installation({ account: { login: 'KRAFTINK-cms', type: 'Organization' } })]],
    });
    options.environment = {
        ...environment,
        KRAFTINK_AUTOMATION_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    };
    assert.equal((await createAppClient(options)).appId, appId);
});

test('rejects missing, malformed or unsafe App credentials before any network request', async (context) => {
    for (const changes of [
        { KRAFTINK_AUTOMATION_APP_ID: undefined },
        { KRAFTINK_AUTOMATION_APP_ID: '0' },
        { KRAFTINK_AUTOMATION_APP_ID: '0123' },
        { KRAFTINK_AUTOMATION_APP_ID: '123\n' },
        { KRAFTINK_AUTOMATION_APP_ID: '9007199254740992' },
        { KRAFTINK_AUTOMATION_APP_ID: 'github-client-id' },
        { KRAFTINK_AUTOMATION_PRIVATE_KEY: undefined },
        { KRAFTINK_AUTOMATION_PRIVATE_KEY: '' },
        { KRAFTINK_AUTOMATION_PRIVATE_KEY: 'private-secret-invalid-key' },
        { KRAFTINK_AUTOMATION_PRIVATE_KEY: 'x'.repeat(65537) },
    ]) {
        await context.test(JSON.stringify(Object.keys(changes)), async () => {
            const { options, calls } = fixture();
            options.environment = { ...environment, ...changes };
            await assert.rejects(createAppClient(options), (error) => {
                assert.ok(!error.message.includes('private-secret-invalid-key'));
                assert.ok(!error.message.includes(privateKey));
                return true;
            });
            assert.equal(calls.length, 0);
        });
    }
});

test('refuses non-RSA signing keys', async () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const { options, calls } = fixture();
    options.environment = {
        ...environment,
        KRAFTINK_AUTOMATION_PRIVATE_KEY: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    };
    await assert.rejects(createAppClient(options), /RSA private key/);
    assert.equal(calls.length, 0);
});

test('checks the authenticated App ID and every required permission before choosing an installation', async (context) => {
    const invalid = [
        { id: appId + 1, slug: appSlug, permissions: requiredPermissions },
        { id: appId, slug: appSlug, permissions: null },
        { id: appId, slug: 'Invalid-Slug', permissions: requiredPermissions },
        { id: appId, slug: '../other-app', permissions: requiredPermissions },
        { id: appId, permissions: requiredPermissions },
    ];
    for (const permission of Object.keys(requiredPermissions)) {
        invalid.push({ id: appId, slug: appSlug, permissions: { ...requiredPermissions, [permission]: 'none' } });
    }
    for (const app of invalid) {
        await context.test(JSON.stringify(app), async () => {
            const { options, calls } = fixture({ app });
            await assert.rejects(createAppClient(options), (error) => {
                assert.ok(error instanceof AppAuthError);
                if (app.id !== appId) assert.match(error.message, /App ID does not match/);
                else if (typeof app.slug !== 'string' || !/^[a-z0-9-]+$/.test(app.slug))
                    assert.match(error.message, /invalid authenticated App slug/);
                else {
                    assert.match(error.message, /missing required repository permissions/);
                    for (const name of Object.keys(requiredPermissions).filter(
                        (key) => !app.permissions || app.permissions[key] !== requiredPermissions[key],
                    )) {
                        assert.ok(error.message.includes(name));
                    }
                }
                return true;
            });
            assert.equal(calls.length, 1);
        });
    }
});

test('rejects selected repositories, suspended installs, users and similarly named organizations', async (context) => {
    for (const changes of [
        { repository_selection: 'selected' },
        { suspended_at: '2026-10-27T10:00:00Z' },
        { suspended_at: undefined },
        { account: { login: 'Kraftink-CMS', type: 'User' } },
        { target_type: 'User' },
        { account: { login: 'Kraftink-CMS-other', type: 'Organization' } },
        { account: { login: 'other/Kraftink-CMS', type: 'Organization' } },
        { account: { login: 123, type: 'Organization' } },
    ]) {
        await context.test(JSON.stringify(changes), async () => {
            const { options, calls } = fixture({ pages: [[installation(changes)]] });
            await assert.rejects(createAppClient(options), /all current and future Kraftink-CMS repositories/);
            assert.ok(calls.every((call) => call.request.method === 'GET'));
        });
    }
});

test('requires exactly one eligible installation and validates its identifier and approved permissions', async (context) => {
    for (const entries of [
        [],
        [installation(), installation({ id: installationId + 1 })],
        [installation({ id: '../other' })],
        [installation({ app_id: appId + 1 })],
        [installation({ permissions: { ...requiredPermissions, administration: 'read' } })],
    ]) {
        await context.test(String(entries.length), async () => {
            const { options, calls } = fixture({ pages: [entries] });
            await assert.rejects(createAppClient(options));
            assert.ok(calls.every((call) => call.request.method === 'GET'));
        });
    }
});

test('accepts a read permission covered by write and optional all-repository token metadata', async () => {
    const { options } = fixture({
        app: { id: appId, slug: appSlug, permissions: { ...requiredPermissions, actions: 'write' } },
        access: {
            token: credential,
            expires_at: '2026-10-27T14:05:00.123Z',
            permissions: { ...requiredPermissions, actions: 'write' },
        },
    });
    assert.equal((await createAppClient(options)).token, credential);
});

test('preserves opaque installation tokens of current and larger lengths without decoding or truncation', async () => {
    for (const length of [520, 1024]) {
        const prefix = `ghs_${appId}_`;
        const token = prefix + 'opaque.jwt-data.signature.'.repeat(100).slice(0, length - prefix.length);
        assert.equal(token.length, length);
        const { options } = fixture({
            access: {
                token,
                expires_at: '2026-10-27T15:00:00Z',
                permissions: requiredPermissions,
                repository_selection: 'all',
            },
        });
        assert.equal((await createAppClient(options)).token, token);
    }
});

test('approved installation permissions and minted token permissions have distinct safe setup diagnostics', async () => {
    const unapproved = fixture({
        pages: [
            [
                installation({
                    permissions: {
                        ...requiredPermissions,
                        workflows: 'read',
                        actions: undefined,
                        secret_permission_name: 'must-not-appear',
                    },
                }),
            ],
        ],
    });
    await assert.rejects(createAppClient(unapproved.options), (error) => {
        assert.ok(error instanceof AppAuthError);
        assert.match(error.message, /installation is missing approved repository permissions: workflows, actions/);
        assert.match(error.message, /Approve the updated permissions/);
        assert.equal(error.message.includes('secret_permission_name'), false);
        assert.equal(error.message.includes('must-not-appear'), false);
        return true;
    });
    assert.equal(
        unapproved.calls.some((call) => call.request.method === 'POST'),
        false,
    );
    const insufficient = fixture({
        access: {
            token: credential,
            expires_at: '2026-10-27T15:00:00Z',
            permissions: { ...requiredPermissions, workflows: ['write'] },
        },
    });
    await assert.rejects(createAppClient(insufficient.options), (error) => {
        assert.ok(error instanceof AppAuthError);
        assert.match(error.message, /installation token is missing required repository permissions: workflows/);
        assert.equal(error.message.includes(credential), false);
        return true;
    });
});

test('safe authentication HTTP diagnostics identify the fixed endpoint and status without reflecting response data', async () => {
    for (const [method, path, status] of [
        ['GET', '/app', 401],
        ['GET', '/app/installations', 403],
        ['POST', `/app/installations/${installationId}/access_tokens`, 422],
    ]) {
        const { options } = fixture({
            intercept: (call) =>
                call.path === path && call.request.method === method
                    ? new Response(`private-response-${credential}`, {
                          status,
                          headers: { 'x-private': privateKey.split('\n')[1] },
                      })
                    : undefined,
        });
        await assert.rejects(createAppClient(options), (error) => {
            assert.ok(error instanceof AppAuthError);
            assert.equal(error.status, status);
            assert.equal(error.message, `GitHub App ${method} ${path} request failed with status ${status}.`);
            assert.equal(String(error.stack).includes(credential), false);
            assert.equal(String(error.stack).includes(privateKey.split('\n')[1]), false);
            assert.equal(error.cause, undefined);
            return true;
        });
    }
});

test('an App registered but never installed reports the required organization installation without minting a token', async () => {
    const { options, calls } = fixture({ pages: [[]] });
    await assert.rejects(createAppClient(options), (error) => {
        assert.ok(error instanceof AppAuthError);
        assert.match(error.message, /Install the GitHub App once on all current and future Kraftink-CMS repositories/);
        return true;
    });
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.request.method === 'GET'));
});

test('rejects expired, unsafe, partially scoped or insufficient installation tokens', async (context) => {
    const access = {
        token: credential,
        expires_at: '2026-10-27T15:00:00Z',
        permissions: { ...requiredPermissions },
        repository_selection: 'all',
    };
    for (const changes of [
        { token: '' },
        { token: 'private-token\nunsafe' },
        { token: ' private-token' },
        { expires_at: '2026-10-27T14:00:00Z' },
        { expires_at: 'not a time' },
        { expires_at: undefined },
        { repository_selection: 'selected' },
        { repository_selection: null },
        { permissions: { ...requiredPermissions, contents: 'read' } },
        { permissions: { ...requiredPermissions, workflows: 'read' } },
        { permissions: { ...requiredPermissions, pull_requests: 'read' } },
        { permissions: { ...requiredPermissions, actions: undefined } },
    ]) {
        await context.test(JSON.stringify(changes), async () => {
            const { options } = fixture({ access: { ...access, ...changes } });
            await assert.rejects(createAppClient(options), (error) => {
                assert.ok(error instanceof AppAuthError);
                assert.match(
                    error.message,
                    changes.permissions
                        ? /missing required repository permissions/
                        : /invalid, expired or insufficient installation token/,
                );
                assert.ok(!error.message.includes('private-token'));
                return true;
            });
        });
    }
});

test('checks token expiry using the time after the API requests complete', async () => {
    let current = timestamp;
    const { options } = fixture({
        now: () => current,
        intercept: (call) => {
            if (call.request.method !== 'POST') return;
            current += 120000;
            return Response.json(
                {
                    token: credential,
                    expires_at: '2026-10-27T14:01:00Z',
                    permissions: requiredPermissions,
                },
                { status: 201 },
            );
        },
    });
    await assert.rejects(createAppClient(options), /expired/);
});

test('refuses to keep using an expired JWT during a slow inventory', async () => {
    let current = timestamp;
    const { options, calls } = fixture({
        now: () => current,
        intercept: (call) => {
            if (call.path === '/app/installations') {
                current += 600000;
                return Response.json([installation()]);
            }
        },
    });
    await assert.rejects(createAppClient(options), /authentication expired/);
    assert.equal(calls.length, 2);
});

test('neutralizes network errors, HTTP bodies and body-stream failures that contain credentials', async (context) => {
    const secret = 'must-not-appear-in-error';
    for (const failure of ['network', 'http', 'stream']) {
        await context.test(failure, async () => {
            const { options } = fixture({
                intercept: () => {
                    if (failure === 'network') throw new Error(`${secret} ${privateKey}`);
                    if (failure === 'http') return new Response(secret, { status: 401 });
                    return new Response(
                        new ReadableStream({
                            start(controller) {
                                controller.error(new Error(secret));
                            },
                        }),
                    );
                },
            });
            await assert.rejects(createAppClient(options), (error) => {
                assert.ok(!String(error.stack).includes(secret));
                assert.ok(!String(error.stack).includes(privateKey));
                assert.equal(error.cause, undefined);
                if (failure === 'http') assert.equal(error.status, 401);
                return true;
            });
        });
    }
});

test('rejects oversized authentication JSON from declared size or streamed bytes', async (context) => {
    for (const declared of [true, false]) {
        await context.test(String(declared), async () => {
            const { options } = fixture({
                intercept: () =>
                    declared
                        ? new Response('{}', { headers: { 'content-length': '8388609' } })
                        : new Response('x'.repeat(8388609)),
            });
            await assert.rejects(createAppClient(options), /size limit/);
        });
    }
});

test('rejects malformed JSON and invalid or unbounded installation inventories', async (context) => {
    for (const invalid of ['json', 'object', 'large-page', 'endless']) {
        await context.test(invalid, async () => {
            const { options, calls } = fixture({
                intercept: (call) => {
                    if (invalid === 'json') return new Response('private-invalid-json');
                    if (call.path !== '/app/installations') return;
                    if (invalid === 'object') return Response.json({ installations: [installation()] });
                    const count = invalid === 'large-page' ? 101 : 100;
                    return Response.json(Array.from({ length: count }, () => installation()));
                },
            });
            await assert.rejects(createAppClient(options), /JSON|inventory/);
            assert.ok(calls.length <= 101);
            assert.ok(calls.every((call) => call.request.method === 'GET'));
        });
    }
});

test('validates an injectable millisecond clock and neutralizes clock failures', async (context) => {
    for (const now of [
        () => NaN,
        () => -1,
        () => '2026-10-27',
        () => timestamp + 0.5,
        () => {
            throw new Error(credential);
        },
    ]) {
        await context.test(String(now), async () => {
            const { options, calls } = fixture({ now });
            await assert.rejects(createAppClient(options), (error) => {
                assert.match(error.message, /clock/);
                assert.ok(!error.message.includes(credential));
                return true;
            });
            assert.equal(calls.length, 0);
        });
    }
});
