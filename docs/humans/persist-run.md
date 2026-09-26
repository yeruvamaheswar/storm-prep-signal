# Saving each run

After the engine finishes a run it still writes a file on this laptop (`var/runs/<id>.json`). Add `--persist` to also copy that file into the `runs` table in Supabase. Without `--persist`, a tape run stays on this laptop and uses no network. The live worker always copies.

If the network or the keys are missing, the local file is still the answer. The wall keeps reading the API / that file. A failed copy never stops the run. An empty `runs` table also does not clear the wall.

More detail: `docs/agents/persist-run.md`.
