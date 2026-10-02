'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function briefHash(brief) {
  return crypto
    .createHash('sha256')
    .update(String(brief || ''))
    .digest('hex');
}

function completionError(reason) {
  const error = new Error(`site build completion requires ${reason}`);
  error.httpStatus = 409;
  return error;
}

function previewOnlyBrief(brief) {
  return /\b(?:preview[- ]only|(?:only|just)\s+(?:a\s+)?(?:private\s+)?preview)\b/i.test(
    String(brief || '')
  );
}

function gitHeadCommit(repo) {
  const gitPath = path.join(repo, '.git');
  const gitDir = fs.statSync(gitPath).isDirectory()
    ? gitPath
    : path.resolve(
        repo,
        fs
          .readFileSync(gitPath, 'utf8')
          .trim()
          .replace(/^gitdir:\s*/, '')
      );
  let head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
  if (head.startsWith('ref: ')) {
    const ref = head.slice(5);
    const looseRef = path.join(gitDir, ref);
    if (fs.existsSync(looseRef)) head = fs.readFileSync(looseRef, 'utf8').trim();
    else {
      const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
      head =
        packed
          .split('\n')
          .find(line => line.endsWith(` ${ref}`))
          ?.split(' ')[0] || '';
    }
  }
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('invalid git HEAD');
  const looseObject = path.join(gitDir, 'objects', head.slice(0, 2), head.slice(2));
  if (fs.existsSync(looseObject)) {
    const header = zlib.inflateSync(fs.readFileSync(looseObject)).toString('utf8', 0, 20);
    if (!header.startsWith('commit ')) throw new Error('HEAD is not a commit');
  } else {
    const packDir = path.join(gitDir, 'objects', 'pack');
    if (!fs.existsSync(packDir) || !fs.readdirSync(packDir).some(name => name.endsWith('.idx')))
      throw new Error('HEAD commit object is missing');
  }
  return head;
}

function assertSiteBuildCompletion(root, task, parent, requests) {
  const site = String(task.site || parent?.site || '').trim();
  if (!site || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(site))
    throw completionError('a valid site domain');
  const proof = (task.evidence || []).find(
    item => item?.type === 'artifact' && item?.contract === 'site-build/v1'
  );
  if (!proof) throw completionError('site-build/v1 evidence');
  if (proof.site !== site || proof.brief_sha256 !== briefHash(parent?.summary || task.summary))
    throw completionError('evidence bound to the site and full owner brief');
  const siteRepo = path.resolve(root, 'sites', site);
  const canonicalBrief = String(parent?.summary || task.summary || '').trim();
  let siteInstructions;
  let buildPrompt;
  try {
    siteInstructions = fs.readFileSync(path.join(siteRepo, 'CLAUDE.md'), 'utf8');
    buildPrompt = fs.readFileSync(path.join(siteRepo, 'ops', 'AGENT_BUILD_PROMPT.md'), 'utf8');
  } catch {
    throw completionError('site instructions and AGENT_BUILD_PROMPT.md');
  }
  if (
    !siteInstructions.includes(`Owner brief SHA256: ${briefHash(canonicalBrief)}`) ||
    /positioning\s+\*\*TBD\*\*|after Jesse provides the brief/i.test(siteInstructions) ||
    !buildPrompt.includes(canonicalBrief)
  )
    throw completionError('the original owner brief in site instructions and build prompt');
  if (!Array.isArray(proof.pages) || proof.pages.length === 0)
    throw completionError('built page paths');
  const siteRoot = path.resolve(root, 'sites', site, 'site');
  const pagesRoot = path.join(siteRoot, 'src', 'pages');
  for (const relative of proof.pages) {
    if (typeof relative !== 'string' || !relative.endsWith('.astro'))
      throw completionError('Astro page paths');
    const page = path.resolve(pagesRoot, relative);
    if (!page.startsWith(`${pagesRoot}${path.sep}`) || !fs.existsSync(page))
      throw completionError(`existing page ${relative}`);
    const contents = fs.readFileSync(page, 'utf8');
    if (/coming soon|positioning\s+tbd|under construction/i.test(contents) || contents.length < 250)
      throw completionError(`non-placeholder content in ${relative}`);
  }
  if (
    !proof.build ||
    proof.build.exit_code !== 0 ||
    !String(proof.build.command || '').trim() ||
    !/^[a-f0-9]{7,40}$/.test(String(proof.build.commit || ''))
  )
    throw completionError('passing build validation tied to a commit');
  if (
    !proof.preview ||
    !['verified-private', 'verified-production'].includes(proof.preview.status) ||
    !/^https?:\/\//.test(String(proof.preview.url || '')) ||
    !Number.isFinite(Date.parse(proof.preview.checked_at || ''))
  )
    throw completionError('verified private-preview or production URL');
  if (!previewOnlyBrief(parent?.summary || task.summary)) {
    let liveHost;
    try {
      const live = new URL(proof.preview.url);
      liveHost = live.protocol === 'https:' ? live.hostname : null;
    } catch {
      liveHost = null;
    }
    if (
      proof.preview.status !== 'verified-production' ||
      ![site, `www.${site}`].includes(liveHost) ||
      proof.deployment?.method !== 'github-cloudflare-workers-builds' ||
      proof.deployment?.status !== 'success' ||
      proof.deployment?.commit !== proof.build.commit ||
      !Number.isFinite(Date.parse(proof.deployment?.checked_at || ''))
    )
      throw completionError(
        'connected GitHub-to-Cloudflare production deployment and verified live site'
      );
  }
  if (proof.source === 'external-builder') {
    const repo = path.resolve(root, 'sites', site);
    try {
      if (gitHeadCommit(repo) !== proof.build.commit) throw new Error('commit mismatch');
    } catch {
      throw completionError('the checked-out site-repository commit for external-builder work');
    }
    if (!String(proof.build.log_uri || '').trim())
      throw completionError('external-builder build log evidence');
  } else {
    const linked = (requests || []).find(
      request =>
        request.site === site &&
        request.action_key === `site-build:${parent?.work_id || task.parent_work_id}` &&
        ['verified', 'deployed'].includes(request.status)
    );
    if (!linked) throw completionError('a deployed or verified downstream build request');
  }
  return proof;
}

module.exports = { briefHash, assertSiteBuildCompletion };
