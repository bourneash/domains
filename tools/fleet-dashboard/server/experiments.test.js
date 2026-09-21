'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eventstore = require('./eventstore');
const experiments = require('./experiments');

function store() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'experiments-'));
  return eventstore.open(root);
}
const known = site => site === 'example.com';

test('creates, runs, records, and analyzes an experiment', () => {
  const s = store();
  const experiment = experiments.create(
    s,
    {
      site: 'example.com',
      name: 'CTA copy',
      hypothesis: 'A clearer CTA increases affiliate clicks',
      primary_metric: 'affiliate_click',
      variants: [{ key: 'control' }, { key: 'clear_cta' }],
      minimum_samples: 50,
    },
    known
  );
  experiments.transition(s, experiment.experiment_id, 'running');
  experiments.recordEvent(
    s,
    {
      experiment_id: experiment.experiment_id,
      site: 'example.com',
      variant: 'control',
      converted: false,
    },
    known
  );
  experiments.recordEvent(
    s,
    {
      experiment_id: experiment.experiment_id,
      site: 'example.com',
      variant: 'clear_cta',
      converted: true,
    },
    known
  );
  const result = experiments.analyze(s, experiment.experiment_id);
  assert.equal(result.variants[1].conversions, 1);
  assert.equal(result.sample_ready, false);
  assert.equal(experiments.summary(s).running, 1);
  s.close();
});
