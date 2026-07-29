#!/usr/bin/env node
// Import a site's src/lib/affiliate.ts, or read a directory of product
// frontmatter files, and dump the products as JSON on stdout. Generic by
// design — usable by any tool that needs the registry as data, not just
// affiliate-audit. Invoke via tsx: `npx tsx discover.mjs <registry-path>`
//
// We import (not regex-parse) so the data is type-checked at import time and
// we never eval/reach into file contents by hand — same rationale as
// site/scripts/generate-redirects.ts.

import { pathToFileURL } from 'node:url';
import { resolve, basename, extname } from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replace(/\\([\\"'])/g, '$1');
  }
  return trimmed;
}

function parseFrontmatter(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return {};
  const end = text.indexOf('\n---', 4);
  if (end === -1) return {};

  // Product registries use simple scalar frontmatter for the fields the audit
  // needs. Deliberately do not attempt to parse arbitrary YAML here: nested
  // fields such as gallery/bullets are irrelevant to an affiliate check.
  const fields = {};
  for (const line of text.slice(4, end).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (match) fields[match[1]] = unquote(match[2]);
  }
  return fields;
}

async function discoverFrontmatterDir(dir) {
  const files = (await readdir(dir))
    .filter((file) => extname(file).toLowerCase() === '.md')
    .sort();
  return Promise.all(files.map(async (file) => {
    const fields = parseFrontmatter(await readFile(resolve(dir, file), 'utf8'));
    const price = Number(fields.price);
    return {
      id: basename(file, extname(file)),
      name: fields.name || basename(file, extname(file)),
      brand: fields.brand || null,
      category: fields.category || null,
      price: Number.isFinite(price) ? price : null,
      asin: fields.amazonAsin || null,
      amazonImageId: null,
      // Frontmatter registries have no separate search query; the product
      // name is the faithful equivalent when a resolution prompt needs one.
      searchQuery: fields.name || basename(file, extname(file)),
      image: fields.hero || null,
      blurb: fields.blurb || '',
      ribbon: fields.badge || null,
      campaignOnly: false,
    };
  }));
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: discover.mjs <path-to-registry>');
    process.exit(1);
  }
  const abs = resolve(target);
  if ((await stat(abs)).isDirectory()) {
    process.stdout.write(JSON.stringify(await discoverFrontmatterDir(abs)));
    return;
  }
  const mod = await import(pathToFileURL(abs).href);
  const products = (mod.PRODUCTS || []).map((p) => ({
    id: p.id,
    name: p.name,
    brand: p.brand,
    category: p.category,
    price: p.price,
    asin: p.asin ?? null,
    amazonImageId: p.amazonImageId ?? null,
    searchQuery: p.searchQuery,
    image: p.image,
    blurb: p.blurb,
    ribbon: p.ribbon ?? null,
    campaignOnly: p.campaignOnly ?? false,
  }));
  process.stdout.write(JSON.stringify(products));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
