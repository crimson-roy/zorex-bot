/*
    bet/providers/httpClient.js

    The ONLY module in the betting engine allowed to talk to axios
    directly. Every provider (apiFootball.js, footballOdds.js,
    tavily.js, newsdata.js, newsapi.js, openrouter.js, gemini.js,
    groq.js, deepseek.js, mistral.js, ...) must go through get(),
    post(), put(), patch(), delete_(), or request() here instead of
    importing axios itself.

    Centralizing this gives the whole engine, for free:
      - one place that reads network.timeout / network.retries /
        network.retryDelay / network.userAgent from config.js
      - one consistent retry policy for flaky upstream APIs, using
        exponential backoff with jitter (or the upstream's own
        Retry-After header, when present — see section 2 below)
      - one consistent error shape every provider/engine module can
        rely on when something goes wrong (status, statusText, url,
        provider, body, duration)
      - one consistent axios instance (see section 6 below) instead
        of every provider file getting its own defaults

    Usage:

        const httpClient = require("./httpClient");

        // GET with query params
        const { data } = await httpClient.get(
            `${config.football.apiFootball.baseUrl}/fixtures`,
            {
                params: { date: "2026-07-26" },
                headers: { "x-apisports-key": config.football.apiFootball.apiKey },
                provider: "apiFootball"
            }
        );

        // POST with a JSON body
        const { data } = await httpClient.post(
            `${config.ai.openrouter.baseUrl}/chat/completions`,
            { model: "...", messages: [...] },
            {
                headers: { Authorization: `Bearer ${config.ai.openrouter.apiKey}` },
                provider: "openrouter"
            }
        );

        // Full control via request(), with optional logging hooks
        const { data, duration } = await httpClient.request({
            method: "DELETE",
            url: "https://example.com/thing/1",
            provider: "example",
            onRequest: ({ attempt, method, url }) => console.log("→", method, url),
            onRetry: ({ attempt, delay, error }) => console.warn("retrying...", delay),
            onSuccess: ({ status, duration }) => console.log("✓", status, duration + "ms"),
            onError: (error) => console.error("✗", error.message)
        });
*/

const axios = require("axios");

const config = require("../config");

// -----------------------------------------------------------------------
// Reusable axios instance (section 6)
//
// Built once from config.network so every request shares the same
// baseline timeout and default headers, instead of each provider (or
// each call) re-specifying them. Per-call values (a custom `timeout`
// passed to request(), or custom `headers`) still override these
// instance defaults on a per-request basis — axios merges instance
// defaults with the config object passed to instance.request(), with
// the per-request config taking precedence.
// -----------------------------------------------------------------------

const axiosInstance = axios.create({

    timeout: config.network.timeout,

    headers: {
        "User-Agent": config.network.userAgent,
        "Accept": "application/json"
    }

});

// -----------------------------------------------------------------------
// Retry policy
// -----------------------------------------------------------------------

/*
    HTTP status codes worth retrying: rate limiting (429) and upstream
    server-side failures (500/502/503/504) are usually transient. Any
    status NOT in this list — including 400/401/403/404, which are
    caller/auth/resource errors that a retry can never fix — is never
    retried automatically.
*/
const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];

/*
    Decides whether a failed request is worth retrying.

    - Requests the caller intentionally aborted (AbortController /
      axios cancellation) are never retried — the caller no longer
      wants the response, so retrying would be wasted work at best
      and surprising behavior at worst.
    - Errors with no `response` object (DNS failure, connection
      refused/reset, timeout, or any other transport-level failure —
      this is where ECONNRESET / ETIMEDOUT / generic "network error"
      surface in axios/Node) are treated as transient and retried.
    - Errors WITH a `response` are retried only if the status code is
      in RETRYABLE_STATUS_CODES.
*/
function isRetryableError(error) {

    if (axios.isCancel(error) || error.code === "ERR_CANCELED" || error.name === "CanceledError") {

        return false;

    }

    if (!error.response) {

        // No response was ever received — a transport/network-level
        // failure (covers ECONNRESET, ETIMEDOUT, ECONNREFUSED,
        // ENOTFOUND, and axios's own "Network Error", among others).
        return true;

    }

    return RETRYABLE_STATUS_CODES.includes(error.response.status);

}

/*
    Simple promise-based delay used between retry attempts. Kept as
    its own tiny function so the retry loop below reads cleanly.
*/
function sleep(ms) {

    return new Promise(resolve => setTimeout(resolve, ms));

}

