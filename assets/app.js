/* Orbit — a hand-inked celestial habit chart.
   Vanilla JS, no build step, no framework.
   All state lives in localStorage under "orbit.v1"; when an account is connected,
   assets/sync.js mirrors that same document to Supabase. Every record carries a
   millisecond stamp so two devices merge field by field, newest write winning. */
(function () {
'use strict';

/* ================================================================
   1. Constants
   ================================================================ */

var STORAGE_KEY = 'orbit.v1';
var ROLLOVER_HOUR = 2;      // the day rolls over at 02:00 local time
var BACKFILL_DAYS = 7;      // today plus the previous 7 days are editable
var EXPORT_NAME = 'orbit-backup.json';

var COLORS = {
  blue:       { ink: '#9FB3C0', label: 'Dusty blue' },
  tan:        { ink: '#D9B48B', label: 'Warm tan' },
  terracotta: { ink: '#C87F5E', label: 'Terracotta' },
  sage:       { ink: '#B6C2A8', label: 'Soft sage' },
  ink:        { ink: '#2C2A26', label: 'Deep ink' }
};
var COLOR_KEYS = Object.keys(COLORS);
var RINGS = ['solid', 'dash', 'dot', 'double', 'tilt'];

var SEED_HABITS = [
  { id: 'h-malay',   name: 'Learning Malay',       type: 'timed',  cadence: 'daily',  weeklyTarget: 7, min: 15, discharge: 1, color: 'sage',       ring: 'solid'  },
  { id: 'h-sqe',     name: 'SQE Revision',         type: 'timed',  cadence: 'daily',  weeklyTarget: 7, min: 30, discharge: 2, color: 'blue',       ring: 'double' },
  { id: 'h-phil',    name: 'Philosophy Reading',   type: 'timed',  cadence: 'daily',  weeklyTarget: 7, min: 20, discharge: 1, color: 'tan',        ring: 'dot'    },
  { id: 'h-eat',     name: 'Healthy Eating',       type: 'binary', cadence: 'daily',  weeklyTarget: 7, min: 0,  discharge: 0, color: 'sage',       ring: 'solid'  },
  { id: 'h-gym',     name: 'Gym',                  type: 'binary', cadence: 'weekly', weeklyTarget: 4, min: 0,  discharge: 0, color: 'terracotta', ring: 'tilt'   },
  { id: 'h-moist',   name: 'Moisturising',         type: 'binary', cadence: 'daily',  weeklyTarget: 7, min: 0,  discharge: 0, color: 'tan',        ring: 'dash'   },
  { id: 'h-reply',   name: 'Replying to Messages', type: 'binary', cadence: 'daily',  weeklyTarget: 7, min: 0,  discharge: 1, color: 'blue',       ring: 'dot'    }
];

var DEFAULT_SETTINGS = {
  quotaEnabled: true,
  busyQuota: 2,
  veryBusyQuota: 1
};

/* ================================================================
   2. Small utilities
   ================================================================ */

var $ = function (sel, root) { return (root || document).querySelector(sel); };
var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function round1(v) { return Math.round(v * 10) / 10; }
function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function uid(prefix) {
  return (prefix || 'h') + '-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}
function fmtPoints(p) {
  var r = Math.round(p * 10) / 10;
  return (Math.abs(r - Math.round(r)) < 0.001) ? String(Math.round(r)) : r.toFixed(1);
}

/* --- dates, all on the 02:00-shifted boundary --- */
function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function parseYmd(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
function shiftedDate(when) {
  var now = when || new Date();
  return ymd(new Date(now.getTime() - ROLLOVER_HOUR * 3600 * 1000));
}
function today() { return shiftedDate(); }
function addDays(s, n) { var d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); }
function daysBetween(a, b) { return Math.round((parseYmd(b) - parseYmd(a)) / 86400000); }
function weekStart(s) { var d = parseYmd(s); return addDays(s, -((d.getDay() + 6) % 7)); }  // Monday
function monthStart(s) { return s.slice(0, 8) + '01'; }
function daysInMonth(s) { var d = parseYmd(s); return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); }
function weekDates(ws) { var out = [], i; for (i = 0; i < 7; i++) out.push(addDays(ws, i)); return out; }

var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
var DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function dowOf(s) { return DOW[(parseYmd(s).getDay() + 6) % 7]; }
function longDate(s) {
  var d = parseYmd(s);
  return dowOf(s) + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3);
}
function relativeDay(s) {
  var n = daysBetween(s, today());
  if (n === 0) return 'Today';
  if (n === 1) return 'Yesterday';
  return n + ' days ago';
}
/** When the busy-day quota next resets: 02:00 on the coming Monday. */
function quotaResetText() {
  var nextMon = addDays(weekStart(today()), 7);
  return 'Resets ' + longDate(nextMon) + ' at 02:00';
}

/* ================================================================
   3. State
   ================================================================ */

var state = null;

function freshState() {
  var start = today();
  return {
    version: 1,
    createdAt: start,
    habits: SEED_HABITS.map(function (h, i) {
      var c = {};
      for (var k in h) c[k] = h[k];
      c.order = i;
      c.archived = false;
      c.createdAt = start;
      c.t = 0;                       // never written by this device yet, so any edit wins
      return c;
    }),
    days: {},
    settings: { quotaEnabled: DEFAULT_SETTINGS.quotaEnabled, busyQuota: DEFAULT_SETTINGS.busyQuota, veryBusyQuota: DEFAULT_SETTINGS.veryBusyQuota },
    tombstones: { habits: {} },
    deviceId: uid('dev'),
    meta: { peakPoints: 0, level: 1, settingsT: 0 }
  };
}

/**
 * Wall-clock milliseconds, corrected by the offset sync.js measures against the
 * server's clock. Every merge decision is a comparison of these stamps, so a
 * device with a badly wrong clock would otherwise win or lose everything.
 */
function now() {
  return Date.now() + (window.OrbitSync ? window.OrbitSync.clockOffset() : 0);
}

/**
 * A stamp that is guaranteed to beat the entry it replaces. Two devices' clocks
 * never agree exactly, so without this a tap could land "before" the record it is
 * editing and be undone by the next sync — the edit would vanish in front of you.
 */
function stampAfter(prev) {
  var t = now();
  return t > (prev || 0) ? t : (prev || 0) + 1;
}

function normalise(s) {
  if (!s || typeof s !== 'object') return freshState();
  var base = freshState();
  s.version = 1;
  s.createdAt = s.createdAt || base.createdAt;
  s.days = (s.days && typeof s.days === 'object') ? s.days : {};
  s.settings = s.settings || {};
  ['quotaEnabled', 'busyQuota', 'veryBusyQuota'].forEach(function (k) {
    if (typeof s.settings[k] === 'undefined') s.settings[k] = DEFAULT_SETTINGS[k];
  });
  s.meta = s.meta || { peakPoints: 0, level: 1, settingsT: 0 };
  s.meta.settingsT = +s.meta.settingsT || 0;
  s.tombstones = s.tombstones || { habits: {} };
  s.tombstones.habits = s.tombstones.habits || {};
  s.deviceId = s.deviceId || uid('dev');
  if (!Array.isArray(s.habits) || !s.habits.length) s.habits = base.habits;
  s.habits.forEach(function (h, i) {
    h.id = h.id || uid();
    h.name = h.name || 'Untitled';
    h.type = h.type === 'timed' ? 'timed' : 'binary';
    h.cadence = h.cadence === 'weekly' ? 'weekly' : 'daily';
    h.weeklyTarget = clamp(+h.weeklyTarget || (h.cadence === 'weekly' ? 4 : 7), 1, 21);
    h.min = Math.max(0, +h.min || 0);
    h.discharge = [0, 1, 2].indexOf(+h.discharge) >= 0 ? +h.discharge : 0;
    h.color = COLORS[h.color] ? h.color : COLOR_KEYS[i % COLOR_KEYS.length];
    h.ring = RINGS.indexOf(h.ring) >= 0 ? h.ring : 'solid';
    h.archived = !!h.archived;
    h.createdAt = h.createdAt || s.createdAt;
    h.t = +h.t || 0;
    if (typeof h.order !== 'number') h.order = i;
  });
  // A habit deleted more recently than its own last edit stays deleted.
  s.habits = s.habits.filter(function (h) { return (s.tombstones.habits[h.id] || 0) <= h.t; });
  // Days: keep only well-formed records, and stamp anything that predates sync.
  var live = {};
  s.habits.forEach(function (h) { live[h.id] = true; });
  Object.keys(s.days).forEach(function (k) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) { delete s.days[k]; return; }
    var d = s.days[k] || {};
    if (d.busy !== 'busy' && d.busy !== 'very') d.busy = null;
    d.busyT = +d.busyT || 0;
    d.logs = (d.logs && typeof d.logs === 'object') ? d.logs : {};
    d.del = (d.del && typeof d.del === 'object') ? d.del : {};
    Object.keys(d.logs).forEach(function (hid) {
      var log = d.logs[hid];
      if (!log || typeof log !== 'object') { delete d.logs[hid]; return; }
      log.t = +log.t || 0;
      if (s.tombstones.habits[hid] || !live[hid]) delete d.logs[hid];      // orphan of a deleted habit
      else if ((d.del[hid] || 0) > log.t) delete d.logs[hid];
    });
    Object.keys(d.del).forEach(function (hid) {
      if (s.tombstones.habits[hid] || !live[hid]) delete d.del[hid];
    });
    s.days[k] = d;
  });
  return s;
}

/** Days holding at least one log — an emptied day keeps its record to carry tombstones. */
function loggedDays() {
  return Object.keys(state.days).filter(function (k) {
    return Object.keys(state.days[k].logs).length > 0;
  });
}

function load() {
  var raw = null;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { raw = null; }
  if (!raw) return freshState();
  try { return normalise(JSON.parse(raw)); } catch (e) { return freshState(); }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    toast('Could not save — storage is full or blocked');
  }
  if (window.OrbitSync) window.OrbitSync.localChanged();
}

function habitsSorted(includeArchived) {
  return state.habits
    .filter(function (h) { return includeArchived || !h.archived; })
    .sort(function (a, b) { return a.order - b.order; });
}
function habitById(id) {
  for (var i = 0; i < state.habits.length; i++) if (state.habits[i].id === id) return state.habits[i];
  return null;
}
function dayRec(date, create) {
  var d = state.days[date];
  if (!d && create) { d = state.days[date] = { busy: null, busyT: 0, logs: {}, del: {} }; }
  if (d) {                                   // tolerate records written by an older version
    if (!d.logs) d.logs = {};
    if (!d.del) d.del = {};
    if (typeof d.busyT !== 'number') d.busyT = 0;
  }
  return d || null;
}
function firstDate() {
  var keys = Object.keys(state.days).sort();
  var earliest = state.createdAt;
  state.habits.forEach(function (h) { if (h.createdAt < earliest) earliest = h.createdAt; });
  if (keys.length && keys[0] < earliest) earliest = keys[0];
  return earliest;
}
function isEditable(date) {
  var n = daysBetween(date, today());
  return n >= 0 && n <= BACKFILL_DAYS;
}

/* ================================================================
   4. Scoring
   ================================================================ */

/** Is this habit discharged on this date by a busy / very busy flag? */
function isDischarged(habit, date) {
  if (!habit.discharge) return false;
  var d = state.days[date];
  if (!d || !d.busy) return false;
  if (d.busy === 'very') return habit.discharge === 1 || habit.discharge === 2;
  return habit.discharge === 1;
}

/** Points for a single log entry, ignoring gym's weekly bonus arithmetic. */
function logPoints(habit, log) {
  if (!log) return 0;
  if (habit.type === 'timed') {
    if (typeof log.m !== 'number') return 1;              // tapped without minutes = full credit
    var min = habit.min > 0 ? habit.min : 1;
    if (log.m >= min) return 1;
    return clamp(round1(log.m / min), 0.1, 1);            // partial credit, floor 0.1
  }
  return 1;
}

/** Number of sessions logged for a habit on a date (weekly habits may take several). */
function sessionsOn(habit, date) {
  var d = state.days[date];
  var log = d && d.logs[habit.id];
  if (!log) return 0;
  return Math.max(1, Math.round(log.s || 1));
}

/**
 * Weekly-cadence habits (gym): sessions 1..target are worth 1 point,
 * every session beyond the target is worth 0.5 as an uncapped bonus.
 * Returns { total, bonus, byDate: {date: points}, sessions }.
 */
function weeklyHabitPoints(habit, ws) {
  var dates = weekDates(ws), byDate = {}, seen = 0, total = 0, bonus = 0;
  dates.forEach(function (date) {
    var n = sessionsOn(habit, date), p = 0, i;
    for (i = 0; i < n; i++) {
      seen++;
      if (seen <= habit.weeklyTarget) { p += 1; } else { p += 0.5; bonus += 0.5; }
    }
    if (n) byDate[date] = p;
    total += p;
  });
  return { total: round1(total), bonus: round1(bonus), byDate: byDate, sessions: seen };
}

