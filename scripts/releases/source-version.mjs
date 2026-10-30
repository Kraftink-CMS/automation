import { execFileSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { posix } from 'node:path';
import { compareVersions, stableVersion } from './version.mjs';

const maximumBytes = 1048576;
const maximumFiles = 100;

function sourceVersion(value) {
    if (typeof value !== 'string') throw new Error('A source version must be X.Y.Z or X.Y.Z-dev.');
    const core = value.endsWith('-dev') ? value.slice(0, -4) : value;
    stableVersion(core);
    return core;
}

function metadataPath(path) {
    if (typeof path !== 'string' || !path || /[\\:\x00-\x1f\x7f]/.test(path)
            || path.split('/').some((part) => !part || part === '.' || part === '..')) {
        throw new Error('Version metadata must stay inside the repository.');
    }
    return path;
}

function command(root, args, options = {}) {
    return execFileSync('git', ['--no-pager', '-C', root, ...args], {
        windowsHide: true,
        shell: false,
        timeout: 20000,
        maxBuffer: maximumBytes + 1,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        ...options,
    });
}

async function reader({ root = process.cwd(), sha, read }) {
    if (read !== undefined && typeof read !== 'function') throw new Error('The source reader must be a function.');
    if (!read) {
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha ?? '')) {
            throw new Error('A pinned source commit is required.');
        }
        const directory = await realpath(root);
        const top = command(directory, ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
        if (directory !== await realpath(top)
                || command(directory, ['rev-parse', '--verify', `${sha}^{commit}`], { encoding: 'utf8' }).trim() !== sha) {
            throw new Error('Version metadata requires the repository root and an exact commit.');
        }
        read = async (path) => {
            const entry = command(directory, ['ls-tree', '-z', sha, '--', path], { encoding: 'utf8' });
            if (!entry) return null;
            const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)\0$/.exec(entry);
            if (!match || match[3] !== path) throw new Error('Version metadata must be a tracked regular file.');
            const size = Number(command(directory, ['cat-file', '-s', match[2]], { encoding: 'utf8' }).trim());
            if (!Number.isSafeInteger(size) || size < 1 || size > maximumBytes) throw new Error('Version metadata is too large or empty.');
            return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(command(directory, ['cat-file', 'blob', match[2]]));
        };
    }
    return async (path) => {
        metadataPath(path);
        const content = await read(path);
        if (content === null) return null;
        if (typeof content !== 'string' || !content.length || Buffer.byteLength(content) > maximumBytes) {
            throw new Error('Version metadata must contain bounded UTF-8 text.');
        }
        return content;
    };
}

function jsonVersion(raw) {
    const value = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Invalid source manifest.');
    sourceVersion(value.version);
    const positions = [];
    let depth = 0;
    for (let index = 0; index < raw.length; index++) {
        const character = raw[index];
        if (character === '"') {
            const start = index;
            while (++index < raw.length) {
                if (raw[index] === '\\') index++;
                else if (raw[index] === '"') break;
            }
            const end = index + 1;
            const following = /^\s*:\s*/.exec(raw.slice(end));
            if (depth === 1 && following && JSON.parse(raw.slice(start, end)) === 'version') {
                const offset = end + following[0].length;
                const token = /^"(?:[^"\\]|\\.)*"/.exec(raw.slice(offset));
                if (!token) throw new Error('The source manifest version must be a string.');
                positions.push({ start: offset, end: offset + token[0].length });
            }
        } else if (character === '{' || character === '[') depth++;
        else if (character === '}' || character === ']') depth--;
    }
    if (positions.length !== 1) throw new Error('The source manifest must contain exactly one root version.');
    return { version: value.version, positions, json: true };
}

