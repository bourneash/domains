#!/usr/bin/env node
// Import a site's src/lib/affiliate.ts and dump PRODUCTS[] as JSON on stdout.
// Generic by design — usable by any tool that needs the registry as data, not
// just affiliate-audit. Invoke via tsx: `npx tsx discover.mjs <path-to-affiliate.ts>`
//
// We import (not regex-parse) so the data is type-checked at import time and
// we never eval/reach into file contents by hand — same rationale as
// site/scripts/generate-redirects.ts.

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: discover.mjs <path-to-affiliate.ts>');
    process.exit(1);
  }
  const abs = resolve(target);
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
