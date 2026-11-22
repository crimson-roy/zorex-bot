"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createZcutProjectStore } = require("../dev/zcutProjectStore");

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcut-projects-"));
    try {
        const store = createZcutProjectStore({ dataDir: root, now: () => 123456 });
        const item = { id: "project_123", name: "Mobile edit", currentComp: "main",
            project: { n: 0, comps: { main: { id: "main", name: "Main", layers: [] } } },
            media: [{ id: "media123", name: "clip.mp4", type: "video", duration: 3, width: 1920, height: 1080, size: 2048, lastModified: 123456789 }] };
        const saved = await store.saveProject("account-a", item);
        assert.equal(saved.name, "Mobile edit");
        assert.equal((await store.listProjects("account-a")).length, 1);
        assert.equal((await store.getProject("account-a", item.id)).media[0].name, "clip.mp4");
        assert.equal((await store.getProject("account-a", item.id)).media[0].size, 2048);
        assert.equal((await store.getProject("account-a", item.id)).media[0].lastModified, 123456789);
        assert.equal(await store.getProject("account-b", item.id), null);
        await store.saveProject("account-a", { ...item, name: "Renamed" });
        assert.equal((await store.listProjects("account-a"))[0].name, "Renamed");
        assert.equal(await store.deleteProject("account-a", item.id), true);
        assert.equal((await store.listProjects("account-a")).length, 0);
        await assert.rejects(() => store.saveProject("account-a", { ...item, id: "../bad" }), /invalid format/i);
        console.log("Z_Cut project store tests passed.");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
