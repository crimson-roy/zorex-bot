"use strict";

const assert = require("node:assert/strict");
const { createAriDeveloperAccess, CSRF_COOKIE, SESSION_COOKIE } = require("../dev/ariDeveloperAccess");
const { normalizedPhone } = require("../dev/ariOtpAuth");

function responseStub() {
    const headers = new Map();
    return {
        headers,
        getHeader(name) { return headers.get(name); },
        setHeader(name, value) { headers.set(name, value); }
    };
}

function request(csrfToken, cookie = "") {
    return {
        headers: {
            host: "127.0.0.1:4173",
            origin: "http://127.0.0.1:4173",
            cookie: [cookie, csrfToken ? CSRF_COOKIE + "=" + csrfToken : ""].filter(Boolean).join("; "),
            "x-ari-csrf": csrfToken
        }
    };
}

function cookieValue(response, name) {
    const cookies = response.headers.get("Set-Cookie") || [];
    const found = cookies.find(value => value.startsWith(name + "="));
    return found ? found.slice(name.length + 1).split(";", 1)[0] : "";
}

async function main() {
    assert.equal(normalizedPhone("08012345678"), "+2348012345678");
    assert.equal(normalizedPhone("+1 (415) 555-0100"), "+14155550100");
    assert.equal(normalizedPhone("not a phone number"), "");

    let current = 1_900_000_000_000;
    const sentEmails = [];
    const sentSms = [];
    const env = {
        ARI_OTP_SECRET: "test-only-secret-that-is-at-least-32-bytes-long",
        ARI_OTP_TTL_SECONDS: "300",
        ARI_OTP_RESEND_SECONDS: "60",
        ARI_OTP_MAX_ATTEMPTS: "5",
        ARI_REGISTRATION_MODE: "open",
        RESEND_API_KEY: "test-resend-key",
        ARI_EMAIL_FROM: "Ari <verify@example.test>",
        TERMII_API_KEY: "test-termii-key",
        TERMII_SENDER_ID: "AriTest"
    };
    const access = createAriDeveloperAccess({
        env,
        now: () => current,
        sendEmail: async (destination, code) => sentEmails.push({ destination, code }),
        sendSms: async (destination, code) => sentSms.push({ destination, code })
    });
    assert.deepEqual(access.config().methods, { emailOtp: true, smsOtp: true });

    const csrfResponse = responseStub();
    const csrfToken = access.issueCsrf(request(""), csrfResponse).csrfToken;
    assert.ok(csrfToken);

    const emailDestination = "New.User@Example.com";
    const emailRequest = await access.requestOtp(request(csrfToken), {
        method: "email",
        destination: emailDestination
    });
    assert.equal(emailRequest.sent, true);
    assert.equal(emailRequest.method, "email");
    assert.equal(emailRequest.maskedDestination, "n***@example.com");
    assert.equal(emailRequest.expiresInSeconds, 300);
    assert.equal(Object.hasOwn(emailRequest, "code"), false);
    assert.equal(sentEmails.length, 1);
    assert.equal(sentEmails[0].destination, "new.user@example.com");
    assert.match(sentEmails[0].code, /^\d{6}$/);

    const wrongResponse = responseStub();
    const firstWrongCode = sentEmails[0].code === "000000" ? "000001" : "000000";
    await assert.rejects(() => access.authenticateOtp(request(csrfToken), wrongResponse, {
        method: "email",
        destination: emailDestination,
        code: firstWrongCode
    }), error => error.statusCode === 401);
    const emailLoginResponse = responseStub();
    const emailLogin = await access.authenticateOtp(request(csrfToken), emailLoginResponse, {
        method: "email",
        destination: emailDestination,
        code: sentEmails[0].code
    });
    assert.equal(emailLogin.authenticated, true);
    assert.equal(emailLogin.user.email, "new.user@example.com");
    assert.equal(emailLogin.user.phone, "");
    const emailSession = cookieValue(emailLoginResponse, SESSION_COOKIE);
    assert.ok(emailSession);
    assert.equal(access.requireSession({
        headers: { cookie: SESSION_COOKIE + "=" + emailSession }
    }).sub, emailLogin.user.sub);

    await assert.rejects(() => access.requestOtp(request(csrfToken), {
        method: "email",
        destination: emailDestination
    }), error => error.statusCode === 429);

    const phoneRequest = await access.requestOtp(request(csrfToken), {
        method: "sms",
        destination: "08012345678"
    });
    assert.equal(phoneRequest.sent, true);
    assert.equal(phoneRequest.method, "sms");
    assert.equal(sentSms[0].destination, "+2348012345678");
    const phoneResponse = responseStub();
    const phoneLogin = await access.authenticateOtp(request(csrfToken), phoneResponse, {
        method: "sms",
        destination: "08012345678",
        code: sentSms[0].code
    });
    assert.equal(phoneLogin.authenticated, true);
    assert.equal(phoneLogin.user.email, "");
    assert.equal(phoneLogin.user.phone, "+2348012345678");

    const attemptsAddress = "attempts@example.com";
    await access.requestOtp(request(csrfToken), { method: "email", destination: attemptsAddress });
    const attemptsCode = sentEmails.at(-1).code;
    const attemptsWrongCode = attemptsCode === "000000" ? "000001" : "000000";
    for (let index = 0; index < 5; index += 1) {
        await assert.rejects(() => access.authenticateOtp(request(csrfToken), responseStub(), {
            method: "email",
            destination: attemptsAddress,
            code: attemptsWrongCode
        }), error => error.statusCode === 401);
    }
    await assert.rejects(() => access.authenticateOtp(request(csrfToken), responseStub(), {
        method: "email",
        destination: attemptsAddress,
        code: attemptsCode
    }), error => error.statusCode === 400);

    const expiryAddress = "expires@example.com";
    await access.requestOtp(request(csrfToken), { method: "email", destination: expiryAddress });
    const expiryCode = sentEmails.at(-1).code;
    current += 301_000;
    await assert.rejects(() => access.authenticateOtp(request(csrfToken), responseStub(), {
        method: "email",
        destination: expiryAddress,
        code: expiryCode
    }), error => error.statusCode === 400 && /expired/i.test(error.message));

    const restricted = createAriDeveloperAccess({
        env: {
            ...env,
            ARI_REGISTRATION_MODE: "restricted",
            ARI_ALLOWED_EMAILS: "allowed@example.com",
            ARI_ALLOWED_PHONE_NUMBERS: "+2348012345678"
        },
        now: () => current,
        sendEmail: async () => {},
        sendSms: async () => {}
    });
    assert.equal(restricted.config().methods.emailOtp, true);
    const restrictedCsrf = restricted.issueCsrf(request(""), responseStub()).csrfToken;
    await assert.rejects(() => restricted.requestOtp(request(restrictedCsrf), {
        method: "email",
        destination: "someone@example.com"
    }), error => error.statusCode === 403);
    assert.equal((await restricted.requestOtp(request(restrictedCsrf), {
        method: "sms",
        destination: "08012345678"
    })).sent, true);

    const restrictedWithoutAllowedContacts = createAriDeveloperAccess({
        env: {
            ...env,
            ARI_REGISTRATION_MODE: "restricted",
            ARI_ALLOWED_EMAILS: "",
            ARI_ALLOWED_PHONE_NUMBERS: ""
        },
        now: () => current,
        sendEmail: async () => {},
        sendSms: async () => {}
    });
    assert.deepEqual(restrictedWithoutAllowedContacts.config().methods, { emailOtp: false, smsOtp: false });

    const invalidRegistrationMode = createAriDeveloperAccess({
        env: { ...env, ARI_REGISTRATION_MODE: "anything-else" },
        now: () => current,
        sendEmail: async () => {},
        sendSms: async () => {}
    });
    assert.deepEqual(invalidRegistrationMode.config().methods, { emailOtp: false, smsOtp: false });

    const disabled = createAriDeveloperAccess({ env: { ARI_OTP_SECRET: "short" } });
    assert.deepEqual(disabled.config().methods, { emailOtp: false, smsOtp: false });
    await assert.rejects(() => disabled.requestOtp(request("token"), {
        method: "email",
        destination: "user@example.com"
    }), error => error.statusCode === 403 || error.statusCode === 503);

    console.log("PASS: Ari email/SMS OTP generation, delivery hooks, hashing, expiry, attempt limits, resend cooldown, allowlists and sessions.");
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
