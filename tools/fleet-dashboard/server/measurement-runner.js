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

// Data-hub calls can briefly fail while the collector/API is restarting. A
// transient read failure must not become the only observation attached to a
// live improvement, so retry read-only telemetry a small, bounded number of
// times. This does not retry writes or alter the measurement gate.
async function retryTelemetry(read, { attempts = 3, delayMs = 250 } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    try {
      const result = await read();
      // `has_data: false` is a valid answer for an unconfigured source, not a
      // transient transport failure. Retrying it only adds latency and load.
      const failed = result?.ok === false || result?.error;
      if (!failed) return result;
      last = result;
    } catch (error) {
      last = { ok: false, error: String(error.message || error) };
    }
    if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
  }
  return last || { ok: false, error: 'telemetry read failed' };
}

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

function compactObservation(metrics = {}, { captured_at, new_impressions } = {}) {
  const analytics = metrics || {};
  const revenue = metrics.revenue || {};
  return {
    captured_at: captured_at || new Date().toISOString(),
    new_impressions: new_impressions == null ? null : Number(new_impressions),
    analytics: {
      has_data: analytics.has_data !== false,
      sessions: Number.isFinite(Number(analytics.sessions)) ? Number(analytics.sessions) : null,
      impressions: Number.isFinite(Number(analytics.impressions))
        ? Number(analytics.impressions)
        : null,
      clicks: Number.isFinite(Number(analytics.clicks)) ? Number(analytics.clicks) : null,
      conversions: Number.isFinite(Number(analytics.conversions))
        ? Number(analytics.conversions)
        : null,
      window_days: Number.isFinite(Number(analytics.window_days))
        ? Number(analytics.window_days)
        : null,
      error: analytics.error || null,
    },
    revenue: {
      has_data: revenue.has_data === true,
      site: revenue.site || null,
      clicks: Number.isFinite(Number(revenue.clicks)) ? Number(revenue.clicks) : null,
      ordered_items: Number.isFinite(Number(revenue.ordered_items))
        ? Number(revenue.ordered_items)
        : null,
      shipped_items: Number.isFinite(Number(revenue.shipped_items))
        ? Number(revenue.shipped_items)
        : null,
      commission_income: Number.isFinite(Number(revenue.commission_income))
        ? Number(revenue.commission_income)
        : null,
      attribution_status: revenue.attribution_status || null,
      attribution_complete: revenue.attribution_complete === true,
      fetched_at: revenue.fetched_at || null,
    },
  };
}

function recordObservation(store, current, metrics, { capturedAt, newImpressions } = {}) {
  const observation = compactObservation(metrics, {
    captured_at: capturedAt,
    new_impressions: newImpressions,
  });
  const existing = Array.isArray(current.outcome?.measurement_observations)
    ? current.outcome.measurement_observations
    : [];
  const outcome = {
    ...(current.outcome || {}),
    last_observed_at: observation.captured_at,
    measurement_observations: [...existing, observation].slice(-30),
  };
  const updated = store.updateImprovement(current.run_id, { outcome });
  store.record({
    event_type: 'improvement.measurement_observed',
    source: 'improvement-measurement',
    site_id: `site:${current.site}`,
    entity_type: 'improvement',
    entity_id: current.run_id,
    correlation_id: current.correlation_id,
    payload: {
      captured_at: observation.captured_at,
      new_impressions: observation.new_impressions,
      analytics_has_data: observation.analytics.has_data,
      revenue_has_data: observation.revenue.has_data,
    },
  });
  return updated;
}

async function newImpressionsSince(site, since, now, analytics) {
  if (typeof analytics.gscSeries !== 'function') return null;
  const days = Math.max(1, Math.min(400, Math.ceil(daysSince(since, now)) + 1));
  const series = await retryTelemetry(() => analytics.gscSeries(site, days));
  if (series?.ok === false || series?.has_data === false || series?.error) return null;
  if (!Array.isArray(series?.records)) return null;
  const cutoff = dateOnly(since);
  return series.records
    .filter(row => String(row.date || '') >= cutoff)
    .reduce((sum, row) => sum + (Number(row.impressions) || 0), 0);
}

async function captureMetrics(root, site, analytics = analyticsDefault, revenue = revenueDefault) {
  const [analyticsResult, revenueResult] = await Promise.all([
    retryTelemetry(() => analytics.summary(site, MEASUREMENT_DAYS)),
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
        // Capture a bounded, read-only interim sample every measurement tick.
        // This gives the executive team immediate evidence about freshness,
        // attribution, and direction without prematurely declaring success.
        const observedMetrics = await captureMetrics(root, current.site, analytics, revenue);
        current = recordObservation(store, current, observedMetrics, {
          capturedAt: now.toISOString(),
          newImpressions,
        });
        results.push({
          run_id: current.run_id,
          site: current.site,
          state: current.state,
          status: 'waiting',
          telemetry_status: newImpressions == null ? 'unavailable' : 'available',
          elapsed_days: Math.round(elapsedDays * 10) / 10,
          new_impressions: newImpressions,
          measurement_due: current.measurement_due,
          last_observed_at: current.outcome?.last_observed_at || null,
          observation_count: current.outcome?.measurement_observations?.length || 0,
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
  compactObservation,
  retryTelemetry,
  recordObservation,
  newImpressionsSince,
  captureMetrics,
  run,
};
