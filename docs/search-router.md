# Zorex Search Router

Zorex Search Router is an isolated CommonJS service for provider-independent web search and safe webpage retrieval. It is disabled by default. This feature branch intentionally does not attach it to Baileys, `.ai`, Ari Medium, Ari Max, Ari Ultra, a command handler, or a production endpoint. `lib/searchRouter/tools.js` exports provider-neutral function schemas for a future model adapter; no tier-specific model tool-calling integration exists in the current WhatsApp code path.

## Public interface

```js
const { web_search, open_webpage, getStatus, searchTools } = require("../lib/searchRouter");

const results = await web_search("latest AI developments", {
  limit: 8,
  freshness: "week",
  country: "US",
  language: "en",
  research_mode: false
});
const page = await open_webpage("https://example.org/article");
```

`web_search` returns `{ results, providers_used, research_mode }`. Each result has `title`, original `url`, `snippet`, optional `content`, optional `published_at`, `provider`, and optional `score`. Missing provider metadata remains `null`/empty; it is not inferred. Dates must parse as dates. Duplicate results are removed by canonical URL while the original citation URL is retained. Ranking preserves provider preference and only compares scores within a provider.

`openWebpage` returns `title`, final `url`, extracted `text`, `publication_date`, `http_status`, `retrieved_at`, and original `source_url`. It does not execute JavaScript. It accepts only HTTP(S), standard ports, HTML/XHTML/plain text, at most three redirects, 2 MiB response bodies by default, and a bounded text result.

## Providers and availability

The common adapter interface is `configured` plus `search(normalizedOptions, config)`. Add a provider by implementing this interface, registering it in `lib/searchRouter/index.js`, adding a normalized response adapter and mocked tests, then adding its name and environment variables to this document and `.env.example`.

- **SearXNG**: only the operator-configured `SEARXNG_BASE_URL` is used. The adapter requests `/search?format=json`; the configured instance must enable JSON. The documented search API has no standard API-key requirement. For Ari, use a private self-hosted instance; no public instance is selected automatically.
- **Serper**: official `POST https://google.serper.dev/search`, authenticated with `X-API-KEY`, configured by `SERPER_API_KEY`. Country and language options map to `gl` and `hl`; freshness filtering is not currently passed through.

An adapter is eligible only when its configuration is valid and it is not in cooldown, over its soft limit, blocked by the global cap, or open in the circuit breaker. There is no startup probe that spends provider quota. Recent requests update its observed success rate and EWMA latency; weighted selection combines those measures with the configured provider order.

Official API references: [SearXNG Search API](https://docs.searxng.org/dev/search_api.html), [Serper](https://serper.dev/playground).

## Configuration

Copy the search variables from `.env.example` into the deployment's secret/configuration manager. The example file is safe to commit; the existing `.env` was not edited. Keep `SEARCH_ENABLED=false` until an administrator has configured and authorized a provider. No account, paid product, or key is created by this code.

Important settings:

- `SEARCH_PROVIDER_ORDER`: deterministic preference weights; defaults to configured SearXNG, then Serper.
- `SEARCH_TIMEOUT_MS`: provider request deadline.
- `SEARCH_MAX_RESULTS`: default result count (1–20).
- `SEARCH_MAX_FALLBACKS`: maximum additional providers after the first failure.
- `SEARCH_RESEARCH_MODE`: must be explicitly enabled before callers can request two-provider research.
- `SEARCH_MONTHLY_SOFT_LIMIT`: global monthly provider-attempt cap; zero disables the cap.
- `SEARXNG_MONTHLY_SOFT_LIMIT`, `SERPER_MONTHLY_SOFT_LIMIT`: optional per-provider caps; zero disables that provider cap.
- `SEARCH_CIRCUIT_FAILURES`, `SEARCH_CIRCUIT_COOLDOWN_MS`: circuit threshold and recovery delay.

Usage counters persist in `data/searchRouterUsage.json` through the existing `dataPath` helper. Month boundaries use UTC `YYYY-MM`. The service records provider attempts, successful attempts, failures, response latency, 429 events, circuit state and only exact credits disclosed by the provider. This is local tracking, not provider-side quota telemetry. `getStatus()` returns a secret-free diagnostic snapshot; the current branch does not expose it as a WhatsApp command because that would require changing the message dispatcher.

## Selection, fallback and research

Normal mode picks the highest-scoring eligible provider and stops after its first valid result set. Timeouts/network errors, 429s, 5xxs, auth/access errors and malformed responses are recorded and permit bounded fallback. 429 uses `Retry-After`; 401/403 are cooled down. Repeated errors open a circuit; after cooldown, one half-open request checks recovery. No request retries indefinitely.

Research mode requires both `SEARCH_RESEARCH_MODE=true` and a caller's explicit `research_mode: true`. It requests up to two eligible independent providers concurrently, merges and deduplicates their results, and reports `providers_used`. It does not silently invoke extra searches in normal mode.

## Webpage safety

`openWebpage` uses `ipaddr.js` classification for public-only address checks. It rejects localhost, metadata hostnames, private/reserved/link-local addresses, and any hostname whose DNS answers include a non-public address. The selected validated address is pinned for the actual HTTP(S) connection to prevent DNS rebinding between validation and connection. Every redirect is parsed and resolved again. Requests are bounded by connection/total timeout, body size, redirect count, allowed ports, and content type. Responses are read as text only; scripts are not run. A URL that cannot be validated fails closed.

Consumers must pass all retrieved page/result text to models as clearly labelled **untrusted tool output**, never as a system/developer prompt. `formatUntrustedToolOutput` creates a labelled `role: "tool"` message for a compatible model adapter. Webpage instructions are data, not authority. Preserve exact source URLs and attach citations to the claims they support. Do not claim a search succeeded unless the router returned results.

## Model integration boundary

`searchTools` contains the `web_search` and `open_webpage` function schemas for a future compatible adapter. The repository currently routes `.ai` through a JSON classifier and Azure `callAI`; there is no tool-call execution protocol for the local Medium/Max/Ultra models in this service. This branch intentionally leaves that pipeline untouched. A future integration should add explicit tier adapters, route tool calls into these functions, place results in labelled untrusted tool messages, preserve citations, and keep Mini/Ari-0 out of scope.

## Tests

Run the isolated, credential-free mocked suite with:

```sh
node test/searchRouter.test.js
```

Tests do not send live provider requests. The router is not enabled by tests or by `.env.example`.
