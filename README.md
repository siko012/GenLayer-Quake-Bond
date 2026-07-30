# Tremorline — Earthquake CAT bond

Tremorline is a parametric catastrophe bond for earthquake risk. Bondholders deposit GEN into a pool. If a qualifying seismic event occurs within a monitored region, the bond triggers and pays out to beneficiaries.

## Data source

The contract reads from the USGS FDSN event API (`earthquake.usgs.gov/fdsnws/event/1/query`), selecting the strongest event within the last 24 h in the target polygon.

## Verdict model

The validator computes `max_mmi` — the maximum MMI intensity of the queried events — and classifies:

| max_mmi | Verdict |
|---|---|
| ≥ VII (7.0) | `SEVERE_SHAKE` — full payout |
| IV–VI (4.0–6.9) | `MODERATE` — partial payout (proportional) |
| < IV (0–3.9) | `NO_EVENT` — no payout |

Validators must agree within ±0.5 MMI units.

## Contract

- **Network:** GenLayer Studionet (61999)
- **Address:** `0x90E07B10167D20B83C6729eCAc5d0f2C48D317D5`
- **Language:** Python (py-genlayer)

The contract accepts a latitude/longitude polygon (min 3 vertices), a trigger MMI threshold, a bond description, and an exposure amount. The adjudicator is callable by any address.

## Frontend

```sh
cd frontend
npm install
npm run dev
```

React 18 + TypeScript + Vite, wagmi, RainbowKit, genlayer-js. Displays a watch list of monitored zones, current MMI status (severity dial), and a bond pool meter.

## License

MIT
