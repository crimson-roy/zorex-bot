"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { createAriLibraryStore } = require("../dev/ariLibraryStore");
const { createServer, HOST } = require("../dev/ari-chat-server");

async function startServer(options) {
    const app = createServer(options);
    await new Promise((resolve, reject) => {
        app.once("error", reject);
        app.listen(0, HOST, resolve);
    });
    return { app, baseUrl: "http://" + HOST + ":" + app.address().port };
}

async function main() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ari-library-store-"));
    const limitedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ari-library-quota-"));
    let server;
    try {
        const library = createAriLibraryStore({
            dataDir: directory,
            maxFileBytes: 512,
            quotaBytes: 1024,
            globalQuotaBytes: 2048
        });
        const authService = {
            config: () => ({ clientId: "test-client", configured: true }),
            issueCsrf: () => ({ csrfToken: "test-csrf", clientId: "test-client", configured: true }),
            requireSession: request => {
                const sub = request.headers["x-test-account"] || "account-one";
                return { sub, email: sub + "@example.test", name: "Test" };
            },
            publicUser: session => ({ sub: session.sub, email: session.email, name: session.name }),
            assertOriginAndCsrf() {},
            authenticateCredential: async () => ({ authenticated: true }),
            logout: () => ({ ok: true })
        };
        const usageStore = { async consumeAcceptedMessage() { return { allowed: true }; } };
        server = await startServer({ authService, usageStore, libraryStore: library });
        const baseUrl = server.baseUrl;

        const empty = await fetch(baseUrl + "/api/library/files");
        assert.equal(empty.status, 200);
        assert.deepEqual((await empty.json()).files, []);

        const document = Buffer.from("Ari Library notes");
        const uploaded = await fetch(baseUrl + "/api/library/files", {
            method: "POST",
            headers: {
                "Content-Type": "text/plain",
                "X-Ari-Filename": encodeURIComponent("../my notes.txt")
            },
            body: document
        });
        assert.equal(uploaded.status, 201);
        const saved = await uploaded.json();
        assert.equal(saved.saved, true);
        assert.equal(saved.file.name, "my notes.txt");
        assert.equal(saved.file.size, document.length);
        assert.equal(saved.storage.usedBytes, document.length);

        const duplicateUpload = await fetch(baseUrl + "/api/library/files", {
            method: "POST",
            headers: {
                "Content-Type": "text/plain",
                "X-Ari-Filename": encodeURIComponent("same-content-renamed.txt")
            },
            body: document
        });
        assert.equal(duplicateUpload.status, 201);
        const duplicate = await duplicateUpload.json();
        assert.equal(duplicate.file.id, saved.file.id, "identical bytes reuse the first stored Library file");
        assert.equal(duplicate.file.duplicate, true);
        assert.equal(duplicate.storage.files.length, 1);
        assert.equal(duplicate.storage.usedBytes, document.length);

        const list = await fetch(baseUrl + "/api/library/files");
        const listed = await list.json();
        assert.equal(listed.files.length, 1);
        assert.equal(listed.files[0].id, saved.file.id);

        const download = await fetch(baseUrl + "/api/library/files/" + saved.file.id + "/download");
        assert.equal(download.status, 200);
        assert.equal(download.headers.get("content-type"), "application/octet-stream");
        assert.match(download.headers.get("content-disposition"), /attachment/);
        assert.deepEqual(Buffer.from(await download.arrayBuffer()), document);

        const hiddenFromOtherAccount = await fetch(baseUrl + "/api/library/files", {
            headers: { "X-Test-Account": "account-two" }
        });
        assert.deepEqual((await hiddenFromOtherAccount.json()).files, []);
        const crossAccountDownload = await fetch(baseUrl + "/api/library/files/" + saved.file.id + "/download", {
            headers: { "X-Test-Account": "account-two" }
        });
        assert.equal(crossAccountDownload.status, 404);

        const image = Buffer.from("mock png bytes");
        const imageUpload = await fetch(baseUrl + "/api/library/files", {
            method: "POST",
            headers: { "Content-Type": "image/png", "X-Ari-Filename": "preview.png" },
            body: image
        });
        assert.equal(imageUpload.status, 201);
        const imageRecord = (await imageUpload.json()).file;
        const preview = await fetch(baseUrl + "/api/library/files/" + imageRecord.id + "/preview");
        assert.equal(preview.status, 200);
        assert.equal(preview.headers.get("content-type"), "image/png");
        assert.deepEqual(Buffer.from(await preview.arrayBuffer()), image);

        const deleted = await fetch(baseUrl + "/api/library/files/" + saved.file.id, { method: "DELETE" });
        assert.equal(deleted.status, 200);
        assert.equal((await deleted.json()).deleted, true);
        assert.equal(library.getFile("account-one", saved.file.id), null);
        assert.equal(library.listFiles("account-one").files.length, 1);

        const limited = createAriLibraryStore({
            dataDir: limitedDirectory,
            maxFileBytes: 12,
            quotaBytes: 10,
            globalQuotaBytes: 15
        });
        const first = Buffer.from("123456789");
        await limited.saveFile("a", { name: "first.txt", mimeType: "text/plain" }, Readable.from([first]), first.length);
        const perAccountOverflow = Buffer.from("12");
        await assert.rejects(
            limited.saveFile("a", { name: "second.txt", mimeType: "text/plain" }, Readable.from([perAccountOverflow]), perAccountOverflow.length),
            error => error.statusCode === 413
        );
        const secondAccount = Buffer.from("1234");
        await limited.saveFile("b", { name: "second-account.txt", mimeType: "text/plain" }, Readable.from([secondAccount]), secondAccount.length);
        const globalOverflow = Buffer.from("123");
        await assert.rejects(
            limited.saveFile("c", { name: "third-account.txt", mimeType: "text/plain" }, Readable.from([globalOverflow]), globalOverflow.length),
            error => error.statusCode === 507
        );
        const overFileLimit = Buffer.from("1234567890123");
        await assert.rejects(
            limited.saveFile("z", { name: "large.txt", mimeType: "text/plain" }, Readable.from([overFileLimit]), overFileLimit.length),
            error => error.statusCode === 413
        );

        console.log("ariLibraryStore.test.js: upload, account isolation, download, preview, deletion and quotas passed");
    } finally {
        if (server?.app) await new Promise(resolve => server.app.close(resolve));
        fs.rmSync(directory, { recursive: true, force: true });
        fs.rmSync(limitedDirectory, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
