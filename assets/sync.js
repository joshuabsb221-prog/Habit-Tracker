/* Orbit — optional account and cross-device sync.
 *
 * Talks to Supabase over plain REST, so there is no SDK to bundle and no build
 * step: fetch, a public anon key, and row-level security doing the fencing.
 *
 * Sign-in never involves clicking a link. A magic link opens the system browser,
 * and an installed home-screen app — iOS especially — keeps its own storage jar,
 * so the link would sign in a window you are not even looking at. Both routes here
 * stay inside whichever window asked:
 *
 *   password — works on a stock Supabase project with nothing else set up;
 *   code     — a six-digit token typed into the app, which needs custom SMTP,
 *              because Supabase only lets you put {{ .Token }} in an email
 *              template once the project has its own mail server.
 *
 * Merging is done by app.js: every record carries a millisecond stamp and the
 * newest write wins, field by field, so two devices editing the same day keep
 * both edits.
 */
(function () {
'use strict';

var CONFIG_KEY = 'orbit.config.v1';
var SESSION_KEY = 'orbit.session.v1';
var CLOCK_KEY = 'orbit.clock.v1';
var TABLE = 'orbit_state';
var DEBOUNCE_MS = 2500;
var PERIODIC_MS = 5 * 60 * 1000;
var TIMEOUT_MS = 15000;

var api = null;                 // the handle app.js passes to attach()
var session = null;             // { access_token, refresh_token, expires_at, user }
var listeners = [];
var status = 'idle';            // idle | syncing | synced | offline | error
var errorText = '';
var noticeText = '';
var lastSyncedAt = 0;
var syncing = false, queued = false, dirty = false, applyingRemote = false;
var timer = null, periodic = null;
var clockOffset = 0;
var pending = { mode: 'password', stage: 'email', email: '', busy: false, message: '' };

/* ---------- little helpers ---------- */

function read(key, fallback) {
  try { var raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
  catch (e) { return fallback; }
}
function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch (e) { /* private mode, quota — sync simply stays off */ }
}
function emit() { listeners.forEach(function (fn) { try { fn(snapshot()); } catch (e) {} }); }
function nowSec() { return Math.floor((Date.now() + clockOffset) / 1000); }

/** Config comes from assets/config.js, overridden by anything set in Settings. */
function config() {
  var file = window.ORBIT_CONFIG || {};
  var saved = read(CONFIG_KEY, {}) || {};
  var url = (saved.url || file.supabaseUrl || '').replace(/\/+$/, '');
  var key = saved.key || file.supabaseAnonKey || '';
  return { url: url, key: key, fromFile: !saved.url && !!file.supabaseUrl };
}
function configured() { var c = config(); return !!(c.url && c.key); }

function setConfig(url, key) {
  url = (url || '').trim().replace(/\/+$/, '');
  key = (key || '').trim();
  if (!url && !key) { write(CONFIG_KEY, null); emit(); return { ok: true }; }
  if (!/^https:\/\/[^\s/]+$/.test(url)) return { ok: false, error: 'That does not look like a project URL (https://…supabase.co)' };
  if (key.length < 20) return { ok: false, error: 'That anon key looks too short' };
  write(CONFIG_KEY, { url: url, key: key });
  emit();
  return { ok: true };
}

/* ---------- transport ---------- */

function request(path, opts) {
  var c = config();
  opts = opts || {};
  var headers = { apikey: c.key, 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
  if (opts.prefer) headers.Prefer = opts.prefer;

  var controller = ('AbortController' in window) ? new AbortController() : null;
  var timeoutId = controller ? setTimeout(function () { controller.abort(); }, TIMEOUT_MS) : null;

  return fetch(c.url + path, {
    method: opts.method || 'GET',
    headers: headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: controller ? controller.signal : undefined,
    cache: 'no-store'
  }).then(function (res) {
    if (timeoutId) clearTimeout(timeoutId);
    // Trust the server's clock over the device's: merges are stamp comparisons.
    var date = res.headers.get('date');
    if (date) {
      var skew = Date.parse(date) - Date.now();
      if (!isNaN(skew) && Math.abs(skew) > 2000) { clockOffset = skew; write(CLOCK_KEY, skew); }
    }
    return res.text().then(function (text) {
      var body = null;
      if (text) { try { body = JSON.parse(text); } catch (e) { body = text; } }
      if (!res.ok) {
        var err = new Error(messageFor(res.status, body));
        err.status = res.status;
        err.body = body;
        throw err;
      }
      return body;
    });
  }, function (e) {
    if (timeoutId) clearTimeout(timeoutId);
    var err = new Error(e && e.name === 'AbortError' ? 'The server took too long to answer' : 'No connection');
    err.offline = true;
    throw err;
  });
}

function messageFor(statusCode, body) {
  var msg = (body && (body.msg || body.message || body.error_description || body.error || body.hint)) || '';
  if (statusCode === 429) return 'Too many attempts — wait a minute and try again';
  if (statusCode === 403 || statusCode === 401) return msg || 'That code is wrong or has expired';
  if (statusCode === 404) return 'The sync table is missing — run the SQL from the README';
  if (statusCode === 0) return 'No connection';
  return msg || ('Server error ' + statusCode);
}

/* ---------- session ---------- */

function loadSession() {
  session = read(SESSION_KEY, null);
  clockOffset = read(CLOCK_KEY, 0) || 0;
  if (session && !session.access_token) session = null;
}
function storeSession(s) {
  if (!s) { session = null; write(SESSION_KEY, null); return; }
  session = {
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_at: s.expires_at || (nowSec() + (s.expires_in || 3600)),
    user: { id: s.user && s.user.id, email: s.user && s.user.email }
  };
  write(SESSION_KEY, session);
}

/** Returns a usable access token, refreshing it first when it is close to expiry. */
function token() {
  if (!session) return Promise.reject(new Error('Not signed in'));
  if (session.expires_at - 60 > nowSec()) return Promise.resolve(session.access_token);
  return request('/auth/v1/token?grant_type=refresh_token', {
    method: 'POST', body: { refresh_token: session.refresh_token }
  }).then(function (res) {
    storeSession(res);
    return session.access_token;
  }, function (e) {
    if (e.offline) throw e;
    storeSession(null);                       // the refresh token is dead: sign out cleanly
    status = 'error';
    errorText = 'Signed out — please sign in again';
    emit();
    throw e;
  });
}

/* ---------- sign-in ---------- */

function validCredentials(email, password, minLen) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) return 'Enter a valid email address';
  if (!password || password.length < minLen) return 'Password must be at least ' + minLen + ' characters';
  return '';
}

/** Sign in with a password. Nothing is emailed, so this works on a bare project. */
function signIn(email, password) {
  email = (email || '').trim();
  var bad = validCredentials(email, password, 6);
  if (bad) { pending.message = bad; emit(); return Promise.resolve(false); }
  pending.busy = true; pending.message = ''; emit();

  return request('/auth/v1/token?grant_type=password', {
    method: 'POST', body: { email: email, password: password }
  }).then(function (res) { return finishSignIn(res); }, function (e) {
    pending.busy = false;
    pending.message = /invalid login/i.test(e.message)
      ? 'Wrong email or password — or use Create account if this is a new device family'
      : e.message;
    emit();
    return false;
  });
}

/** Create the account. With email confirmation off, Supabase signs you straight in. */
function signUp(email, password) {
  email = (email || '').trim();
  var bad = validCredentials(email, password, 8);
  if (bad) { pending.message = bad; emit(); return Promise.resolve(false); }
  pending.busy = true; pending.message = ''; emit();

  return request('/auth/v1/signup', {
    method: 'POST', body: { email: email, password: password }
  }).then(function (res) {
    if (!res || !res.access_token) {
      // The project still has "Confirm email" on, so it emailed a link instead of a session.
      pending.busy = false;
      pending.message = 'Account made, but the project wants an emailed confirmation. ' +
        'Turn off Authentication → Sign In / Providers → Email → Confirm email, then sign in.';
      emit();
      return false;
    }
    return finishSignIn(res);
  }, function (e) {
    pending.busy = false;
    pending.message = /already registered|already exists/i.test(e.message)
      ? 'That account exists — sign in instead'
      : e.message;
    emit();
    return false;
  });
}

function finishSignIn(res) {
  storeSession(res);
  pending = { mode: pending.mode, stage: 'email', email: '', busy: false, message: '' };
  noticeText = 'Signed in. Merging this device with the account…';
  emit();
  dirty = true;                                 // always push once, to create or update the row
  return syncNow('sign-in').then(function () {
    noticeText = '';
    emit();
    return true;
  });
}

function setMode(mode) {
  pending.mode = mode === 'code' ? 'code' : 'password';
  pending.stage = 'email';
  pending.message = '';
  emit();
}

function sendCode(email) {
  email = (email || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    pending.message = 'Enter a valid email address';
    emit();
    return Promise.resolve(false);
  }
  pending.busy = true; pending.message = ''; emit();
  return request('/auth/v1/otp', {
    method: 'POST',
    body: { email: email, create_user: true }
  }).then(function () {
    pending.busy = false;
    pending.stage = 'code';
    pending.email = email;
    pending.message = 'Code sent to ' + email + '. It expires in an hour.';
    emit();
    return true;
  }, function (e) {
    pending.busy = false;
    pending.message = e.message;
    emit();
    return false;
  });
}

/**
 * Verify the typed code. Supabase types the token differently depending on whether
 * the address was already registered, so try the plausible ones in order.
 */
function verifyCode(code) {
  code = (code || '').replace(/\D/g, '');
  if (code.length < 6) {
    pending.message = 'The code is six digits';
    emit();
    return Promise.resolve(false);
  }
  pending.busy = true; pending.message = ''; emit();

  var types = ['email', 'magiclink', 'signup'], i = 0;
  var attempt = function () {
    return request('/auth/v1/verify', {
      method: 'POST',
      body: { type: types[i], email: pending.email, token: code }
    }).catch(function (e) {
      i++;
      if (i < types.length && !e.offline) return attempt();
      throw e;
    });
  };

  return attempt().then(function (res) {
    return finishSignIn(res);
  }, function (e) {
    pending.busy = false;
    pending.message = e.message;
    emit();
    return false;
  });
}

function cancelCode() {
  pending = { mode: pending.mode, stage: 'email', email: '', busy: false, message: '' };
  emit();
}

function signOut(wipeLocal) {
  var t = session && session.access_token;
  storeSession(null);
  status = 'idle'; errorText = ''; lastSyncedAt = 0;
  if (t) request('/auth/v1/logout', { method: 'POST', token: t }).catch(function () {});
  if (wipeLocal && api) api.wipeLocal();
  emit();
}

/* ---------- the sync itself ---------- */

function pull(accessToken) {
  return request('/rest/v1/' + TABLE + '?user_id=eq.' + encodeURIComponent(session.user.id) + '&select=doc,rev', {
    token: accessToken
  }).then(function (rows) { return (rows && rows[0]) || null; });
}

function pushNew(accessToken, doc) {
  return request('/rest/v1/' + TABLE, {
    method: 'POST', token: accessToken, prefer: 'return=representation',
    body: { user_id: session.user.id, doc: doc, rev: 1 }
  }).then(function (rows) { return (rows && rows[0]) || null; });
}

/** Compare-and-set on rev: an empty result means another device wrote first. */
function pushOver(accessToken, doc, seenRev) {
  return request('/rest/v1/' + TABLE +
    '?user_id=eq.' + encodeURIComponent(session.user.id) + '&rev=eq.' + seenRev, {
    method: 'PATCH', token: accessToken, prefer: 'return=representation',
    body: { doc: doc, rev: seenRev + 1 }
  }).then(function (rows) { return (rows && rows[0]) || null; });
}

function syncNow(reason) {
  if (!configured() || !session || !api) return Promise.resolve(false);
  if (syncing) { queued = true; return Promise.resolve(false); }
  if (navigator.onLine === false) { status = 'offline'; emit(); return Promise.resolve(false); }

  syncing = true;
  status = 'syncing';
  errorText = '';
  emit();

  var attemptsLeft = 3;

  var round = function (accessToken) {
    return pull(accessToken).then(function (row) {
      var changed = false;
      if (row && row.doc) {
        applyingRemote = true;                 // saves caused by the merge must not re-arm a push
        try {
          var merged = api.mergeDoc(row.doc);
          changed = merged.changed;
          if (changed) { api.save(); api.render(); }
        } finally { applyingRemote = false; }
      }
      var mustPush = !row || dirty || changed || reason === 'sign-in';
      if (!mustPush) return true;

      var doc = api.getDoc();
      var p = row ? pushOver(accessToken, doc, row.rev) : pushNew(accessToken, doc);
      return p.then(function (saved) {
        if (saved) { dirty = false; return true; }
        attemptsLeft--;                                  // lost the race — merge their write and retry
        if (attemptsLeft <= 0) throw new Error('Another device kept writing — try again in a moment');
        return round(accessToken);
      }, function (e) {
        if (e.status === 409 && attemptsLeft-- > 0) return round(accessToken);
        throw e;
      });
    });
  };

  return token().then(round).then(function () {
    syncing = false;
    lastSyncedAt = Date.now();
    status = 'synced';
    emit();
    if (queued) { queued = false; setTimeout(function () { syncNow('queued'); }, 400); }
    return true;
  }, function (e) {
    syncing = false;
    status = e.offline ? 'offline' : 'error';
    errorText = e.message;
    emit();
    return false;
  });
}

function schedule() {
  if (!session || !configured()) return;
  dirty = true;
  status = status === 'syncing' ? status : 'pending';
  emit();
  clearTimeout(timer);
  timer = setTimeout(function () { syncNow('local-change'); }, DEBOUNCE_MS);
}

/* ---------- the handle app.js reads ---------- */

function snapshot() {
  var c = config();
  return {
    configured: configured(),
    url: c.url,
    fromFile: c.fromFile,
    signedIn: !!session,
    email: session ? session.user.email : '',
    status: status,
    statusText: statusText(),
    error: errorText,
    notice: noticeText,
    lastSyncedAt: lastSyncedAt,
    pending: { mode: pending.mode, stage: pending.stage, email: pending.email, busy: pending.busy, message: pending.message }
  };
}

function statusText() {
  if (!configured()) return 'Not set up';
  if (!session) return 'Signed out';
  if (status === 'syncing') return 'Syncing…';
  if (status === 'pending') return 'Waiting to sync';
  if (status === 'offline') return 'Offline — will sync later';
  if (status === 'error') return errorText || 'Sync failed';
  if (lastSyncedAt) return 'Synced ' + agoText(lastSyncedAt);
  return 'Signed in';
}

function agoText(ts) {
  var secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 45) return 'just now';
  if (secs < 3600) return Math.round(secs / 60) + ' min ago';
  if (secs < 86400) return Math.round(secs / 3600) + ' h ago';
  return Math.round(secs / 86400) + ' d ago';
}

function attach(handle) {
  api = handle;
  loadSession();
  emit();

  // These are all no-ops until there is a session, so they can be wired unconditionally —
  // signing in later must not leave the device without its background triggers.
  clearInterval(periodic);
  periodic = setInterval(function () {
    if (document.visibilityState === 'visible') syncNow('periodic');
  }, PERIODIC_MS);

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && Date.now() - lastSyncedAt > 30000) syncNow('foreground');
  });
  window.addEventListener('online', function () { syncNow('online'); });
  window.addEventListener('offline', function () {
    if (session && status !== 'syncing') { status = 'offline'; emit(); }
  });

  if (session && configured()) syncNow('startup');
}

window.OrbitSync = {
  attach: attach,
  subscribe: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; },
  snapshot: snapshot,
  configured: configured,
  config: config,
  setConfig: setConfig,
  signIn: signIn,
  signUp: signUp,
  setMode: setMode,
  sendCode: sendCode,
  verifyCode: verifyCode,
  cancelCode: cancelCode,
  signOut: signOut,
  syncNow: syncNow,
  /** app.js calls this from save(); a merge in progress must not mark itself dirty. */
  localChanged: function () { if (!applyingRemote) schedule(); },
  clockOffset: function () { return clockOffset; }
};

})();
