'use strict';

// Closes the loop for deployed improvement work without requiring a dashboard
// page to be opened. A result is eligible after 14 days or 100 new GSC
// impressions, whichever comes first. Missing telemetry remains inconclusive;
// it is never coerced to zero or treated as a success.

const analyticsDefault = require('./analytics');
const eventstore = require('./eventstore');
const executive = require('./executive');
const improvements = require('./improvements');
const revenueDefault = require('./revenue');

const MEASUREMENT_DAYS = 14;
const IMPRESSION_THRESHOLD = 100;

function dateOnly(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function deploymentAt(run) {
  return (
    run.outcome?.deployment_verified_at ||
    run.approval?.approved_at ||
    run.updated_at ||
    run.created_at
  );
}

function daysSince(value, now) {
  const elapsed = now.getTime() - Date.parse(value);
  return Number.isFinite(elapsed) ? Math.max(0, elapsed / 86400000) : 0;
}

async function newImpressionsSince(site, since, now, analytics) {
  if (typeof analytics.gscSeries !== 'function') return null;
  const days = Math.max(1, Math.min(400, Math.ceil(daysSince(since, now)) + 1));
  const series = await analytics.gscSeries(site, days);
  if (series?.ok === false || series?.has_data === false || series?.error) return null;
  if (!Array.isArray(series?.records)) return null;
  const cutoff = dateOnly(since);
  return series.records
    .filter(row => String(row.date || '') >= cutoff)
    .reduce((sum, row) => sum + (Number(row.impressions) || 0), 0);
}

async function captureMetrics(root, site, analytics = analyticsDefault, revenue = revenueDefault) {
  const [analyticsResult, revenueResult] = await Promise.all([
    analytics.summary(site, MEASUREMENT_DAYS),
    Promise.resolve(revenue.amazonSummary(root)),
  ]);
  return {
    ...analyticsResult,
    revenue: revenue.siteAttribution(revenueResult, site) || {
      has_data: false,
      site,
    },
  };
}

async function run({
  root,
  now = new Date(),
  analytics = analyticsDefault,
  revenue = revenueDefault,
} = {}) {
  if (!root) throw new Error('measurement runner requires root');
  const store = eventstore.open(root);
  const audit = executive.action(store, {
    actor: 'system',
    action_type: 'observe',
    summary: 'Run due improvement measurements',
    target_type: 'improvement-measurement',
  });
  const results = [];
  try {
    const rows = store
      .listImprovements({ limit: 1000 })
      .filter(row => ['deployed', 'measuring'].includes(row.state));
    for (const row of rows) {
      let current = row;
      if (current.state === 'deployed') {
        const due =
          current.measurement_due || improvements.measurementDate(MEASUREMENT_DAYS, now.getTime());
        current = improvements.transition(store, current.run_id, {
          state: 'measuring',
          measurement_due: due,
          outcome: {
            deployment_verified_at: deploymentAt(current),
            measurement_started_at: now.toISOString(),
          },
        });
      }

      const deployedAt = deploymentAt(current);
      const elapsedDays = daysSince(deployedAt, now);
      const newImpressions = await newImpressionsSince(current.site, deployedAt, now, analytics);
      const due = !current.measurement_due || current.measurement_due <= dateOnly(now);
      const thresholdReached = newImpressions != null && newImpressions >= IMPRESSION_THRESHOLD;
      if (!due && !thresholdReached) {
        results.push({
          run_id: current.run_id,
          site: current.site,
          state: current.state,
          status: 'waiting',
          elapsed_days: Math.round(elapsedDays * 10) / 10,
          new_impressions: newImpressions,
          measurement_due: current.measurement_due,
        });
        continue;
      }

      const currentMetrics = await captureMetrics(root, current.site, analytics, revenue);
      const outcome = improvements.compareOutcome(
        current.baseline?.analytics || {},
        currentMetrics,
        now.toISOString()
      );
      outcome.measurement_gate = {
        ready_reason: thresholdReached ? '100_new_impressions' : '14_days',
        elapsed_days: Math.round(elapsedDays * 10) / 10,
        new_impressions: newImpressions,
        impression_threshold: IMPRESSION_THRESHOLD,
        day_threshold: MEASUREMENT_DAYS,
      };
      const measured = improvements.transition(store, current.run_id, {
        state: outcome.classification,
        outcome,
        measurement_due: null,
      });
      results.push({
        run_id: measured.run_id,
        site: measured.site,
        state: measured.state,
        status: 'measured',
        outcome,
      });
    }
    executive.finishAction(store, audit.action_id, {
      status: 'completed',
      result: { results },
    });
    return { results };
  } catch (error) {
    executive.finishAction(store, audit.action_id, { status: 'failed', error: error.message });
    throw error;
  } finally {
    store.close();
  }
}

module.exports = {
  MEASUREMENT_DAYS,
  IMPRESSION_THRESHOLD,
  deploymentAt,
  daysSince,
  newImpressionsSince,
  captureMetrics,
  run,
};
