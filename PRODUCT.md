# Builder Radar — Product Contract

## Mission

Surface the most interesting new tools emerging from GitHub and Hacker News every day, and turn each discovery into a concrete, actionable build idea.

## Primary User Story

> As a builder, I want to discover cool new tools and get concrete project ideas so I can build/learn faster.

## Daily UX

### Today Page (`/today`)

Seven curated cards for the current date, each showing:

- **Title** (linked to source)
- **Unlock** — one sentence on what the tool makes possible
- **Novelty** — one sentence on why it is different
- **Why cool** — 2–4 bullets
- **Best start** — a concrete pointer (README section, demo, file path)
- **Build ideas** — three sized ideas: small / medium / spicy
- **Signals** — HN points and GitHub stars where available

Cards load from pre-computed DB data; no live LLM calls at render time.

### Build Page (`/build`)

Five to fifteen pairings derived from Today's 7 (or top 30 candidates), each showing:

- **Pair title** — "X + Y"
- **Rationale** — one sentence on why they combine well
- **Per-item summary** — unlock + best start for each tool in the pair

## Input Sources

| Source | Status | Notes |
|---|---|---|
| GitHub | v1 (existing) | Search-driven; repo metadata + README |
| Hacker News | v1 (new) | Top stories; GitHub links extracted |
| Reddit | vNext | Planned; not in scope for this slice |
| RSS / Other | vNext | Planned; extensible via source enum |

## Output Contract

Every item surfaced to a user **must** be represented as a canonical **ItemV1** record:

- Stored in the `items` table in SQLite
- Enriched with signals, tags, analysis, and scores before rendering
- Referenced by `daily_picks` (today page) and `daily_pairings` (build page)

The full field-level definition lives in `schemas/item_v1.md`.

## Pipeline (overview)

```
ingest_github + ingest_hn
        |
  normalize → ItemV1 candidates
        |
  fuse signals + deduplicate
        |
  rank (cool / buildability / momentum scores)
        |
  select top 7 (today) + top 30 (LLM input)
        |
  LLM structured analysis → analysis fields
        |
  pairing heuristic → daily_pairings
        |
  /today  and  /build  read from DB
```

## Non-Goals (this slice)

- Perfect personalization or user accounts
- Reddit or RSS ingestion
- Heavy UI redesign
- Multi-tenant auth or paid features
