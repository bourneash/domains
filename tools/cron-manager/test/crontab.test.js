const { test } = require('node:test');
const assert = require('node:assert');
const { parseCrontab, isValidCron } = require('../server/crontab');

const SAMPLE = [
  '# header prose, not a cron line',
  'COMPOSE_PROJECT_NAME=americastrikes-ops',
  '',
  '0 6,8,10,12,14,16,18,20,22 * * *  bash ops/scripts/run-worker.sh update',
  '0 6 * * 1     bash ops/scripts/run-worker.sh planner',
  '# 0 7 * * *     bash ops/scripts/run-worker.sh newsletter-editor',
  '*/15 * * * *  bash ops/scripts/run-scraper.sh',
  "*/5 * * * *   bash -c '[ -f .deploy-needed ] || exit 0; bash ops/scripts/run-worker.sh deployer'",
  '0 4 * * 0   find ops/logs -type f -mtime +14 -delete',
].join('\n');

test('isValidCron accepts 5-field expressions and rejects prose', () => {
  assert.ok(isValidCron('0 6 * * 1'));
  assert.ok(isValidCron('*/15 * * * *'));
  assert.ok(isValidCron('0 6,8,10,12,14,16,18,20,22 * * *'));
  assert.ok(!isValidCron('Each cron line invokes docker'));
  assert.ok(!isValidCron('0 6 * *'));            // only 4 fields
});

test('parseCrontab skips prose, blanks, and env lines', () => {
  const { entries } = parseCrontab(SAMPLE);
  // 5 active cron lines (update, planner, scraper, deployer, prune-find)
  // + 1 commented cron line (newsletter-editor) = 6 entries
  assert.strictEqual(entries.length, 6);
});

test('parseCrontab extracts schedule, command, role', () => {
  const { entries } = parseCrontab(SAMPLE);
  const planner = entries.find(e => e.role === 'planner');
  assert.strictEqual(planner.schedule, '0 6 * * 1');
  assert.strictEqual(planner.command, 'bash ops/scripts/run-worker.sh planner');
  assert.strictEqual(planner.commented, false);
});

test('parseCrontab surfaces commented-out cron lines with commented=true', () => {
  const { entries } = parseCrontab(SAMPLE);
  const news = entries.find(e => e.role === 'newsletter-editor');
  assert.strictEqual(news.commented, true);
});

test('parseCrontab extracts role from a bash -c wrapped run-worker call', () => {
  const { entries } = parseCrontab(SAMPLE);
  const dep = entries.find(e => e.role === 'deployer');
  assert.ok(dep, 'deployer role found inside bash -c wrapper');
  assert.strictEqual(dep.schedule, '*/5 * * * *');
});

test('parseCrontab sets role=null for non run-worker commands', () => {
  const { entries } = parseCrontab(SAMPLE);
  const scraper = entries.find(e => e.command.includes('run-scraper.sh'));
  assert.strictEqual(scraper.role, null);
  const prune = entries.find(e => e.command.startsWith('find '));
  assert.strictEqual(prune.role, null);
});

test('parseCrontab records lineIndex pointing at the source rawLine', () => {
  const { entries, lines } = parseCrontab(SAMPLE);
  for (const e of entries) {
    assert.strictEqual(lines[e.lineIndex], e.rawLine);   // index resolves to its own line
    assert.ok(e.rawLine.includes(e.command));            // command came from that line
  }
});

const { commentLine, uncommentLine, editSchedule, removeLine } = require('../server/crontab');

const TWO = [
  '# header',
  '0 6 * * 1     bash ops/scripts/run-worker.sh planner',
  '*/15 * * * *  bash ops/scripts/run-scraper.sh',
].join('\n');

test('commentLine prefixes the target line and preserves all others', () => {
  const out = commentLine(TWO, 1, '0 6 * * 1     bash ops/scripts/run-worker.sh planner');
  const lines = out.split('\n');
  assert.strictEqual(lines[0], '# header');                                  // untouched
  assert.strictEqual(lines[1], '# 0 6 * * 1     bash ops/scripts/run-worker.sh planner');
  assert.strictEqual(lines[2], '*/15 * * * *  bash ops/scripts/run-scraper.sh'); // untouched
});

test('uncommentLine reverses commentLine exactly', () => {
  const commented = commentLine(TWO, 1, '0 6 * * 1     bash ops/scripts/run-worker.sh planner');
  const back = uncommentLine(commented, 1, '# 0 6 * * 1     bash ops/scripts/run-worker.sh planner');
  assert.strictEqual(back, TWO);
});

test('editSchedule replaces only the schedule, keeps the command', () => {
  const out = editSchedule(TWO, 1, '0 7 * * 2', '0 6 * * 1     bash ops/scripts/run-worker.sh planner');
  const lines = out.split('\n');
  assert.strictEqual(lines[1], '0 7 * * 2  bash ops/scripts/run-worker.sh planner');
  assert.strictEqual(lines[2], '*/15 * * * *  bash ops/scripts/run-scraper.sh'); // untouched
});

test('editSchedule rejects an invalid cron expression', () => {
  assert.throws(() => editSchedule(TWO, 1, 'not a cron', '0 6 * * 1     bash ops/scripts/run-worker.sh planner'),
    /invalid cron/i);
});

test('rewrites reject when expected line does not match (concurrent edit guard)', () => {
  assert.throws(() => commentLine(TWO, 1, 'STALE LINE'), /changed/i);
  assert.throws(() => editSchedule(TWO, 1, '0 7 * * 2', 'STALE LINE'), /changed/i);
  assert.throws(() => removeLine(TWO, 1, 'STALE LINE'), /changed/i);
});

test('removeLine deletes the target line only', () => {
  const out = removeLine(TWO, 2, '*/15 * * * *  bash ops/scripts/run-scraper.sh');
  assert.strictEqual(out, ['# header', '0 6 * * 1     bash ops/scripts/run-worker.sh planner'].join('\n'));
});
