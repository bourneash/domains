'use strict';

// Unit tests for the token gate (auth.js) — the highest-risk untested module
// before this: it's the only thing standing between the docker socket / VPN
// network and full fleet control. auth.js reads FD_TOKEN/FD_AUTH/FD_ALLOWED_HOSTS
// from process.env ONCE at require time, so each scenario reloads it fresh
// against a controlled env (see `withAuth`).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const MODPATH = require.resolve('./auth');

// Reload auth.js with a specific env, run `fn(auth)`, then restore process.env
// and the require cache so other tests see the real module again.
function withAuth(envPatch, fn) {
  const saved = { ...process.env };
  for (const k of ['FD_TOKEN', 'FD_AUTH', 'FD_ALLOWED_HOSTS']) delete process.env[k];
  Object.assign(process.env, envPatch);
  delete require.cache[MODPATH];
  const auth = require('./auth');
  try {
    return fn(auth);
  } finally {
    process.env = saved;
    delete require.cache[MODPATH];
  }
}

function mockReq({ headers = {}, hostname, cookie } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  return { headers: h, hostname, path: h.path };
}

/* ---- token gate disabled (no FD_TOKEN) ---- */
test('with no FD_TOKEN, everyone is authed and login says auth not required', () => {
  withAuth({}, auth => {
    assert.equal(auth.authed(mockReq()), true);
    const res = fakeRes();
    auth.loginHandler({ body: {} }, res);
    assert.deepEqual(res.json.mock.calls[0].arguments[0], { ok: true, authRequired: false });
  });
});

/* ---- FD_AUTH=0 explicit off-switch overrides a set FD_TOKEN ---- */
test('FD_AUTH=0 disables the gate even with FD_TOKEN set', () => {
  withAuth({ FD_TOKEN: 'secret123', FD_AUTH: '0' }, auth => {
    assert.equal(auth.TOKEN, null);
    assert.equal(auth.authed(mockReq()), true);
  });
});

/* ---- token gate enabled ---- */
test('tokenValid accepts only the exact configured token', () => {
  withAuth({ FD_TOKEN: 'correct-horse' }, auth => {
    assert.equal(auth.tokenValid('correct-horse'), true);
    assert.equal(auth.tokenValid('wrong'), false);
    assert.equal(auth.tokenValid(''), false);
    assert.equal(auth.tokenValid(undefined), false);
    assert.equal(auth.tokenValid(null), false);
  });
});

test('FD_TOKEN accepts a comma-separated list — any listed token authenticates, the primary still drives the cookie', () => {
  withAuth({ FD_TOKEN: 'human-token, claude-token ,  ' }, auth => {
    assert.equal(auth.tokenValid('human-token'), true);
    assert.equal(auth.tokenValid('claude-token'), true);
    assert.equal(auth.tokenValid('neither'), false);
    assert.equal(auth.authed(mockReq({ headers: { 'x-fd-token': 'claude-token' } })), true);
    assert.equal(auth.TOKEN, 'human-token', 'first token stays primary for the browser cookie');
  });
});

test('authed() accepts a valid x-fd-token header', () => {
  withAuth({ FD_TOKEN: 'correct-horse' }, auth => {
    assert.equal(auth.authed(mockReq({ headers: { 'x-fd-token': 'correct-horse' } })), true);
    assert.equal(auth.authed(mockReq({ headers: { 'x-fd-token': 'nope' } })), false);
    assert.equal(auth.authed(mockReq()), false);
  });
});

test('authed() accepts the httpOnly cookie set by loginHandler, not an arbitrary cookie value', () => {
  withAuth({ FD_TOKEN: 'correct-horse' }, auth => {
    const res = fakeRes();
    auth.loginHandler({ body: { token: 'correct-horse' } }, res);
    const setCookie = res.setHeader.mock.calls[0].arguments[1];
    assert.match(setCookie, /; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000$/);
    const cookieVal = setCookie.match(/^fd_auth=([^;]+)/)[1];
    assert.equal(auth.authed(mockReq({ cookie: `fd_auth=${cookieVal}` })), true);
    // A guessed/forged cookie value must not authenticate.
    assert.equal(auth.authed(mockReq({ cookie: 'fd_auth=deadbeef' })), false);
    // The cookie is an HMAC of a constant, never the raw token — leaking it
    // must not reveal the shared secret.
    assert.notEqual(cookieVal, 'correct-horse');
    assert.equal(
      cookieVal,
      crypto.createHmac('sha256', 'correct-horse').update('fd-auth-v1').digest('hex')
    );
  });
});

test('apiGuard renews a valid browser cookie but does not create one for header clients', () => {
  withAuth({ FD_TOKEN: 'correct-horse' }, auth => {
    const loginRes = fakeRes();
    auth.loginHandler({ body: { token: 'correct-horse' } }, loginRes);
    const cookie = loginRes.setHeader.mock.calls[0].arguments[1].split(';')[0];

    const browserRes = fakeRes();
    let browserNext = false;
    auth.apiGuard({ headers: { cookie }, path: '/api/roles' }, browserRes, () => {
      browserNext = true;
    });
    assert.equal(browserNext, true);
    assert.equal(browserRes.setHeader.mock.callCount(), 1);
    assert.match(browserRes.setHeader.mock.calls[0].arguments[1], /Max-Age=2592000$/);

    const headerRes = fakeRes();
    let headerNext = false;
    auth.apiGuard(
      { headers: { 'x-fd-token': 'correct-horse' }, path: '/api/roles' },
      headerRes,
      () => {
        headerNext = true;
      }
    );
    assert.equal(headerNext, true);
    assert.equal(headerRes.setHeader.mock.callCount(), 0);
  });
});