function xml(raw) {
    const nodes = [];
    const stack = [];
    let cursor = 0;
    while (cursor < raw.length) {
        const start = raw.indexOf('<', cursor);
        const text = raw.slice(cursor, start < 0 ? raw.length : start);
        if (!stack.length && text.replace(/^\uFEFF/, '').trim()) throw new Error('Invalid POM XML outside the project.');
        if (start < 0) break;
        if (raw.startsWith('<!--', start) || raw.startsWith('<?', start)) {
            const ending = raw.startsWith('<!--', start) ? '-->' : '?>';
            const end = raw.indexOf(ending, start + 2);
            if (end < 0) throw new Error('Unclosed POM XML comment or declaration.');
            cursor = end + ending.length;
            continue;
        }
        if (raw.startsWith('<!', start)) throw new Error('POM XML declarations and entities are not supported.');
        let quote = null;
        let end = start + 1;
        for (; end < raw.length; end++) {
            const character = raw[end];
            if (quote) {
                if (character === quote) quote = null;
            } else if (character === '"' || character === "'") quote = character;
            else if (character === '>') break;
            else if (character === '<') throw new Error('Invalid POM XML tag.');
        }
        if (end === raw.length || quote) throw new Error('Unclosed POM XML tag.');
        const tag = raw.slice(start + 1, end);
        const closing = /^\/([A-Za-z_][\w:.-]*)\s*$/.exec(tag);
        if (closing) {
            const node = stack.pop();
            if (!node || node.name !== closing[1]) throw new Error('Mismatched POM XML tags.');
            node.end = start;
        } else {
            const opening = /^([A-Za-z_][\w:.-]*)([^]*)$/.exec(tag);
            if (!opening || !/^(?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*\/?$/.test(opening[2])) {
                throw new Error('Invalid POM XML element.');
            }
            const parent = stack.at(-1) ?? null;
            const node = { name: opening[1], local: opening[1].split(':').at(-1), parent, start: end + 1, end: null };
            nodes.push(node);
            if (/\/\s*$/.test(tag)) node.end = node.start;
            else stack.push(node);
        }
        cursor = end + 1;
    }
    const roots = nodes.filter((node) => !node.parent);
    if (stack.length || roots.length !== 1 || roots[0].local !== 'project') throw new Error('A complete POM project is required.');
    const children = (parent, name) => nodes.filter((node) => node.parent === parent && node.local === name);
    const one = (parent, name, required = false) => {
        const matches = children(parent, name);
        if (matches.length > 1 || required && matches.length !== 1) throw new Error(`Ambiguous or missing POM ${name}.`);
        return matches[0] ?? null;
    };
    const scalar = (node) => {
        if (!node) return null;
        const text = raw.slice(node.start, node.end);
        if (/[<&]/.test(text)) throw new Error('POM metadata must use literal scalar values.');
        return text.trim();
    };
    const project = roots[0];
    const parent = one(project, 'parent');
    const identity = (node, name) => scalar(one(node, name, true));
    const group = scalar(one(project, 'groupId')) ?? (parent ? identity(parent, 'groupId') : null);
    const artifact = identity(project, 'artifactId');
    if (!group || !/^[A-Za-z0-9_.-]+$/.test(group) || !/^[A-Za-z0-9_.-]+$/.test(artifact)) {
        throw new Error('POM coordinates must be literal group and artifact identifiers.');
    }
    const versionNode = one(project, 'version');
    const parentVersion = parent ? one(parent, 'version', true) : null;
    const modules = one(project, 'modules');
    return {
        coordinate: `${group}:${artifact}`,
        version: scalar(versionNode),
        versionNode,
        parent: parent ? `${identity(parent, 'groupId')}:${identity(parent, 'artifactId')}` : null,
        parentVersion: scalar(parentVersion),
        parentVersionNode: parentVersion,
        modules: modules ? children(modules, 'module').map(scalar) : [],
    };
}

function position(raw, node) {
    const text = raw.slice(node.start, node.end);
    return { start: node.start + /^\s*/.exec(text)[0].length, end: node.end - /\s*$/.exec(text)[0].length };
}

async function inspect(options) {
    const read = await reader(options);
    const manifest = await read('manifest.json');
    if (manifest !== null) {
        const metadata = jsonVersion(manifest);
        return { format: 'json', version: metadata.version, files: [{ path: 'manifest.json', raw: manifest, ...metadata }] };
    }
    const rootPom = await read('pom.xml');
    if (rootPom === null) {
        const packageManifest = await read('package.json');
        if (packageManifest === null) throw new Error('The source manifest, POM or package.json is missing.');
        const metadata = jsonVersion(packageManifest);
        return { format: 'json', version: metadata.version, files: [{ path: 'package.json', raw: packageManifest, ...metadata }] };
    }
    const documents = [];
    const visited = new Set();
    const visit = async (path) => {
        metadataPath(path);
        if (visited.has(path.toLowerCase()) || visited.size >= maximumFiles) throw new Error('Duplicate or excessive POM modules.');
        visited.add(path.toLowerCase());
        const raw = path === 'pom.xml' ? rootPom : await read(path);
        if (raw === null) throw new Error('The source POM or a declared module POM is missing.');
        const metadata = xml(raw);
        documents.push({ path, raw, metadata, positions: [] });
        for (const module of metadata.modules) {
            metadataPath(module);
            const child = posix.join(posix.dirname(path), module);
            await visit(module.endsWith('.xml') ? child : `${child}/pom.xml`);
        }
    };
    await visit('pom.xml');
    const root = documents[0];
    sourceVersion(root.metadata.version);
    root.positions.push(position(root.raw, root.metadata.versionNode));
    const managed = new Set([root.metadata.coordinate]);
    const coordinates = new Set();
    for (const document of documents) {
        if (coordinates.has(document.metadata.coordinate)) throw new Error('Duplicate POM reactor coordinates.');
        coordinates.add(document.metadata.coordinate);
    }
    let added;
    do {
        added = false;
        for (const document of documents.slice(1)) {
            const metadata = document.metadata;
            if (!managed.has(metadata.parent)) continue;
            if (metadata.parentVersion !== root.metadata.version) throw new Error('Reactor parent versions must match the source version.');
            if (metadata.version === null && !managed.has(metadata.coordinate)) {
                managed.add(metadata.coordinate);
                added = true;
            }
        }
    } while (added);
    for (const document of documents.slice(1)) {
        if (managed.has(document.metadata.parent)) document.positions.push(position(document.raw, document.metadata.parentVersionNode));
    }
    return { format: 'pom', version: root.metadata.version, files: documents.filter((document) => document.positions.length) };
}

export async function inspectSourceVersion(options = {}) {
    const result = await inspect(options);
    return { format: result.format, version: result.version, paths: result.files.map((file) => file.path) };
}

export async function sourceVersionChanges({ version, expectedVersion, ...options } = {}) {
    sourceVersion(version);
    const source = await inspect(options);
    if (expectedVersion !== undefined && source.version !== expectedVersion) throw new Error('The source version changed before preparation.');
    const files = [];
    for (const file of source.files) {
        let after = file.raw;
        for (const span of file.positions.toSorted((left, right) => right.start - left.start)) {
            after = after.slice(0, span.start) + (file.json ? JSON.stringify(version) : version) + after.slice(span.end);
        }
        if (after !== file.raw) files.push({ path: file.path, before: file.raw, after });
    }
    return { source_version: source.version, version, files };
}

export function nextDevelopmentVersion(stable, target = null) {
    const parts = stableVersion(stable);
    parts[2]++;
    let next = parts.join('.');
    stableVersion(next);
    if (target !== null && target !== undefined) {
        const candidate = sourceVersion(target);
        if (compareVersions(candidate, next) > 0) next = candidate;
    }
    return `${next}-dev`;
}