/*
    Case-insensitive header lookup. Axios normally lowercases response
    header names, but upstream proxies / mocks / tests aren't always
    consistent about it, so this checks safely rather than assuming
    a specific casing.
*/
function getHeader(headers, name) {

    if (!headers) return undefined;

    const lowerName = name.toLowerCase();

    const matchingKey = Object.keys(headers).find(
        key => key.toLowerCase() === lowerName
    );

    return matchingKey ? headers[matchingKey] : undefined;

}

/*
    Section 2 — Rate Limit Support.

    Parses a Retry-After header value into a millisecond delay.
    Retry-After is defined by HTTP to come in one of two forms:
      - a plain integer number of seconds ("120")
      - an HTTP-date ("Wed, 21 Oct 2026 07:28:00 GMT")

    Returns:
      - a non-negative number of milliseconds to wait, if the header
        was present and parseable
      - null if the header was absent or unparseable, so the caller
        knows to fall back to exponential backoff instead
*/
function parseRetryAfterMs(headerValue) {

    if (headerValue === undefined || headerValue === null) {

        return null;

    }

    const trimmed = String(headerValue).trim();

    if (trimmed === "") {

        return null;

    }

    // Plain integer seconds form.
    if (/^\d+$/.test(trimmed)) {

        return Number(trimmed) * 1000;

    }

    // HTTP-date form.
    const parsedDate = Date.parse(trimmed);

    if (!Number.isNaN(parsedDate)) {

        const msUntil = parsedDate - Date.now();

        return msUntil > 0 ? msUntil : 0;

    }

    return null;

}

/*
    Section 1 — Exponential Backoff.

    Computes the delay before the next retry attempt:
      - attemptIndex 0 (first retry)  → baseDelay * 2^0 = baseDelay
      - attemptIndex 1 (second retry) → baseDelay * 2^1 = baseDelay * 2
      - attemptIndex 2 (third retry)  → baseDelay * 2^2 = baseDelay * 4
      ...and so on, matching the "1000ms, 2000ms, 4000ms" example.

    A small random jitter (100–300ms) is added on top of every
    exponential-backoff delay to avoid many concurrent callers retrying
    in perfect lockstep and re-creating the exact spike that triggered
    the failures in the first place ("retry storms").
*/
function computeBackoffDelayMs(baseDelay, attemptIndex) {

    const exponential = baseDelay * Math.pow(2, attemptIndex);

    const jitter = 100 + Math.random() * 200; // 100–300ms

    return exponential + jitter;

}

/*
    Decides how long to wait before the next attempt.

    Per section 2's requirement, an upstream Retry-After header takes
    priority over exponential backoff whenever the failed response
    supplied one (this is most relevant for 429 responses, but the
    header is honored on any retryable response that includes it,
    since some upstreams also attach it to 503s). Falls back to
    computeBackoffDelayMs() otherwise.
*/
function computeRetryDelayMs(error, baseDelay, attemptIndex) {

    const responseHeaders = error && error.response ? error.response.headers : null;

    const retryAfterMs = parseRetryAfterMs(getHeader(responseHeaders, "retry-after"));

    if (retryAfterMs !== null) {

        return retryAfterMs;

    }

    return computeBackoffDelayMs(baseDelay, attemptIndex);

}

// -----------------------------------------------------------------------
// Header / config building — every function here returns a NEW object
// rather than mutating anything passed in by the caller.
// -----------------------------------------------------------------------

/*
    Builds the final header set for a request:
      1. Start from the configured defaults (User-Agent, Accept —
         also present on axiosInstance itself, but repeated here so
         buildHeaders() stays correct even if this function is ever
         used against a plain axios call).
      2. Add a JSON Content-Type automatically when a body is present
         (callers can still override this via their own headers).
      3. Layer the caller's custom headers on top last, so a caller
         can always override any default if they genuinely need to.

    Never touches `customHeaders` itself — always spreads into a new
    object.
*/
function buildHeaders(customHeaders, hasBody) {

    const defaults = {
        "User-Agent": config.network.userAgent,
        "Accept": "application/json"
    };

    if (hasBody) {

        defaults["Content-Type"] = "application/json";

    }

    return {
        ...defaults,
        ...(customHeaders || {})
    };

}

/*
    Builds the exact object that will be handed to
    axiosInstance.request() for a single attempt. Pulled into its own
    function so the retry loop can call it fresh — though in practice
    the same built config is safely reused across retries since axios
    does not mutate the config object it's given.
*/
function buildAxiosConfig({ method, url, params, data, headers, signal, timeout, extra }) {

    const hasBody = data !== undefined;

    return {
        ...extra,
        method,
        url,
        timeout,
        headers: buildHeaders(headers, hasBody),
        ...(params ? { params: { ...params } } : {}),
        ...(hasBody ? { data } : {}),
        ...(signal ? { signal } : {})
    };

}

