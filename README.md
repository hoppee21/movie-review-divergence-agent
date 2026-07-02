<div align="center">

# Movie Review Divergence Agent

**Turn an IMDb/Douban rating gap into an evidence-grounded explanation.**

[![Python 3.11+](https://img.shields.io/badge/Python-3.11%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-API-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![LangChain](https://img.shields.io/badge/LangChain-Agent-1C3C3C)](https://www.langchain.com/)
[![Chroma](https://img.shields.io/badge/Chroma-Evidence_Index-F5C518)](https://www.trychroma.com/)
[![React](https://img.shields.io/badge/React-Frontend-61DAFB?logo=react&logoColor=111)](https://react.dev/)

Explore rating gaps · Read grounded reports · Inspect the evidence · Ask focused follow-ups

</div>

![Movie explorer showing IMDb and Douban rating gaps](docs/assets/movie-explorer.png)

## Why This Exists

A rating gap tells us that two audiences reacted differently. It does not tell
us **what they disagreed about**, whether the difference is a real clash of
viewpoints, or simply a difference in scoring severity.

Movie Review Divergence Agent turns that gap into an evidence-grounded
explanation. Select a movie, generate a Chinese or English report, inspect the
reviews behind its claims, and ask focused follow-up questions.

> The analysis does not search for convenient reviews or invent cultural causes.
> It explains only what the fixed evidence set can support.

## What You Can Do

- Browse and sort movies by their IMDb/Douban rating gap.
- Generate a concise divergence report in Chinese or English.
- Open evidence popovers without interrupting the reading experience.
- Ask up to five focused follow-ups for each language-specific report.
- Distinguish real viewpoint conflict from differences in scoring severity.

![Evidence-grounded analysis and follow-up conversation](docs/assets/evidence-analysis.png)

## Evidence Journey

| Discover | Ground | Explain | Explore |
| --- | --- | --- | --- |
| Choose a movie with a notable rating gap. | Use the fixed cross-platform review evidence selected for that movie. | Generate a readable report that separates strong disagreement from weak evidence. | Inspect original reviews and continue with bounded follow-up questions. |

## Run Locally

**Requirements:** Python 3.11 or newer and Node.js 20.19 or newer.

1. Create the local OpenAI configuration:

   ```bash
   cp config/openai.example.yml config/openai.yml
   ```

2. Install dependencies:

   ```bash
   pip install -r requirements.txt
   cd frontend && npm install && cd ..
   ```

3. Add the local movie catalog and evidence index. These private data files stay
   ignored by Git.

4. Start the API and frontend in separate terminals:

   ```bash
   python scripts/run_api.py
   ```

   ```bash
   cd frontend
   npm run dev
   ```

