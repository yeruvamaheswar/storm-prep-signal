# ReserveGate: team manifest (Uma, Rajat, Sunny)

**What it is.** ReserveGate is a controller for a simulated fleet of home batteries. It sells power when the grid asks for it, but it never drains a home below the backup reserve that home needs in a blackout. It's built for Base fleet operators first and utility partners second.

**How Storm Prep fits.** Storm Prep reads ERCOT's public outage postings. When its rule reads HIGH, or when the signal can't be read, ReserveGate raises every home's reserve floor (from 30% to 60% in our example settings). Missing the target is then allowed, and the brief explains why. The data shows the new rule fired on 1.7% of out-of-sample postings, where the old rule fired on 88%.

**Who owns what**
- **Uma:** policy, the engine that connects everything, shared files, and merges. Also records the Loom.
- **Rajat:** the controller and fleet, meaning how work is split across homes, what happens when homes fail, and scoring.
- **Sunny:** the story, meaning the demo tape, the brief, the screen, `demo.sh`, CI, the README, and the pitch.

**The one no-conflict rule.** Every file has one owner, and nobody else edits it. Only Uma edits `engine.py`. Merge `main` into your branch right before asking Uma to merge.

**Timeline (CT)**
- Fri 9:30 PM: contracts frozen on `main`.
- Sat 12:30 PM: end-to-end run works.
- Sat 1:30–2:30 PM: factory tour. No merges.
- Sat 9:00 PM: feature freeze.
- Sun 9:30 AM: code freeze.
- Sun 10:30 AM: submit.

**Never cut:** the storm rule driving the reserve floor, the reserve-floor tests, labels on every number, and zero homes drained below their floor.

**Honest limits (we say these out loud)**
- The fleet is simulated, and the battery sizes and reserve percentages are example settings, not Base specs.
- The target and price come from a tape labeled synthetic. The storm spike is also labeled synthetic.
- The 15% storm margin was tuned on one month of data and has not been validated.
- Rules make every decision. No LLM makes dispatch decisions, and the brief is written only after the decision.
- Don't call it an AI VPP.
