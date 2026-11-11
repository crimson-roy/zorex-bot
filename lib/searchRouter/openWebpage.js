"use strict";

const dns = require("node:dns").promises;
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const ipaddr = require("ipaddr.js");
const cheerio = require("cheerio");

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const CONNECT_TIMEOUT_MS = 5000;
const TOTAL_TIMEOUT_MS = 12000;
const BLOCKED_HOSTS = new Set(["metadata.google.internal", "metadata.google", "metadata"]);

function parsePublicAddress(value) {
    let address;
    try { address = ipaddr.process(value); } catch { return null; }
    if (address.range() !== "unicast") return null;
    return { address: address.toString(), family: address.kind() === "ipv4" ? 4 : 6 };
}

async function resolvePublicHost(hostname, lookup = dns.lookup) {
    const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
    if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || BLOCKED_HOSTS.has(host)) {
        throw Object.assign(new Error("Local and metadata hosts are blocked"), { code: "SSRF_BLOCKED" });
    }
    if (net.isIP(host)) {
        const address = parsePublicAddress(host);
        if (!address) throw Object.assign(new Error("Non-public IP addresses are blocked"), { code: "SSRF_BLOCKED" });
        return [address];
    }
    let records;
    try { records = await lookup(host, { all: true, verbatim: true }); }
    catch (cause) { throw Object.assign(new Error("Could not safely resolve webpage host"), { code: "URL_VALIDATION_FAILED", cause }); }
    if (!Array.isArray(records) || !records.length) throw Object.assign(new Error("Webpage host has no addresses"), { code: "URL_VALIDATION_FAILED" });
    const addresses = records.map(record => parsePublicAddress(record.address));
    if (addresses.some(address => !address)) throw Object.assign(new Error("Host resolved to a non-public address"), { code: "SSRF_BLOCKED" });
    return addresses;
}

function validateUrl(value) {
    let url;
    try { url = new URL(value); } catch { throw Object.assign(new Error("A valid public webpage URL is required"), { statusCode: 400 }); }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port && !/^\d+$/.test(url.port)) {
        throw Object.assign(new Error("Only credential-free HTTP or HTTPS URLs are allowed"), { statusCode: 400 });
    }
    if (url.port && Number(url.port) !== 80 && Number(url.port) !== 443) {
        throw Object.assign(new Error("Non-standard ports are not allowed"), { statusCode: 400 });
    }
    url.hash = "";
    return url;
}

function requestPinned(url, address, timeoutMs = TOTAL_TIMEOUT_MS, maxBytes = MAX_BYTES) {
    return new Promise((resolve, reject) => {
        const client = url.protocol === "https:" ? https : http;
        let settled = false;
        let size = 0;
        const chunks = [];
        const request = client.request(url, {
            method: "GET",
            headers: { "User-Agent": "ZorexSearchRouter/1.0 (+public-web-fetch)", Accept: "text/html,application/xhtml+xml,text/plain;q=0.9", "Accept-Encoding": "identity" },
            lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
            servername: net.isIP(url.hostname) ? undefined : url.hostname,
            agent: false,
            maxHeaderSize: 16 * 1024
        }, response => {
            const headers = response.headers;
            response.on("data", chunk => {
                size += chunk.length;
                if (size > maxBytes) {
                    response.destroy(Object.assign(new Error("Webpage response exceeded size limit"), { code: "BODY_TOO_LARGE" }));
                    return;
                }
                chunks.push(chunk);
            });
            response.on("end", () => finish(null, { status: response.statusCode || 0, headers, body: Buffer.concat(chunks) }));
            response.on("error", error => finish(error));
        });
        const totalTimer = setTimeout(() => request.destroy(Object.assign(new Error("Webpage retrieval timed out"), { code: "ETIMEDOUT" })), timeoutMs);
        request.setTimeout(Math.min(CONNECT_TIMEOUT_MS, timeoutMs), () => request.destroy(Object.assign(new Error("Webpage connection timed out"), { code: "ETIMEDOUT" })));
        request.on("socket", socket => {
            if (!socket.connecting) return;
            const connectTimer = setTimeout(() => request.destroy(Object.assign(new Error("Webpage connection timed out"), { code: "ETIMEDOUT" })), Math.min(CONNECT_TIMEOUT_MS, timeoutMs));
            const established = url.protocol === "https:" ? "secureConnect" : "connect";
            socket.once(established, () => clearTimeout(connectTimer));
            request.once("close", () => clearTimeout(connectTimer));
        });
        request.on("error", error => finish(error));
        request.end();
        function finish(error, result) {
            if (settled) return;
            settled = true;
            clearTimeout(totalTimer);
            if (error) reject(error); else resolve(result);
        }
    });
}

