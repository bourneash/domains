'use strict';

const fs = require('node:fs');
const path = require('node:path');

function config(root, env = process.env) {
  let file = '';
  try {
    file = fs.readFileSync(path.join(root, '.env'), 'utf8');
  } catch {}
  const fromFile = key => {
    const match = file.match(new RegExp(`^\\s*${key}\\s*=\\s*["']?([^\\s"'#]+)`, 'm'));
    return match?.[1] || '';
  };
  return {
    token: env.SLACK_BOT_TOKEN || fromFile('SLACK_BOT_TOKEN'),
    channel:
      env.SLACK_CHANNEL_FLEET_OPS ||
      fromFile('SLACK_CHANNEL_FLEET_OPS') ||
      env.SLACK_CHANNEL_FLEET ||
      fromFile('SLACK_CHANNEL_FLEET') ||
      '',
  };
}

function failureStreak(runs) {
  const streak = [];
  for (const run of runs) {
    if (run.status !== 'failed') break;
    streak.push(run);
  }
  return streak;
}

async function alertConsecutiveFailures(
  store,
  { agent, runId, root, report, fetchImpl = fetch, env = process.env }
) {
  const runs = store.listAgentRuns({ agent_id: agent.agent_id, limit: 1000 });
  const streak = failureStreak(runs);
  if (streak.length < 2 || streak[0]?.run_id !== runId)
    return { attempted: false, streak: streak.length };
  if (streak.some(run => run.result?.overwatch_alert?.sent)) {
    return { attempted: false, streak: streak.length, reason: 'already-alerted' };
  }
  const { token, channel } = config(root, env);
  let result = { attempted: true, sent: false, streak: streak.length, channel };
  if (!token || !channel) {
    result.reason = !token ? 'SLACK_BOT_TOKEN unavailable' : 'fleet Slack channel not configured';
  } else {
    const error = String(
      report?.after?.cycles?.[0]?.error || report?.delivery_error || streak[0]?.error || ''
    ).slice(0, 350);
    const text = `🚨 Exec Overwatch failed ${streak.length} consecutive runs. Executive delivery may be stalled. Latest: ${error || 'no verified delivery'}. Run ${runId}. Check the executive runner and Overwatch reports.`;
    try {
      const response = await fetchImpl('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, text }),
        signal: AbortSignal.timeout(10000),
      });
      const body = await response.json();
      if (response.ok && body?.ok) result.sent = true;
      else result.reason = body?.error || `HTTP ${response.status}`;
    } catch (error) {
      result.reason = String(error.message || error);
    }
  }
  result.at = new Date().toISOString();
  const current = store.getAgentRun(runId);
  store.updateAgentRun(runId, { result: { ...current.result, overwatch_alert: result } });
  return result;
}

module.exports = { config, failureStreak, alertConsecutiveFailures };
