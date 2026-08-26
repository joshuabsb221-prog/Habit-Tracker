# Orbit

A habit and productivity tracker drawn as a hand-inked celestial chart. Seven planets in loose
orbit, a cream-paper ground, and no dashboard anywhere in sight.

Static HTML, CSS and JavaScript — no build step, no framework, no backend, no accounts. Everything
lives in `localStorage` on the device that logged it.

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
**Settings** — habit editor, quota rules, minimums, export/import, wipe.

## Data

State is one `localStorage` key, `orbit.v1`:

```jsonc
{
  "version": 1,
  "createdAt": "2026-08-26",
  "habits": [{ "id": "h-gym", "name": "Gym", "type": "binary", "cadence": "weekly",
               "weeklyTarget": 4, "min": 0, "discharge": 0, "color": "ink", "ring": "tilt",
               "archived": false, "order": 4, "createdAt": "2026-08-26" }],
  "days": { "2026-08-26": { "busy": null, "logs": { "h-malay": { "m": 20 }, "h-gym": { "s": 2 } } } },
  "settings": { "quotaEnabled": true, "busyQuota": 2, "veryBusyQuota": 1 },
  "meta": { "peakPoints": 128.5, "level": 3 }
}
```

Log shapes: `{"d":1}` a plain completion, `{"m":20}` twenty minutes, `{"s":2}` two sessions.

**Export** downloads `orbit-backup.json` — the object above, verbatim. **Import** merges: habits
match on id, then on name; day entries merge by date with the incoming file winning any clash.
Nothing is ever uploaded anywhere.

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
  app.js                  state, scoring, views, interaction
  styles.css              palette and layout
  manifest.webmanifest
  sw.js                   the actual worker — cache list and fetch strategy
  icons/
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
