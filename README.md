# Bigdata Movie Evidence Agent

Local movie-review evidence analysis app for comparing IMDb and Douban review disagreement.

The notebook builds a local Chroma evidence index. The runtime app loads that local evidence and asks an LLM to generate a grounded report with source popovers.

## What Is Committed

- Agent/API source under `app/`
- Frontend source under `frontend/src/`
- Tests under `tests/`
- Small metadata files such as `selected_movies.csv`
- Config template `config/openai.example.yml`

## What Is Not Committed

The following files are intentionally local-only and ignored:

- `config/openai.yml`
- raw review data such as `reviews.jsonl`
- Chroma databases and evidence JSONL/CSV outputs
- zip artifacts
- `frontend/node_modules/`
- build/cache folders

## Setup

```bash
cp config/openai.example.yml config/openai.yml
```

Put your local OpenAI key in `config/openai.yml`. Do not commit that file.

Install Python dependencies in the environment you use for this project:

```bash
pip install -r requirements.txt
```

Install frontend dependencies:

```bash
cd frontend
npm install
```

## Run

Start the API:

```bash
/opt/anaconda3/envs/Agent/bin/python scripts/run_api.py
```

Start the frontend:

```bash
cd frontend
npm run dev -- --host 127.0.0.1
```

Open `http://127.0.0.1:5173/`.

## Tests

```bash
/opt/anaconda3/envs/Agent/bin/python -m pytest -q
```

```bash
cd frontend
npm run build
```
