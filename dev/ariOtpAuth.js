"use strict";

const crypto = require("node:crypto");

function authError(message, statusCode) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function normalizedEmail(value) {
    if (typeof value !== "string") return "";
    const email = value.trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "";
    return email;
}

function normalizedPhone(value) {
    if (typeof value !== "string") return "";
    const raw = value.trim();
    let digits = raw.replace(/\D/g, "");
    if (raw.startsWith("00")) digits = digits.slice(2);
    if (digits.length === 11 && digits.startsWith("0")) digits = "234" + digits.slice(1);
    if (digits.length === 13 && digits.startsWith("234")) return "+" + digits;
    if (raw.startsWith("+") && digits.length >= 8 && digits.length <= 15 && digits[0] !== "0") return "+" + digits;
    return "";
}

function constantTimeEqual(left, right) {
    const a = Buffer.from(String(left || ""));
    const b = Buffer.from(String(right || ""));
    return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function createAriOtpAuth(options = {}) {
    const env = options.env || process.env;
    const now = options.now || (() => Date.now());
    const fetchImpl = options.fetch || globalThis.fetch;
    const secret = String(env.ARI_OTP_SECRET || "");
    const ttlSeconds = Number(env.ARI_OTP_TTL_SECONDS || 300);
    const resendSeconds = Number(env.ARI_OTP_RESEND_SECONDS || 60);
    const maxAttempts = Number(env.ARI_OTP_MAX_ATTEMPTS || 5);
    const sessionTtlSeconds = options.sessionTtlSeconds;
    const resendApiKey = String(env.RESEND_API_KEY || "").trim();
    const emailFrom = String(env.ARI_EMAIL_FROM || "").trim();
    const termiiApiKey = String(env.TERMII_API_KEY || "").trim();
    const termiiSenderId = String(env.TERMII_SENDER_ID || "").trim();
    const termiiBaseUrl = String(env.TERMII_BASE_URL || "https://api.ng.termii.com").trim().replace(/\/+$/, "");
    const termiiChannel = String(env.TERMII_CHANNEL || "dnd").trim();
    const productionOriginReady = options.isProduction !== true || Boolean(options.validPublicOrigin);
    const timingReady = Number.isSafeInteger(sessionTtlSeconds) && sessionTtlSeconds >= 60 &&
        secret.length >= 32 && Number.isSafeInteger(ttlSeconds) && ttlSeconds >= 120 &&
        ttlSeconds <= 900 && Number.isSafeInteger(resendSeconds) && resendSeconds >= 30 &&
        resendSeconds <= 600 && Number.isSafeInteger(maxAttempts) && maxAttempts >= 3 &&
        maxAttempts <= 10 && productionOriginReady;
    const emailConfigured = Boolean(timingReady && resendApiKey && emailFrom && fetchImpl);
    let validTermiiBase = false;
    try {
        const parsed = new URL(termiiBaseUrl);
        validTermiiBase = parsed.protocol === "https:" && parsed.origin === termiiBaseUrl;
    } catch { /* Invalid provider URL leaves SMS sign-in disabled. */ }
    const smsConfigured = Boolean(timingReady && termiiApiKey && termiiSenderId &&
        validTermiiBase && fetchImpl);
    const challenges = options.challenges || new Map();
    const sentAt = options.sentAt || new Map();
    const sendEmailOverride = options.sendEmail;
    const sendSmsOverride = options.sendSms;
    const assertOriginAndCsrf = options.assertOriginAndCsrf;
    const createSession = options.createSession;
    const isAuthorized = options.isAuthorized || (() => true);

    function digest(value) {
        return crypto.createHmac("sha256", secret).update(value).digest("hex");
    }

    function challengeKey(method, destination) {
        return crypto.createHash("sha256").update(method + ":" + destination).digest("hex");
    }

    function maskDestination(method, destination) {
        if (method === "email") {
            const [local, domain] = destination.split("@");
            return (local.slice(0, 1) || "*") + "***@" + domain;
        }
        return destination.slice(0, 4) + "••••" + destination.slice(-3);
    }

    async function sendEmail(destination, code) {
        if (typeof sendEmailOverride === "function") return sendEmailOverride(destination, code);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        try {
            const response = await fetchImpl("https://api.resend.com/emails", {
                method: "POST",
                signal: controller.signal,
                headers: {
                    Authorization: "Bearer " + resendApiKey,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    from: emailFrom,
                    to: [destination],
                    subject: "Your Ari verification code",
                    text: "Your Ari verification code is " + code + ". It expires in " + Math.ceil(ttlSeconds / 60) +
                        " minutes. Do not share this code with anyone.",
                    html: "<p>Your Ari verification code is:</p><p style=\"font-size:28px;font-weight:700;letter-spacing:6px\">" +
                        code + "</p><p>It expires in " + Math.ceil(ttlSeconds / 60) +
                        " minutes. Do not share this code with anyone.</p>"
                })
            });
            if (!response.ok) throw new Error("Email delivery was rejected.");
            const result = await response.json().catch(() => ({}));
            if (!result || !result.id) throw new Error("Email delivery could not be confirmed.");
        } finally {
            clearTimeout(timer);
        }
    }

    async function sendSms(destination, code) {
        if (typeof sendSmsOverride === "function") return sendSmsOverride(destination, code);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        try {
            const response = await fetchImpl(termiiBaseUrl + "/api/sms/send", {
                method: "POST",
                signal: controller.signal,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    to: destination.replace(/^\+/, ""),
                    from: termiiSenderId,
                    sms: "Your Ari verification code is " + code + ". It expires in " +
                        Math.ceil(ttlSeconds / 60) + " minutes. Do not share it.",
                    type: "plain",
                    channel: termiiChannel,
                    api_key: termiiApiKey
                })
            });
            if (!response.ok) throw new Error("SMS delivery was rejected.");
            const result = await response.json().catch(() => ({}));
            if (!result || !result.message_id) throw new Error("SMS delivery could not be confirmed.");
        } finally {
            clearTimeout(timer);
        }
    }

    function normalizeDestination(method, value) {
        if (method === "email") return normalizedEmail(value);
        if (method === "sms") return normalizedPhone(value);
        return "";
    }

    function configured(method) {
        return method === "email" ? emailConfigured : method === "sms" ? smsConfigured : false;
    }

    async function requestOtp(request, body = {}) {
        assertOriginAndCsrf(request);
        const method = body.method === "email" || body.method === "sms" ? body.method : "";
        if (!method) throw authError("Choose email or phone verification.", 400);
        if (!configured(method)) throw authError("This verification method is not configured yet.", 503);
        const destination = normalizeDestination(method, body.destination);
        if (!destination) {
            throw authError(method === "email"
                ? "Enter a valid email address."
                : "Enter a phone number with its country code, or a Nigerian number beginning with 0.", 400);
        }
        if (!isAuthorized(method, destination)) {
            throw authError("This contact method is not enabled for Ari. Please contact the site administrator.", 403);
        }

        const key = challengeKey(method, destination);
        const currentTime = now();
        for (const [storedKey, timestamp] of sentAt) {
            if (timestamp + 86_400_000 <= currentTime) sentAt.delete(storedKey);
        }
        const lastSent = sentAt.get(key) || 0;
        if (lastSent && currentTime - lastSent < resendSeconds * 1000) {
            const retryAfterSeconds = Math.max(1, Math.ceil((lastSent + resendSeconds * 1000 - currentTime) / 1000));
            throw authError("Please wait " + retryAfterSeconds + " seconds before requesting another code.", 429);
        }

        const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
        const challenge = {
            method,
            destination,
            codeHash: digest(method + ":" + destination + ":" + code),
            expiresAt: currentTime + ttlSeconds * 1000,
            attemptsRemaining: maxAttempts
        };
        challenges.set(key, challenge);
        sentAt.set(key, currentTime);
        try {
            if (method === "email") await sendEmail(destination, code);
            else await sendSms(destination, code);
        } catch {
            challenges.delete(key);
            throw authError("Ari could not send the verification code. Check the address or number and try again later.", 502);
        }
        return {
            sent: true,
            method,
            maskedDestination: maskDestination(method, destination),
            expiresInSeconds: ttlSeconds,
            resendAfterSeconds: resendSeconds
        };
    }

    async function authenticateOtp(request, response, body = {}) {
        assertOriginAndCsrf(request);
        const method = body.method === "email" || body.method === "sms" ? body.method : "";
        if (!method || !configured(method)) throw authError("This verification method is unavailable.", 503);
        const destination = normalizeDestination(method, body.destination);
        const code = typeof body.code === "string" ? body.code.trim() : "";
        if (!destination || !/^\d{6}$/.test(code)) {
            throw authError("Enter the six-digit verification code.", 400);
        }
        if (!isAuthorized(method, destination)) {
            throw authError("This contact method is not enabled for Ari. Please contact the site administrator.", 403);
        }
        const key = challengeKey(method, destination);
        const challenge = challenges.get(key);
        if (!challenge || challenge.expiresAt <= now()) {
            challenges.delete(key);
            throw authError("That verification code has expired. Request a new one.", 400);
        }
        const candidate = digest(method + ":" + destination + ":" + code);
        if (!constantTimeEqual(candidate, challenge.codeHash)) {
            challenge.attemptsRemaining -= 1;
            if (challenge.attemptsRemaining <= 0) challenges.delete(key);
            throw authError(challenge.attemptsRemaining <= 0
                ? "Too many incorrect attempts. Request a new verification code."
                : "That verification code is incorrect. Please try again.", 401);
        }

        challenges.delete(key);
        const subject = "ari:" + method + ":" + digest("account:" + method + ":" + destination);
        return createSession(request, response, {
            sub: subject,
            email: method === "email" ? destination : "",
            phone: method === "sms" ? destination : "",
            name: ""
        });
    }

    function methods() {
        return { emailOtp: emailConfigured, smsOtp: smsConfigured };
    }

    return { methods, requestOtp, authenticateOtp, challenges, sentAt };
}

module.exports = { createAriOtpAuth, normalizedPhone, normalizedEmail };
