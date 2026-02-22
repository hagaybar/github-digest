# ItemV1 — Canonical Schema (v1)

Every item discovered by Builder Radar — whether it originates from GitHub, Hacker News, or a future source — is normalized into a single **ItemV1** record. This document is the authoritative field-level reference.

A corresponding Pydantic model lives (or will live) in `src/github_digest/db/models.py` and must remain consistent with this document.

---

## Top-level identity fields (required)

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Stable, deterministic identifier. Computed as `sha1(source + ":" + source_id)`, or `sha1(normalized_url)` if `source_id` is not stable. Must be collision-safe across sources. |
| `source` | `enum` | Origin of the item. One of: `github`, `hackernews`, `reddit` (vNext), `rss` (vNext), `other`. |
| `source_id` | `string` | Native identifier in the source system. Examples: HN story id (`"42183901"`), GitHub repo full name (`"owner/repo"`). |
| `url` | `string` | Canonical URL of the item (normalized: tracking params stripped). |
| `title` | `string` | Display title as returned by the source. |
| `published_at` | `string` | ISO 8601 UTC timestamp of original publication or creation (e.g., `"2026-02-21T09:00:00Z"`). |
| `collected_at` | `string` | ISO 8601 UTC timestamp when this record was first ingested by the pipeline. |

---

## `github_repo` object (optional, nullable)

Present when the item is or links to a GitHub repository. Set to `null` for non-GitHub items that have no associated repo.

| Field | Type | Description |
|---|---|---|
| `full_name` | `string` | Repository slug in `owner/repo` format. |
| `html_url` | `string` | Browser URL of the repository (`https://github.com/owner/repo`). |
| `description` | `string \| null` | Short repository description from GitHub. |
| `language` | `string \| null` | Primary language as reported by GitHub (e.g., `"Python"`, `"Go"`). |
| `stars` | `integer \| null` | Total stargazer count at collection time. |
| `forks` | `integer \| null` | Total fork count at collection time. |
| `open_issues` | `integer \| null` | Open issues count at collection time. |
| `pushed_at` | `string \| null` | ISO 8601 UTC timestamp of the most recent push. |
| `created_at` | `string \| null` | ISO 8601 UTC timestamp of repository creation. |

---

## `content` object

Textual content extracted or derived from the source. Not the full page; always capped to stay within LLM context budgets.

| Field | Type | Description |
|---|---|---|
| `summary_source_text` | `string \| null` | Short excerpt suitable for LLM input. For HN: story title + top comment snippet. For GitHub: repo description + first paragraph of README. Maximum 1 000 characters. |
| `readme_excerpt` | `string \| null` | First meaningful section of the README (if GitHub repo). Capped at 3 000 characters. `null` if not a GitHub item or README unavailable. |
| `tags_detected` | `list[string]` | Keywords or phrases extracted from title/description by lightweight heuristics before LLM analysis (e.g., `["cli", "self-host", "agent"]`). Empty list if none detected. |

---

## `signals` object

Numeric signals used for fusion and ranking. All fields default to `null` if unavailable for the item's source.

| Field | Type | Description |
|---|---|---|
| `github_stars_total` | `integer \| null` | Snapshot of total stars at collection time. Same as `github_repo.stars`; duplicated here for convenient access in ranking queries. |
| `github_stars_7d` | `integer \| null` | Star delta over the past 7 days. Requires daily stats tracking (populated from `RepoStatsDaily` or equivalent). |
| `github_velocity` | `float \| null` | Computed stars-per-day over the measurement window. Formula: `github_stars_7d / 7`. `null` if `github_stars_7d` is unavailable. |
| `hn_points` | `integer \| null` | HN story score (upvotes) at collection time. |
| `hn_comments` | `integer \| null` | HN comment count (`descendants`) at collection time. |
| `hn_rank` | `integer \| null` | Position on the HN front page or top-stories list at collection time. Lower is better. |
| `reddit_score` | `integer \| null` | Reddit post score. **vNext** — always `null` in v1. |
| `rss_mentions` | `integer \| null` | Number of RSS feed appearances. **vNext** — always `null` in v1. |

---

## `tags` object

