# ReserveGate

## Run

Operator wall:

```bash
cd web
npm install
npm run dev
```

The wall reads `web/public/runs/latest.json` after `demo.sh` copies an engine run. Until that file exists, it shows the layout fixture for the 12-tick demo tape. Target and price on that fixture are synthetic.
