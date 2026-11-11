# Zorex Search Router

Zorex Search Router is a CommonJS service for provider-independent web search and safe webpage retrieval. Ari's web workspace now invokes it for explicit web lookups and selected time-sensitive questions. The WhatsApp `.ai` command and other bot paths remain separate. `lib/searchRouter/tools.js` continues to export provider-neutral function schemas for a future native tool-call adapter; the current WhatsApp code path does not use those schemas.

## Ari web workspace integration

The Ari playground calls the router when a user explicitly asks for an online lookup or asks a question that clearly depends on current information. Serper is the preferred provider, with SearXNG as a configured fallback. Search results and selected public-page text are passed into the model as untrusted research material. Relevant page image references may be included so Ari can display them with Markdown image syntax. If search is disabled or unavailable, Ari must say that the information was not verified online rather than claiming a search succeeded.

For deployment, set `SEARCH_ENABLED=true`, `SEARCH_PROVIDER_ORDER=serper,searxng`, and the secret `SERPER_API_KEY` in the server environment. Never commit the key. The checked-in `.env.example` contains the public defaults but leaves the key blank.

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

Copy the search variables from `.env.example` into the deployment's secret/configuration manager. The example file is safe to commit; the existing `.env` was not edited. Keep `SEARCH_ENABLED=true` until an administrator has configured and authorized a provider. No account, paid product, or key is created by this code.

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


## Private VPS deployment

For a private Ari-only instance, use the official Docker Compose template from the SearXNG repository. Set `SEARXNG_HOST=127.0.0.1` and `SEARXNG_PORT=8080` in the SearXNG `.env` file so the published host port is loopback-only. Do not expose port 8080 through the VM firewall or the public reverse proxy.

Start only the `core` service initially; the bundled Valkey service is not needed while SearXNG's limiter remains disabled. Set a unique `SEARXNG_SECRET` before use. Keep the deployment's configuration and persistent cache directories on the VPS.

The adapter requests `/search?format=json`. SearXNG's default `search.formats` example only enables HTML, so add `json` alongside `html` in `core-config/settings.yml`, then restart the core service. Verify with a request to `http://127.0.0.1:8080/search?q=test&format=json`. Set Ari's server-side `SEARXNG_BASE_URL=http://127.0.0.1:8080`.

## Model integration boundary

`searchTools` contains the `web_search` and `open_webpage` function schemas for a future compatible adapter. The repository currently routes `.ai` through a JSON classifier and Azure `callAI`; there is no tool-call execution protocol for the local Medium/Max/Ultra models in this service. This branch intentionally leaves that pipeline untouched. A future integration should add explicit tier adapters, route tool calls into these functions, place results in labelled untrusted tool messages, preserve citations, and keep Mini/Ari-0 out of scope.

## Tests

Run the isolated, credential-free mocked suite with:

```sh
node test/searchRouter.test.js
```

Tests do not send live provider requests. `.env.example` enables the Ari search path and prefers Serper, but the provider is unavailable until `SERPER_API_KEY` is configured in the server environment.
