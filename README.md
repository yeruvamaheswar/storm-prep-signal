# ReserveGate

## Run

Operator wall:

```bash
cd web
npm install
npm run dev
```

Console API (FastAPI, serves the `/v1` routes from sample fixtures for now):

```bash
pip install -r requirements.txt
uvicorn server.app:app --reload
```

With both running, the wall's masthead shows `API OK`; `npm run dev` proxies `/health` and `/v1` to port 8000. Deploy the API on Render with the Blueprint in `render.yaml`. Details: `docs/agents/backend.md`.

The wall reads `web/public/runs/latest.json` after `demo.sh` copies an engine run. Until that file exists, it shows the layout fixture for the 12-tick demo tape. Target and price on that fixture are synthetic.
