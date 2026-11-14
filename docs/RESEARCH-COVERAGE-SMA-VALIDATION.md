# Research coverage — SMA validation (closed)

Phase closed. Do not optimize for more claims / `sourceUrl` / `verified`.
0 verified is correct when evidence cannot support the requested facts.
TripPanel / Interactive TripPanel / grounding rules unchanged by follow-ups.

## Canonical jobs

| | Job ID | When |
|--|--------|------|
| **Before** | `2b9db875-9408-4683-83c9-42d2dc703763` | Pre-fix prod diagnosis |
| **After** | `01333454-b90c-4d32-be20-1041ba02a060` | Post-fix k3s validation |

Discard any aborted enqueue/poll runs (e.g. `kubectl cp` targeting `deploy/` instead of the pod). Those are not agent or pipeline failures.

## Before → after (`2b9db875` → `01333454`)

| Metric | Before | After |
|--------|--------|-------|
| Duration | 36.8 s | 27.2 s |
| Tool rounds | 1 | 3 |
| Tool calls used | 4 / 6 | 6 / 6 |
| Forced coverage nudge | 0 | 0 (budget spent in first batch via reserved `fetchUrl` slots) |
| `webSearch` OK | 4 | 4 |
| `fetchUrl` OK | 0 | **2** |
| Claims | 0 | 0 |
| Anchored sources (`option.sourceUrl`) | 0 | 0 |
| Consulted sources (`toolTrace`) | 20 | 17 |
| Verified options | 0 | 0 |
| Checklist items | 5 | 3 |
| “Central Nueva … basada en búsqueda” in notes | yes | **no** |

### After tools (`01333454`)

1. `webSearch` — vuelos Ciudad de México a Guadalajara 19 septiembre 2026  
2. `webSearch` — terminal autobuses Guadalajara a San Miguel el Alto  
3. `webSearch` — corrida autobús Guadalajara a San Miguel el Alto 20:00 duración 2h30  
4. `webSearch` — hoteles cerca terminal autobuses Guadalajara  
5. (extra `webSearch` held by reserve)  
6. `fetchUrl` OK — `https://www.volaris.com/es-mx/vuelos-desde-mexico-df-a-guadalajara`  
7. `fetchUrl` OK — `https://terminal.horariodeautobuses.com.mx/central-autobuses-san-miguel-el-alto`

### After research goals

| Status | Kind |
|--------|------|
| UNRESOLVED | `flight_day_specific`, `event_activities` |
| PARTIAL | `airport_terminal`, `bus_terminal`, `connection_feasibility`, `lodging_contingency`, `lodging_destination`, `ground_leg` |

### Candidate discard reasons (diagnostics only)

- `insufficient_evidence` ×15  
- `duplicate` ×5  
- `generic_landing_page` ×1  
- `wrong_date` ×1  

### Expected behavior (approved)

- Multi-round investigation with directed `fetchUrl`  
- Reject insufficient / wrong-date evidence  
- No artificial promotion to VERIFIED  
- UNKNOWN / PARTIAL when evidence does not support claims  
- Free-text factual leak (“Central Nueva basada en búsqueda”) removed without provenance  

## Commits (this phase)

- `3c21bb3` — Force directed research coverage for new_travel goals  
- `037d9bd` — Reserve tool budget for directed research follow-up  
- `15c4d23` — Prefer fetchUrl when spending reserved research follow-up budget  
- `b9260bc` — Let fetchUrl spend the reserved research follow-up slots  

## Tests

### `travel-agent/src/agent/researchCoverage.test.ts`

- derives concrete SMA goals from prompt  
- 1 goal resolved + several unresolved → force another round  
- all goals resolved → no extra searches  
- tool budget exhausted → no force (checklist path)  
- generic landing + wrong-date flight hits → rejected  
- named hotel hit without fetch → not verified (partial candidate only)  
- valid anchored hit → sourceUrl counts as anchored  
- notes “Central Nueva basada en búsqueda” without provenance → scrubbed  
- 0 option sources but toolTrace hits → consulted vs anchored distinguished  
- PARTIAL without fetchUrl → force directed round  
- generic first search → directed nudge prefers fetchUrl/refined, not repeat  

### Related

- `travel-agent/src/agent/claims.test.ts` — skeleton drops invalid `evidenceIndex` claims instead of failing closed; existing scrub / aggregate-flight cases  
- `src/application/tripPanel/buildTripPanel.test.ts` — consulted vs anchored diagnostics distinction (case 14)  

## Flight-critical priority (follow-up)

Closed separately from the initial coverage ship. Canonical regression job:

| | Job ID |
|--|--------|
| **Before** | `24bf6051-bfee-4046-ab16-83ee7fc1d0c0` |
| **After** | `898b7032-0e89-40d2-80bd-b930f4b61b62` |

Changes: critical `flight_day_specific` tier, directed carrier retry before lodging/events, `fetch_blocked_js` / day-specific criteria, no false RESOLVED for `airport_terminal` / `connection_feasibility` from bus terminal URLs.

After validation outcome: flight remained UNRESOLVED without inventing schedule; tool budget spent on flight searches + airline fetches (no lodging/event calls); connection correctly UNRESOLVED (flight arrival unknown). webSearch+fetchUrl still insufficient for day-specific MX domestic inventory — next phase (not implemented): Amadeus/Duffel/etc.