Derived classification applied before or alongside LLM analysis. May be produced by lightweight heuristics, keyword matching, or LLM.

| Field | Type | Description |
|---|---|---|
| `domains` | `list[string]` | Functional domains. Suggested values: `agents`, `devtools`, `infra`, `data`, `web`, `security`, `ml`, `db`, `ui`. List may be empty. |
| `languages` | `list[string]` | Programming languages associated with the item (union of `github_repo.language` and any languages detected in README/tags). |
| `maturity` | `enum` | Maturity level: `experimental`, `beta`, `stable`, `unknown`. |
| `composable` | `enum` | How easily this tool can be composed with others: `low`, `medium`, `high`, `unknown`. |

---

## `analysis` object

Structured LLM output for card rendering. Generated by the analyze step for the top-k candidates. All fields `null` until analysis is run; items with `null` analysis are rendered with "analysis pending".

| Field | Type | Description |
|---|---|---|
| `unlock` | `string \| null` | One sentence describing what this tool makes possible for a builder. No marketing language. |
| `novelty` | `string \| null` | One sentence on what makes this different from existing alternatives. |
| `why_cool` | `list[string] \| null` | 2–4 concise bullets explaining the tool's appeal. |
| `best_start` | `string \| null` | Concrete pointer to where a builder should begin: a README section name, a file path, or a demo URL. If unknown, set to `"README: Quickstart"` and reduce `confidence`. |
| `build_ideas` | `list[BuildIdea] \| null` | Exactly 3 build ideas (see `BuildIdea` below). |
| `confidence` | `float \| null` | LLM self-reported confidence in the analysis, range `0.0`–`1.0`. Reduced when source material is sparse or `best_start` had to be guessed. |

### `BuildIdea` item (nested inside `build_ideas`)

| Field | Type | Description |
|---|---|---|
| `size` | `enum` | Effort level: `small` (hours), `medium` (days), `spicy` (ambitious / weekend+). |
| `idea` | `string` | One-sentence description of the build idea. |
| `steps` | `list[string] \| null` | Optional ordered steps to get started. |
| `prerequisites` | `list[string] \| null` | Optional list of tools/knowledge required before starting. |

---

## `scores` object

Computed by the ranking layer (score_version `"v1"`). All scores are floats in the range `0.0`–`1.0` unless otherwise noted.

| Field | Type | Description |
|---|---|---|
| `cool_score` | `float \| null` | Heuristic coolness score. Placeholder `0.5` until LLM analysis enriches it; updated post-analysis if LLM provides signal. |
| `buildability_score` | `float \| null` | Heuristic score for how easy it is to start building with this tool. Factors: README length, presence of "Install"/"Quickstart" sections, known language. |
| `momentum_score` | `float \| null` | Velocity/engagement score. Combines log-normalized HN points and GitHub velocity where both are available. |
| `final_score` | `float \| null` | Weighted sum of the component scores. Weights are configurable in `config.yaml`. Higher is better. |
| `score_version` | `string \| null` | Version tag for the scoring formula used to produce these values (e.g., `"v1"`). Allows invalidating old scores when formula changes. |

---

## `daily_pick` object

Populated when this item is selected for a specific date's Today page. `null` fields mean the item was not selected for that day.

| Field | Type | Description |
|---|---|---|
| `picked_for_date` | `string \| null` | The date this item was selected for, in `YYYY-MM-DD` format. `null` if not selected for any day. |
| `picked_rank` | `integer \| null` | Rank among the day's 7 picks. Values `1` through `7`; `1` is the top pick. `null` if not a daily pick. |

---

## `pairing` object (optional)

Present when the item participates in at least one pairing on the Build page. Omitted or `null` if no pairings exist for this item.

| Field | Type | Description |
|---|---|---|
| `paired_with_ids` | `list[string] \| null` | List of `id` values of items this item is paired with. |
| `pairing_rationale` | `string \| null` | Short human-readable rationale string for the pairing (e.g., `"Combine X (data collection) + Y (UI) to build Z"`). When an item participates in multiple pairings, this field reflects the highest-ranked pairing rationale. |

---

## Full example (JSON)