test('loginHandler rejects a wrong token with 401 and sets no cookie', () => {
  withAuth({ FD_TOKEN: 'correct-horse' }, auth => {
    const res = fakeRes();
    auth.loginHandler({ body: { token: 'wrong' } }, res);
    assert.equal(res.status.mock.calls[0].arguments[0], 401);
    assert.equal(res.setHeader.mock.callCount(), 0);
  });
});

test('authStatus reports authRequired + whether this caller is authed', () => {
  withAuth({ FD_TOKEN: 'correct-horse' }, auth => {
    const res = fakeRes();
    auth.authStatus(mockReq({ headers: { 'x-fd-token': 'correct-horse' } }), res);
    assert.deepEqual(res.json.mock.calls[0].arguments[0], { authRequired: true, authed: true });
  });
});

test('authStatus renews an existing valid browser session', () => {
  withAuth({ FD_TOKEN: 'correct-horse' }, auth => {
    const loginRes = fakeRes();
    auth.loginHandler({ body: { token: 'correct-horse' } }, loginRes);
    const cookie = loginRes.setHeader.mock.calls[0].arguments[1].split(';')[0];

    const res = fakeRes();
    auth.authStatus(mockReq({ cookie }), res);
    assert.deepEqual(res.json.mock.calls[0].arguments[0], { authRequired: true, authed: true });
    assert.equal(res.setHeader.mock.callCount(), 1);
  });
});

/* ---- apiGuard middleware ---- */
test('apiGuard exempts /api/version and /api/login even without a token, blocks other /api/* routes, and passes non-/api/ routes through', () => {
  withAuth({ FD_TOKEN: 'correct-horse' }, auth => {
    const blocked = { headers: {}, path: '/api/roles' };
    const res1 = fakeRes();
    let nextCalled = false;
    auth.apiGuard(blocked, res1, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(res1.status.mock.calls[0].arguments[0], 401);

    const staticReq = { headers: {}, path: '/index.html' };
    const res2 = fakeRes();
    let staticNext = false;
    auth.apiGuard(staticReq, res2, () => {
      staticNext = true;
    });
    assert.equal(staticNext, true);

    const exempt = { headers: {}, path: '/api/version' };
    const res3 = fakeRes();
    let exemptNext = false;
    auth.apiGuard(exempt, res3, () => {
      exemptNext = true;
    });
    assert.equal(exemptNext, true);

    const authedReq = { headers: { 'x-fd-token': 'correct-horse' }, path: '/api/roles' };
    const res4 = fakeRes();
    let authedNext = false;
    auth.apiGuard(authedReq, res4, () => {
      authedNext = true;
    });
    assert.equal(authedNext, true);
  });
});

/* ---- hostGuard: DNS-rebinding defense, always on regardless of FD_TOKEN ---- */
test('hostGuard allows loopback/default hosts and rejects an arbitrary Host header', () => {
  withAuth({}, auth => {
    for (const h of ['127.0.0.1', 'localhost', 'fleet-dashboard']) {
      let called = false;
      auth.hostGuard({ hostname: h, headers: {} }, fakeRes(), () => {
        called = true;
      });
      assert.equal(called, true, `expected ${h} to pass hostGuard`);
    }
    const res = fakeRes();
    let called = false;
    auth.hostGuard({ hostname: 'evil.example.com', headers: {} }, res, () => {
      called = true;
    });
    assert.equal(called, false);
    assert.equal(res.status.mock.calls[0].arguments[0], 403);
  });
});

test('hostGuard honours FD_ALLOWED_HOSTS, and "*" disables the check', () => {
  withAuth({ FD_ALLOWED_HOSTS: 'my.custom.host' }, auth => {
    let called = false;
    auth.hostGuard({ hostname: 'my.custom.host', headers: {} }, fakeRes(), () => {
      called = true;
    });
    assert.equal(called, true);
  });
  withAuth({ FD_ALLOWED_HOSTS: '*' }, auth => {
    let called = false;
    auth.hostGuard({ hostname: 'literally.anything', headers: {} }, fakeRes(), () => {
      called = true;
    });
    assert.equal(called, true);
  });
});

test('safeEqual-backed comparisons never throw on type/length mismatches', () => {
  withAuth({ FD_TOKEN: 'correct-horse' }, auth => {
    assert.doesNotThrow(() => auth.tokenValid(12345));
    assert.doesNotThrow(() => auth.tokenValid({}));
    assert.equal(auth.tokenValid(12345), false);
  });
});

// Minimal mock res compatible with node:test's built-in mock, avoiding a new dep.
const { mock } = require('node:test');
function fakeRes() {
  const res = {};
  res.status = mock.fn(() => res);
  res.json = mock.fn(() => res);
  res.setHeader = mock.fn(() => res);
  return res;
}
