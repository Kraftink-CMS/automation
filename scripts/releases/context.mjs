import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { localBundle } from './publish.mjs';

export async function collectCustomAssets(directory) {
    const source = await lstat(directory);
    if (!source.isDirectory() || source.isSymbolicLink())
        throw new Error('The build artifact must be a regular directory.');
    const names = (await readdir(directory)).filter((name) => name !== 'bundle.json').sort();
    if (!names.length || names.length > 100) throw new Error('A custom release requires between 1 and 100 assets.');
    const assets = [];
    for (const name of names) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(name)) throw new Error('Invalid custom release asset name.');
        const path = resolve(directory, name);
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 536870912)
            throw new Error('Custom release assets must be bounded regular files.');
        let size = 0;
        const hash = createHash('sha256');
        for await (const bytes of createReadStream(path)) {
            size += bytes.length;
            if (size > stat.size) throw new Error('A custom release asset grew while reading.');
            hash.update(bytes);
        }
        if (size !== stat.size) throw new Error('A custom release asset changed while reading.');
        assets.push({ name, size, sha256: hash.digest('hex') });
    }
    return assets;
}

async function jsonFile(path, limit = 65536) {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > limit) {
        throw new Error('Release context files must be bounded regular JSON files.');
    }
    const bytes = await readFile(path);
    if (bytes.length !== stat.size) {
        throw new Error('A release context file changed while reading.');
    }
    return JSON.parse(bytes.toString('utf8'));
}

export async function verifyBuiltAssets({ plan, manifest, history, repository, directory }) {
    const assets = await localBundle(plan, directory);
    const filename = `${manifest.id}-${plan.version}.zip`;
    const expected = [filename, `${filename}.sha256`, 'kraftink-extension.json'];
    if (!isDeepStrictEqual(assets.map((asset) => asset.name).sort(), [...expected].sort())) {
        throw new Error('The build must contain exactly the source package ZIP, checksum and release metadata.');
    }
    const files = await readdir(directory);
    if (!isDeepStrictEqual(files.sort(), [...expected, 'bundle.json'].sort())) {
        throw new Error('Unexpected files are present in the build artifact.');
    }
    const archive = assets.find((asset) => asset.name === filename);
    if (
        archive.size > 52428800 ||
        assets.find((asset) => asset.name === `${filename}.sha256`).size > 4096 ||
        assets.find((asset) => asset.name === 'kraftink-extension.json').size > 262144
    ) {
        throw new Error('Built release files exceed the extension publication limits.');
    }
    const checksum = await readFile(resolve(directory, `${filename}.sha256`), 'utf8');
    if (checksum !== `${archive.sha256}  ${filename}\n`) {
        throw new Error('The archive checksum file does not match the built package.');
    }
    const metadata = await jsonFile(resolve(directory, 'kraftink-extension.json'), 262144);
    const download = {
        url: `https://github.com/${repository}/releases/download/${plan.tag}/${filename}`,
        sha256: archive.sha256,
    };
    const ownerName = repository.split('/')[0].toLowerCase();
    const owner = /^[a-z][a-z0-9-]{1,49}$/.test(ownerName) ? ownerName : `github-${ownerName}`;
    if (
        metadata.schema_version !== 1 ||
        metadata.slug !== manifest.id ||
        metadata.type !== manifest.type ||
        metadata.version !== plan.version ||
        !isDeepStrictEqual(metadata.requirements, manifest.requires) ||
        !isDeepStrictEqual(metadata.download, download) ||
        metadata.resource?.id !== `${owner}/${manifest.id}` ||
        metadata.resource?.slug !== manifest.id ||
        metadata.resource?.type !== manifest.type ||
        metadata.resource?.repository !== `https://github.com/${repository}` ||
        metadata.resource?.author?.id !== owner
    ) {
        throw new Error('Built metadata does not match the committed source identity and archive.');
    }
    const current = {
        version: plan.version,
        requirements: manifest.requires,
        download,
    };
    const versions = [current, ...history.filter((entry) => entry.version !== plan.version)].slice(0, 100);
    if (
        !Array.isArray(metadata.versions) ||
        !metadata.versions.length ||
        metadata.versions.length > versions.length ||
        !isDeepStrictEqual(metadata.versions, versions.slice(0, metadata.versions.length))
    ) {
        throw new Error('Built metadata does not preserve the trusted release history.');
    }
    return assets;
}
