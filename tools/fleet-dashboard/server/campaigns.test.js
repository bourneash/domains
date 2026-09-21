'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eventstore = require('./eventstore');
const campaigns = require('./campaigns');
const revops = require('./revops');
test('campaigns keep consent and UTM policy explicit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'campaigns-'));
  const s = eventstore.open(root);
  const c = campaigns.create(
    s,
    {
      site: 'example.com',
      name: 'Pilot CTA',
      channel: 'social',
      landing_url: 'https://example.com/',
    },
    () => true,
    revops.buildUtmUrl
  );
  assert.equal(c.status, 'draft');
  assert.match(c.landing_url, /utm_source=social/);
  campaigns.transition(s, c.campaign_id, 'active');
  campaigns.touch(
    s,
    { campaign_id: c.campaign_id, site: 'example.com', type: 'click' },
    () => true
  );
  assert.equal(campaigns.summary(s).active, 1);
  s.close();
});
