"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createZcutBridge } = require("../dev/zcutBridge");

async function main() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcut-bridge-test-"));
    const htmlPath = path.join(tempDir, "zcut.html");
    fs.writeFileSync(htmlPath, "<!doctype html><title>Z_Cut smoke test</title>");

    const bridge = createZcutBridge({
        htmlPath,
        filesDir: path.join(tempDir, "files"),
        publicBase: "http://127.0.0.1"
    });

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        if (!(await bridge.handle(req, res, url))) {
            res.writeHead(404);
            res.end("Not found");
        }
    });

    try {
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });

        const address = server.address();
        const base = `http://127.0.0.1:${address.port}`;

        const page = await fetch(base + "/zcut");
        assert.equal(page.status, 200);
        assert.match(await page.text(), /Z_Cut smoke test/);

        const ping = await fetch(base + "/api/zcut/ping");
        assert.equal(ping.status, 200);
        assert.deepEqual(await ping.json(), { ok: true, service: "zcut", version: 1 });

        const guide = await fetch(base + "/api/zcut/guide");
        assert.equal(guide.status, 200);
        assert.match(await guide.text(), /Z_Cut API/);

        const linkResponse = await fetch(base + "/api/zcut/link", { method: "POST" });
        assert.equal(linkResponse.status, 200);
        const { key } = await linkResponse.json();
        assert.match(key, /^[a-f0-9]{32}$/);

        const status = await fetch(base + "/api/zcut/status", {
            headers: { Authorization: "Bearer " + key }
        });
        assert.equal(status.status, 200);
        assert.equal((await status.json()).connected, false);

        const unauthorized = await fetch(base + "/api/zcut/state");
        assert.equal(unauthorized.status, 401);

        console.log("Z_Cut bridge smoke tests passed.");
    } finally {
        bridge.close();
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
