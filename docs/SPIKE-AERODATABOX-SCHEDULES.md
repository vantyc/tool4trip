# Spike AeroDataBox schedules (read-only)

Companion: `scripts/spike-aerodatabox-schedules.ts`  
Design: `docs/SEARCH-FLIGHTS-PROVIDER-DESIGN.md` (schedule-only MVP)

**Status (2026-09-19):** script ready; **real call blocked** — no `AERODATABOX_RAPIDAPI_KEY` / `AERODATABOX_API_KEY` in agent environment. No simulated results.

## Credential

```bash
# RapidAPI (preferred): subscribe to AeroDataBox, copy X-RapidAPI-Key
printf '%s\n' 'AERODATABOX_RAPIDAPI_KEY=...' > .env.aerodatabox
chmod 600 .env.aerodatabox
# .env.* already gitignored

set -a && source .env.aerodatabox && set +a
npx tsx scripts/spike-aerodatabox-schedules.ts \
  --origin MEX --destination GDL --date 2026-09-19 \
  --fallback-date 2026-09-20
```

Primary date is never silently replaced. If `2026-09-19` fails, document the error; fallback runs only with `--fallback-date`.

## Semantics

Published schedule ≠ availability ≠ bookable inventory.
