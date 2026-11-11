"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
    createAriDeveloperAccess,
    createAriDeveloperUsage,
    SESSION_COOKIE,
    CSRF_COOKIE,
} = require("../dev/ariDeveloperAccess");
const { createServer, HOST } = require("../dev/ari-chat-server");
const { ARI_SELF_KNOWLEDGE_POLICY, respondAriSelfKnowledge } = require("../dev/ariSelfKnowledge");

const CLIENT_ID = "ari-test-client.apps.googleusercontent.com";
const BASE_CLAIMS = {
    aud: CLIENT_ID,
    iss: "https://accounts.google.com",
    exp: 2_000_000_000,
    email_verified: true,
    sub: "google-account-123",
    email: "DEV@example.com",
    name: "Developer",
};

function setupAccess(overrides = {}, now = () => 1_900_000_000_000) {
    const env = {
        GOOGLE_CLIENT_ID: CLIENT_ID,
        ARI_ALLOWED_EMAILS: "dev@example.com, Other@Example.com",
        ARI_SESSION_TTL_SECONDS: "120",
        ...overrides.env,
    };
    const claims = overrides.claims || BASE_CLAIMS;
    const access = createAriDeveloperAccess({
        env,
        now,
        verifyIdToken: overrides.verifyIdToken || (async credential => {
            if (credential === "bad") throw new Error("invalid token");
            return claims;
        }),
        isProduction: overrides.isProduction,
    });
    return { access, env };
}

function responseStub() {
    const headers = new Map();
    return {
        headers,
        getHeader(name) { return headers.get(name); },
        setHeader(name, value) { headers.set(name, value); },
    };
}

function cookieValue(response, name) {
    const cookies = response.headers.get("Set-Cookie") || [];
    const cookie = cookies.find(value => value.startsWith(name + "="));
    return cookie && cookie.slice(name.length + 1).split(";", 1)[0];
}

function request({ host = "127.0.0.1:4173", origin = `http://${host}`, cookie = "", csrf = "" } = {}) {
    return { headers: { host, origin, cookie, "x-ari-csrf": csrf } };
}

