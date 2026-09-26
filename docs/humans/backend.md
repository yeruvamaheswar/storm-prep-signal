# The backend

We now have a small web server in `server/`. It uses FastAPI.

It answers the same questions the operator wall asks: the zone, the latest tick, the homes, the tapes, and playback. For now the answers come from sample files. They are not live ERCOT data.

It never decides how much a home sells or what the reserve floor is. The engine still does that.

**Run it on your laptop**

```bash
pip install -r requirements.txt
uvicorn server.app:app --reload
```

Then open http://localhost:8000/docs to try each call.

**Put it online.** In Render, choose New, then Blueprint, and pick this repo. Render reads `render.yaml`.

More detail for agents: `docs/agents/backend.md`.
