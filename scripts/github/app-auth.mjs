import { constants, createPrivateKey, sign } from 'node:crypto';

const organization = 'Kraftink-CMS';
const responseLimit = 8388608;
const requiredPermissions = Object.freeze({
    administration: 'write',
    contents: 'write',
    workflows: 'write',
    pull_requests: 'write',
    actions: 'read',
});
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (value) => Number.isSafeInteger(value) && value > 0;

export class AppAuthError extends Error {}

function currentTime(now) {
    let value;
    try {
        value = now();
    } catch {
        throw new AppAuthError('The authentication clock is unavailable.');
    }
    if (!Number.isSafeInteger(value) || value < 60000 || value > 8640000000000000) {
        throw new AppAuthError('The authentication clock must return a valid Unix time in milliseconds.');
    }
    return value;
}

function missingPermissions(value) {
    const levels = { read: 1, write: 2 };
    return Object.entries(requiredPermissions)
        .filter(
            ([name, level]) =>
                !plainObject(value) || typeof value[name] !== 'string' || !(levels[value[name]] >= levels[level]),
        )
        .map(([name]) => name);
}

function credentials(environment, now) {
    const identifier = environment?.KRAFTINK_AUTOMATION_APP_ID;
    const pem = environment?.KRAFTINK_AUTOMATION_PRIVATE_KEY;
    if (typeof identifier !== 'string' || !/^[1-9]\d*$/.test(identifier) || !validId(Number(identifier))) {
        throw new AppAuthError('KRAFTINK_AUTOMATION_APP_ID must be a positive numeric GitHub App ID.');
    }
    if (typeof pem !== 'string' || !pem.trim() || pem.length > 65536 || pem.includes('\0')) {
        throw new AppAuthError('KRAFTINK_AUTOMATION_PRIVATE_KEY must contain the GitHub App RSA private key.');
    }
    const appId = Number(identifier);
    const seconds = Math.floor(currentTime(now) / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: appId })).toString(
        'base64url',
    );
    const unsigned = `${header}.${payload}`;
    let signature;
    try {
        const key = createPrivateKey(pem);
        if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
            throw new AppAuthError('Invalid RSA private key.');
        }
        signature = sign('RSA-SHA256', Buffer.from(unsigned), {
            key,
            padding: constants.RSA_PKCS1_PADDING,
        }).toString('base64url');
    } catch {
        throw new AppAuthError('The GitHub App RSA private key could not sign the authentication request.');
    }
    return { appId, jwt: `${unsigned}.${signature}`, expires: (seconds + 540) * 1000 };
}

async function discard(response) {
    try {
        await response?.body?.cancel();
    } catch {}
}

async function responseJson(response) {
    try {
        const declared = response.headers.get('content-length');
        if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > responseLimit)) {
            await discard(response);
            throw new AppAuthError('The GitHub App response exceeds its size limit.');
        }
        let size = 0;
        const chunks = [];
        if (response.body) {
            for await (const chunk of response.body) {
                size += chunk.length;
                if (size > responseLimit) {
                    throw new AppAuthError('The GitHub App response exceeds its size limit.');
                }
                chunks.push(Buffer.from(chunk));
            }
        }
        try {
            return JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
            throw new AppAuthError('GitHub returned invalid authentication JSON.');
        }
    } catch (error) {
        if (error instanceof AppAuthError) throw error;
        throw new AppAuthError('The GitHub App response could not be read.');
    }
}

