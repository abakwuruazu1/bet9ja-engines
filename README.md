# Bet9ja Engines (online)

- **Website:** `docs/` — League Plus, Zoom Football and Zoom Tennis dashboards (served by GitHub Pages).
- **Recorder:** `recorder/run.js` — runs the engines' capture code 24/7 in GitHub Actions and publishes the data to the `data` branch.
- The Chrome extensions still work on their own; this is the same code running online.

## Railway recorder (all 3 engines)
Railway builds `Dockerfile` and runs `recorder/run.js` non-stop. Variables needed:
- `GITHUB_TOKEN` – fine-grained token with **Contents: Read and write** on this repo only
- `GITHUB_REPO` – `abakwuruazu1/bet9ja-engines`

While the Railway recorder is publishing, the GitHub Actions recorder sees it and steps aside.
