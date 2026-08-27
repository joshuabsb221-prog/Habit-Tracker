# Orbit

A habit and productivity tracker drawn as a hand-inked celestial chart. Seven planets in loose
orbit, a cream-paper ground, and no dashboard anywhere in sight.

Static HTML, CSS and JavaScript — no build step, no framework. Everything lives in `localStorage` on
the device that logged it; sync across devices is optional, off until you connect a project, and
described under [Sync](#sync).

## Run it

Open `index.html`. That is the whole install. It works from `file://`, from any static host, and
from GitHub Pages.

### GitHub Pages

1. Push this repository (or unzip `orbit.zip` into one).
2. **Settings → Pages → Build and deployment → Deploy from a branch**, pick the branch and `/ (root)`.
3. Open the published URL on your phone and **Add to Home Screen**. The manifest sets
   `display: standalone` with a maskable icon, so it opens as a real full-screen app.

`.nojekyll` is present so Pages serves the files as-is.

## The model

**Days roll over at 02:00 local time.** A log made at 01:30 on Tuesday belongs to Monday. Every
date calculation in the app uses that shifted boundary, never `Date` midnight. Days are keyed
`YYYY-MM-DD` on the shifted date.

**Back-fill reaches 7 days.** Today and the previous seven days can be edited from the Today view's
date stepper or by tapping a cell in the Week grid. Anything older is frozen and read-only.

### Habits

| Habit | Target | Type | Full credit |
|---|---|---|---|
| Learning Malay | daily | timed | 15 min |
| SQE Revision | daily | timed | 30 min |
| Philosophy Reading | daily | timed | 20 min |
| Healthy Eating | daily | binary | — |
| Gym | 4 × week | binary | — |
| Moisturising | daily | binary | — |
| Replying to Messages | daily | binary | — |

All seven are seeds, not fixtures: rename, reorder, retarget, recolour, archive or delete any of
them, and add your own. Archiving keeps the history; deleting purges it.

- **Timed habits** take an optional minutes value. At or above the minimum is a full point. Below
  it scores `minutes ÷ minimum`, rounded to the nearest 0.1, floor 0.1. Tapping without entering
  minutes counts as a full completion.
- **Gym** is a weekly target, not a daily one. Sessions 1–4 in a week are worth 1 point each; every
  session past the fourth is worth 0.5 as an uncapped bonus. Gym is never "missed" on a single day,
  only under target for the week. Press and hold to log more than one session in a day.

### Busy days

Two mutually exclusive toggles per day, set from Today.

- **Busy day** discharges Learning Malay, Philosophy Reading and Replying to Messages.
- **Very busy day** discharges those three plus SQE Revision.
- Gym, Healthy Eating and Moisturising are never discharged.

A discharged habit is **neutral**: it does not break a streak, does not extend one, and drops out of
that day's denominator — so a fully-logged busy day still reads 100%. It also drops out of that
week's target, so a discharge can never make the week harder to clear. Discharged cells are drawn
with a faint dotted ring, distinct from both a hit and a miss.

The quota is 2 busy + 1 very busy per calendar week (Mon–Sun), enforced by default, adjustable in
Settings, and switchable off entirely. When it is spent the button is disabled and says when it
resets.

### Scoring

- **Points** — 1 per completion, partial credit as above, 0.5 per bonus gym session.
- **Weekly target** — the sum of every active habit's weekly obligation (daily = 7, gym = 4), less
  anything discharged that week. The week clears when points ≥ target; bonus points count.
- **Levels** — cumulative lifetime points on a gentle curve, level *n* at `50 × n^1.5`. The level is
  held monotonic: editing history can never take a level back.
- **Streaks** — per habit plus one overall. A daily streak breaks on a logged miss, never on an
  empty today or a discharged day. A partial log keeps a streak alive. Gym's streak counts
  consecutive weeks at target. Current and all-time best are tracked for each.

## Views

**Today** — planets to tap, press-and-hold for minutes or sessions, busy-day toggles, today's
points, the overall streak, and a date stepper for back-fill.
**Week** — habits × 7 days, per-habit progress against its own target, weekly points vs target,
busy days used. Cells inside the back-fill window are tappable.
**Month** — a calendar heatmap by daily completion, monthly totals per habit, best streak in the
month, busy-day count.
**Stats** — level dial, lifetime points, every streak current vs best, all-time completion rate per
habit, and a sparkline of the last 12 weeks against target.
**Settings** — account and sync, habit editor, quota rules, minimums, export/import, wipe.

## Data

State is one `localStorage` key, `orbit.v1`:

```jsonc
{
  "version": 1,
  "createdAt": "2026-08-26",
  "habits": [{ "id": "h-gym", "name": "Gym", "type": "binary", "cadence": "weekly",
               "weeklyTarget": 4, "min": 0, "discharge": 0, "color": "ink", "ring": "tilt",
               "archived": false, "order": 4, "createdAt": "2026-08-26" }],
  "days": { "2026-08-26": { "busy": null, "busyT": 0,
                            "logs": { "h-malay": { "m": 20, "t": 1787812345678 } },
                            "del":  { "h-gym": 1787812349999 } } },
  "settings": { "quotaEnabled": true, "busyQuota": 2, "veryBusyQuota": 1 },
  "tombstones": { "habits": { "h-reply": 1787812340000 } },
  "meta": { "peakPoints": 128.5, "level": 3, "settingsT": 1787812340000 }
}
```

Log shapes: `{"d":1}` a plain completion, `{"m":20}` twenty minutes, `{"s":2}` two sessions.

Every record carries `t`, a millisecond stamp of its last edit, and every deletion leaves a
tombstone — `del` for a cleared log, `tombstones.habits` for a deleted habit — so a removal travels
between devices as an edit rather than as an absence. Merging compares those stamps entry by entry;
see [Sync](#sync).

**Export** downloads `orbit-backup.json` — the object above, verbatim. **Import** merges: habits
match on id, then on name; day entries merge by date with the incoming file winning any clash.
Nothing is ever uploaded anywhere.

## Sync

Optional, and off until you connect a project. Without one Orbit behaves exactly as before: local,
private, no network. With one, the same chart follows you between phone, tablet and laptop.

### Signing in without a link

Neither route asks you to click a link in an email. A magic link opens your default browser, and an
app added to the home screen — on iOS especially — keeps a storage jar of its own, so the link would
sign in a window you are not even looking at while the installed app stays signed out. Both routes
below finish inside the window that started them.

**Email and password** is the default, and works on a stock Supabase project with nothing else set
up. Create the account on the first device, then sign in with the same details on the others.

**A six-digit code** typed into the app is offered behind "Email me a code instead". It needs the
project to have its own SMTP server: Supabase will only let you put `{{ .Token }}` into an email
template once custom SMTP is configured, and its stock templates send a link and nothing else. Set
SMTP up (Resend, Brevo, Mailgun, your own — Authentication → Emails → SMTP Settings), then put the
token into **both** the *Confirm signup* and *Magic Link* templates, for example:

```html
<h2>Your Orbit code</h2>
<p style="font-size:28px;letter-spacing:6px"><strong>{{ .Token }}</strong></p>
```

Both templates matter: the first sign-in for an address sends *Confirm signup*, every one after
sends *Magic Link*. The code box is marked `autocomplete="one-time-code"`, so iOS and Android offer
the code straight from the notification.

### Setting up a project (about five minutes, free)

1. Create a project at [supabase.com](https://supabase.com). Any region; the free tier is plenty.
2. **SQL Editor → New query**, paste [`supabase/schema.sql`](supabase/schema.sql), **Run**. That
   creates the one table and its row-level security policies.
3. **Authentication → Sign In / Providers → Email**: turn **off** *Confirm email*. Without this,
   creating the account emails you a confirmation link instead of signing you in, which is the very
   thing we are avoiding. The app says so plainly if you forget.
4. **Project Settings → API**: copy the **Project URL** and the **anon public** key (newer
   dashboards may call it the *publishable* key — either is fine). Never the `service_role` or
   secret key: that one bypasses row-level security and must not go into a static site.
5. Put them in `assets/config.js` and redeploy, or open **Settings → Account & sync** in the app and
   paste them there. The config file is the better route for several devices; the in-app form is
   handy for trying it out on one.
6. In the app: **Settings → Account & sync** → your email and a password → **Create account**. On
   every other device, the same details → **Sign in**.
7. Then go back to **Authentication → Sign In / Providers → Email** and turn **off** *Allow new
   users to sign up*. Your account keeps working; nobody else can create one in your project.

### What syncing does

The whole document is stored as one row per account. On each sync Orbit pulls that row, merges it
into the local one, and pushes the result back under a compare-and-set on a revision number, so a
device that loses a race re-merges instead of overwriting.

Merging is per entry, not per document: a habit, a single day's log, the busy flag on a day, and the
settings block each carry their own stamp, and the newer edit wins. Two devices logging different
habits on the same day therefore keep both logs, and clearing a log on one device clears it on the
other rather than being undone by the other device's stale copy. An edit you make always outranks
the record it replaces even if the other device's clock is ahead, and Orbit corrects its own clock
against the server's on every request. The monotonic level counters take the higher of the two
sides, so a level is never lost to a merge.

Syncs run a couple of seconds after a change, when the app returns to the foreground, every five
minutes while it is open, and when the network comes back. Offline, everything keeps working and
the changes go up on the next connection.

### What it costs you in privacy

The anon key is a public client key — that is by design, and it grants nothing on its own: the three
row-level security policies in the schema let a signed-in account read and write only its own row.
The data is not end-to-end encrypted, so anyone with admin access to your Supabase project (you) can
read it. If that matters, the alternative is to stay signed out and move backups by hand.

## Offline

`assets/sw.js` caches the shell on first load, so the app opens with the network off. Fonts
(Fraunces, Inter) are attached by `app.js` after the page has loaded, so a slow or absent network
never blocks paint; without them the local serif/sans fallback stacks stand in and the layout is
identical. Service workers do not exist on `file://`;
the app runs there anyway, just without the cache.

## Layout of the repo

```
index.html
sw.js                     root-scope shim: importScripts('assets/sw.js')
assets/
  app.js                  state, scoring, merging, views, interaction
  sync.js                 optional account and cross-device sync
  config.js               your Supabase URL and anon key (empty = sync off)
  styles.css              palette and layout
  manifest.webmanifest
  sw.js                   the actual worker — cache list and fetch strategy
  icons/
supabase/
  schema.sql              the table and its row-level security policies
.nojekyll
```

A service worker can only control pages at or below its own path, so the worker has to be served
from the site root to cache the app shell. The root `sw.js` is a one-line shim that imports the
real one from `assets/`, and every URL inside it is resolved against `registration.scope` — so it
works unchanged at a domain root and under a GitHub Pages project path.

`window.Orbit` exposes the scoring functions and state for console poking and for the acceptance
checks.

## Licence

MIT — see `LICENSE`.