```json
{
  "id": "a3f2c1d4e5b6a7f8c9d0e1f2a3b4c5d6e7f8a9b0",
  "source": "hackernews",
  "source_id": "42183901",
  "url": "https://github.com/acme/turbo-index",
  "title": "Turbo Index: Sub-millisecond vector search in pure Python",
  "published_at": "2026-02-21T09:00:00Z",
  "collected_at": "2026-02-21T10:15:00Z",
  "github_repo": {
    "full_name": "acme/turbo-index",
    "html_url": "https://github.com/acme/turbo-index",
    "description": "Sub-millisecond vector search with no native dependencies",
    "language": "Python",
    "stars": 1204,
    "forks": 43,
    "open_issues": 7,
    "pushed_at": "2026-02-20T22:00:00Z",
    "created_at": "2026-01-15T08:00:00Z"
  },
  "content": {
    "summary_source_text": "Sub-millisecond vector search in pure Python. 1200 HN points in 8 hours.",
    "readme_excerpt": "## Quickstart\npip install turbo-index\n...",
    "tags_detected": ["vector", "search", "python", "self-host"]
  },
  "signals": {
    "github_stars_total": 1204,
    "github_stars_7d": 1100,
    "github_velocity": 157.1,
    "hn_points": 1200,
    "hn_comments": 312,
    "hn_rank": 2,
    "reddit_score": null,
    "rss_mentions": null
  },
  "tags": {
    "domains": ["ml", "db", "devtools"],
    "languages": ["Python"],
    "maturity": "experimental",
    "composable": "high"
  },
  "analysis": {
    "unlock": "Drop-in vector search for any Python project without standing up a separate service.",
    "novelty": "Achieves <1 ms latency using pure Python bit-packing rather than C/SIMD extensions.",
    "why_cool": [
      "Zero native dependencies — works on any platform including ARM64",
      "Single-file library, easy to audit and fork",
      "Benchmarks beat FAISS for small (<100 k) corpora"
    ],
    "best_start": "README: Quickstart",
    "build_ideas": [
      {
        "size": "small",
        "idea": "Add semantic search to your notes app using local embeddings + turbo-index.",
        "steps": ["Embed notes with sentence-transformers", "Index with turbo-index", "Query on keypress"],
        "prerequisites": ["Python 3.11", "sentence-transformers"]
      },
      {
        "size": "medium",
        "idea": "Build a local code-search CLI that indexes a repo and answers natural-language queries.",
        "steps": ["Chunk source files", "Embed with a small code model", "Search via turbo-index", "Display results with context"],
        "prerequisites": ["Python", "a code embedding model"]
      },
      {
        "size": "spicy",
        "idea": "Replace pgvector in a production RAG pipeline and benchmark throughput vs latency trade-offs.",
        "steps": null,
        "prerequisites": ["Existing RAG system", "observability tooling"]
      }
    ],
    "confidence": 0.88
  },
  "scores": {
    "cool_score": 0.82,
    "buildability_score": 0.91,
    "momentum_score": 0.95,
    "final_score": 0.89,
    "score_version": "v1"
  },
  "daily_pick": {
    "picked_for_date": "2026-02-21",
    "picked_rank": 1
  },
  "pairing": {
    "paired_with_ids": ["b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0"],
    "pairing_rationale": "Combine turbo-index (vector search) + stream-ui (React streaming UI) to build a local AI assistant with real-time search."
  }
}
```

---

## Storage notes

- **`items` table**: stores core identity fields plus `signals_json`, `tags_json`, `scores_json` as JSON columns (or individual columns where indexed queries are needed). Index on `github_full_name`, `url`, `published_at`.
- **`item_analysis` table**: stores `analysis_json` keyed by `(item_id, analysis_version)` with `created_at`. Kept separate to allow re-analysis without touching the core item row.
- **`daily_picks` table**: keyed by `(date, rank)`. References `item_id`.
- **`daily_pairings` table**: keyed by `(date, rank)`. Stores `item_id_a`, `item_id_b`, `rationale`.

Fields marked **vNext** (`reddit_score`, `rss_mentions`) are reserved in the schema but always `null` in v1 implementations. The `source` enum already includes `reddit` and `rss` to allow additive ingestion without schema migration.