/** Points scored by one habit on one date (weekly habits resolved in week context). */
function habitPointsOn(habit, date) {
  if (habit.cadence === 'weekly') {
    var w = weeklyHabitPoints(habit, weekStart(date));
    return w.byDate[date] || 0;
  }
  var d = state.days[date];
  return logPoints(habit, d && d.logs[habit.id]);
}

/** Total points scored on a date across every habit, archived ones included. */
function dayPoints(date) {
  var total = 0;
  state.habits.forEach(function (h) { total += habitPointsOn(h, date); });
  return round1(total);
}

/**
 * Status of one habit on one date:
 * 'done' | 'partial' | 'miss' | 'discharged' | 'open' | 'future' | 'before' | 'logged'
 */
function statusOf(habit, date) {
  var t = today();
  if (date > t) return 'future';
  if (isDischarged(habit, date)) return 'discharged';
  var d = state.days[date];
  var log = d && d.logs[habit.id];
  if (habit.cadence === 'weekly') return log ? 'logged' : (date === t ? 'open' : 'none');
  if (log) return logPoints(habit, log) >= 1 ? 'done' : 'partial';
  if (date < habit.createdAt) return 'before';
  if (date === t) return 'open';
  return 'miss';
}

/** Daily habits that count toward a date's completion percentage. */
function dailyObligations(date) {
  return habitsSorted().filter(function (h) {
    return h.cadence === 'daily' && date >= h.createdAt && !isDischarged(h, date);
  });
}

/** Completion percentage for a date, 0..1, with discharged habits excluded entirely. */
function dayCompletion(date) {
  var obs = dailyObligations(date);
  if (!obs.length) return { pct: 0, done: 0, total: 0, empty: true };
  var got = 0;
  obs.forEach(function (h) { got += clamp(habitPointsOn(h, date), 0, 1); });
  return { pct: clamp(got / obs.length, 0, 1), done: round1(got), total: obs.length, empty: false };
}

/** True when every non-discharged daily obligation on that date is satisfied. */
function dayComplete(date) {
  var c = dayCompletion(date);
  return !c.empty && c.pct >= 0.999;
}

/* --- streaks --- */

function habitStreak(habit) {
  var t = today(), floor = firstDate(), n = 0, date, st;
  if (habit.cadence === 'weekly') {
    var ws = weekStart(t), floorWs = weekStart(habit.createdAt < floor ? floor : habit.createdAt);
    if (weeklyHabitPoints(habit, ws).sessions >= habit.weeklyTarget) n++;   // current week counts if already met
    ws = addDays(ws, -7);
    while (ws >= floorWs) {
      if (weeklyHabitPoints(habit, ws).sessions >= habit.weeklyTarget) { n++; ws = addDays(ws, -7); }
      else break;
    }
    return n;
  }
  date = t;
  while (date >= floor && date >= habit.createdAt) {
    st = statusOf(habit, date);
    if (st === 'discharged' || st === 'before') { date = addDays(date, -1); continue; }  // neutral
    if (st === 'done' || st === 'partial') { n++; date = addDays(date, -1); continue; }
    if (date === t) { date = addDays(date, -1); continue; }                              // an open today never breaks
    break;
  }
  return n;
}

function habitBestStreak(habit) {
  var t = today(), date = firstDate(), best = 0, run = 0, st;
  if (habit.cadence === 'weekly') {
    var ws = weekStart(date), end = weekStart(t);
    while (ws <= end) {
      if (weeklyHabitPoints(habit, ws).sessions >= habit.weeklyTarget) { run++; if (run > best) best = run; }
      else if (ws < end) { run = 0; }          // the in-progress week can't break a run
      ws = addDays(ws, 7);
    }
    return best;
  }
  while (date <= t) {
    st = statusOf(habit, date);
    if (st === 'done' || st === 'partial') { run++; if (run > best) best = run; }
    else if (st === 'discharged' || st === 'before') { /* neutral */ }
    else if (date === t) { /* open today */ }
    else run = 0;
    date = addDays(date, 1);
  }
  return best;
}

function overallStreak() {
  var t = today(), floor = firstDate(), date = t, n = 0;
  while (date >= floor) {
    var obs = dailyObligations(date);
    if (!obs.length) { date = addDays(date, -1); continue; }
    if (dayComplete(date)) { n++; date = addDays(date, -1); continue; }
    if (date === t) { date = addDays(date, -1); continue; }
    break;
  }
  return n;
}

function overallBestStreak() {
  var t = today(), date = firstDate(), best = 0, run = 0;
  while (date <= t) {
    var obs = dailyObligations(date);
    if (!obs.length) { /* nothing owed, neutral */ }
    else if (dayComplete(date)) { run++; if (run > best) best = run; }
    else if (date === t) { /* open today */ }
    else run = 0;
    date = addDays(date, 1);
  }
  return best;
}

/* --- weekly target --- */

/**
 * Weekly obligation: 7 for a daily habit, the session target for a weekly one,
 * less any obligations discharged by busy days that week (a discharge is neutral,
 * so it must not make the week's target harder to clear).
 */
function weekTarget(ws) {
  var dates = weekDates(ws), target = 0;
  habitsSorted().forEach(function (h) {
    if (h.cadence === 'weekly') { target += h.weeklyTarget; return; }
    dates.forEach(function (date) {
      if (date < h.createdAt) return;
      if (isDischarged(h, date)) return;
      target += 1;
    });
  });
  return round1(target);
}

function weekPoints(ws) {
  var total = 0;
  weekDates(ws).forEach(function (date) { total += dayPoints(date); });
  return round1(total);
}

function busyUsed(ws) {
  var used = { busy: 0, very: 0 };
  weekDates(ws).forEach(function (date) {
    var d = state.days[date];
    if (!d || !d.busy) return;
    if (d.busy === 'very') used.very++; else used.busy++;
  });
  return used;
}

/* --- points, levels --- */

function lifetimePoints() {
  var total = 0;
  Object.keys(state.days).forEach(function (date) { total += dayPoints(date); });
  return round1(total);
}

function levelThreshold(n) { return Math.round(50 * Math.pow(n, 1.5)); }   // level n+1 needs 50·n^1.5

function levelFor(points) {
  var n = 1;
  while (points >= levelThreshold(n) && n < 999) n++;
  return n;
}

/** Lifetime points, held monotonic: editing history can never take a level away. */
function peakPoints() {
  var live = lifetimePoints();
  if (live > (state.meta.peakPoints || 0)) state.meta.peakPoints = live;
  return state.meta.peakPoints;
}

function levelInfo() {
  var pts = peakPoints();
  var lv = levelFor(pts);
  if (lv > (state.meta.level || 1)) state.meta.level = lv;
  lv = state.meta.level;
  var prev = lv > 1 ? levelThreshold(lv - 1) : 0;
  var next = levelThreshold(lv);
  return {
    level: lv, points: pts, prev: prev, next: next,
    pct: clamp((pts - prev) / Math.max(1, next - prev), 0, 1),
    toGo: Math.max(0, round1(next - pts))
  };
}

/* ================================================================
   5. Hand-inked SVG
   Nothing here draws a perfect circle: every shape is jittered by a
   seeded RNG so the same habit is always drawn the same wobbly way.
   ================================================================ */

var svgSeq = 0;