// -----------------------------------------------------------------------
// Optional logging hooks (section 4)
//
// Each of onRequest / onRetry / onSuccess / onError is entirely
// optional. This module never calls console.log/warn/error itself —
// if a caller wants visibility into what httpClient is doing, they
// supply one or more of these callbacks in the options passed to
// request() (or, transitively, to get()/post()/put()/patch()/
// delete_()). If none are supplied, invokeHook() below is simply a
// no-op and the module behaves exactly as silently as before.
// -----------------------------------------------------------------------

function invokeHook(hook, payload) {

    if (typeof hook === "function") {

        hook(payload);

    }

}

// -----------------------------------------------------------------------
// Error building
// -----------------------------------------------------------------------

/*
    Converts any axios error (or, defensively, any thrown value) into
    a single, descriptive Error object every caller can rely on having
    the same shape:

        error.status       → HTTP status code, or null for a
                              transport-level failure with no response
        error.statusText   → HTTP status text, or null
        error.url          → the request URL that failed
        error.provider     → whatever `provider` the caller supplied
                              to get()/post()/request(), or null
        error.body         → the response body (parsed JSON if the
                              upstream sent JSON), or null
        error.duration     → how long the FINAL attempt took, in
                              milliseconds (section 3)
        error.cause        → the original axios/Node error, preserved
                              for anyone who needs the raw detail

    The message itself is human-readable so it's useful on its own in
    logs, without needing to inspect the extra properties.
*/
function buildHttpError(error, axiosConfig, provider, duration) {

    const response = error && error.response ? error.response : null;

    const status = response ? response.status : null;
    const statusText = response ? response.statusText : null;
    const body = response ? response.data : null;

    const method = (axiosConfig.method || "GET").toUpperCase();
    const url = axiosConfig.url;
    const providerTag = provider ? `${provider} ` : "";

    const reason = status
        ? `${status}${statusText ? " " + statusText : ""}`
        : (error && (error.code || error.message)) || "unknown error";

    const httpError = new Error(
        `[httpClient] ${providerTag}request failed: ${method} ${url} → ${reason}`
    );

    httpError.name = "HttpClientError";
    httpError.status = status;
    httpError.statusText = statusText;
    httpError.url = url;
    httpError.provider = provider || null;
    httpError.body = body;
    httpError.duration = duration;
    httpError.cause = error;

    return httpError;

}

// -----------------------------------------------------------------------
// Core request function — every exported function funnels through this
// -----------------------------------------------------------------------

