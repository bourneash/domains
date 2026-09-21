'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eventstore = require('./eventstore');
const revops = require('./revops');

function store() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'revops-'));
  return eventstore.open(root);
}
const known = site => site === 'example.com';

test('scores and stages a consented lead without storing raw contact data', () => {
  const s = store();
  const lead = revops.createLead(
    s,
    {
      site: 'example.com',
      source: 'newsletter',
      consent: true,
      contact_ref: 'contact:hashed',
      fit: { company: true, role: true, intent: true },
      engagement: { form_submit: 1 },
    },
    known
  );
  assert.equal(lead.stage, 'mql');
  assert.equal(lead.score, 80);
  assert.equal(revops.summary(s).mqls, 1);
  s.close();
});

test('rejects PII-like contact references without consent and builds normalized UTMs', () => {
  const s = store();
  assert.throws(
    () => revops.createLead(s, { site: 'example.com', contact_ref: 'email@example.com' }, known),
    /consent/
  );
  assert.equal(
    revops.buildUtmUrl('https://example.com/page', { utm_source: 'CEO', utm_campaign: 'Pilot 1' }),
    'https://example.com/page?utm_source=ceo&utm_campaign=pilot-1'
  );
  s.close();
});