function rng(seed) {
  var a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(str) {
  var h = 2166136261, i;
  str = String(str);
  for (i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function n2(v) { return Math.round(v * 100) / 100; }

/** Closed catmull-rom through points, emitted as cubic beziers. */
function closedCurve(pts) {
  var n = pts.length, d = 'M' + n2(pts[0][0]) + ',' + n2(pts[0][1]), i;
  for (i = 0; i < n; i++) {
    var p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    var c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    var c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += 'C' + n2(c1x) + ',' + n2(c1y) + ' ' + n2(c2x) + ',' + n2(c2y) + ' ' + n2(p2[0]) + ',' + n2(p2[1]);
  }
  return d + 'Z';
}

/** A wobbly, hand-drawn circle. */
function inkCircle(cx, cy, r, seed, wobble) {
  var rand = rng(seed), pts = [], N = 11, i;
  wobble = wobble == null ? 0.045 : wobble;
  for (i = 0; i < N; i++) {
    var a = (i / N) * Math.PI * 2 + (rand() - 0.5) * 0.12;
    var rr = r * (1 + (rand() - 0.5) * 2 * wobble);
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  return closedCurve(pts);
}

/** A wobbly ellipse, used for orbital rings. */
function inkEllipse(cx, cy, rx, ry, seed, wobble) {
  var rand = rng(seed), pts = [], N = 13, i;
  wobble = wobble == null ? 0.03 : wobble;
  for (i = 0; i < N; i++) {
    var a = (i / N) * Math.PI * 2 + (rand() - 0.5) * 0.1;
    var k = 1 + (rand() - 0.5) * 2 * wobble;
    pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
  }
  return closedCurve(pts);
}

/** A wobbly rounded square, used for calendar cells. */
function inkSquare(cx, cy, half, seed) {
  var rand = rng(seed), pts = [], i;
  var base = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
  for (i = 0; i < base.length; i++) {
    pts.push([
      cx + base[i][0] * half * (1 + (rand() - 0.5) * 0.09),
      cy + base[i][1] * half * (1 + (rand() - 0.5) * 0.09)
    ]);
  }
  return closedCurve(pts);
}

/** A four-point star / sparkle. */
function starPath(cx, cy, r, inner) {
  inner = inner == null ? r * 0.22 : inner;
  return 'M' + n2(cx) + ',' + n2(cy - r) +
    'Q' + n2(cx + inner) + ',' + n2(cy - inner) + ' ' + n2(cx + r) + ',' + n2(cy) +
    'Q' + n2(cx + inner) + ',' + n2(cy + inner) + ' ' + n2(cx) + ',' + n2(cy + r) +
    'Q' + n2(cx - inner) + ',' + n2(cy + inner) + ' ' + n2(cx - r) + ',' + n2(cy) +
    'Q' + n2(cx - inner) + ',' + n2(cy - inner) + ' ' + n2(cx) + ',' + n2(cy - r) + 'Z';
}

/** The waterline of a partial fill — a wobbly horizontal edge. */
function inkWaterline(cx, cy, r, level, seed) {
  // level 0..1 measured from the bottom of the body
  var y = cy + r - 2 * r * level;
  var rand = rng(seed), pts = [], N = 7, i;
  for (i = 0; i <= N; i++) {
    var x = cx - r * 1.2 + (2.4 * r) * (i / N);
    pts.push([x, y + (rand() - 0.5) * r * 0.06]);
  }
  var d = 'M' + n2(pts[0][0]) + ',' + n2(pts[0][1]);
  for (i = 1; i < pts.length; i++) {
    var prev = pts[i - 1], cur = pts[i];
    d += 'Q' + n2((prev[0] + cur[0]) / 2) + ',' + n2(cur[1] + (i % 2 ? -1.4 : 1.4)) + ' ' + n2(cur[0]) + ',' + n2(cur[1]);
  }
  d += 'L' + n2(cx + r * 1.3) + ',' + n2(cy + r * 1.4) + 'L' + n2(cx - r * 1.3) + ',' + n2(cy + r * 1.4) + 'Z';
  return d;
}

function ringDash(style) {
  if (style === 'dash') return '7 5';
  if (style === 'dot') return '1.6 5';
  if (style === 'double') return '11 4';
  return null;
}

/**
 * The planet for one habit.
 * opts: { size, fill 0..1, rings, discharged, missed, flat }
 */
function planetSVG(habit, opts) {
  opts = opts || {};
  var size = opts.size || 112;
  var vb = 100, cx = 50, cy = 50, r = 26;
  var seed = hash(habit.id);
  var uidn = 'p' + (++svgSeq);
  var color = COLORS[habit.color] ? COLORS[habit.color].ink : COLORS.blue.ink;
  var fill = clamp(opts.fill || 0, 0, 1);
  var body = inkCircle(cx, cy, r, seed, 0.05);
  var s = '';

  s += '<svg class="planet__svg" viewBox="0 0 ' + vb + ' ' + vb + '" width="' + size + '" height="' + size + '" aria-hidden="true" focusable="false">';
  s += '<defs>';
  s += '<radialGradient id="g' + uidn + '" cx="38%" cy="34%" r="72%">' +
       '<stop offset="0%" stop-color="' + color + '" stop-opacity=".55"/>' +
       '<stop offset="100%" stop-color="' + color + '" stop-opacity=".18"/></radialGradient>';
  s += '<clipPath id="c' + uidn + '"><path d="' + body + '"/></clipPath>';
  s += '</defs>';

  // orbital rings — one band per completed week of streak, up to four
  var bands = clamp(opts.rings || 0, 0, 4), i;
  var wrap = opts.flat ? '<g>' : '<g class="drift">';
  s += wrap;
  for (i = 0; i < bands; i++) {
    var rot = -22 + i * 9;
    var rx = r + 9 + i * 5.5, ry = (r + 9 + i * 5.5) * 0.44;
    var dash = ringDash(habit.ring);
    s += '<path d="' + inkEllipse(cx, cy, rx, ry, seed + 31 * (i + 1), 0.035) + '" ' +
         'transform="rotate(' + rot + ' ' + cx + ' ' + cy + ')" fill="none" stroke="' + (i === 0 ? '#2C2A26' : color) + '" ' +
         'stroke-width="' + (i === 0 ? 1.5 : 1.1) + '" opacity="' + (0.75 - i * 0.13) + '"' +
         (dash ? ' stroke-dasharray="' + dash + '"' : '') + ' stroke-linecap="round"/>';
  }

  // body
  s += '<path d="' + body + '" fill="url(#g' + uidn + ')"/>';
  if (fill > 0) {
    s += '<g clip-path="url(#c' + uidn + ')">' +
         '<path d="' + inkWaterline(cx, cy, r, fill, seed + 7) + '" fill="' + color + '" opacity=".85"/>' +
         '</g>';
  }
  s += '<path d="' + body + '" fill="none" stroke="#2C2A26" stroke-width="1.9" stroke-linejoin="round" opacity=".92"/>';
  s += '<path d="' + inkCircle(cx, cy, r * 0.995, seed + 991, 0.055) + '" fill="none" stroke="#2C2A26" stroke-width=".7" opacity=".35"/>';

  // small surface marks so no two planets read alike
  var rand = rng(seed + 5);
  for (i = 0; i < 3; i++) {
    var a = rand() * Math.PI * 2, rr = rand() * r * 0.55;
    s += '<path d="' + inkCircle(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 2 + rand() * 3, seed + i * 13, 0.3) +
         '" fill="none" stroke="#2C2A26" stroke-width=".7" opacity=".22"/>';
  }

  if (opts.discharged) {
    s += '<path d="' + inkCircle(cx, cy, r + 6, seed + 77, 0.04) + '" fill="none" stroke="#2C2A26" ' +
         'stroke-width="1.3" stroke-dasharray="1.5 5" opacity=".5" stroke-linecap="round"/>';
  }
  if (opts.missed) {
    s += '<path d="M' + (cx - r * 0.5) + ',' + (cy - r * 0.5) + ' L' + (cx + r * 0.52) + ',' + (cy + r * 0.48) + '" ' +
         'stroke="#C87F5E" stroke-width="1.8" stroke-linecap="round" opacity=".7" fill="none"/>';
  }
  if (opts.star) {
    s += '<path d="' + starPath(cx + r * 0.86, cy - r * 0.86, 6.5) + '" fill="#D9B48B" stroke="#2C2A26" stroke-width=".9"/>';
  }
  s += '</g></svg>';
  return s;
}

/** Compact status glyph for the week grid and month calendar. */
function cellSVG(status, value, seedStr, colorKey) {
  var seed = hash(seedStr), color = COLORS[colorKey] ? COLORS[colorKey].ink : COLORS.blue.ink;
  var s = '<svg class="cell" viewBox="0 0 30 30" aria-hidden="true" focusable="false">';
  var body = inkCircle(15, 15, 10.5, seed, 0.07);
  if (status === 'discharged') {
    s += '<path d="' + inkCircle(15, 15, 10, seed + 3, 0.06) + '" fill="none" stroke="#2C2A26" stroke-width="1.2" stroke-dasharray="1.4 4" opacity=".6" stroke-linecap="round"/>';
  } else if (status === 'done' || status === 'logged') {
    s += '<path d="' + body + '" fill="' + color + '" opacity=".8"/>';
    s += '<path d="' + body + '" fill="none" stroke="#2C2A26" stroke-width="1.5"/>';
    if (value > 1) s += '<path d="' + starPath(24, 6, 4.6) + '" fill="#D9B48B" stroke="#2C2A26" stroke-width=".8"/>';
  } else if (status === 'partial') {
    s += '<defs><clipPath id="cc' + (++svgSeq) + '"><path d="' + body + '"/></clipPath></defs>';
    s += '<g clip-path="url(#cc' + svgSeq + ')"><rect x="3" y="' + (25.5 - 21 * clamp(value, 0, 1)) + '" width="24" height="' + (21 * clamp(value, 0, 1) + 2) + '" fill="' + color + '" opacity=".8"/></g>';
    s += '<path d="' + body + '" fill="none" stroke="#2C2A26" stroke-width="1.5"/>';
  } else if (status === 'miss') {
    s += '<path d="' + body + '" fill="none" stroke="#C87F5E" stroke-width="1.3" opacity=".85"/>';
    s += '<path d="M10.5,10.5 L19.5,19.6" stroke="#C87F5E" stroke-width="1.4" stroke-linecap="round" opacity=".8"/>';
  } else if (status === 'open') {
    s += '<path d="' + body + '" fill="none" stroke="#2C2A26" stroke-width="1.3" opacity=".55"/>';
  } else {  // future, before, none
    s += '<path d="' + inkCircle(15, 15, 3, seed + 9, 0.2) + '" fill="none" stroke="#2C2A26" stroke-width="1" opacity=".28"/>';
  }
  return s + '</svg>';
}

/** Month calendar cell: a wobbly square filled by the day's completion. */
function calCellSVG(pct, seedStr, opts) {
  opts = opts || {};
  var seed = hash(seedStr), id = 'k' + (++svgSeq);
  var path = inkSquare(20, 20, 15, seed);
  var s = '<svg viewBox="0 0 40 40" aria-hidden="true" focusable="false">';
  s += '<defs><clipPath id="' + id + '"><path d="' + path + '"/></clipPath></defs>';
  if (pct > 0) {
    s += '<g clip-path="url(#' + id + ')"><rect x="2" y="' + (36 - 34 * pct) + '" width="36" height="' + (34 * pct + 2) + '" fill="#B6C2A8" opacity="' + (0.35 + 0.5 * pct) + '"/></g>';
  }
  s += '<path d="' + path + '" fill="none" stroke="#2C2A26" stroke-width="' + (opts.today ? 1.9 : 1.1) + '" opacity="' + (opts.dim ? 0.25 : 0.8) + '"/>';
  if (opts.busy) {
    s += '<path d="' + inkSquare(20, 20, 11.5, seed + 5) + '" fill="none" stroke="#2C2A26" stroke-width="1" stroke-dasharray="1.4 4" opacity=".65"/>';
  }
  if (opts.perfect) s += '<path d="' + starPath(32, 8, 4.4) + '" fill="#D9B48B" stroke="#2C2A26" stroke-width=".8"/>';
  return s + '</svg>';
}

/* ================================================================
   6. View state + shared bits
   ================================================================ */

var ui = { view: 'today', date: today(), month: monthStart(today()), week: weekStart(today()) };

function bandsFor(habit, streak) {
  if (!streak) return 0;
  if (habit.cadence === 'weekly') return clamp(streak, 0, 4);
  return clamp(1 + Math.floor(streak / 7), 0, 4);
}

function habitSubtitle(habit) {
  if (habit.cadence === 'weekly') return habit.weeklyTarget + '× a week';
  if (habit.type === 'timed') return 'Daily · ' + habit.min + ' min';
  return 'Daily';
}

function progressBar(value, target) {
  var pct = target > 0 ? clamp(value / target, 0, 1) : 0;
  var over = target > 0 && value >= target;
  return '<div class="bar"><div class="bar__fill' + (over ? ' bar__fill--over' : '') + '" style="width:' + (pct * 100).toFixed(1) + '%"></div></div>';
}

/* ================================================================
   7. Today
   ================================================================ */

function renderToday() {
  var date = ui.date, t = today();
  var editable = isEditable(date);
  var rec = state.days[date];
  var busy = rec ? rec.busy : null;
  var habits = habitsSorted();
  var comp = dayCompletion(date);
  var s = '';

  // date stepper, limited to the back-fill window
  var canBack = isEditable(addDays(date, -1));
  var canFwd = date < t;
  s += '<div class="stepper">' +
    '<button class="arrow" data-act="day" data-delta="-1"' + (canBack ? '' : ' disabled') + ' aria-label="Previous day">&larr;</button>' +
    '<div class="stepper__label">' + esc(longDate(date)) + '<span class="stepper__sub">' + esc(relativeDay(date)) + '</span></div>' +
    '<button class="arrow" data-act="day" data-delta="1"' + (canFwd ? '' : ' disabled') + ' aria-label="Next day">&rarr;</button>' +
    '</div>';

  // planets
  s += '<div class="orbits">';
  habits.forEach(function (h) {
    var st = statusOf(h, date);
    var pts = habitPointsOn(h, date);
    var streak = habitStreak(h);
    var fill = h.cadence === 'weekly' ? (sessionsOn(h, date) ? 1 : 0) : clamp(pts, 0, 1);
    var log = rec && rec.logs[h.id];
    var meta = '', flag = '';

    if (st === 'discharged') { meta = 'Discharged'; }
    else if (h.cadence === 'weekly') {
      var wk = weeklyHabitPoints(h, weekStart(date));
      var n = sessionsOn(h, date);
      meta = (n ? n + (n > 1 ? ' sessions' : ' session') + ' · ' : '') + wk.sessions + '/' + h.weeklyTarget + ' this week';
    } else if (log && h.type === 'timed') {
      meta = (typeof log.m === 'number' ? log.m + ' min' : 'Done') + (pts < 1 ? ' · ' + fmtPoints(pts) + ' pt' : '');
    } else if (log) { meta = 'Done'; }
    else if (h.type === 'timed') { meta = h.min + ' min'; }
    else { meta = 'Not yet'; }

    if (streak > 0) flag = streak + (h.cadence === 'weekly' ? 'w' : 'd') + ' streak';

    s += '<div class="orbit">' +
      '<button class="planet' + (st === 'discharged' ? ' is-discharged' : '') + '" data-habit="' + esc(h.id) + '"' +
      (editable ? '' : ' disabled') +
      ' aria-label="' + esc(h.name + ' — ' + meta) + '">' +
      planetSVG(h, {
        fill: fill,
        rings: bandsFor(h, streak),
        discharged: st === 'discharged',
        missed: st === 'miss',
        star: pts > 1
      }) +
      '<span class="planet__name">' + esc(h.name) + '</span>' +
      '<span class="planet__meta">' + esc(meta) + '</span>' +
      '<span class="planet__flag">' + esc(flag) + '</span>' +
      '</button></div>';
  });
  s += '</div>';

  // day summary
  s += '<div class="daybar">' +
    '<div class="daybar__stat"><span class="daybar__value num">' + fmtPoints(dayPoints(date)) + '</span><span class="daybar__label">Points</span></div>' +
    '<div class="daybar__sep"></div>' +
    '<div class="daybar__stat"><span class="daybar__value num">' + Math.round(comp.pct * 100) + '%</span><span class="daybar__label">' + (comp.empty ? 'Nothing owed' : comp.done + ' of ' + comp.total) + '</span></div>' +
    '<div class="daybar__sep"></div>' +
    '<div class="daybar__stat"><span class="daybar__value num">' + overallStreak() + '</span><span class="daybar__label">Day streak</span></div>' +
    '</div>';

  // busy toggles
  var used = busyUsed(weekStart(date));
  var qOn = state.settings.quotaEnabled;
  var busyLeft = state.settings.busyQuota - used.busy;
  var veryLeft = state.settings.veryBusyQuota - used.very;
  var busyBlocked = qOn && busy !== 'busy' && busyLeft <= 0;
  var veryBlocked = qOn && busy !== 'very' && veryLeft <= 0;
  var tip = quotaResetText();

  s += '<div class="busybar">' +
    '<button class="btn' + (busy === 'busy' ? ' is-on' : '') + '" data-act="busy" data-mode="busy"' +
      ((!editable || busyBlocked) ? ' disabled' : '') +
      (busyBlocked ? ' title="' + esc('Busy days spent. ' + tip) + '"' : '') +
      ' aria-pressed="' + (busy === 'busy') + '">Busy day</button>' +
    '<button class="btn' + (busy === 'very' ? ' is-on' : '') + '" data-act="busy" data-mode="very"' +
      ((!editable || veryBlocked) ? ' disabled' : '') +
      (veryBlocked ? ' title="' + esc('Very busy days spent. ' + tip) + '"' : '') +
      ' aria-pressed="' + (busy === 'very') + '">Very busy</button>' +
    '</div>';

  if (qOn) {
    s += '<p class="quota-note">' + Math.max(0, busyLeft) + ' busy · ' + Math.max(0, veryLeft) + ' very busy left this week. ' + esc(tip) + '</p>';
  } else {
    s += '<p class="quota-note">Quota off — busy days are unlimited.</p>';
  }
  if (busy) {
    var dis = habits.filter(function (h) { return isDischarged(h, date); }).map(function (h) { return h.name; });
    s += '<p class="quota-note">Discharged today: ' + (dis.length ? esc(dis.join(', ')) : 'nothing') + '. Neutral — no streak broken, no streak extended.</p>';
  }
  if (!editable) {
    s += '<p class="frozen">This day is frozen. Back-fill reaches ' + BACKFILL_DAYS + ' days back only.</p>';
  } else {
    s += '<p class="quota-note tiny">Tap a planet to complete it. Press and hold for minutes, sessions, or to clear.</p>';
  }
  return s;
}

/* ================================================================
   8. Week
   ================================================================ */

function renderWeek() {
  var ws = ui.week, dates = weekDates(ws), t = today();
  var habits = habitsSorted();
  var pts = weekPoints(ws), target = weekTarget(ws);
  var used = busyUsed(ws);
  var s = '';

  var canFwd = ws < weekStart(t);
  s += '<div class="stepper">' +
    '<button class="arrow" data-act="week" data-delta="-1" aria-label="Previous week">&larr;</button>' +
    '<div class="stepper__label">' + esc(longDate(ws) + ' – ' + longDate(dates[6])) +
      '<span class="stepper__sub">' + (ws === weekStart(t) ? 'This week' : Math.round(daysBetween(ws, weekStart(t)) / 7) + ' weeks ago') + '</span></div>' +
    '<button class="arrow" data-act="week" data-delta="1"' + (canFwd ? '' : ' disabled') + ' aria-label="Next week">&rarr;</button>' +
    '</div>';

  s += '<div class="card">' +
    '<div class="section__head"><span class="section__title">Week points</span>' +
    '<span class="section__note num">' + fmtPoints(pts) + ' / ' + fmtPoints(target) + '</span></div>' +
    progressBar(pts, target) +
    '<p class="tiny muted" style="margin:8px 0 0">' +
      (pts >= target ? 'Week cleared. Everything beyond this is bonus.' : fmtPoints(Math.max(0, round1(target - pts))) + ' points to clear the week.') +
    '</p></div>';

  s += '<div class="section"><div class="grid-scroll"><table class="grid"><thead><tr><th class="grid__habit">Habit</th>';
  dates.forEach(function (d) {
    var isT = d === t;
    s += '<th' + (isT ? ' class="grid__col-today"' : '') + '>' + dowOf(d).charAt(0) + '<span>' + parseYmd(d).getDate() + '</span></th>';
  });
  s += '<th class="grid__tot">Done</th></tr></thead><tbody>';

  habits.forEach(function (h) {
    s += '<tr><td class="grid__habit">' + esc(h.name) + '<br><span class="tiny muted">' + esc(habitSubtitle(h)) + '</span></td>';
    var hits = 0;
    dates.forEach(function (d) {
      var st = statusOf(h, d);
      var value = h.cadence === 'weekly' ? sessionsOn(h, d) : habitPointsOn(h, d);
      if (h.cadence === 'weekly') { hits += sessionsOn(h, d); }
      else if (st === 'done' || st === 'partial') { hits += clamp(value, 0, 1); }
      var inner = cellSVG(st, value, h.id + d, h.color);
      if (isEditable(d)) {
        s += '<td' + (d === t ? ' class="grid__col-today"' : '') + '><button class="cellbtn" data-act="cell" data-habit="' + esc(h.id) + '" data-date="' + d + '" aria-label="' + esc(h.name + ' on ' + longDate(d) + ' — ' + st) + '">' + inner + '</button></td>';
      } else {
        s += '<td' + (d === t ? ' class="grid__col-today"' : '') + '>' + inner + '</td>';
      }
    });
    var goal = h.cadence === 'weekly' ? h.weeklyTarget : 7;
    s += '<td class="grid__tot">' + fmtPoints(hits) + '/' + goal + '</td></tr>';
  });
  s += '</tbody></table></div>';

  // busy days used
  s += '<div class="section"><div class="section__head"><span class="section__title">Busy days</span>' +
    '<span class="section__note">' + (state.settings.quotaEnabled ? 'Quota ' + state.settings.busyQuota + ' + ' + state.settings.veryBusyQuota : 'Quota off') + '</span></div>' +
    '<div class="statlist">' +
    '<div class="statrow"><span class="statrow__name">Busy</span><span class="statrow__val">' + used.busy + (state.settings.quotaEnabled ? ' / ' + state.settings.busyQuota : '') + '</span></div>' +
    '<div class="statrow"><span class="statrow__name">Very busy</span><span class="statrow__val">' + used.very + (state.settings.quotaEnabled ? ' / ' + state.settings.veryBusyQuota : '') + '</span></div>' +
    '</div></div>';

  s += '<div class="legend">' +
    '<span>' + cellSVG('done', 1, 'lg1', 'sage') + 'Complete</span>' +
    '<span>' + cellSVG('partial', 0.5, 'lg2', 'sage') + 'Partial</span>' +
    '<span>' + cellSVG('miss', 0, 'lg3', 'sage') + 'Missed</span>' +
    '<span>' + cellSVG('discharged', 0, 'lg4', 'sage') + 'Discharged</span>' +
    '<span>' + cellSVG('open', 0, 'lg5', 'sage') + 'Open</span>' +
    '</div>';
  s += '</div>';
  return s;
}

/* ================================================================
   9. Month
   ================================================================ */

function renderMonth() {
  var ms = ui.month, t = today();
  var d0 = parseYmd(ms), n = daysInMonth(ms);
  var lead = (d0.getDay() + 6) % 7;
  var habits = habitsSorted();
  var s = '', i;

  var canFwd = ms < monthStart(t);
  s += '<div class="stepper">' +
    '<button class="arrow" data-act="month" data-delta="-1" aria-label="Previous month">&larr;</button>' +
    '<div class="stepper__label">' + MONTHS[d0.getMonth()] + ' ' + d0.getFullYear() +
      '<span class="stepper__sub">' + (ms === monthStart(t) ? 'This month' : 'Archive') + '</span></div>' +
    '<button class="arrow" data-act="month" data-delta="1"' + (canFwd ? '' : ' disabled') + ' aria-label="Next month">&rarr;</button>' +
    '</div>';

  // heatmap
  s += '<div class="cal">';
  DOW.forEach(function (d) { s += '<div class="cal__dow">' + d.charAt(0) + '</div>'; });
  for (i = 0; i < lead; i++) s += '<div></div>';

  var monthPoints = 0, busyCount = 0, perfectDays = 0, bestRun = 0, run = 0;
  for (i = 1; i <= n; i++) {
    var date = ms.slice(0, 8) + pad2(i);
    var future = date > t;
    var comp = dayCompletion(date);
    var rec = state.days[date];
    var pct = future ? 0 : comp.pct;
    monthPoints += dayPoints(date);
    if (rec && rec.busy) busyCount++;
    var perfect = !future && !comp.empty && comp.pct >= 0.999;
    if (perfect) perfectDays++;
    if (!future) {
      if (comp.empty) { /* neutral */ }
      else if (perfect) { run++; if (run > bestRun) bestRun = run; }
      else if (date === t) { /* open today */ }
      else run = 0;
    }
    s += '<div class="cal__cell' + (date === t ? ' is-today' : '') + '" title="' + esc(longDate(date) + ' — ' + Math.round(pct * 100) + '%') + '">' +
      calCellSVG(pct, 'cal' + date, { today: date === t, dim: future, busy: !!(rec && rec.busy), perfect: perfect }) +
      '<span class="cal__num">' + i + '</span></div>';
  }
  s += '</div>';

  s += '<div class="tiles">' +
    '<div class="tile"><div class="tile__value num">' + fmtPoints(monthPoints) + '</div><div class="tile__label">Points this month</div></div>' +
    '<div class="tile"><div class="tile__value num">' + bestRun + '</div><div class="tile__label">Best streak in month</div></div>' +
    '<div class="tile"><div class="tile__value num">' + perfectDays + '</div><div class="tile__label">Full days</div></div>' +
    '<div class="tile"><div class="tile__value num">' + busyCount + '</div><div class="tile__label">Busy days used</div></div>' +
    '</div>';

  // per-habit monthly totals
  s += '<div class="section"><div class="section__head"><span class="section__title">By habit</span>' +
    '<span class="section__note">Completed / owed</span></div><div class="statlist">';
  habits.forEach(function (h) {
    var got = 0, owed = 0, dis = 0;
    for (i = 1; i <= n; i++) {
      var date = ms.slice(0, 8) + pad2(i);
      if (date > t || date < h.createdAt) continue;
      if (h.cadence === 'weekly') { got += sessionsOn(h, date); continue; }
      if (isDischarged(h, date)) { dis++; continue; }
      owed++;
      got += clamp(habitPointsOn(h, date), 0, 1);
    }
    if (h.cadence === 'weekly') {
      // owed = the weekly target once per week that touches this month and has started
      var ws = weekStart(ms), last = weekStart(ms.slice(0, 8) + pad2(n)), weeks = 0;
      while (ws <= last) {
        if (ws <= t && addDays(ws, 6) >= h.createdAt) weeks++;
        ws = addDays(ws, 7);
      }
      owed = h.weeklyTarget * weeks;
    }
    s += '<div class="statrow"><span class="statrow__name">' + esc(h.name) +
      (dis ? ' <span class="tiny muted">· ' + dis + ' discharged</span>' : '') + '</span>' +
      '<span class="statrow__val num">' + fmtPoints(got) + ' / ' + fmtPoints(owed) + '</span></div>';
  });
  s += '</div></div>';
  return s;
}

/* ================================================================
   10. Stats
   ================================================================ */

function completionRate(h) {
  var t = today(), date = h.createdAt > firstDate() ? h.createdAt : firstDate();
  var got = 0, owed = 0;
  if (h.cadence === 'weekly') {
    var ws = weekStart(date), end = weekStart(t), sessions = 0, weeks = 0;
    while (ws <= end) {
      var w = weeklyHabitPoints(h, ws);
      sessions += w.sessions;
      if (ws < end) weeks++;                       // don't judge the in-progress week
      ws = addDays(ws, 7);
    }
    owed = Math.max(1, weeks) * h.weeklyTarget;
    return { got: sessions, owed: owed, pct: clamp(sessions / owed, 0, 1) };
  }
  while (date <= t) {
    var st = statusOf(h, date);
    if (st !== 'discharged' && st !== 'before' && !(st === 'open' && date === t)) {
      owed++;
      got += clamp(habitPointsOn(h, date), 0, 1);
    } else if (st === 'open' && date === t && habitPointsOn(h, date) > 0) {
      owed++; got += clamp(habitPointsOn(h, date), 0, 1);
    }
    date = addDays(date, 1);
  }
  return { got: round1(got), owed: owed, pct: owed ? clamp(got / owed, 0, 1) : 0 };
}

function sparklineSVG(weeks) {
  var w = 320, h = 82, padL = 4, padR = 4, padT = 10, padB = 16;
  var max = 1, i;
  weeks.forEach(function (v) { if (v.points > max) max = v.points; if (v.target > max) max = v.target; });
  var stepX = (w - padL - padR) / Math.max(1, weeks.length - 1);
  var yFor = function (v) { return padT + (h - padT - padB) * (1 - v / max); };
  var s = '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true" focusable="false">';

  // target line, drawn as a soft dashed rule at the latest target
  var tgt = weeks.length ? weeks[weeks.length - 1].target : 0;
  if (tgt > 0) {
    s += '<path d="M' + padL + ',' + n2(yFor(tgt)) + ' L' + (w - padR) + ',' + n2(yFor(tgt)) + '" stroke="#C87F5E" stroke-width="1" stroke-dasharray="4 5" opacity=".6" fill="none"/>';
  }
  var d = '', pts = [];
  weeks.forEach(function (v, i) { pts.push([padL + i * stepX, yFor(v.points)]); });
  pts.forEach(function (p, i) {
    if (i === 0) { d += 'M' + n2(p[0]) + ',' + n2(p[1]); return; }
    var prev = pts[i - 1];
    var mx = (prev[0] + p[0]) / 2;
    d += 'C' + n2(mx) + ',' + n2(prev[1]) + ' ' + n2(mx) + ',' + n2(p[1]) + ' ' + n2(p[0]) + ',' + n2(p[1]);
  });
  s += '<path d="' + d + '" fill="none" stroke="#2C2A26" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';
  pts.forEach(function (p, i) {
    var hit = weeks[i].points >= weeks[i].target && weeks[i].target > 0;
    s += '<circle cx="' + n2(p[0]) + '" cy="' + n2(p[1]) + '" r="' + (hit ? 3 : 2) + '" fill="' + (hit ? '#B6C2A8' : '#F2EFE4') + '" stroke="#2C2A26" stroke-width="1.1"/>';
  });
  s += '<path d="M' + padL + ',' + (h - padB + 5) + ' L' + (w - padR) + ',' + (h - padB + 5) + '" stroke="#2C2A26" stroke-width=".8" opacity=".25" fill="none"/>';
  return s + '</svg>';
}

function renderStats() {
  var info = levelInfo(), t = today();
  var habits = habitsSorted(true);
  var s = '';

  // level dial
  var ringR = 34, circ = 2 * Math.PI * ringR;
  s += '<div class="card levelcard">' +
    '<svg viewBox="0 0 96 96" aria-hidden="true" focusable="false">' +
      '<path d="' + inkCircle(48, 48, ringR, 4242, 0.03) + '" fill="none" stroke="#2C2A26" stroke-width="1.1" opacity=".28"/>' +
      '<circle cx="48" cy="48" r="' + ringR + '" fill="none" stroke="#C87F5E" stroke-width="4.5" stroke-linecap="round" ' +
        'stroke-dasharray="' + n2(circ * info.pct) + ' ' + n2(circ) + '" transform="rotate(-90 48 48)" opacity=".85"/>' +
      '<path d="' + inkCircle(48, 48, 24, 77, 0.05) + '" fill="#D9B48B" opacity=".28" stroke="#2C2A26" stroke-width="1.2"/>' +
      '<text x="48" y="54" text-anchor="middle" font-family="Fraunces, Georgia, serif" font-size="21" fill="#2C2A26">' + info.level + '</text>' +
    '</svg>' +
    '<div class="levelcard__body">' +
      '<div class="levelcard__lv">Level ' + info.level + '</div>' +
      '<div class="tiny muted">' + fmtPoints(info.points) + ' lifetime points · ' + fmtPoints(info.toGo) + ' to level ' + (info.level + 1) + '</div>' +
      '<div class="bar-row">' + progressBar(info.points - info.prev, info.next - info.prev) +
      '<span class="bar-row__val num">' + Math.round(info.pct * 100) + '%</span></div>' +
    '</div></div>';

  // last 12 weeks
  var weeks = [], ws = addDays(weekStart(t), -7 * 11), i;
  for (i = 0; i < 12; i++) {
    weeks.push({ ws: ws, points: weekPoints(ws), target: weekTarget(ws) });
    ws = addDays(ws, 7);
  }
  var cleared = weeks.filter(function (w) { return w.target > 0 && w.points >= w.target; }).length;
  s += '<div class="section"><div class="section__head"><span class="section__title">Last 12 weeks</span>' +
    '<span class="section__note">' + cleared + ' week' + (cleared === 1 ? '' : 's') + ' cleared</span></div>' +
    '<div class="card">' + sparklineSVG(weeks) +
    '<div class="tiny muted" style="display:flex;justify-content:space-between;margin-top:2px">' +
    '<span>' + esc(longDate(weeks[0].ws)) + '</span><span>this week</span></div></div></div>';

  // streaks
  s += '<div class="section"><div class="section__head"><span class="section__title">Streaks</span>' +
    '<span class="section__note">Current vs best</span></div>' +
    '<table class="streaktable"><thead><tr><th>Habit</th><th>Now</th><th>Best</th><th>Rate</th></tr></thead><tbody>';
  habits.forEach(function (h) {
    var r = completionRate(h);
    var unit = h.cadence === 'weekly' ? 'w' : 'd';
    s += '<tr><td>' + esc(h.name) + (h.archived ? ' <span class="tiny muted">archived</span>' : '') + '</td>' +
      '<td>' + habitStreak(h) + unit + '</td><td>' + habitBestStreak(h) + unit + '</td>' +
      '<td>' + Math.round(r.pct * 100) + '%</td></tr>';
  });
  s += '<tr class="is-total"><td>All habits</td><td>' + overallStreak() + 'd</td><td>' + overallBestStreak() + 'd</td><td>—</td></tr>';
  s += '</tbody></table></div>';

  // lifetime tiles
  var totalLogs = 0;
  Object.keys(state.days).forEach(function (k) { totalLogs += Object.keys(state.days[k].logs || {}).length; });
  s += '<div class="tiles">' +
    '<div class="tile"><div class="tile__value num">' + fmtPoints(lifetimePoints()) + '</div><div class="tile__label">Lifetime points</div></div>' +
    '<div class="tile"><div class="tile__value num">' + totalLogs + '</div><div class="tile__label">Completions logged</div></div>' +
    '<div class="tile"><div class="tile__value num">' + loggedDays().length + '</div><div class="tile__label">Days on the chart</div></div>' +
    '<div class="tile"><div class="tile__value num">' + levelThreshold(info.level) + '</div><div class="tile__label">Next threshold</div></div>' +
    '</div>';
  return s;
}

/* ================================================================
   11. Settings
   ================================================================ */

/* ---------- account and sync ---------- */

var syncDraft = { email: '', pass: '', code: '', url: '', key: '' };
var rendering = false;

function syncGlyph(status) {
  var seed = 4711, color = '#B6C2A8', dash = '', mark = '';
  if (status === 'syncing' || status === 'pending') { color = '#D9B48B'; dash = ' stroke-dasharray="3 4"'; }
  if (status === 'offline') { color = '#9FB3C0'; dash = ' stroke-dasharray="1.6 4"'; }
  if (status === 'error') { color = '#C87F5E'; mark = '<path d="M5.5,5.5 L12.5,12.6" stroke="#C87F5E" stroke-width="1.5" stroke-linecap="round"/>'; }
  return '<svg viewBox="0 0 18 18" width="13" height="13" aria-hidden="true" focusable="false" style="vertical-align:-1px">' +
    '<path d="' + inkCircle(9, 9, 6, seed, 0.08) + '" fill="' + (status === 'synced' ? color : 'none') + '" ' +
    'opacity="' + (status === 'synced' ? '.75' : '1') + '" stroke="#2C2A26" stroke-width="1.3"' + dash + '/>' + mark + '</svg>';
}

function renderSyncCard() {
  if (!window.OrbitSync) {
    return '<div class="card"><p class="tiny muted" style="margin:0">Sync is unavailable — <code>assets/sync.js</code> did not load.</p></div>';
  }
  var v = window.OrbitSync.snapshot();
  var s = '<div class="card" id="syncCard">';

  if (!v.configured) {
    s += '<p class="tiny muted" style="margin:0 0 10px">Orbit needs no account: everything works offline on this device. ' +
      'To carry the same chart between devices, connect a free Supabase project — the README has the SQL and the five-minute setup — then paste its two public values here.</p>' +
      '<label class="field"><span class="field__label">Project URL</span>' +
      '<input type="text" id="cfgUrl" spellcheck="false" autocapitalize="off" placeholder="https://xxxx.supabase.co" value="' + esc(syncDraft.url) + '"></label>' +
      '<label class="field"><span class="field__label">Anon (public) key</span>' +
      '<input type="text" id="cfgKey" spellcheck="false" autocapitalize="off" placeholder="eyJhbGciOi…" value="' + esc(syncDraft.key) + '"></label>' +
      '<div class="btn-row"><button class="btn btn--primary" data-act="sync-config-save">Connect project</button></div>';
    if (v.error) s += '<p class="tiny" style="color:#9c4f30;margin:10px 0 0">' + esc(v.error) + '</p>';
    return s + '</div>';
  }

  if (!v.signedIn) {
    if (v.pending.mode === 'code' && v.pending.stage === 'code') {
      s += '<p class="tiny muted" style="margin:0 0 10px">' + esc(v.pending.message || ('Code sent to ' + v.pending.email)) + '</p>' +
        '<label class="field"><span class="field__label">Six-digit code</span>' +
        '<input type="text" id="syncCode" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" ' +
        'placeholder="000000" style="letter-spacing:.4em;font-size:20px;text-align:center" value="' + esc(syncDraft.code) + '"></label>' +
        '<div class="btn-row">' +
        '<button class="btn btn--primary" data-act="sync-verify"' + (v.pending.busy ? ' disabled' : '') + '>' + (v.pending.busy ? 'Checking…' : 'Sign in') + '</button>' +
        '<button class="btn" data-act="sync-resend"' + (v.pending.busy ? ' disabled' : '') + '>Send again</button>' +
        '<button class="btn btn--ghost" data-act="sync-back">Different email</button></div>';
    } else if (v.pending.mode === 'code') {
      s += '<p class="tiny muted" style="margin:0 0 10px">Orbit will email you a six-digit code to type in here — no link to click, so it works in the installed app. ' +
        'This route needs the project to have its own SMTP: Supabase only lets you put the code into an email template once custom SMTP is set up.</p>' +
        '<label class="field"><span class="field__label">Email</span>' +
        '<input type="email" id="syncEmail" inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false" ' +
        'placeholder="you@example.com" value="' + esc(syncDraft.email) + '"></label>' +
        '<div class="btn-row"><button class="btn btn--primary" data-act="sync-send"' + (v.pending.busy ? ' disabled' : '') + '>' +
        (v.pending.busy ? 'Sending…' : 'Email me a code') + '</button>' +
        '<button class="btn btn--ghost" data-act="sync-mode-password">Use a password instead</button></div>';
      if (v.pending.message) s += '<p class="tiny" style="margin:10px 0 0;color:#9c4f30">' + esc(v.pending.message) + '</p>';
    } else {
      s += '<p class="tiny muted" style="margin:0 0 10px">Sign in to carry this chart to your other devices. ' +
        'Everything happens in this window — nothing to click in an email — so it works the same in the installed app, ' +
        'where a link would open your browser and sign in a window you are not looking at.</p>' +
        '<label class="field"><span class="field__label">Email</span>' +
        '<input type="email" id="syncEmail" inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false" ' +
        'placeholder="you@example.com" value="' + esc(syncDraft.email) + '"></label>' +
        '<label class="field"><span class="field__label">Password</span>' +
        '<input type="password" id="syncPass" autocomplete="current-password" placeholder="At least 8 characters" value="' + esc(syncDraft.pass) + '"></label>' +
        '<div class="btn-row">' +
        '<button class="btn btn--primary" data-act="sync-signin"' + (v.pending.busy ? ' disabled' : '') + '>' + (v.pending.busy ? 'Signing in…' : 'Sign in') + '</button>' +
        '<button class="btn" data-act="sync-signup"' + (v.pending.busy ? ' disabled' : '') + '>Create account</button></div>' +
        '<p class="tiny muted" style="margin:10px 0 0">First device? Create the account, then sign in with the same details everywhere else. ' +
        '<button class="btn btn--sm btn--ghost" data-act="sync-mode-code">Email me a code instead</button></p>';
      if (v.pending.message) s += '<p class="tiny" style="margin:10px 0 0;color:#9c4f30">' + esc(v.pending.message) + '</p>';
    }
    if (!v.fromFile) {
      s += '<p class="tiny muted" style="margin:12px 0 0">Connected to <code>' + esc(v.url.replace('https://', '')) + '</code> · ' +
        '<button class="btn btn--sm btn--ghost" data-act="sync-config-clear">Disconnect</button></p>';
    }
    return s + '</div>';
  }

  s += '<div class="switch" style="border-top:0"><span class="switch__text">' + esc(v.email) +
    '<small>' + syncGlyph(v.status) + ' ' + esc(v.statusText) + '</small></span>' +
    '<button class="btn btn--sm" data-act="sync-now"' + (v.status === 'syncing' ? ' disabled' : '') + '>Sync now</button></div>';
  if (v.notice) s += '<p class="tiny muted" style="margin:0 0 8px">' + esc(v.notice) + '</p>';
  s += '<p class="tiny muted" style="margin:8px 0 10px">Changes sync a couple of seconds after you make them, when the app comes back to the front, and every five minutes it is open. ' +
    'Edits made on two devices merge entry by entry — the newer edit of any one habit, day or setting wins, so nothing is silently overwritten.</p>' +
    '<div class="btn-row"><button class="btn" data-act="sync-signout">Sign out</button>' +
    '<button class="btn btn--danger btn--sm" data-act="sync-signout-wipe">Sign out and clear this device</button></div>';
  return s + '</div>';
}

function renderSettings() {
  var habits = habitsSorted(true);
  var s = '';
  // Account first: it is the one thing here that reaches beyond this device.

  s += '<div class="section"><div class="section__head"><span class="section__title">Account &amp; sync</span>' +
    '<span class="section__note">' + esc(window.OrbitSync ? window.OrbitSync.snapshot().statusText : 'Unavailable') + '</span></div>' +
    renderSyncCard() + '</div>';

  s += '<div class="section"><div class="section__head"><span class="section__title">Habits</span>' +
    '<button class="btn btn--sm" data-act="habit-new">+ Add habit</button></div><div class="hlist">';
  habits.forEach(function (h, i) {
    var c = COLORS[h.color].ink;
    s += '<div class="hrow' + (h.archived ? ' is-archived' : '') + '">' +
      '<svg class="hrow__dot" viewBox="0 0 24 24" aria-hidden="true"><path d="' + inkCircle(12, 12, 9, hash(h.id), 0.07) + '" fill="' + c + '" opacity=".75" stroke="#2C2A26" stroke-width="1.3"/></svg>' +
      '<div class="hrow__main"><div class="hrow__name">' + esc(h.name) + '</div>' +
      '<div class="hrow__sub">' + esc(habitSubtitle(h)) + ' · ' + (h.type === 'timed' ? 'timed' : 'binary') +
      ' · ' + ['never discharged', 'busy + very busy', 'very busy only'][h.discharge] + (h.archived ? ' · archived' : '') + '</div></div>' +
      '<div class="hrow__acts">' +
        '<button class="btn btn--sm btn--icon" data-act="habit-move" data-id="' + esc(h.id) + '" data-delta="-1" aria-label="Move up"' + (i === 0 ? ' disabled' : '') + '>&uarr;</button>' +
        '<button class="btn btn--sm btn--icon" data-act="habit-move" data-id="' + esc(h.id) + '" data-delta="1" aria-label="Move down"' + (i === habits.length - 1 ? ' disabled' : '') + '>&darr;</button>' +
        '<button class="btn btn--sm" data-act="habit-edit" data-id="' + esc(h.id) + '">Edit</button>' +
      '</div></div>';
  });
  s += '</div></div>';

  var st = state.settings;
  s += '<div class="section"><div class="section__head"><span class="section__title">Busy-day quota</span>' +
    '<span class="section__note">Per calendar week, Mon–Sun</span></div><div class="card">' +
    '<div class="switch"><span class="switch__text">Enforce the quota<small>Off means busy days are unlimited</small></span>' +
    '<button class="btn btn--sm' + (st.quotaEnabled ? ' is-on' : '') + '" data-act="quota-toggle" aria-pressed="' + st.quotaEnabled + '">' + (st.quotaEnabled ? 'On' : 'Off') + '</button></div>' +
    '<div class="inline-fields">' +
      '<label class="field"><span class="field__label">Busy days / week</span>' +
      '<input type="number" min="0" max="7" step="1" value="' + st.busyQuota + '" data-setting="busyQuota"' + (st.quotaEnabled ? '' : ' disabled') + '></label>' +
      '<label class="field"><span class="field__label">Very busy / week</span>' +
      '<input type="number" min="0" max="7" step="1" value="' + st.veryBusyQuota + '" data-setting="veryBusyQuota"' + (st.quotaEnabled ? '' : ' disabled') + '></label>' +
    '</div>' +
    '<p class="tiny muted" style="margin:0">Busy discharges ' + esc(habitsSorted().filter(function (h) { return h.discharge === 1; }).map(function (h) { return h.name; }).join(', ') || 'nothing') +
    '. Very busy also discharges ' + esc(habitsSorted().filter(function (h) { return h.discharge === 2; }).map(function (h) { return h.name; }).join(', ') || 'nothing') + '.</p>' +
    '</div></div>';

  s += '<div class="section"><div class="section__head"><span class="section__title">Data</span>' +
    '<span class="section__note">' + (window.OrbitSync && window.OrbitSync.snapshot().signedIn ? 'This device and your account' : 'Stays on this device') + '</span></div><div class="card">' +
    '<div class="btn-row">' +
      '<button class="btn" data-act="export">Export JSON</button>' +
      '<button class="btn" data-act="import">Import JSON</button>' +
      '<button class="btn btn--danger" data-act="wipe">Wipe data</button>' +
    '</div>' +
    '<p class="tiny muted" style="margin:10px 0 0">Export downloads <code>' + EXPORT_NAME + '</code>. Import merges: habits match on id, then on name; day logs merge by date with the incoming file winning any clash.</p>' +
    '</div></div>';

  s += '<div class="section"><div class="card">' +
    '<p class="tiny muted" style="margin:0">Day rolls over at 02:00 local time — a log made at 01:30 belongs to the day before. ' +
    'Back-fill reaches ' + BACKFILL_DAYS + ' days; older days are frozen. Levels follow 50 × n^1.5 and never go down.</p>' +
    '<p class="tiny muted" style="margin:8px 0 0">Orbit ' + esc(state.version + '.0') + ' · offline-first · no accounts, no network.</p>' +
    '</div></div>';
  return s;
}

/* ================================================================
   12. Sheets
   ================================================================ */

var sheetEl, sheetTitle, sheetBody, viewEl, toastEl, fxEl, toastTimer;

function openSheet(title, html) {
  sheetTitle.textContent = title;
  sheetBody.innerHTML = html;
  sheetEl.hidden = false;
  document.body.style.overflow = 'hidden';
  var focusable = sheetBody.querySelector('input,button,select,textarea');
  if (focusable) { try { focusable.focus({ preventScroll: true }); } catch (e) { focusable.focus(); } }
}
function closeSheet() {
  sheetEl.hidden = true;
  sheetBody.innerHTML = '';
  document.body.style.overflow = '';
}
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toastEl.hidden = true; }, 2200);
}

function logSheet(habitId, date) {
  var h = habitById(habitId);
  if (!h) return;
  if (!isEditable(date)) { toast('That day is frozen'); return; }
  var rec = state.days[date];
  var log = rec && rec.logs[h.id];
  var s = '';

  s += '<p class="tiny muted" style="margin:0 0 4px">' + esc(longDate(date)) + ' · ' + esc(habitSubtitle(h)) + '</p>';
  if (isDischarged(h, date)) {
    s += '<p class="tiny" style="margin:0 0 10px">Discharged by a ' + (state.days[date].busy === 'very' ? 'very busy' : 'busy') +
      ' day — neutral for streaks. You can still log it if you did it.</p>';
  }

  if (h.cadence === 'weekly') {
    var n = log ? Math.max(1, Math.round(log.s || 1)) : 0;
    var wk = weeklyHabitPoints(h, weekStart(date));
    s += '<p class="tiny muted" style="margin:0 0 8px">' + wk.sessions + ' of ' + h.weeklyTarget + ' sessions this week' +
      (wk.bonus ? ' · ' + fmtPoints(wk.bonus) + ' bonus points' : '') + '. Sessions past ' + h.weeklyTarget + ' are worth 0.5 each.</p>';
    s += '<div class="chips">' +
      '<button class="btn" data-act="sessions" data-id="' + esc(h.id) + '" data-date="' + date + '" data-n="' + Math.max(0, n - 1) + '">−</button>' +
      '<span class="btn" style="pointer-events:none"><span class="num">' + n + '</span>&nbsp;session' + (n === 1 ? '' : 's') + ' today</span>' +
      '<button class="btn" data-act="sessions" data-id="' + esc(h.id) + '" data-date="' + date + '" data-n="' + (n + 1) + '">+</button>' +
      '</div>';
  } else if (h.type === 'timed') {
    var mins = [5, 10, h.min, Math.round(h.min * 1.5), h.min * 2, 60].filter(function (v, i, a) {
      return v > 0 && a.indexOf(v) === i;
    }).sort(function (a, b) { return a - b; });
    s += '<p class="tiny muted" style="margin:0 0 8px">' + h.min + ' min is a full point. Less scores minutes ÷ ' + h.min + ', rounded to 0.1, never below 0.1.</p>';
    s += '<div class="chips">';
    mins.forEach(function (m) {
      var p = logPoints(h, { m: m });
      s += '<button class="btn' + (log && log.m === m ? ' is-on' : '') + '" data-act="minutes" data-id="' + esc(h.id) + '" data-date="' + date + '" data-m="' + m + '">' +
        m + ' min <span class="tiny muted">' + fmtPoints(p) + '</span></button>';
    });
    s += '</div>';
    s += '<div class="inline-fields"><label class="field" style="margin-top:4px"><span class="field__label">Exact minutes</span>' +
      '<input type="number" min="1" max="600" step="1" id="minInput" placeholder="e.g. 12" value="' + (log && typeof log.m === 'number' ? log.m : '') + '"></label></div>' +
      '<div class="btn-row"><button class="btn btn--primary" data-act="minutes-custom" data-id="' + esc(h.id) + '" data-date="' + date + '">Save minutes</button>' +
      '<button class="btn" data-act="full" data-id="' + esc(h.id) + '" data-date="' + date + '">Mark done (full)</button></div>';
  } else {
    s += '<div class="btn-row"><button class="btn btn--primary" data-act="full" data-id="' + esc(h.id) + '" data-date="' + date + '">Mark done</button></div>';
  }

  s += '<div class="btn-row" style="margin-top:12px">' +
    (log ? '<button class="btn btn--danger" data-act="clear" data-id="' + esc(h.id) + '" data-date="' + date + '">Clear this day</button>' : '') +
    '<button class="btn btn--ghost" data-close="1">Close</button></div>';

  openSheet(h.name, s);
}

function habitSheet(id) {
  var h = id ? habitById(id) : null;
  var isNew = !h;
  if (isNew) {
    h = { id: '', name: '', type: 'binary', cadence: 'daily', weeklyTarget: 7, min: 20, discharge: 0, color: 'sage', ring: 'solid', archived: false };
  }
  var s = '';
  s += '<label class="field"><span class="field__label">Name</span><input type="text" id="hName" value="' + esc(h.name) + '" placeholder="Habit name" maxlength="48"></label>';
  s += '<div class="inline-fields">' +
    '<label class="field"><span class="field__label">Kind</span><select id="hType">' +
      '<option value="binary"' + (h.type === 'binary' ? ' selected' : '') + '>Binary — done or not</option>' +
      '<option value="timed"' + (h.type === 'timed' ? ' selected' : '') + '>Timed — minutes</option>' +
    '</select></label>' +
    '<label class="field"><span class="field__label">Cadence</span><select id="hCadence">' +
      '<option value="daily"' + (h.cadence === 'daily' ? ' selected' : '') + '>Daily</option>' +
      '<option value="weekly"' + (h.cadence === 'weekly' ? ' selected' : '') + '>× per week</option>' +
    '</select></label>' +
    '</div>';
  s += '<div class="inline-fields">' +
    '<label class="field"><span class="field__label">Weekly target</span><input type="number" id="hTarget" min="1" max="21" step="1" value="' + h.weeklyTarget + '"></label>' +
    '<label class="field"><span class="field__label">Minutes for full credit</span><input type="number" id="hMin" min="0" max="600" step="1" value="' + h.min + '"></label>' +
    '</div>';
  s += '<label class="field"><span class="field__label">Busy days</span><select id="hDischarge">' +
    '<option value="0"' + (h.discharge === 0 ? ' selected' : '') + '>Never discharged</option>' +
    '<option value="1"' + (h.discharge === 1 ? ' selected' : '') + '>Discharged on busy and very busy</option>' +
    '<option value="2"' + (h.discharge === 2 ? ' selected' : '') + '>Discharged on very busy only</option>' +
    '</select></label>';
  s += '<div class="field"><span class="field__label">Colour</span><div class="swatches" id="hColors">';
  COLOR_KEYS.forEach(function (k) {
    s += '<button type="button" class="swatch' + (h.color === k ? ' is-on' : '') + '" data-color="' + k + '" title="' + COLORS[k].label + '" style="background:' + COLORS[k].ink + '"></button>';
  });
  s += '</div></div>';
  s += '<label class="field"><span class="field__label">Ring style</span><select id="hRing">' +
    RINGS.map(function (r) { return '<option value="' + r + '"' + (h.ring === r ? ' selected' : '') + '>' + r + '</option>'; }).join('') +
    '</select></label>';

  s += '<div class="btn-row" style="margin-top:14px">' +
    '<button class="btn btn--primary" data-act="habit-save" data-id="' + esc(h.id) + '">' + (isNew ? 'Add habit' : 'Save') + '</button>';
  if (!isNew) {
    s += '<button class="btn" data-act="habit-archive" data-id="' + esc(h.id) + '">' + (h.archived ? 'Unarchive' : 'Archive') + '</button>' +
      '<button class="btn btn--danger" data-act="habit-delete" data-id="' + esc(h.id) + '">Delete</button>';
  }
  s += '<button class="btn btn--ghost" data-close="1">Cancel</button></div>';
  if (!isNew) s += '<p class="tiny muted" style="margin-top:10px">Archiving keeps every log. Deleting purges this habit and all of its history.</p>';

  openSheet(isNew ? 'New habit' : 'Edit habit', s);
}

function importSheet() {
  var s = '<p class="tiny muted" style="margin:0 0 8px">Paste an Orbit backup, or choose the file. Habits match on id, then on name. Day logs merge by date — the incoming file wins any clash.</p>' +
    '<label class="field"><span class="field__label">Backup file</span><input type="file" id="impFile" accept="application/json,.json"></label>' +
    '<label class="field"><span class="field__label">…or paste JSON</span><textarea id="impText" spellcheck="false" placeholder="{&quot;version&quot;:1,…}"></textarea></label>' +
    '<div class="btn-row"><button class="btn btn--primary" data-act="import-run">Merge</button><button class="btn btn--ghost" data-close="1">Cancel</button></div>';
  openSheet('Import backup', s);
}

/* ================================================================
   13. Mutations
   ================================================================ */

function setLog(habitId, date, log) {
  var h = habitById(habitId);
  if (!h || !isEditable(date)) return false;
  var before = levelInfo().level;
  var d = dayRec(date, true);
  var prev = d.logs[habitId] ? (d.logs[habitId].t || 0) : (d.del[habitId] || 0);
  var stamp = stampAfter(prev);
  if (log === null) {
    delete d.logs[habitId];
    d.del[habitId] = stamp;                    // a tombstone, so the clear syncs as an edit
  } else {
    log.t = stamp;
    d.logs[habitId] = log;
    delete d.del[habitId];
  }
  save();
  var after = levelInfo().level;
  if (after > before) celebrateLevel(after);
  return true;
}

function toggleHabit(habitId, date) {
  var h = habitById(habitId);
  if (!h) return;
  var rec = state.days[date];
  var log = rec && rec.logs[habitId];
  if (log) {
    setLog(habitId, date, null);
    toast(h.name + ' cleared');
  } else {
    setLog(habitId, date, h.cadence === 'weekly' ? { s: 1 } : { d: 1 });
    toast(h.name + ' — done');
  }
}

function setBusy(date, mode) {
  if (!isEditable(date)) { toast('That day is frozen'); return; }
  var d = dayRec(date, true);
  var ws = weekStart(date), used = busyUsed(ws), st = state.settings;
  if (d.busy === mode) {
    d.busy = null;
  } else {
    if (st.quotaEnabled) {
      if (mode === 'busy' && used.busy - (d.busy === 'busy' ? 1 : 0) >= st.busyQuota) { toast('Busy days spent. ' + quotaResetText()); return; }
      if (mode === 'very' && used.very - (d.busy === 'very' ? 1 : 0) >= st.veryBusyQuota) { toast('Very busy days spent. ' + quotaResetText()); return; }
    }
    d.busy = mode;                       // the two modes are mutually exclusive
  }
  d.busyT = stampAfter(d.busyT);
  save();
  render();
}

function saveHabitFromSheet(id) {
  var name = ($('#hName').value || '').trim();
  if (!name) { toast('Give the habit a name'); return; }
  var type = $('#hType').value === 'timed' ? 'timed' : 'binary';
  var cadence = $('#hCadence').value === 'weekly' ? 'weekly' : 'daily';
  var target = clamp(Math.round(+$('#hTarget').value || (cadence === 'weekly' ? 4 : 7)), 1, 21);
  var min = clamp(Math.round(+$('#hMin').value || 0), 0, 600);
  var discharge = +$('#hDischarge').value || 0;
  var ring = $('#hRing').value;
  var colorBtn = $('#hColors .is-on');
  var color = colorBtn ? colorBtn.getAttribute('data-color') : 'sage';
  if (type === 'timed' && min <= 0) min = 15;

  var h = id ? habitById(id) : null;
  if (h) {
    h.name = name; h.type = type; h.cadence = cadence; h.weeklyTarget = cadence === 'daily' ? 7 : target;
    h.min = min; h.discharge = discharge; h.color = color; h.ring = ring;
    h.t = stampAfter(h.t);
    toast('Saved');
  } else {
    var maxOrder = state.habits.reduce(function (m, x) { return Math.max(m, x.order); }, -1);
    state.habits.push({
      id: uid(), name: name, type: type, cadence: cadence,
      weeklyTarget: cadence === 'daily' ? 7 : target, min: min, discharge: discharge,
      color: color, ring: ring, archived: false, order: maxOrder + 1, createdAt: today(), t: stampAfter(0)
    });
    toast('Habit added');
  }
  save(); closeSheet(); render();
}

function moveHabit(id, delta) {
  var list = habitsSorted(true), i = list.findIndex(function (h) { return h.id === id; });
  var j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return;
  var a = list[i], b = list[j], tmp = a.order;
  a.order = b.order; b.order = tmp;
  a.t = stampAfter(a.t); b.t = stampAfter(b.t);
  save(); render();
}

/* ================================================================
   14. Export / import
   ================================================================ */

function exportData() {
  var payload = JSON.stringify(state, null, 2);
  var blob = new Blob([payload], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = EXPORT_NAME; a.rel = 'noopener';
  document.body.appendChild(a); a.click();
  setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 400);
  toast('Exported ' + EXPORT_NAME);
}

/**
 * Merge another Orbit document into the local one, field by field, newest stamp winning.
 * This is the single merge used by both file import and device sync.
 *
 * opts.preferIncoming — for hand-imported backups, where entries may predate stamps
 * entirely: an incoming entry then wins a tie instead of losing it, which keeps the
 * documented "incoming wins on a clash" behaviour of the Import button.
 *
 * Returns { habitsAdded, habitsUpdated, days, changed }.
 */
function mergeDoc(incoming, opts) {
  opts = opts || {};
  var pref = !!opts.preferIncoming;
  var beats = function (mine, theirs) { return pref ? theirs >= mine : theirs > mine; };
  var before = JSON.stringify(state);
  var out = { habitsAdded: 0, habitsUpdated: 0, days: 0, changed: false };

  incoming = normalise(JSON.parse(JSON.stringify(incoming)));

  // 1. Deletions first: a tombstone from either side applies to both.
  Object.keys(incoming.tombstones.habits).forEach(function (id) {
    var t = incoming.tombstones.habits[id] || 0;
    if (t > (state.tombstones.habits[id] || 0)) state.tombstones.habits[id] = t;
  });
  state.habits = state.habits.filter(function (h) {
    return (state.tombstones.habits[h.id] || 0) <= (h.t || 0);
  });

  // 2. Habits: match on id, then on name, so two devices that seeded separately still line up.
  var idMap = {};
  incoming.habits.forEach(function (ih) {
    if ((state.tombstones.habits[ih.id] || 0) > (ih.t || 0)) return;      // deleted after this version
    var local = habitById(ih.id);
    if (!local) {
      local = state.habits.filter(function (h) {
        return h.name.toLowerCase().trim() === ih.name.toLowerCase().trim();
      })[0] || null;
    }
    if (!local) {
      var maxOrder = state.habits.reduce(function (m, x) { return Math.max(m, x.order); }, -1);
      ih.order = maxOrder + 1;
      state.habits.push(ih);
      idMap[ih.id] = ih.id;
      out.habitsAdded++;
      return;
    }
    idMap[ih.id] = local.id;
    if (beats(local.t || 0, ih.t || 0)) {
      local.name = ih.name; local.type = ih.type; local.cadence = ih.cadence;
      local.weeklyTarget = ih.weeklyTarget; local.min = ih.min; local.discharge = ih.discharge;
      local.color = ih.color; local.ring = ih.ring; local.archived = ih.archived;
      local.order = ih.order; local.t = ih.t || 0;
      out.habitsUpdated++;
    }
    if (ih.createdAt < local.createdAt) local.createdAt = ih.createdAt;
  });

  // 3. Days, entry by entry, so two devices logging different habits on the same day both keep theirs.
  Object.keys(incoming.days).forEach(function (date) {
    var src = incoming.days[date], dst = dayRec(date, true);
    out.days++;
    if (beats(dst.busyT || 0, src.busyT || 0)) { dst.busy = src.busy; dst.busyT = src.busyT || 0; }
    Object.keys(src.del || {}).forEach(function (hid) {
      var id = idMap[hid] || hid, t = src.del[hid] || 0;
      if (t > (dst.del[id] || 0)) dst.del[id] = t;
    });
    Object.keys(src.logs || {}).forEach(function (hid) {
      var id = idMap[hid] || hid, log = src.logs[hid];
      var mine = dst.logs[id] ? (dst.logs[id].t || 0) : (dst.del[id] || 0);
      if (beats(mine, log.t || 0)) { dst.logs[id] = log; }
    });
    Object.keys(dst.del).forEach(function (id) {           // a clear that lands after the log removes it
      var log = dst.logs[id];
      if (log && dst.del[id] > (log.t || 0)) delete dst.logs[id];
    });
  });

  // 4. Settings, and the monotonic level counters.
  if (incoming.settings && beats(state.meta.settingsT || 0, incoming.meta.settingsT || 0)) {
    state.settings.quotaEnabled = !!incoming.settings.quotaEnabled;
    state.settings.busyQuota = incoming.settings.busyQuota;
    state.settings.veryBusyQuota = incoming.settings.veryBusyQuota;
    state.meta.settingsT = incoming.meta.settingsT || 0;
  }
  if (incoming.createdAt && incoming.createdAt < state.createdAt) state.createdAt = incoming.createdAt;
  if (incoming.meta.peakPoints > (state.meta.peakPoints || 0)) state.meta.peakPoints = incoming.meta.peakPoints;
  if (incoming.meta.level > (state.meta.level || 1)) state.meta.level = incoming.meta.level;

  state = normalise(state);
  levelInfo();
  out.changed = JSON.stringify(state) !== before;
  return out;
}

/** The Import button: parse, merge with incoming winning ties, report. */
function mergeImport(raw) {
  var incoming;
  try { incoming = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch (e) { toast('That is not valid JSON'); return false; }
  if (!incoming || typeof incoming !== 'object' || (!incoming.habits && !incoming.days)) { toast('Not an Orbit backup'); return false; }
  var r = mergeDoc(incoming, { preferIncoming: true });
  save();
  toast('Merged ' + r.days + ' day' + (r.days === 1 ? '' : 's') + ' · ' + r.habitsAdded + ' new, ' + r.habitsUpdated + ' updated');
  return true;
}

function wipeData() {
  if (!window.confirm('Wipe every habit and every log on this device? This cannot be undone.')) return;
  if (!window.confirm('Really wipe? Export first if you want a backup.')) return;
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  state = freshState();
  save();
  ui.date = today(); ui.week = weekStart(today()); ui.month = monthStart(today());
  render();
  toast('Back to a blank chart');
}

/* ================================================================
   15. Level-up flourish
   ================================================================ */

function celebrateLevel(level) {
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var note = document.createElement('div');
  note.className = 'levelup';
  note.innerHTML = '<div class="levelup__lv">' + level + '</div><div class="levelup__label">Level up</div>';
  document.body.appendChild(note);
  if (!reduce) {
    var s = '<svg viewBox="0 0 100 100" preserveAspectRatio="none">', i, rand = rng(Date.now() >>> 0);
    for (i = 0; i < 14; i++) {
      var x = 20 + rand() * 60, y = 22 + rand() * 34, r = 1.6 + rand() * 3.2;
      s += '<g class="sparkle" style="animation-delay:' + (rand() * 0.5).toFixed(2) + 's;transform-origin:' + x + 'px ' + y + 'px">' +
        '<path d="' + starPath(x, y, r) + '" fill="#D9B48B" stroke="#2C2A26" stroke-width=".3"/></g>';
    }
    fxEl.innerHTML = s + '</svg>';
    setTimeout(function () { fxEl.innerHTML = ''; }, 2000);
  }
  setTimeout(function () { if (note.parentNode) note.parentNode.removeChild(note); }, 2500);
}

/* ================================================================
   16. Render + router
   ================================================================ */

var VIEWS = { today: renderToday, week: renderWeek, month: renderMonth, stats: renderStats, settings: renderSettings };

function render() {
  var fn = VIEWS[ui.view] || renderToday;
  var metaBefore = JSON.stringify(state.meta);
  rendering = true;
  viewEl.innerHTML = fn();
  var info = levelInfo();
  $('#chipLevel').textContent = 'Lv ' + info.level;
  $('#chipLevel').title = fmtPoints(info.points) + ' points · ' + fmtPoints(info.toGo) + ' to level ' + (info.level + 1);
  var os = overallStreak();
  $('#chipStreak').textContent = os + 'd';
  $('#chipStreak').title = 'Overall streak — ' + os + ' day' + (os === 1 ? '' : 's');
  $$('.tab').forEach(function (b) {
    var on = b.getAttribute('data-view') === ui.view;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  rendering = false;
  refreshSyncUI();
  // levelInfo() can raise the monotonic counters; that is the only thing a paint persists.
  if (JSON.stringify(state.meta) !== metaBefore) save();
}

/** Repaint just the sync bits, so a status change never clears a half-typed code. */
function refreshSyncUI() {
  var chip = $('#chipSync');
  if (chip) {
    if (!window.OrbitSync || !window.OrbitSync.configured()) {
      chip.hidden = true;
    } else {
      var v = window.OrbitSync.snapshot();
      chip.hidden = false;
      chip.innerHTML = syncGlyph(v.signedIn ? v.status : 'offline');
      chip.title = 'Sync — ' + v.statusText;
      chip.classList.toggle('is-error', v.status === 'error');
    }
  }
  if (rendering || ui.view !== 'settings') return;
  var card = $('#syncCard');
  if (!card) return;
  var active = document.activeElement;
  var id = active && active.id, caret = null;
  try { caret = active && active.selectionStart; } catch (e) { caret = null; }
  var holder = document.createElement('div');
  holder.innerHTML = renderSyncCard();
  card.parentNode.replaceChild(holder.firstChild, card);
  if (id) {
    var again = document.getElementById(id);
    if (again) {
      try { again.focus({ preventScroll: true }); } catch (e) { again.focus(); }
      if (caret != null && again.setSelectionRange) { try { again.setSelectionRange(caret, caret); } catch (e) {} }
    }
  }
}

function go(view) {
  if (!VIEWS[view]) return;
  ui.view = view;
  if (view === 'today' && !isEditable(ui.date)) ui.date = today();
  render();
  window.scrollTo({ top: 0, behavior: 'auto' });
}

/* ================================================================
   17. Events
   ================================================================ */

function bloom(el) {
  var svg = el && el.querySelector('svg');
  if (!svg) return;
  svg.classList.remove('bloom');
  void svg.offsetWidth;
  svg.classList.add('bloom');
}

function onAction(e) {
  var closer = e.target.closest('[data-close]');
  if (closer) { closeSheet(); return; }

  var tab = e.target.closest('.tab');
  if (tab) { go(tab.getAttribute('data-view')); return; }

  var swatch = e.target.closest('.swatch');
  if (swatch) {
    $$('.swatch', sheetBody).forEach(function (b) { b.classList.remove('is-on'); });
    swatch.classList.add('is-on');
    return;
  }

  var btn = e.target.closest('[data-act]');
  if (btn) {
    var act = btn.getAttribute('data-act');
    var id = btn.getAttribute('data-id');
    var date = btn.getAttribute('data-date');

    if (act === 'day') { ui.date = addDays(ui.date, +btn.getAttribute('data-delta')); render(); return; }
    if (act === 'week') { ui.week = addDays(ui.week, 7 * +btn.getAttribute('data-delta')); render(); return; }
    if (act === 'month') {
      var d = parseYmd(ui.month); d.setMonth(d.getMonth() + (+btn.getAttribute('data-delta')));
      ui.month = monthStart(ymd(d)); render(); return;
    }
    if (act === 'busy') { setBusy(ui.date, btn.getAttribute('data-mode')); return; }
    if (act === 'cell') { logSheet(id, date); return; }
    if (act === 'full') { setLog(id, date, habitById(id).cadence === 'weekly' ? { s: 1 } : { d: 1 }); closeSheet(); render(); toast('Logged'); return; }
    if (act === 'minutes') { setLog(id, date, { m: +btn.getAttribute('data-m') }); closeSheet(); render(); toast('Logged ' + btn.getAttribute('data-m') + ' min'); return; }
    if (act === 'minutes-custom') {
      var v = Math.round(+($('#minInput').value || 0));
      if (!(v > 0)) { toast('Enter minutes above zero'); return; }
      setLog(id, date, { m: clamp(v, 1, 600) }); closeSheet(); render(); toast('Logged ' + clamp(v, 1, 600) + ' min'); return;
    }
    if (act === 'sessions') {
      var n = +btn.getAttribute('data-n');
      setLog(id, date, n > 0 ? { s: n } : null);
      render(); logSheet(id, date); return;
    }
    if (act === 'clear') { setLog(id, date, null); closeSheet(); render(); toast('Cleared'); return; }
    if (act === 'habit-new') { habitSheet(null); return; }
    if (act === 'habit-edit') { habitSheet(id); return; }
    if (act === 'habit-save') { saveHabitFromSheet(id); return; }
    if (act === 'habit-move') { moveHabit(id, +btn.getAttribute('data-delta')); return; }
    if (act === 'habit-archive') {
      var h = habitById(id); h.archived = !h.archived; h.t = stampAfter(h.t); save(); closeSheet(); render();
      toast(h.archived ? h.name + ' archived — history kept' : h.name + ' back in orbit'); return;
    }
    if (act === 'habit-delete') {
      var hd = habitById(id);
      if (!window.confirm('Delete "' + hd.name + '" and purge all of its history? Archiving keeps the history instead.')) return;
      state.habits = state.habits.filter(function (x) { return x.id !== id; });
      state.tombstones.habits[id] = stampAfter(hd.t);
      Object.keys(state.days).forEach(function (k) {
        delete state.days[k].logs[id];
        delete state.days[k].del[id];
      });
      save(); closeSheet(); render(); toast('Deleted'); return;
    }
    if (act === 'quota-toggle') { state.settings.quotaEnabled = !state.settings.quotaEnabled; state.meta.settingsT = stampAfter(state.meta.settingsT); save(); render(); return; }
    if (act === 'export') { exportData(); return; }
    if (act === 'import') { importSheet(); return; }
    if (act === 'import-run') {
      var text = $('#impText').value.trim();
      var file = $('#impFile').files && $('#impFile').files[0];
      if (file) {
        var reader = new FileReader();
        reader.onload = function () { if (mergeImport(String(reader.result))) { closeSheet(); render(); } };
        reader.onerror = function () { toast('Could not read that file'); };
        reader.readAsText(file);
        return;
      }
      if (!text) { toast('Paste a backup or choose a file'); return; }
      if (mergeImport(text)) { closeSheet(); render(); }
      return;
    }
    if (act === 'wipe') { wipeData(); return; }

    if (act.indexOf('sync-') === 0) {
      var S = window.OrbitSync;
      if (!S) { toast('Sync is unavailable'); return; }
      if (act === 'sync-config-save') {
        var r = S.setConfig($('#cfgUrl').value, $('#cfgKey').value);
        if (!r.ok) { toast(r.error); return; }
        syncDraft.url = syncDraft.key = '';
        render();
        toast('Project connected — sign in to start syncing');
        return;
      }
      if (act === 'sync-config-clear') {
        if (!window.confirm('Disconnect this device from the project? Your chart stays on the device.')) return;
        S.signOut(false); S.setConfig('', ''); render(); toast('Disconnected'); return;
      }
      if (act === 'sync-mode-code') { syncDraft.pass = ''; S.setMode('code'); return; }
      if (act === 'sync-mode-password') { S.setMode('password'); return; }
      if (act === 'sync-signin' || act === 'sync-signup') {
        syncDraft.email = $('#syncEmail').value;
        syncDraft.pass = $('#syncPass').value;
        var run = act === 'sync-signin' ? S.signIn : S.signUp;
        run(syncDraft.email, syncDraft.pass).then(function (okIn) {
          if (!okIn) return;
          syncDraft = { email: '', pass: '', code: '', url: '', key: '' };
          render();
          toast('Signed in — this device and your account are merged');
        });
        return;
      }
      if (act === 'sync-send') { syncDraft.email = $('#syncEmail').value; S.sendCode(syncDraft.email); return; }
      if (act === 'sync-resend') { S.sendCode(S.snapshot().pending.email); return; }
      if (act === 'sync-back') { syncDraft.code = ''; S.cancelCode(); return; }
      if (act === 'sync-verify') {
        syncDraft.code = $('#syncCode').value;
        S.verifyCode(syncDraft.code).then(function (okSignIn) {
          if (!okSignIn) return;
          syncDraft = { email: '', pass: '', code: '', url: '', key: '' };
          render();
          toast('Signed in — this device and your account are merged');
        });
        return;
      }
      if (act === 'sync-now') { S.syncNow('manual'); return; }
      if (act === 'sync-signout') {
        if (!window.confirm('Sign out? The chart stays on this device.')) return;
        S.signOut(false); render(); toast('Signed out'); return;
      }
      if (act === 'sync-signout-wipe') {
        if (!window.confirm('Sign out and delete the local copy on this device? Your account keeps its own copy.')) return;
        S.signOut(true); toast('Signed out, device cleared'); return;
      }
      return;
    }
  }

  var planet = e.target.closest('.planet');
  if (planet && !planet.disabled) {
    if (planet.dataset.longpressed === '1') { planet.dataset.longpressed = ''; return; }
    toggleHabit(planet.getAttribute('data-habit'), ui.date);
    bloom(planet);
    var keep = planet.getAttribute('data-habit');
    render();
    var again = viewEl.querySelector('.planet[data-habit="' + CSS.escape(keep) + '"]');
    if (again) bloom(again);
  }
}

function bindLongPress() {
  var timer = null, startX = 0, startY = 0, target = null;

  function cancel() { clearTimeout(timer); timer = null; target = null; }

  document.addEventListener('pointerdown', function (e) {
    var p = e.target.closest('.planet');
    if (!p || p.disabled) return;
    target = p; startX = e.clientX; startY = e.clientY;
    p.dataset.longpressed = '';
    clearTimeout(timer);
    timer = setTimeout(function () {
      if (!target) return;
      target.dataset.longpressed = '1';
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch (err) {} }
      logSheet(target.getAttribute('data-habit'), ui.date);
      target = null;
    }, 460);
  }, { passive: true });

  document.addEventListener('pointermove', function (e) {
    if (!timer) return;
    if (Math.abs(e.clientX - startX) > 10 || Math.abs(e.clientY - startY) > 10) cancel();
  }, { passive: true });

  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (evt) {
    document.addEventListener(evt, function () { clearTimeout(timer); timer = null; target = null; }, { passive: true });
  });

  document.addEventListener('contextmenu', function (e) {
    var p = e.target.closest('.planet');
    if (!p) return;
    e.preventDefault();
    if (!p.disabled) logSheet(p.getAttribute('data-habit'), ui.date);
  });
}

function bindSettingsInputs() {
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!t || !t.id) return;
    if (t.id === 'syncEmail') syncDraft.email = t.value;
    else if (t.id === 'syncPass') syncDraft.pass = t.value;
    else if (t.id === 'syncCode') syncDraft.code = t.value;
    else if (t.id === 'cfgUrl') syncDraft.url = t.value;
    else if (t.id === 'cfgKey') syncDraft.key = t.value;
  });
  document.addEventListener('change', function (e) {
    var f = e.target.closest('[data-setting]');
    if (!f) return;
    var key = f.getAttribute('data-setting');
    state.settings[key] = clamp(Math.round(+f.value || 0), 0, 7);
    state.meta.settingsT = stampAfter(state.meta.settingsT);
    save();
    render();
  });
}

