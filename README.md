# Foil Forecast

An installable phone app that scores every daylight hour for the next 7 days for wing, downwind, prone and SUP foiling, matched to each rider's own weight and gear. It fetches a live forecast from Open-Meteo every time you open it, and works offline with the last forecast it loaded.

Open it at `https://jack-mccrea.github.io/Foil-Forecast/`, then add it to your home screen (iPhone: Share, Add to Home Screen; Android: Install app).

- **Forecast:** next good session, the rest of the week's best bets, and hour-by-hour scores with wind, swell, model tide and water temperature. Filter by sport and spot.
- **Gear:** riders, boards, hand wings and front wings, edited in the app. See and override each combo's wind range.
- **Spots:** beach direction, swell window, hill-shadow winds, wave factor, downwind run. "Use my current location" sets a spot's position from the beach.
- **Sessions:** log how a session felt and see where the forecast reads high or low for each spot.

Settings you change in the app are saved on that phone. `config.yaml` holds the shared defaults every phone starts with; to make your phone's settings the default, use Gear, Copy settings, and paste over the contents of `config.yaml` on GitHub.

The app lives in `app/`. The GitHub workflow publishes it on every change to `app/`, `config.yaml` or the workflow, and twice a day also builds the classic dashboard (`classic.html`) and sends optional ntfy phone alerts with `foil_forecast.py`.

---

## Classic dashboard notes (unchanged)

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
