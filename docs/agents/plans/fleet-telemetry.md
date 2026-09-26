# Fleet last-reading columns

**Goal:** `/fleet` and `/fleet/{home_id}` show `charge_state` and `power_kw` from the last streamed reading, paged, add-only.

**Architecture:** Select the two columns in `server/api/homes.py`, parse them as optional on Home, render two table/fact cells. Same `GET /v1/homes` page (default 50, max 200).

**Stack:** FastAPI, PostgREST `public.homes`, existing fleet feature pages, vitest + pytest.

## Global constraints

- Home JSON add-only. Do not rename or remove fields.
- Never send 10k homes in one body.
- No new dependency.
- Color only for state (`DESIGN.md` tokens).
- Engine still never imports Supabase.

### Task 1: API copies last-reading columns

**Files:** `server/api/homes.py`, `tests/test_homes_api.py`

- [ ] Test: row with `charge_state` / `power_kw` appears on the console home; a row without them is `null`.
- [ ] `HOME_SELECT` includes `charge_state,power_kw`.
- [ ] `as_console_home` copies known charge states only; unknown or missing is `null`. `power_kw` is `null` when absent.

### Task 2: Parse add-only Home fields

**Files:** `web/src/domain/types.ts`, `web/src/domain/parse.ts`, `web/src/features/fleet/types.ts`, `web/tests/fleetPage.test.ts`

- [ ] Test: fixture without the fields parses as `null`; present values parse.
- [ ] Types: `ChargeState` union; `charge_state` and `power_kw` are `| null`.

### Task 3: Fleet list and home detail

**Files:** `web/src/features/fleet/display.ts`, `FleetPage.tsx`, `HomePage.tsx`, `preview-data.ts`, `web/tests/fleetPage.test.ts`

- [ ] Test: table headers Charge state and Power; home-001 shows DISCHARGING and 3.5 kW; a missing reading is `—`.
- [ ] Empty colspan becomes 10.
- [ ] Home page facts include the same two lines.

### Task 4: Verify

- [ ] `pytest -q`
- [ ] `npx vitest run web/tests/fleetPage.test.ts web/tests/domain.test.ts`
- [ ] `npx tsc --noEmit` if types changed
- [ ] Append `docs/agents/progress.md`
