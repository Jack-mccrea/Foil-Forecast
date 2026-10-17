# Foil forecast

A dashboard that scores every daylight hour for the next 7 days for wing, downwind, prone and SUP foiling, matched to each rider's own weight and gear. It updates itself twice a day, and you open it on your phone like an app.

Scores have two layers:

- **Conditions:** Wind direction against the beach, gusts, and swell size, period and direction. These are the same for everyone.
- **Gear fit:** Whether the wind suits your weight, board, wing size and front wing. The dashboard tells you which combo to take.

Forecast data comes from Open-Meteo, which is free and needs no key.

---

## Option A: Join an existing dashboard (no setup)

Ask the person who runs it to add you to `config.yaml` (copy the example rider block), then open their link. Tap your name at the top. Add `#yourname` to the end of the link to open straight to your view.

## Option B: Run your own (about 10 minutes)

1. Sign in to GitHub (a free account is fine) and open the template repo you were sent.
2. Click **Use this template → Create a new repository**. Name it `foil-forecast` and make it **Public**.
3. In your new repo, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
4. Open `config.yaml`, click the pencil icon, and change the rider details and spots to your own. Click **Commit changes**.

Saving the file builds your dashboard automatically. After a couple of minutes it's live at `https://YOUR-USERNAME.github.io/foil-forecast/`. Open it on your phone and use **Add to Home Screen**.

It refreshes at about 6am and 12pm every day, and every time you save `config.yaml`.

---

## Changing your gear

Edit your rider block in `config.yaml`:

- **Wings:** List your hand-held wing sizes in square metres.
- **Foils:** For each front wing, give its name, area in cm² (usually printed on the wing), type (`low`, `mid` or `high` aspect) and which sports you use it for.
- **Boards:** Give the volume in litres and which sports you use each board for.

The dashboard estimates a wind range for every combination. Open **Your wind ranges** on the dashboard to see them. If one doesn't match how it feels on the water, add your own numbers under `overrides` using the combo name exactly as the dashboard shows it.

## Phone alerts (optional)

1. Install the free **ntfy** app and subscribe to a topic with a hard-to-guess name, such as `jack-foil-8k2q`.
2. In the repo, go to **Settings → Secrets and variables → Actions → New repository secret**. Use the name from your rider's `alert_secret` line (for example `NTFY_TOPIC`) and paste the topic as the value.

You'll get a push notification when a session in the next 48 hours scores 7.5 or more.

## Sharing it as a template (for the repo owner)

In your repo, go to **Settings** and tick **Template repository**. Then anyone can follow Option B from your repo link.

## Notes

- Spot directions in `config.yaml` are only as good as the local knowledge behind them. Check `faces` and `swell_window` for every spot.
- Wind ranges are rules of thumb. A few weeks of comparing scores with real sessions, plus overrides where needed, make them reliable.
- On a free GitHub account the dashboard is public. It shows forecasts, riders' first names and gear, and nothing else.
- To preview locally: `pip install pyyaml`, then `python foil_forecast.py --demo --out demo.html`.