function bindKeys() {
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !sheetEl.hidden) { closeSheet(); return; }
    if (e.target.matches('input,textarea,select')) return;
    if (ui.view === 'today' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      var delta = e.key === 'ArrowLeft' ? -1 : 1;
      var next = addDays(ui.date, delta);
      if (isEditable(next)) { ui.date = next; render(); }
    }
  });
}

/* ================================================================
   18. Boot
   ================================================================ */

function watchRollover() {
  var seen = today();
  setInterval(function () {
    var now = today();
    if (now !== seen) {
      var wasToday = ui.date === seen;
      seen = now;
      if (wasToday) ui.date = now;
      ui.week = weekStart(now);
      render();
    }
  }, 30000);
}

/** Web fonts are a nicety: attach them after load so the network never blocks paint. */
function loadFonts() {
  var href = 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Inter:wght@400;500;600&display=swap';
  var attach = function () {
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.crossOrigin = 'anonymous';
    document.head.appendChild(link);                 // failure is silent — the fallback stacks stand in
  };
  if (document.readyState === 'complete') attach();
  else window.addEventListener('load', attach);
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;   // file:// has no SW
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function () { /* offline shell is a bonus, not a requirement */ });
  });
}

function init() {
  viewEl = $('#view'); sheetEl = $('#sheet'); sheetTitle = $('#sheetTitle');
  sheetBody = $('#sheetBody'); toastEl = $('#toast'); fxEl = $('#fx');

  state = load();
  var isNew = !loggedDays().length && state.meta.peakPoints === 0;
  save();

  ui.date = today(); ui.week = weekStart(ui.date); ui.month = monthStart(ui.date);
  render();

  document.addEventListener('click', onAction);
  bindLongPress();
  bindSettingsInputs();
  bindKeys();
  watchRollover();
  loadFonts();
  registerSW();

  if (window.OrbitSync) {
    window.OrbitSync.subscribe(function () { refreshSyncUI(); });
    window.OrbitSync.attach({
      getDoc: function () { return JSON.parse(JSON.stringify(state)); },
      mergeDoc: function (doc) { return mergeDoc(doc); },
      save: save,
      render: render,
      wipeLocal: function () {
        try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
        state = freshState();
        save();
        ui.date = today(); ui.week = weekStart(ui.date); ui.month = monthStart(ui.date);
        render();
      }
    });
  }

  window.addEventListener('storage', function (e) {
    if (e.key !== STORAGE_KEY) return;
    state = load();
    render();
  });

  // A small hook for the acceptance checks and for anyone poking at the console.
  window.Orbit = {
    get state() { return state; },
    save: save, render: render, go: go,
    today: today, shiftedDate: shiftedDate, weekStart: weekStart,
    logPoints: logPoints, dayPoints: dayPoints, weeklyHabitPoints: weeklyHabitPoints,
    statusOf: statusOf, isDischarged: isDischarged, dailyObligations: dailyObligations,
    dayCompletion: dayCompletion, habitStreak: habitStreak, overallStreak: overallStreak,
    levelInfo: levelInfo, levelThreshold: levelThreshold, weekTarget: weekTarget, weekPoints: weekPoints,
    setLog: setLog, setBusy: setBusy, mergeImport: mergeImport, mergeDoc: mergeDoc, isEditable: isEditable,
    now: now, loggedDays: loggedDays,
    reset: function (seed) { state = seed ? normalise(seed) : freshState(); save(); render(); },
    ui: ui
  };

  if (isNew) toast('Seven habits seeded. Tap a planet to begin.');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();