async function main() {
    assert.equal(respondAriSelfKnowledge("Who are you?"), "I'm Ari, an AI assistant created by Zorex AI.");
    assert.equal(respondAriSelfKnowledge("What is your creator's real name?"), "I was created by Zorex AI. I don't have a personal creator name to share.");
    assert.match(respondAriSelfKnowledge("What are your usage limits?"), /contact the site administrator/i);
    assert.doesNotMatch(respondAriSelfKnowledge("What are your usage limits?"), /\b(?:100|10)\b/);
    assert.match(respondAriSelfKnowledge("How do I register?"), /verified Google account.*automatically/i);
    assert.doesNotMatch(respondAriSelfKnowledge("How do I get an invite?"), /invited accounts/i);
    assert.match(ARI_SELF_KNOWLEDGE_POLICY, /never disclose numeric quotas/i);
    const selfKnowledgeDoc = fs.readFileSync(path.join(__dirname, "..", "dev", "ari-self-knowledge.md"), "utf8");
    const developerDoc = fs.readFileSync(path.join(__dirname, "..", "dev", "ari-developer-reference.md"), "utf8");
    assert.match(selfKnowledgeDoc, /Zorex AI/);
    assert.match(selfKnowledgeDoc, /open registration is enabled/);
    assert.doesNotMatch(selfKnowledgeDoc, /invited accounts|contact their inviter/i);
    assert.doesNotMatch(selfKnowledgeDoc, /100 accepted chat requests|10 requests per minute/);
    assert.match(developerDoc, /ARI_DAILY_MESSAGE_LIMIT=100/);
    assert.match(developerDoc, /ARI_MESSAGES_PER_MINUTE=10/);

    let current = 1_900_000_000_000;
    const { access } = setupAccess({}, () => current);
    assert.equal(access.config().configured, true);
    assert.equal(access.registrationMode, "restricted");
    assert.equal(access.config().registrationMode, "restricted");
    const restrictedWithoutEmails = setupAccess({ env: { ARI_ALLOWED_EMAILS: "" } }).access;
    assert.equal(restrictedWithoutEmails.config().configured, false);
    const csrfResponse = responseStub();
    const issued = access.issueCsrf(request(), csrfResponse);
    const csrfCookie = cookieValue(csrfResponse, CSRF_COOKIE);
    assert.equal(issued.csrfToken, csrfCookie);

    const loginResponse = responseStub();
    const login = await access.authenticateCredential(
        request({ cookie: `${CSRF_COOKIE}=${csrfCookie}`, csrf: csrfCookie }),
        loginResponse,
        { credential: "valid" }
    );
    assert.equal(login.authenticated, true);
    assert.equal(login.user.sub, BASE_CLAIMS.sub);
    assert.equal(login.user.email, "dev@example.com");
    const sessionCookie = cookieValue(loginResponse, SESSION_COOKIE);
    const sessionReq = request({ cookie: `${SESSION_COOKIE}=${sessionCookie}` });
    assert.equal(access.requireSession(sessionReq).sub, BASE_CLAIMS.sub);
    assert.match(loginResponse.headers.get("Set-Cookie").find(value => value.startsWith(SESSION_COOKIE)), /HttpOnly/);
    assert.doesNotMatch(loginResponse.headers.get("Set-Cookie").find(value => value.startsWith(SESSION_COOKIE)), /Secure/);

    const production = setupAccess({ isProduction: true, env: { ARI_PUBLIC_ORIGIN: "https://ari.example.com" } }).access;
    const productionResponse = responseStub();
    const prodCsrf = production.issueCsrf(request({ host: "ari.example.com", origin: "https://ari.example.com" }), productionResponse).csrfToken;
    const prodLoginResponse = responseStub();
    await production.authenticateCredential(
        request({ host: "ari.example.com", origin: "https://ari.example.com", cookie: `${CSRF_COOKIE}=${prodCsrf}`, csrf: prodCsrf }),
        prodLoginResponse,
        { credential: "valid" }
    );
    const prodSessionCookie = prodLoginResponse.headers.get("Set-Cookie").find(value => value.startsWith(SESSION_COOKIE));
    assert.match(prodSessionCookie, /HttpOnly/);
    assert.match(prodSessionCookie, /Secure/);
    assert.match(prodSessionCookie, /SameSite=Lax/);
    assert.match(prodSessionCookie, /Path=\//);

    await assert.rejects(() => access.authenticateCredential(
        request({ cookie: `${CSRF_COOKIE}=${csrfCookie}`, csrf: csrfCookie }), responseStub(), { credential: "bad" }
    ), { statusCode: 401 });
    for (const invalidClaims of [
        { ...BASE_CLAIMS, exp: 1_899_999_999 },
        { ...BASE_CLAIMS, aud: "wrong-client" },
        { ...BASE_CLAIMS, iss: "https://evil.example" },
        { ...BASE_CLAIMS, email_verified: false },
        { ...BASE_CLAIMS, sub: "" },
    ]) {
        const invalid = setupAccess({ claims: invalidClaims }, () => current).access;
        await assert.rejects(() => invalid.authenticateCredential(
            request({ cookie: `${CSRF_COOKIE}=${csrfCookie}`, csrf: csrfCookie }), responseStub(), { credential: "valid" }
        ), { statusCode: 401 });
    }
    const unapproved = setupAccess({ claims: { ...BASE_CLAIMS, email: "stranger@example.com" } }, () => current).access;
    await assert.rejects(() => unapproved.authenticateCredential(
        request({ cookie: `${CSRF_COOKIE}=${csrfCookie}`, csrf: csrfCookie }), responseStub(), { credential: "valid" }
    ), error => error.statusCode === 403 && /not enabled for Ari/i.test(error.message));

    const openRegistration = setupAccess({
        env: { ARI_REGISTRATION_MODE: "open", ARI_ALLOWED_EMAILS: "" },
        claims: { ...BASE_CLAIMS, email: "New.User@example.com" },
    }, () => current).access;
    assert.equal(openRegistration.config().configured, true);
    assert.equal(openRegistration.registrationMode, "open");
    assert.equal(openRegistration.config().registrationMode, "open");
    for (let signIn = 0; signIn < 2; signIn += 1) {
        const openResponse = responseStub();
        const openLogin = await openRegistration.authenticateCredential(
            request({ cookie: `${CSRF_COOKIE}=${csrfCookie}`, csrf: csrfCookie }), openResponse, { credential: "valid" }
        );
        assert.equal(openLogin.authenticated, true);
        assert.equal(openLogin.user.sub, BASE_CLAIMS.sub);
        assert.equal(openLogin.user.email, "new.user@example.com");
        const openSessionCookie = cookieValue(openResponse, SESSION_COOKIE);
        assert.equal(openRegistration.requireSession(request({ cookie: `${SESSION_COOKIE}=${openSessionCookie}` })).sub, BASE_CLAIMS.sub);
    }

    for (const invalidClaims of [
        { ...BASE_CLAIMS, exp: 1_899_999_999 },
        { ...BASE_CLAIMS, aud: "wrong-client" },
        { ...BASE_CLAIMS, iss: "https://evil.example" },
        { ...BASE_CLAIMS, email_verified: false },
        { ...BASE_CLAIMS, sub: "" },
    ]) {
        const openInvalid = setupAccess({
            env: { ARI_REGISTRATION_MODE: "open", ARI_ALLOWED_EMAILS: "" },
            claims: invalidClaims,
        }, () => current).access;
        await assert.rejects(() => openInvalid.authenticateCredential(
            request({ cookie: `${CSRF_COOKIE}=${csrfCookie}`, csrf: csrfCookie }), responseStub(), { credential: "valid" }
        ), { statusCode: 401 });
    }

    const invalidSignature = setupAccess({
        env: { ARI_REGISTRATION_MODE: "open", ARI_ALLOWED_EMAILS: "" },
        verifyIdToken: async () => { throw new Error("invalid signature"); },
    }, () => current).access;
    await assert.rejects(() => invalidSignature.authenticateCredential(
        request({ cookie: `${CSRF_COOKIE}=${csrfCookie}`, csrf: csrfCookie }), responseStub(), { credential: "tampered" }
    ), { statusCode: 401 });
    const invalidMode = setupAccess({ env: { ARI_REGISTRATION_MODE: "anyone" } }, () => current).access;
    assert.equal(invalidMode.config().configured, false);
    await assert.rejects(() => invalidMode.authenticateCredential(
        request({ cookie: `${CSRF_COOKIE}=${csrfCookie}`, csrf: csrfCookie }), responseStub(), { credential: "valid" }
    ), { statusCode: 503 });
    await assert.rejects(() => access.authenticateCredential(
        request({ cookie: `${CSRF_COOKIE}=${csrfCookie}`, csrf: "wrong" }), responseStub(), { credential: "valid" }
    ), { statusCode: 403 });
    await assert.rejects(() => access.authenticateCredential(
        request({ host: "127.0.0.1:4173", origin: "http://evil.example", cookie: `${CSRF_COOKIE}=${csrfCookie}`, csrf: csrfCookie }), responseStub(), { credential: "valid" }
    ), { statusCode: 403 });

    const logoutResponse = responseStub();
    access.logout(request({ cookie: `${SESSION_COOKIE}=${sessionCookie}; ${CSRF_COOKIE}=${login.csrfToken}`, csrf: login.csrfToken }), logoutResponse);
    assert.equal(access.requireSession(sessionReq), null);
    assert.ok(logoutResponse.headers.get("Set-Cookie").some(value => value.startsWith(`${SESSION_COOKIE}=`) && /Max-Age=0/.test(value)));

    const expiryAccess = setupAccess({}, () => current).access;
    const expiryResponse = responseStub();
    const expiryLogin = await expiryAccess.authenticateCredential(
        request({ cookie: `${CSRF_COOKIE}=${csrfCookie}`, csrf: csrfCookie }), expiryResponse, { credential: "valid" }
    );
    const expiryCookie = cookieValue(expiryResponse, SESSION_COOKIE);
    current += 120_001;
    assert.equal(expiryAccess.requireSession(request({ cookie: `${SESSION_COOKIE}=${expiryCookie}` })), null);
    assert.equal(expiryLogin.authenticated, true);

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ari-developer-usage-"));
    try {
        let usageNow = Date.UTC(2026, 10, 10, 12, 0, 0);
        const usage = createAriDeveloperUsage({ dataDir, dailyLimit: 3, perMinuteLimit: 2, now: () => usageNow });
        const firstTwo = await Promise.all([
            usage.consumeAcceptedMessage("account-a"),
            usage.consumeAcceptedMessage("account-a"),
        ]);
        assert.equal(firstTwo.filter(result => result.allowed).length, 2);
        assert.equal((await usage.consumeAcceptedMessage("account-a")).reason, "minute");
        assert.equal((await usage.consumeAcceptedMessage("account-b")).allowed, true);

        usageNow += 61_000;
        assert.equal((await usage.consumeAcceptedMessage("account-a")).allowed, true);
        assert.equal((await usage.consumeAcceptedMessage("account-a")).reason, "daily");

        const restarted = createAriDeveloperUsage({ dataDir, dailyLimit: 3, perMinuteLimit: 2, now: () => usageNow });
        assert.equal(restarted.usageFor("account-a").daily, 3);
        assert.equal(restarted.usageFor("account-b").daily, 1);
        const anotherAccount = await restarted.consumeAcceptedMessage("account-c");
        assert.equal(anotherAccount.allowed, true);
        assert.ok(fs.existsSync(restarted.filePath));
    } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }

    const pageSource = fs.readFileSync(path.join(__dirname, "..", "dev", "ari-chat.html"), "utf8");
    assert.match(pageSource, /isn\x27t on Ari\x27s approved sign-in list/,
        "the sign-in page should explain that a 403 means the Google account is not allowlisted");
    const historyFunction = pageSource.match(/function historyStorageKey\(sub\) \{([\s\S]*?)\n    \}/);
    assert.ok(historyFunction, "the browser must scope history using the authenticated Google subject");
    const getHistoryKey = new Function("STORAGE_KEY_PREFIX", `return function historyStorageKey(sub) {${historyFunction[1]}\n}`)("ari-playground-chats-v1:");
    assert.notEqual(getHistoryKey("google-sub-one"), getHistoryKey("google-sub-two"));
    assert.match(getHistoryKey("google-sub-one"), /^ari-playground-chats-v1:/);
    assert.doesNotMatch(pageSource, /localStorage\.(?:getItem|setItem)\(["'](?:ari-playground-chats-v1|google-id-token)/);

    const authDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ari-auth-http-"));
    const server = createServer({
        env: { NODE_ENV: "test", GOOGLE_CLIENT_ID: CLIENT_ID, ARI_ALLOWED_EMAILS: "dev@example.com", ARI_DATA_DIR: authDataDir },
        authService: setupAccess().access,
        usageStore: createAriDeveloperUsage({ dataDir: authDataDir, dailyLimit: 1, perMinuteLimit: 10 }),
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, HOST, resolve); });
    try {
        const baseUrl = `http://${HOST}:${server.address().port}`;
        const unauthenticated = await fetch(baseUrl + "/api/chat", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "hello" })
        });
        assert.equal(unauthenticated.status, 401);
        const privateHealth = await fetch(baseUrl + "/api/health");
        assert.equal(privateHealth.status, 401);
        assert.doesNotMatch(await privateHealth.text(), /model|gpu|kaggle/i);

        const csrfResponseHttp = await fetch(baseUrl + "/api/auth/csrf");
        const csrfData = await csrfResponseHttp.json();
        const csrfSetCookie = csrfResponseHttp.headers.getSetCookie();
        const csrfCookieHttp = csrfSetCookie.find(value => value.startsWith(`${CSRF_COOKIE}=`)).split(";", 1)[0];
        const loginHttp = await fetch(baseUrl + "/api/auth/google", {
            method: "POST",
            headers: {
                Origin: baseUrl,
                Cookie: csrfCookieHttp,
                "X-Ari-CSRF": csrfData.csrfToken,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ credential: "valid" }),
        });
        assert.equal(loginHttp.status, 200);
        const authResult = await loginHttp.json();
        const sessionCookieHttp = loginHttp.headers.getSetCookie().find(value => value.startsWith(`${SESSION_COOKIE}=`)).split(";", 1)[0];
        const csrfAfterLogin = loginHttp.headers.getSetCookie().find(value => value.startsWith(`${CSRF_COOKIE}=`)).split(";", 1)[0];
        const cookies = `${sessionCookieHttp}; ${csrfAfterLogin}`;
        const acceptedHeaders = { Origin: baseUrl, Cookie: cookies, "X-Ari-CSRF": authResult.csrfToken, "Content-Type": "application/json" };
        const invalidRequest = await fetch(baseUrl + "/api/chat", {
            method: "POST", headers: acceptedHeaders, body: JSON.stringify({ message: "   " })
        });
        assert.equal(invalidRequest.status, 400);
        const accepted = await fetch(baseUrl + "/api/chat", {
            method: "POST", headers: acceptedHeaders, body: JSON.stringify({ message: "1 + 1" })
        });
        assert.equal(accepted.status, 200);
        const limited = await fetch(baseUrl + "/api/chat", {
            method: "POST", headers: acceptedHeaders, body: JSON.stringify({ message: "2 + 2" })
        });
        assert.equal(limited.status, 429);
        assert.match((await limited.json()).error, /usage limit/);
        const badCsrf = await fetch(baseUrl + "/api/auth/logout", {
            method: "POST", headers: { Origin: baseUrl, Cookie: cookies, "X-Ari-CSRF": "invalid" }
        });
        assert.equal(badCsrf.status, 403);
        assert.equal(authResult.user.sub, BASE_CLAIMS.sub);
    } finally {
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(authDataDir, { recursive: true, force: true });
    }

    console.log("PASS: Google token validation, restricted/open registration, CSRF, sessions, account quotas, persistence and protected routes.");
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
