import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { buildReleaseNotes, normalizeReleaseNotes } from './notes.mjs';

async function fixture(context) {
    const root = await mkdtemp(resolve(tmpdir(), 'kraftink-release-notes-'));
    context.after(() => rm(root, { recursive: true, force: true }));
    const run = (args, input, environment = {}) => execFileSync('git', ['-C', root, ...args], { input,
        encoding: 'utf8', windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: {
            ...process.env, GIT_AUTHOR_NAME: 'Human author', GIT_AUTHOR_EMAIL: 'author@example.invalid',
            GIT_COMMITTER_NAME: 'Human committer', GIT_COMMITTER_EMAIL: 'committer@example.invalid', ...environment,
        } }).trimEnd();
    run(['init', '-b', 'dev']);
    const tree = run(['mktree'], '');
    let head = null;
    const commit = (subject, environment = {}, parents = head ? [head] : []) => {
        head = run(['commit-tree', tree, ...parents.flatMap((sha) => ['-p', sha])], subject + '\n', environment);
        run(['update-ref', 'refs/heads/dev', head]);
        return head;
    };
    return { root, run, commit, build: (sha, options = {}) => buildReleaseNotes({ root,
        repository: 'Kraftink-CMS/Example', sha, ...options }) };
}

test('note modes preserve Markdown and reject ignored, empty or oversized messages before Git access', async () => {
    assert.deepEqual(normalizeReleaseNotes(), { mode: 'auto', message: '' });
    assert.deepEqual(normalizeReleaseNotes({ mode: 'append', message: '  ## Highlights\r\n\r\n**Useful** changes  ' }),
        { mode: 'append', message: '## Highlights\n\n**Useful** changes' });
    for (const options of [{ mode: 'unknown' }, { mode: 'auto', message: 'Ignored text' }, { mode: 'append' },
        { mode: 'replace', message: ' \n ' }, { mode: 'append', message: 7 },
        { mode: 'replace', message: 'a\0b' }, { mode: 'append', message: 'é'.repeat(4097) }])
        assert.throws(() => normalizeReleaseNotes(options));
    const options = { root: 'a-path-that-does-not-exist', repository: 'Kraftink-CMS/Example', sha: 'a'.repeat(40),
        mode: 'replace', message: '## Fixed\n\n- **Keep my Markdown**\n- [Guide](https://example.invalid/guide)' };
    assert.equal(await buildReleaseNotes(options), options.message);
    for (const invalid of [{ sha: 'HEAD' }, { repository: 'owner/repo/extra' }, { previousTag: '--all' },
        { previousTag: '../main' }, { previousTag: 'version.lock' }, { root: '' }])
        await assert.rejects(buildReleaseNotes({ ...options, ...invalid }));
});

test('first release lists real human commits while author bots, committer bots, merges and exact automation commits are excluded', async (context) => {
    const data = await fixture(context);
    const first = data.commit('feat: first working feature');
    data.commit('fix: bot authored change', { GIT_AUTHOR_NAME: 'dependabot[bot]' });
    data.commit('fix: bot committed change', { GIT_COMMITTER_NAME: 'github-actions' });
    data.commit('fix: bot email identity', { GIT_COMMITTER_EMAIL: '123+renovate[bot]@users.noreply.github.com' });
    data.commit('chore: set source version to 1.0.0');
    data.commit('chore: set source version to 1.0.1-dev');
    data.commit('chore: configure extension release');
    data.commit('chore: prepare release target 1.1.0');
    data.commit('chore: publish alpha channel 1.1.0-alpha.1');
    const migration = data.commit('chore: migrate existing database indexes');
    const technicalLookalike = data.commit('chore: set source version to support server selections');
    const merge = data.commit('Merge the release pull request', {}, [technicalLookalike, first]);
    const body = await data.build(merge);
    assert.match(body, /first working feature/);
    assert.match(body, /migrate existing database indexes/);
    assert.match(body, /support server selections/);
    assert.ok(body.includes('/commit/' + migration));
    assert.ok(body.includes('/commit/' + first));
    assert.ok(body.includes('/commits/' + merge));
    for (const excluded of ['bot authored', 'bot committed', 'bot email', '1.0.0', '1.0.1-dev',
        'configure extension release', 'prepare release target', 'publish alpha channel', 'Merge the release'])
        assert.ok(!body.includes(excluded), excluded);
});

test('a previous annotated release tag restricts notes to the exact source range rather than HEAD', async (context) => {
    const data = await fixture(context);
    const old = data.commit('feat: previous release');
    data.run(['tag', '-a', 'v1.0.0', '-m', 'Stable release', old]);
    const selected = data.commit('fix: selected release');
    data.commit('feat: later development');
    const body = await data.build(selected, { previousTag: 'v1.0.0' });
    assert.match(body, /selected release/);
    assert.ok(!body.includes('previous release'));
    assert.ok(!body.includes('later development'));
    assert.ok(body.includes('/compare/v1.0.0...' + selected));
    const unrelated = data.commit('fix: another history', {}, []);
    data.run(['tag', 'v9.0.0', unrelated]);
    await assert.rejects(data.build(selected, { previousTag: 'v9.0.0' }), /source history/);
});

test('append places the manual Markdown before generated commits and escapes subjects as plain text', async (context) => {
    const data = await fixture(context);
    const sha = data.commit('fix: [click](javascript:alert(1)) <script> *format* `code`');
    const message = '## Important\n\nRead the **upgrade guide** first.';
    const body = await data.build(sha, { mode: 'append', message });
    assert.ok(body.startsWith(message + '\n\n## Changes\n\n'));
    assert.ok(body.includes('\\[click\\]\\(javascript:alert\\(1\\)\\)'));
    assert.ok(body.includes('&lt;script&gt;'));
    assert.ok(body.includes('\\*format\\*'));
    assert.ok(body.includes('\\`code\\`'));
    assert.ok(body.includes('/commit/' + sha));
});

test('large histories and long subjects are shortened within bounded Markdown without failing publication notes', async (context) => {
    const data = await fixture(context);
    let sha;
    for (let index = 0; index < 112; index++) sha = data.commit('fix: change ' + index);
    const body = await data.build(sha);
    assert.equal(body.split('\n').filter((line) => line.startsWith('- ')).length, 100);
    assert.match(body, /list is shortened/);
    assert.ok(Buffer.byteLength(body) <= 20480);
    sha = data.commit('feat: ' + '😀'.repeat(700));
    const appended = await data.build(sha, { mode: 'append', message: '**Notice**\n\n' + 'x'.repeat(8100) });
    assert.match(appended, /list is shortened/);
    assert.ok(Buffer.byteLength(appended) <= 20480);
    assert.ok(appended.includes('/commits/' + sha));
});

test('an empty human range remains useful without exposing automated commit subjects', async (context) => {
    const data = await fixture(context);
    const sha = data.commit('chore: set source version to 1.0.0-dev', { GIT_AUTHOR_NAME: 'github-actions[bot]' });
    const body = await data.build(sha);
    assert.match(body, /No changes to list/);
    assert.ok(body.includes('/commits/' + sha));
    data.run(['tag', 'v1.0.0', sha]);
    assert.match(await data.build(sha, { previousTag: 'v1.0.0' }), /No changes to list/);
});
