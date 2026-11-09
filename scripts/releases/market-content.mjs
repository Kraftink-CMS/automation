import { createRequire } from 'node:module';
import {
    marketIconId,
    marketReadmeBytes,
    validateMarketIcon,
    validateMarketImage,
    validateMarketReadme,
} from '../market/catalogue.mjs';

const require = createRequire(import.meta.url);
const decoder = new TextDecoder('utf-8', { fatal: true });
const marketDirectory = 'resources/market/';

function imageUrl(value, files, repository, version) {
    validateMarketImage(value, true);
    if (/^https:/i.test(value)) {
        return value;
    }
    const path = value.startsWith(marketDirectory) ? value : marketDirectory + value;
    if (!files.has(path)) {
        throw new Error(`The market image file is missing: ${path}`);
    }
    if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
        throw new Error('Repository market images require a stable staged package version.');
    }
    return `https://raw.githubusercontent.com/${repository}/v${version}/${path}`;
}

function imageMarkdown(value, title, url) {
    const alt = value.replace(/[\r\n]/g, ' ').replace(/&/g, '&#38;').replace(/[\\[\]]/g, '\\$&');
    const label = title?.replace(/[\r\n]/g, ' ').replace(/&/g, '&#38;').replace(/[\\"]/g, '\\$&');
    return `![${alt}](<${url}>${label ? ` "${label}"` : ''})`;
}

function normalizeMarkdown(markdown, parse, resolveImage) {
    const pending = [parse(markdown)];
    const definitions = new Map();
    const images = [];
    while (pending.length) {
        const node = pending.pop();
        if (node.type === 'html') {
            throw new Error('Market Markdown cannot contain raw HTML.');
        }
        if (node.type === 'definition' && !definitions.has(node.identifier)) {
            definitions.set(node.identifier, node);
        }
        if (node.type === 'image' || node.type === 'imageReference') {
            images.push(node);
        }
        for (const child of (node.children ?? []).slice().reverse()) {
            pending.push(child);
        }
    }
    let start = 0;
    const parts = [];
    for (const image of images) {
        const destination = image.type === 'imageReference' ? definitions.get(image.identifier) : image;
        const url = resolveImage(destination.url);
        parts.push(
            markdown.slice(start, image.position.start.offset),
            imageMarkdown(image.alt ?? '', destination.title, url),
        );
        start = image.position.end.offset;
    }
    return parts.join('') + markdown.slice(start);
}

export async function packageMarketContent(files, repository) {
    const entries = new Map(files);
    const { market, version } = JSON.parse(entries.get('manifest.json').toString('utf8'));
    const content = {};
    const resolveImage = (image) => imageUrl(image, entries, repository, version);
    if (market?.icon !== undefined) {
        validateMarketIcon(market.icon, true);
        if (marketIconId.test(market.icon)) {
            const icons = require('bootstrap-icons/font/bootstrap-icons.json');
            if (!Object.hasOwn(icons, market.icon)) {
                throw new Error(`Unknown Bootstrap Icons identifier: ${market.icon}`);
            }
            content.icon = market.icon;
        } else {
            content.icon = resolveImage(market.icon);
        }
    }
    const readme = market?.readme === undefined && entries.has('MARKET.md') ? 'MARKET.md' : market?.readme;
    if (readme === undefined) {
        return content;
    }
    validateMarketReadme(readme, true);
    const source = (path) => {
        const bytes = entries.get(path);
        if (!bytes || bytes.length > marketReadmeBytes) {
            throw new Error(`The market Markdown file is missing or exceeds 32 KiB: ${path}`);
        }
        return decoder.decode(bytes).replace(/\r\n?/g, '\n');
    };
    const map = (value, transform) => typeof value === 'string'
        ? transform(value)
        : Object.fromEntries(Object.entries(value).map(([locale, text]) => [locale, transform(text)]));
    const markdown = map(readme, source);
    validateMarketReadme(markdown);
    const { fromMarkdown } = await import('mdast-util-from-markdown');
    content.readme = map(markdown, (text) => normalizeMarkdown(text, fromMarkdown, resolveImage));
    validateMarketReadme(content.readme);
    return content;
}