export async function createAppClient({ environment = process.env, transport = fetch, now = Date.now } = {}) {
    const { appId, jwt, expires } = credentials(environment, now);
    const request = async (method, path, body, expected = 200) => {
        const endpoint = `${method} ${path.split('?')[0]}`;
        if (currentTime(now) >= expires) {
            throw new AppAuthError('The GitHub App authentication expired. Restart authentication.');
        }
        let response;
        try {
            response = await transport(`https://api.github.com${path}`, {
                method,
                headers: {
                    Accept: 'application/vnd.github+json',
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${jwt}`,
                    'User-Agent': 'KraftInk-Automation-App',
                    'X-GitHub-Api-Version': '2022-11-28',
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                redirect: 'error',
                signal: AbortSignal.timeout(20000),
            });
        } catch {
            throw new AppAuthError(`The GitHub App authentication request failed at ${endpoint}.`);
        }
        if (!Number.isInteger(response?.status) || response.status < 100 || response.status > 599) {
            await discard(response);
            throw new AppAuthError('GitHub returned an invalid authentication response.');
        }
        if (response.status !== expected) {
            await discard(response);
            const error = new AppAuthError(`GitHub App ${endpoint} request failed with status ${response.status}.`);
            error.status = response.status;
            throw error;
        }
        return responseJson(response);
    };
    const app = await request('GET', '/app');
    if (!plainObject(app) || app.id !== appId) {
        throw new AppAuthError(
            'The authenticated GitHub App ID does not match KRAFTINK_AUTOMATION_APP_ID. Use the numeric App ID, not the installation ID.',
        );
    }
    if (typeof app.slug !== 'string' || !/^[a-z0-9-]+$/.test(app.slug)) {
        throw new AppAuthError('GitHub returned an invalid authenticated App slug.');
    }
    const appMissing = missingPermissions(app.permissions);
    if (appMissing.length) {
        throw new AppAuthError(
            `The GitHub App is missing required repository permissions: ${appMissing.join(', ')}. Configure their required access in the App settings.`,
        );
    }
    const installations = [];
    for (let page = 1; page <= 100; page++) {
        const entries = await request('GET', `/app/installations?per_page=100&page=${page}`);
        if (!Array.isArray(entries) || entries.length > 100) {
            throw new AppAuthError('GitHub returned an invalid App installation inventory.');
        }
        installations.push(...entries);
        if (entries.length < 100) break;
        if (page === 100) {
            throw new AppAuthError('The GitHub App installation inventory exceeds its size limit.');
        }
    }
    const matching = installations.filter(
        (installation) =>
            typeof installation?.account?.login === 'string' &&
            installation.account.login.toLowerCase() === organization.toLowerCase() &&
            installation.account.type === 'Organization' &&
            installation.target_type === 'Organization' &&
            installation.suspended_at === null &&
            installation.repository_selection === 'all',
    );
    if (matching.length !== 1) {
        throw new AppAuthError('Install the GitHub App once on all current and future Kraftink-CMS repositories.');
    }
    const installation = matching[0];
    if (!validId(installation.id) || (installation.app_id !== undefined && installation.app_id !== appId)) {
        throw new AppAuthError('The Kraftink-CMS App installation ID does not match the authenticated App.');
    }
    const installationMissing = missingPermissions(installation.permissions);
    if (installationMissing.length) {
        throw new AppAuthError(
            `The Kraftink-CMS App installation is missing approved repository permissions: ${installationMissing.join(', ')}. Approve the updated permissions in the organization installation settings.`,
        );
    }
    const access = await request(
        'POST',
        `/app/installations/${installation.id}/access_tokens`,
        { permissions: { ...requiredPermissions } },
        201,
    );
    if (
        !plainObject(access) ||
        typeof access.token !== 'string' ||
        access.token.length < 1 ||
        access.token.length > 65536 ||
        /[^\x21-\x7e]/.test(access.token) ||
        (access.repository_selection !== undefined && access.repository_selection !== 'all') ||
        typeof access.expires_at !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(access.expires_at) ||
        !Number.isFinite(Date.parse(access.expires_at)) ||
        Date.parse(access.expires_at) <= currentTime(now)
    ) {
        throw new AppAuthError('GitHub returned an invalid, expired or insufficient installation token.');
    }
    const tokenMissing = missingPermissions(access.permissions);
    if (tokenMissing.length) {
        throw new AppAuthError(
            `The installation token is missing required repository permissions: ${tokenMissing.join(', ')}. Approve the updated App permissions and retry.`,
        );
    }
    return {
        token: access.token,
        appId,
        appSlug: app.slug,
        installationId: installation.id,
        expiresAt: access.expires_at,
    };
}