/*
    Performs a single logical HTTP request with automatic retries.

    options:
        method       string, default "GET"
        url          string, required
        params       object — query string params (GET or otherwise)
        data         any — request body; when present, JSON headers
                     are added automatically
        headers      object — custom headers, merged over the defaults
        signal       AbortSignal — passed straight through to axios
        provider     string — optional label attached to any thrown
                     error, e.g. "apiFootball", "openrouter"
        timeout      number — overrides config.network.timeout for
                     this call only
        retries      number — overrides config.network.retries for
                     this call only
        retryDelay   number — overrides config.network.retryDelay for
                     this call only (used as the base delay for
                     exponential backoff — see section 1)
        onRequest    function({ attempt, method, url, provider }) —
                     called immediately before every attempt, including
                     the first (section 4)
        onRetry      function({ attempt, nextAttempt, delay, error,
                     status, provider, url }) — called after a
                     retryable failure, right before waiting (section 4)
        onSuccess    function({ status, duration, url, provider,
                     attempt }) — called once, after the request
                     ultimately succeeds (section 4)
        onError      function(httpError) — called once, right before
                     the final HttpClientError is thrown (section 4)
        ...rest      any other axios request-config fields are passed
                     straight through untouched ("support custom axios
                     options")

    Returns, on success:
        { data, status, statusText, headers, duration }

        `duration` (section 3) is the time, in milliseconds, taken by
        the SUCCESSFUL attempt only — time spent on earlier failed
        attempts/retries is not included, since it reflects how long
        the response that was actually returned took to arrive.

    Throws, on final failure:
        an Error built by buildHttpError() (see above), which also
        carries a `duration` for the final (failing) attempt.

    Never mutates the `options` object (or anything nested in it) the
    caller passed in — every value that needs merging is copied into
    a new object first.
*/
async function request(options) {

    if (!options || typeof options !== "object") {

        throw new Error("[httpClient] request() requires an options object.");

    }

    const {
        method = "GET",
        url,
        params,
        data,
        headers,
        signal,
        provider,
        timeout,
        retries,
        retryDelay,
        onRequest,
        onRetry,
        onSuccess,
        onError,
        ...extra
    } = options;

    if (!url) {

        throw new Error("[httpClient] request() requires options.url.");

    }

    const effectiveTimeout = typeof timeout === "number" ? timeout : config.network.timeout;
    const effectiveRetries = typeof retries === "number" ? retries : config.network.retries;
    const effectiveRetryDelay = typeof retryDelay === "number" ? retryDelay : config.network.retryDelay;

    const axiosConfig = buildAxiosConfig({
        method,
        url,
        params,
        data,
        headers,
        signal,
        timeout: effectiveTimeout,
        extra
    });

    // Total attempts = effectiveRetries + 1 (the first try isn't a "retry").
    for (let attempt = 0; attempt <= effectiveRetries; attempt++) {

        invokeHook(onRequest, {
            attempt,
            method: axiosConfig.method,
            url: axiosConfig.url,
            provider: provider || null
        });

        // Section 3 — Request Timing. Measured per attempt: on success
        // this becomes the returned `duration`; on the final failed
        // attempt it becomes the thrown error's `duration`.
        const attemptStartedAt = Date.now();

        try {

            const response = await axiosInstance.request(axiosConfig);

            const duration = Date.now() - attemptStartedAt;

            invokeHook(onSuccess, {
                attempt,
                status: response.status,
                duration,
                url: axiosConfig.url,
                provider: provider || null
            });

            return {
                data: response.data,
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                duration
            };

        } catch (error) {

            const duration = Date.now() - attemptStartedAt;

            const isLastAttempt = attempt === effectiveRetries;

            if (isLastAttempt || !isRetryableError(error)) {

                const httpError = buildHttpError(error, axiosConfig, provider, duration);

                invokeHook(onError, httpError);

                throw httpError;

            }

            // Retryable failure with attempts remaining. Prefer the
            // upstream's own Retry-After header (section 2) if it
            // supplied one; otherwise fall back to exponential
            // backoff with jitter (section 1).
            const delay = computeRetryDelayMs(error, effectiveRetryDelay, attempt);

            invokeHook(onRetry, {
                attempt,
                nextAttempt: attempt + 1,
                delay,
                error,
                status: error.response ? error.response.status : null,
                provider: provider || null,
                url: axiosConfig.url
            });

            await sleep(delay);

        }

    }

    // Unreachable in practice (the loop above always either returns or
    // throws), but keeps this function's control flow explicit rather
    // than implicitly returning undefined if the loop body were ever
    // changed incorrectly in the future.
    throw new Error(`[httpClient] request() exhausted all attempts without a result: ${url}`);

}

// -----------------------------------------------------------------------
// Public convenience wrappers (section 5)
//
// get() and post() are unchanged in behavior. put(), patch(), and
// delete_() are new and simply fix `method` the same way get()/post()
// already do — all five are thin wrappers around request() and share
// its full option set (retries, backoff, hooks, signal, etc.).
//
// Exported as `delete_` (with a trailing underscore) because `delete`
// is a reserved word and cannot be used as a plain identifier/export
// name in this context; callers destructure it as
// `const { delete: del } = httpClient` if they prefer the bare word,
// or use `httpClient.delete_(...)` / `httpClient["delete"](...)`
// directly.
// -----------------------------------------------------------------------

/*
    GET request. `options` supports everything request() supports
    (params, headers, signal, provider, timeout, retries, retryDelay,
    hooks, plus any custom axios field) — get() just fixes method to
    "GET" and folds `url` into the same options object request()
    expects.
*/
function get(url, options = {}) {

    return request({
        ...options,
        method: "GET",
        url
    });

}

/*
    POST request. `body` becomes the JSON request body (options.data);
    `options` supports everything else request() supports.
*/
function post(url, body, options = {}) {

    return request({
        ...options,
        method: "POST",
        url,
        data: body
    });

}

/*
    PUT request. Same shape as post() — `body` becomes options.data.
*/
function put(url, body, options = {}) {

    return request({
        ...options,
        method: "PUT",
        url,
        data: body
    });

}

/*
    PATCH request. Same shape as post() — `body` becomes options.data.
*/
function patch(url, body, options = {}) {

    return request({
        ...options,
        method: "PATCH",
        url,
        data: body
    });

}

/*
    DELETE request. Body is optional for DELETE (some APIs accept one,
    most don't need it) — pass it via options.data directly if needed,
    since delete_() itself only takes a url and options.
*/
function delete_(url, options = {}) {

    return request({
        ...options,
        method: "DELETE",
        url
    });

}

module.exports = {
    get,
    post,
    put,
    patch,
    delete: delete_,
    request
};
