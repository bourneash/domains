'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'fleet-dashboard');
const OLD_TOKEN = '1'.repeat(64);
const NEW_TOKEN = '2'.repeat(64);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-dashboard-cli-'));
  const fakeBin = path.join(root, 'bin');
  const envFile = path.join(root, 'tool-fleet-dashboard.env');
  const broker = path.join(root, 'env_broker.py');
  const brokerCalls = path.join(root, 'broker.calls');
  const dockerCalls = path.join(root, 'docker.calls');
  const dockerGids = path.join(root, 'docker.gids');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(envFile, `ALPHA=one\nFD_TOKEN=${OLD_TOKEN}\nOMEGA=two\n`, { mode: 0o400 });

  // Stands in for `env_broker.py set-secret`: the real one writes the token to
  // Vaultwarden and re-renders. Both ends of that are the broker's contract, so
  // the CLI test asserts only that the launcher delegates and then sees the new
  // value in the rendered file it reads.
  fs.writeFileSync(
    broker,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FD_TEST_BROKER_CALLS"
[[ "\${FD_TEST_BROKER_FAIL:-0}" == "1" ]] && exit 1
value="$(cat)"
umask 077
tmp="$(mktemp)"
sed "s/^FD_TOKEN=.*/FD_TOKEN=\${value}/" "$FD_ENV_FILE" > "$tmp"
chmod --reference="$FD_ENV_FILE" "$tmp"
mv "$tmp" "$FD_ENV_FILE"
`,
    { mode: 0o755 }
  );

  fs.writeFileSync(
    path.join(fakeBin, 'docker'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FD_TEST_DOCKER_CALLS"
printf '%s\\n' "\${DOCKER_GID:-}" >> "$FD_TEST_DOCKER_GIDS"
if [[ "\${1:-}" == "inspect" ]]; then
  [[ "\${FD_TEST_CONTAINER_PRESENT:-0}" == "1" ]]
fi
if [[ "\${1:-}" == "compose" && "\${FD_TEST_COMPOSE_FAIL:-0}" == "1" ]]; then
  exit 1
fi
`,
    { mode: 0o755 }
  );
  fs.writeFileSync(path.join(fakeBin, 'curl'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(
    path.join(fakeBin, 'getent'),
    '#!/usr/bin/env bash\nprintf "docker:x:1004:test\\n"\n',
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(fakeBin, 'stat'),
    '#!/usr/bin/env bash\nprintf "%s\\n" "${FD_TEST_SOCKET_GID:-1234}"\n',
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(fakeBin, 'openssl'),
    `#!/usr/bin/env bash\nprintf '%s\\n' '${NEW_TOKEN}'\n`,
    { mode: 0o755 }
  );

  function run(args, extraEnv = {}) {
    const result = spawnSync(SCRIPT, args, {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        FD_ENV_FILE: envFile,
        FD_ENV_BROKER: broker,
        FD_TEST_BROKER_CALLS: brokerCalls,
        FD_HEALTHCHECK_ATTEMPTS: '1',
        FD_TEST_DOCKER_CALLS: dockerCalls,
        FD_TEST_DOCKER_GIDS: dockerGids,
        FD_DOCKER_SOCKET: path.join(root, 'docker.sock'),
        ...extraEnv,
      },
    });
    return {
      ...result,
      calls: fs.existsSync(dockerCalls) ? fs.readFileSync(dockerCalls, 'utf8') : '',
      brokerCalls: fs.existsSync(brokerCalls) ? fs.readFileSync(brokerCalls, 'utf8') : '',
      gids: fs.existsSync(dockerGids) ? fs.readFileSync(dockerGids, 'utf8') : '',
    };
  }

  return { root, envFile, broker, run };
}

test('up always supplies the shared env file and waits for health', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));

  const result = f.run(['up']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, new RegExp(`^compose --env-file ${f.envFile} up -d panel$`, 'm'));
  assert.match(result.gids, /^1234$/m);
  assert.match(result.stdout, /Fleet Dashboard ready/);
});

test('socket numeric GID overrides a mismatched named docker group', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));

  const result = f.run(['up'], { FD_TEST_SOCKET_GID: '4321' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.gids, /^4321$/m);
  assert.doesNotMatch(result.gids, /^1004$/m);
});

test('restart starts an absent panel and restarts an existing one', t => {
  const absent = fixture();
  const present = fixture();
  t.after(() => fs.rmSync(absent.root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(present.root, { recursive: true, force: true }));

  const absentResult = absent.run(['restart']);
  assert.equal(absentResult.status, 0, absentResult.stderr);
  assert.match(absentResult.calls, /compose .* up -d panel/);

  const presentResult = present.run(['restart'], { FD_TEST_CONTAINER_PRESENT: '1' });
  assert.equal(presentResult.status, 0, presentResult.stderr);
  assert.match(presentResult.calls, /compose .* restart panel/);
});

test('rotate-token routes the new secret through the broker, preserves permissions, and recreates the panel', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));

  const result = f.run(['rotate-token']);
  assert.equal(result.status, 0, result.stderr);
  // The vault is FD_TOKEN's only home: rotating by editing the rendered file
  // directly would be reverted by the next `env_broker.py render --all`.
  assert.match(result.brokerCalls, /set-secret --group dashboard --key FD_TOKEN/);
  assert.equal(fs.readFileSync(f.envFile, 'utf8'), `ALPHA=one\nFD_TOKEN=${NEW_TOKEN}\nOMEGA=two\n`);
  assert.equal(fs.statSync(f.envFile).mode & 0o777, 0o400);
  assert.match(result.calls, /compose .* up -d --force-recreate panel/);
  assert.doesNotMatch(result.stdout, new RegExp(NEW_TOKEN));
  assert.match(result.stdout, /Retrieve it locally/);
});

test('token prints the persisted token without involving Docker', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));

  const result = f.run(['token']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${OLD_TOKEN}\n`);
  assert.equal(result.calls, '');
});

test('a failed recreate clearly reports that the newly persisted token remains in effect', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));

  const result = f.run(['rotate-token'], { FD_TEST_COMPOSE_FAIL: '1' });
  assert.equal(result.status, 1);
  assert.match(fs.readFileSync(f.envFile, 'utf8'), new RegExp(`^FD_TOKEN=${NEW_TOKEN}$`, 'm'));
  assert.match(result.stderr, /new token remains persisted/);
  assert.match(result.stderr, /token$/m);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(NEW_TOKEN));
});

test('a broker/vault failure aborts rotation with the old token still in effect', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));

  const result = f.run(['rotate-token'], { FD_TEST_BROKER_FAIL: '1' });
  assert.equal(result.status, 1);
  // Half-rotating is the dangerous outcome: a panel recreated against a token
  // the vault never accepted would lock the operator out with no way back.
  assert.match(fs.readFileSync(f.envFile, 'utf8'), new RegExp(`^FD_TOKEN=${OLD_TOKEN}$`, 'm'));
  assert.match(result.stderr, /rotation failed; FD_TOKEN is unchanged/);
  assert.doesNotMatch(result.calls, /force-recreate/);
});