function extractPage(body, contentType) {
    const html = /(?:text\/html|application\/xhtml\+xml)/i.test(contentType);
    const source = body.toString("utf8");
    if (!html) return { title: "", text: source.replace(/\s+/g, " ").trim(), publicationDate: null };
    const $ = cheerio.load(source);
    $("script,style,noscript,template,svg,canvas,iframe,nav,footer,header,aside,form,button,[hidden],[aria-hidden='true']").remove();
    const title = String($('meta[property="og:title"]').attr("content") || $("title").first().text() || $("h1").first().text() || "").trim();
    const candidates = ["article", "main", "[role=main]", "body"]
        .map(selector => $(selector).first()).filter(node => node.length)
        .map(node => ({ node, text: node.text().replace(/\s+/g, " ").trim() }))
        .sort((a, b) => b.text.length - a.text.length);
    const text = (candidates[0]?.text || "").trim();
    const dates = [
        $('meta[property="article:published_time"]').attr("content"),
        $('meta[name="datePublished"]').attr("content"),
        $('meta[itemprop="datePublished"]').attr("content"),
        $("time[datetime]").first().attr("datetime")
    ];
    let publicationDate = null;
    for (const value of dates) {
        const stamp = typeof value === "string" ? Date.parse(value) : NaN;
        if (Number.isFinite(stamp)) { publicationDate = new Date(stamp).toISOString(); break; }
    }
    return { title, text, publicationDate };
}

async function openWebpage(sourceUrl, options = {}, dependencies = {}) {
    const timeoutMs = Math.max(1000, Math.min(30000, Number(options.timeoutMs) || TOTAL_TIMEOUT_MS));
    const maxBytes = Math.max(1024, Math.min(5 * 1024 * 1024, Number(options.maxBytes) || MAX_BYTES));
    const lookup = dependencies.lookup || dns.lookup;
    const request = dependencies.request || requestPinned;
    let current = validateUrl(sourceUrl);
    let response;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
        let dnsTimer;
        const addresses = await Promise.race([
            resolvePublicHost(current.hostname, lookup),
            new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(Object.assign(new Error("Webpage DNS lookup timed out"), { code: "ETIMEDOUT" })), Math.min(CONNECT_TIMEOUT_MS, timeoutMs)); })
        ]).finally(() => clearTimeout(dnsTimer));
        response = await request(current, addresses[0], timeoutMs, maxBytes);
        if (response.status >= 300 && response.status < 400 && response.headers.location) {
            if (redirects === MAX_REDIRECTS) throw Object.assign(new Error("Too many webpage redirects"), { code: "TOO_MANY_REDIRECTS" });
            current = validateUrl(new URL(response.headers.location, current).toString());
            continue;
        }
        break;
    }
    const contentType = String(response.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (!["text/html", "application/xhtml+xml", "text/plain"].includes(contentType)) {
        throw Object.assign(new Error("Webpage content type is not readable HTML or plain text"), { code: "INVALID_CONTENT_TYPE", statusCode: 415 });
    }
    if (response.status < 200 || response.status >= 300) {
        throw Object.assign(new Error(`Webpage returned HTTP ${response.status}`), { code: "WEBPAGE_HTTP_ERROR", statusCode: response.status });
    }
    const extracted = extractPage(response.body, contentType);
    return {
        title: extracted.title,
        url: current.toString(),
        text: extracted.text.slice(0, Math.max(1000, Math.min(50000, Number(options.maxTextChars) || 20000))),
        publication_date: extracted.publicationDate,
        http_status: response.status,
        retrieved_at: new Date().toISOString(),
        source_url: String(sourceUrl)
    };
}

module.exports = { openWebpage, validateUrl, resolvePublicHost, parsePublicAddress, extractPage };
