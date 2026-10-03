'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { recent, summarizeDocument, fetchOne } = require('./research');
test('fresh observed research is sorted by time and scoped before limiting', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-recency-')),
    dir = path.join(root, 'tools/executive/data/research');
  fs.mkdirSync(dir, { recursive: true });
  try {
    for (const [id, site, at] of [
      ['zzz', 'owned.example', '2026-10-01'],
      ['aaa', 'owned.example', '2026-10-03'],
      ['new', 'other.example', '2026-10-04'],
    ])
      fs.writeFileSync(
        path.join(dir, id + '.json'),
        JSON.stringify({ id, url: `https://${site}/`, fetched_at: at, text: 'public evidence' })
      );
    assert.equal(recent(root, 1)[0].id, 'new');
    assert.equal(recent(root, 1, { sites: ['owned.example'] })[0].id, 'aaa');
    assert.equal(recent(root, 1, { sites: ['owned.example'] })[0].text_preview, 'public evidence');
    assert.deepEqual(recent(root, 0), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('document evidence exposes body headings and same-origin links without claiming browser validation', () => {
  const html =
    '<html><head><title>Observed title</title><script>hidden</script></head><body><h1>Real <em>heading</em></h1><a href="/help">Help</a><a href="https://external.example/">External</a><a href="#section">Section</a><a href="javascript:alert(1)">Bad</a><script>secretScript</script><style>hiddenStyle</style><p>Actual body</p></body></html>';
  const d = summarizeDocument(html, 'https://owned.example/');
  assert.equal(d.title, 'Observed title');
  assert.deepEqual(d.headings, [{ level: 1, text: 'Real heading' }]);
  assert.deepEqual(d.internal_links, [
    { href: '/help', text: 'Help' },
    { href: '/#section', text: 'Section' },
  ]);
  assert.match(d.body_text_preview, /Actual body/);
  assert.doesNotMatch(d.body_text_preview, /secretScript|hiddenStyle|Observed title/);
  assert.match(d.limitations, /not validated/);
  assert.equal(summarizeDocument('plain evidence', 'https://owned.example/'), null);
});
test('fetch preserves raw source and records the actual HTTP outcome with observed document evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-fetch-'));
  try {
    const row = await fetchOne(
      root,
      { url: 'https://owned.example/', question: 'Inspect' },
      async () => ({
        ok: false,
        status: 404,
        text: async () =>
          '<html><head><title>Missing</title></head><body><h1>Not found</h1></body></html>',
      }),
      async () => [{ address: '8.8.8.8' }]
    );
    assert.equal(row.http_status, 404);
    assert.equal(row.status, 'http_error');
    assert.equal(row.document.headings[0].text, 'Not found');
    const stored = JSON.parse(
      fs.readFileSync(path.join(root, 'tools/executive/data/research', row.id + '.json'))
    );
    assert.match(stored.text, /<head>/);
    assert.equal(stored.document.title, 'Missing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
