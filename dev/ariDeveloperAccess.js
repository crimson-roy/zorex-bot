"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SESSION_COOKIE = "ari_session";
const CSRF_COOKIE = "ari_csrf";
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

function parseCookies(header = "") {
    const result = Object.create(null);
    for (const part of String(header).split(";")) {
        const separator = part.indexOf("=");
        if (separator < 1) continue;
        const name = part.slice(0, separator).trim();
        const value = part.slice(separator + 1).trim();
        if (name) result[name] = value;
    }
    return result;
}

function normalizedEmail(value) {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function safeEqual(left, right) {
    if (typeof left !== "string" || typeof right !== "string" || !left || !right) return false;
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function integerSetting(value, fallback, minimum, maximum) {
    if (value === undefined || value === "") return fallback;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : null;
}

function createAriDeveloperAccess(options = {}) {
    const env = options.env || process.env;
    const isProduction = options.isProduction ?? env.NODE_ENV === "production";
    const clientId = String(env.GOOGLE_CLIENT_ID || "").trim();
    const requestedRegistrationMode = String(env.ARI_REGISTRATION_MODE || "open").trim().toLowerCase();
    const registrationModeValid = requestedRegistrationMode === "restricted" || requestedRegistrationMode === "open";
    const registrationMode = registrationModeValid ? requestedRegistrationMode : "restricted";
    const allowedEmails = new Set(String(env.ARI_ALLOWED_EMAILS || "").split(",").map(normalizedEmail).filter(Boolean));
    const sessionTtlSeconds = integerSetting(env.ARI_SESSION_TTL_SECONDS, 28800, 60, 2592000);
    const publicOrigin = String(env.ARI_PUBLIC_ORIGIN || "").trim();
    let validPublicOrigin = false;
    try {
        const parsedOrigin = new URL(publicOrigin);
        validPublicOrigin = parsedOrigin.origin === publicOrigin.replace(/\/$/, "") &&
            (!isProduction || parsedOrigin.protocol === "https:");
    } catch { /* Missing or malformed origin keeps production authentication disabled. */ }
    const now = options.now || (() => Date.now());
    const sessions = options.sessions || new Map();
    let verifyIdToken = options.verifyIdToken;
    let verifierLoadError = null;

    if (!verifyIdToken && clientId) {
        try {
            const { OAuth2Client } = require("google-auth-library");
            const googleClient = new OAuth2Client(clientId);
            verifyIdToken = async token => {
                const ticket = await googleClient.verifyIdToken({ idToken: token, audience: clientId });
                return ticket.getPayload();
            };
        } catch (error) {
            verifierLoadError = error;
        }
    }

    const configured = Boolean(
        clientId && registrationModeValid && (registrationMode === "open" || allowedEmails.size) && sessionTtlSeconds && verifyIdToken &&
        (!isProduction || validPublicOrigin)
    );
    const configError = !clientId
        ? "Google sign-in is not configured yet. Please contact Ari's administrator."
        : !registrationModeValid
            ? "Google sign-in configuration is invalid. Please contact Ari's administrator."
            : registrationMode === "restricted" && !allowedEmails.size
                ? "Google sign-in is not fully configured. Please contact Ari's administrator."
            : !sessionTtlSeconds
                ? "Ari's session configuration is invalid. Please contact Ari's administrator."
                : verifierLoadError
                    ? "Google sign-in is temporarily unavailable. Please contact Ari's administrator."
                    : isProduction && !validPublicOrigin
                        ? "Ari's secure site origin is not configured. Please contact Ari's administrator."
                        : null;

    function expectedOrigin(request) {
        if (publicOrigin) {
            try {
                const parsed = new URL(publicOrigin);
                if (parsed.origin !== publicOrigin.replace(/\/$/, "")) return null;
                if (isProduction && parsed.protocol !== "https:") return null;
                return parsed.origin;
            } catch {
                return null;
            }
        }
        if (isProduction) return null;
        const origin = request.headers.origin;
        const host = request.headers.host;
        if (typeof host === "string" && /^(?:127\.0\.0\.1|localhost):\d{1,5}$/.test(host) && origin === `http://${host}`) return origin;
        return null;
    }

    function sameOrigin(request) {
        const expected = expectedOrigin(request);
        if (!expected || typeof request.headers.origin !== "string") return false;
        try {
            return new URL(request.headers.origin).origin === expected && request.headers.origin === expected;
        } catch {
            return false;
        }
    }

    function cookieOptions(maxAge, httpOnly) {
        return [
            "Path=/",
            `Max-Age=${maxAge}`,
            "SameSite=Lax",
            ...(httpOnly ? ["HttpOnly"] : []),
            ...(isProduction ? ["Secure"] : []),
        ].join("; ");
    }

    function appendCookie(response, cookie) {
        const current = response.getHeader("Set-Cookie");
        response.setHeader("Set-Cookie", current ? [...(Array.isArray(current) ? current : [current]), cookie] : [cookie]);
    }

    function setCsrfCookie(response, token, maxAge = 3600) {
        appendCookie(response, `${CSRF_COOKIE}=${token}; ${cookieOptions(maxAge, false)}`);
    }

    function clearCookie(response, name, httpOnly) {
        appendCookie(response, `${name}=; ${cookieOptions(0, httpOnly)}`);
    }

    function issueCsrf(request, response) {
        const cookies = parseCookies(request.headers.cookie);
        const token = /^[A-Za-z0-9_-]{40,60}$/.test(cookies[CSRF_COOKIE] || "")
            ? cookies[CSRF_COOKIE]
            : crypto.randomBytes(32).toString("base64url");
        if (cookies[CSRF_COOKIE] !== token) setCsrfCookie(response, token);
        return { csrfToken: token, clientId, configured, error: configured ? null : configError };
    }

    function assertOriginAndCsrf(request) {
        if (!sameOrigin(request)) {
            const error = new Error("This request could not be verified. Refresh the page and try again.");
            error.statusCode = 403;
            throw error;
        }
        const cookies = parseCookies(request.headers.cookie);
        if (!safeEqual(request.headers["x-ari-csrf"], cookies[CSRF_COOKIE])) {
            const error = new Error("This request could not be verified. Refresh the page and try again.");
            error.statusCode = 403;
            throw error;
        }
    }

    function hashSessionId(sessionId) {
        return crypto.createHash("sha256").update(sessionId).digest("hex");
    }

    function sessionFor(request) {
        const sessionId = parseCookies(request.headers.cookie)[SESSION_COOKIE];
        if (!sessionId || sessionId.length !== 64) return null;
        const key = hashSessionId(sessionId);
        const session = sessions.get(key);
        if (!session) return null;
        if (session.expiresAt <= now()) {
            sessions.delete(key);
            return null;
        }
        return session;
    }

    function publicUser(session) {
        return session ? {
            sub: session.sub,
            email: session.email || "",
            phone: session.phone || "",
            name: session.name || ""
        } : null;
    }

    function createSession(request, response, identity) {
        const oldSessionId = parseCookies(request.headers.cookie)[SESSION_COOKIE];
        if (oldSessionId) sessions.delete(hashSessionId(oldSessionId));
        const sessionId = crypto.randomBytes(32).toString("hex");
        const session = {
            sub: String(identity.sub),
            email: normalizedEmail(identity.email),
            phone: typeof identity.phone === "string" ? identity.phone : "",
            name: typeof identity.name === "string" ? identity.name.slice(0, 120) : "",
            expiresAt: now() + sessionTtlSeconds * 1000,
        };
        sessions.set(hashSessionId(sessionId), session);
        appendCookie(response, `${SESSION_COOKIE}=${sessionId}; ${cookieOptions(sessionTtlSeconds, true)}`);
        const csrfToken = crypto.randomBytes(32).toString("base64url");
        setCsrfCookie(response, csrfToken, sessionTtlSeconds);
        return { authenticated: true, user: publicUser(session), csrfToken };
    }

    async function authenticateCredential(request, response, body) {
        assertOriginAndCsrf(request);
        if (!configured) {
            const error = new Error(configError || "Google sign-in is unavailable.");
            error.statusCode = 503;
            throw error;
        }
        if (!body || typeof body.credential !== "string" || !body.credential || body.credential.length > 12000) {
            const error = new Error("Google sign-in could not be verified. Please try again.");
            error.statusCode = 401;
            throw error;
        }

        let claims;
        let verificationTimer;
        try {
            claims = await Promise.race([
                verifyIdToken(body.credential),
                new Promise((_, reject) => { verificationTimer = setTimeout(() => reject(new Error("verification timeout")), 10000); }),
            ]);
        } catch {
            const error = new Error("Google sign-in could not be verified. Please try again.");
            error.statusCode = 401;
            throw error;
        } finally {
            clearTimeout(verificationTimer);
        }
        const nowSeconds = Math.floor(now() / 1000);
        const audience = claims && claims.aud;
        const audienceMatches = Array.isArray(audience) ? audience.includes(clientId) : audience === clientId;
        if (!claims || !audienceMatches || !GOOGLE_ISSUERS.has(claims.iss) ||
            typeof claims.exp !== "number" || claims.exp <= nowSeconds ||
            claims.email_verified !== true || typeof claims.sub !== "string" || !claims.sub.trim()) {
            const error = new Error("Google sign-in could not be verified. Please try again.");
            error.statusCode = 401;
            throw error;
        }

        const email = normalizedEmail(claims.email);
        if (registrationMode === "restricted" && (!email || !allowedEmails.has(email))) {
            const error = new Error("This Google account is not enabled for Ari. Please contact the site administrator.");
            error.statusCode = 403;
            throw error;
        }

        return createSession(request, response, {
            sub: claims.sub,
            email,
            name: typeof claims.name === "string" ? claims.name.slice(0, 120) : ""
        });
    }

    function logout(request, response) {
        assertOriginAndCsrf(request);
        const sessionId = parseCookies(request.headers.cookie)[SESSION_COOKIE];
        if (sessionId) sessions.delete(hashSessionId(sessionId));
        clearCookie(response, SESSION_COOKIE, true);
        const csrfToken = crypto.randomBytes(32).toString("base64url");
        setCsrfCookie(response, csrfToken);
        return { ok: true, csrfToken };
    }

    function requireSession(request) {
        return sessionFor(request);
    }

    function config() {
        return { clientId, configured, error: configured ? null : configError, registrationMode };
    }

    function invalidateAll() {
        sessions.clear();
    }

    return {
        config,
        issueCsrf,
        sameOrigin,
        assertOriginAndCsrf,
        authenticateCredential,
        logout,
        requireSession,
        publicUser,
        invalidateAll,
        sessions,
        sessionTtlSeconds,
        isProduction,
        registrationMode,
    };
}

function createAriDeveloperUsage(options = {}) {
    const fsImpl = options.fs || fs;
    const now = options.now || (() => Date.now());
    const dailyLimit = options.dailyLimit ?? 100;
    const perMinuteLimit = options.perMinuteLimit ?? 10;
    const directory = path.resolve(options.dataDir || path.join(__dirname, "..", "data"));
    const filePath = path.join(directory, "ariDeveloperUsage.json");
    let queue = Promise.resolve();

    if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 1 ||
        !Number.isSafeInteger(perMinuteLimit) || perMinuteLimit < 1) {
        throw new Error("Ari developer usage limits must be positive integers.");
    }

    function accountKey(sub) {
        return crypto.createHash("sha256").update(String(sub)).digest("hex");
    }

    function readStore() {
        try {
            const parsed = JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
            if (parsed && parsed.version === 1 && parsed.accounts && typeof parsed.accounts === "object") return parsed;
        } catch (error) {
            if (error.code !== "ENOENT") throw new Error("Ari usage data could not be read safely.");
        }
        return { version: 1, accounts: {} };
    }

    function writeStore(store) {
        fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
        try {
            fsImpl.writeFileSync(temporary, JSON.stringify(store), { encoding: "utf8", mode: 0o600, flag: "wx" });
            fsImpl.renameSync(temporary, filePath);
            try { fsImpl.chmodSync(filePath, 0o600); } catch { /* Windows ACLs replace POSIX mode bits. */ }
        } catch (error) {
            try { fsImpl.rmSync(temporary, { force: true }); } catch { /* Ignore cleanup errors. */ }
            throw new Error("Ari usage data could not be saved safely.");
        }
    }

    function snapshot(account, currentTime) {
        const date = new Date(currentTime).toISOString().slice(0, 10);
        const cutoff = currentTime - 60_000;
        account.days = account.days && typeof account.days === "object" ? account.days : {};
        account.recentAcceptedAt = Array.isArray(account.recentAcceptedAt)
            ? account.recentAcceptedAt.filter(value => Number.isSafeInteger(value) && value > cutoff)
            : [];
        for (const day of Object.keys(account.days)) {
            if (day < date.slice(0, 8) + "01") delete account.days[day];
        }
        return {
            day: date,
            daily: Number(account.days[date] || 0),
            minute: account.recentAcceptedAt.length,
            dayResetSeconds: Math.max(1, Math.ceil((Date.UTC(
                Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + 1
            ) - currentTime) / 1000)),
            retryAfterSeconds: account.recentAcceptedAt.length
                ? Math.max(1, Math.ceil((account.recentAcceptedAt[0] + 60_000 - currentTime) / 1000))
                : 60,
        };
    }

    async function consume(sub) {
        const currentTime = now();
        const store = readStore();
        const key = accountKey(sub);
        const account = store.accounts[key] || (store.accounts[key] = { days: {}, recentAcceptedAt: [] });
        const status = snapshot(account, currentTime);
        if (status.daily >= dailyLimit) return { allowed: false, reason: "daily", ...status };
        if (status.minute >= perMinuteLimit) return { allowed: false, reason: "minute", ...status };
        account.days[status.day] = status.daily + 1;
        account.recentAcceptedAt.push(currentTime);
        writeStore(store);
        return { allowed: true, daily: status.daily + 1, minute: status.minute + 1 };
    }

    function consumeAcceptedMessage(sub) {
        const operation = queue.then(() => consume(sub));
        queue = operation.catch(() => undefined);
        return operation;
    }

    function usageFor(sub) {
        const store = readStore();
        const account = store.accounts[accountKey(sub)] || { days: {}, recentAcceptedAt: [] };
        return snapshot(account, now());
    }

    return { consumeAcceptedMessage, usageFor, filePath, dailyLimit, perMinuteLimit };
}

module.exports = {
    createAriDeveloperAccess,
    createAriDeveloperUsage,
    normalizedEmail,
    parseCookies,
    SESSION_COOKIE,
    CSRF_COOKIE,
};
