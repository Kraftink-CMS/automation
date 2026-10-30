import { git } from './version.mjs';

const messageLimit = 8192;
const notesLimit = 20480;
const commitLimit = 100;
const scanLimit = 1000;
const validSha = (value) => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);

export function normalizeReleaseNotes({ mode = 'auto', message = '' } = {}) {
    if (!['auto', 'append', 'replace'].includes(mode) || typeof message !== 'string')
        throw new Error('Choose auto, append or replace and provide Markdown text.');
    const normalized = message.replace(/\r\n?/g, '\n').trim();
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(normalized) || Buffer.byteLength(normalized) > messageLimit)
        throw new Error('Release notes must contain at most 8192 UTF-8 bytes without control characters.');
    if (mode === 'auto' && normalized || mode !== 'auto' && !normalized)
        throw new Error('Auto notes require an empty message. Append and replace require a message.');
    return { mode, message: normalized };
}

function validTag(value) {
    return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value)
        && !value.includes('..') && !value.includes('//') && !value.endsWith('/') && !value.endsWith('.')
        && value.split('/').every((part) => !part.endsWith('.lock'));
}

function bot(name, email) {
    return /\[bot\]/i.test(name + ' ' + email) || /^github-actions$/i.test(name)
        || /^(?:\d+\+)?github-actions@users\.noreply\.github\.com$/i.test(email);
}

function technical(subject) {
    return ['chore: configure extension release', 'chore: promote dev to master'].includes(subject)
        || /^chore: set source version to \d+\.\d+\.\d+(?:-dev|-SNAPSHOT)?$/.test(subject)
        || /^chore: prepare release target \d+\.\d+\.\d+$/.test(subject)
        || /^chore: publish (?:alpha|beta|stable) channel \d+\.\d+\.\d+(?:-(?:alpha|beta)\.[1-9]\d*)?$/.test(subject);
}

function markdown(value) {
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replace(/[\\`*_{}\[\]()#+.!|~=-]/g, '\\$&');
}

export async function buildReleaseNotes({ root, repository, sha, previousTag = null, mode = 'auto', message = '' } = {}) {
    const notes = normalizeReleaseNotes({ mode, message });
    if (typeof root !== 'string' || !root.trim() || typeof repository !== 'string'
            || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository)
            || !validSha(sha) || previousTag !== null && !validTag(previousTag))
        throw new Error('Release notes require a repository, source commit and safe previous release tag.');
    if (notes.mode === 'replace') return notes.message;
    if (git(root, ['rev-parse', '--verify', sha + '^{commit}']) !== sha)
        throw new Error('Release notes must identify an exact source commit.');
    const range = [sha];
    if (previousTag !== null) {
        const previous = git(root, ['rev-parse', '--verify', 'refs/tags/' + previousTag + '^{commit}']);
        if (git(root, ['merge-base', '--is-ancestor', previous, sha], true) === null)
            throw new Error('The previous release tag must belong to the source history.');
        range.push('^' + previous);
    }
    const format = '%H%x00%an%x00%ae%x00%cn%x00%ce%x00%<(600,trunc)%s';
    const raw = git(root, ['log', '--no-merges', '--topo-order', '--max-count=' + (scanLimit + 1),
        '-z', '--format=' + format, ...range, '--']);
    const fields = raw ? raw.split('\0') : [];
    if (fields.at(-1) === '') fields.pop();
    if (fields.length % 6) throw new Error('Git returned invalid release note records.');
    const base = 'https://github.com/' + repository;
    const footer = previousTag === null
        ? '[Full history](' + base + '/commits/' + sha + ')'
        : '[Full comparison](' + base + '/compare/' + encodeURIComponent(previousTag) + '...' + sha + ')';
    const prefix = (notes.mode === 'append' ? notes.message + '\n\n' : '') + '## Changes\n\n';
    const notice = 'This list is shortened. See the full history below.';
    const lines = [];
    let shortened = fields.length / 6 > scanLimit;
    for (let offset = 0; offset < Math.min(fields.length, scanLimit * 6); offset += 6) {
        const [commit, author, authorEmail, committer, committerEmail, rawSubject] = fields.slice(offset, offset + 6);
        if (!validSha(commit)) throw new Error('Git returned an invalid release note commit.');
        const subject = rawSubject.trim();
        if (bot(author, authorEmail) || bot(committer, committerEmail) || technical(subject)) continue;
        const characters = Array.from(subject);
        const label = characters.length > 300 ? characters.slice(0, 299).join('') + '…' : subject;
        const line = '- ' + markdown(label) + ' ([`' + commit.slice(0, 7) + '`](' + base + '/commit/' + commit + '))';
        if (lines.length === commitLimit || Buffer.byteLength(prefix + [...lines, line].join('\n')
                + '\n\n' + notice + '\n\n' + footer) > notesLimit) {
            shortened = true;
            break;
        }
        if (characters.length > 300) shortened = true;
        lines.push(line);
    }
    return prefix + (lines.length ? lines.join('\n') : 'No changes to list.')
        + (shortened ? '\n\n' + notice : '') + '\n\n' + footer;
}
