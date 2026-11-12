"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WordNetDictionary } = require("../lib/wordNet");
const { createServer, respondToMessage, respondWithGpuModel, respondWithModel, shouldSearchWeb, isExplicitWebSearchRequest, isRestrictedSearchIntent, buildSearchQuery, prepareSearchMessages, appendWebpageImages, HOST } = require("../dev/ari-chat-server");
const { AriGpuClient } = require("../dev/ariGpuClient");
const { createAriWorkspaceStore } = require("../dev/ariWorkspaceStore");
const { createAriAnalyticsStore } = require("../dev/ariAnalyticsStore");
const { createAriExperienceStore } = require("../dev/ariExperienceStore");

function createTestServer(options = {}) {
    const authService = {
        config: () => ({ clientId: "test-client", configured: true, error: null }),
        issueCsrf: () => ({ csrfToken: "test-csrf", clientId: "test-client", configured: true, error: null }),
        requireSession: () => ({ sub: "test-google-sub", email: "test@example.com", name: "Test" }),
        publicUser: session => ({ sub: session.sub, email: session.email, name: session.name, isAdmin: options.isAdmin === true }),
        isAdmin: () => options.isAdmin === true,
        assertOriginAndCsrf() {},
        authenticateCredential: async () => ({ authenticated: true }),
        logout: () => ({ ok: true }),
    };
    const usageStore = { async consumeAcceptedMessage() { return { allowed: true }; } };
    const workspaceData = new Map();
    const workspaceStore = options.workspaceStore || {
        getChats(subject) { return workspaceData.get(subject) || []; },
        searchChats() { return []; },
        getProfile() {
            return { preferredNickname: "", hobbies: "", occupation: "", aboutYou: "", personality: "neutral", emojiUse: "balanced" };
        },
        async updateProfile(_subject, profile) { return profile; },
        getSettings() { return { accessPreviousChats: false, accessLastChat: false, activeExperienceLearning: true }; },
        async updateSettings(_subject, settings) {
            return { accessPreviousChats: false, accessLastChat: false, activeExperienceLearning: true, ...settings };
        },
        async replaceChats(subject, chats) {
            workspaceData.set(subject, chats);
            return chats;
        }
    };
    return createServer({ ...options, authService, usageStore, workspaceStore });
}

async function main() {
    const arithmetic = respondToMessage("What is 1 + 1?");
    assert.equal(arithmetic.reply, "2");
    assert.match(arithmetic.mode, /no AI API/i);

    const greeting = respondToMessage("Hi Ari");
    assert.match(greeting.reply, /Hi!/);
    assert.match(greeting.mode, /no AI API/i);

    const unsupported = respondToMessage("Explain photosynthesis.");
    assert.match(unsupported.reply, /still learning/i);

    const fallbackMessages = [{ role: "user", content: "Explain gradient descent in simple terms." }];
    const backup = await respondWithGpuModel("Explain gradient descent in simple terms.", fallbackMessages, {
        tier: "medium",
        textFallbackClient: async messages => {
            assert.deepEqual(messages, fallbackMessages);
            return "This answer came from the text-only backup.";
        }
    });
    assert.equal(backup.reply, "This answer came from the text-only backup.");
    assert.equal(backup.mode, "Text-only backup");

    const miniBackup = await respondWithModel("Explain gradient descent in simple terms.", fallbackMessages, {
        modelClient: { async generate() { throw new Error("local model offline"); } },
        textFallbackClient: async () => "Mini used the text-only backup."
    });
    assert.equal(miniBackup.reply, "Mini used the text-only backup.");
    assert.equal(miniBackup.mode, "Text-only backup");

    let mediaWasSentToBackup = false;
    await assert.rejects(() => respondWithGpuModel("Describe this image.", fallbackMessages, {
        tier: "medium",
        image: { mime_type: "image/png", data_base64: "AA==" },
        gpuClient: { async chat() {
            const error = new Error("GPU offline");
            error.statusCode = 503;
            error.code = "GPU_DISCONNECTED";
            error.retryable = true;
            throw error;
        } },
        textFallbackClient: async () => {
            mediaWasSentToBackup = true;
            return "This should never be returned.";
        }
    }), error => error.code === "GPU_MEDIA_UNAVAILABLE");
    assert.equal(mediaWasSentToBackup, false, "the text-only backup must never receive a media request.");

    assert.equal(shouldSearchWeb("What's the latest Kaggle CPU notebook runtime?"), true);
    assert.equal(shouldSearchWeb("What is a CPU?"), false);
    assert.equal(shouldSearchWeb("Can you search the web?"), false);
    assert.equal(buildSearchQuery("Search the web for current Kaggle CPU limits."), "current Kaggle CPU limits.");
    const appendedImages = appendWebpageImages("A useful result.", [
        { alt: "Notebook settings", url: "https://images.example.test/notebook.png" },
        { alt: "Duplicate image", url: "https://images.example.test/notebook.png" },
        { alt: "Second image", url: "https://images.example.test/second.png" }
    ]);
    assert.match(appendedImages, /!\[Notebook settings\]\(https:\/\/images\.example\.test\/notebook\.png\)/);
    assert.match(appendedImages, /!\[Second image\]\(https:\/\/images\.example\.test\/second\.png\)/);
    assert.equal((appendedImages.match(/!\[/g) || []).length, 2);
    assert.ok(!appendedImages.includes("Duplicate image"));
    assert.equal(isExplicitWebSearchRequest("Search the web for the current Kaggle session limit."), true);
    assert.equal(isRestrictedSearchIntent("Where can I find a supplier for a dangerous product?"), true);
    assert.equal(isRestrictedSearchIntent("Explain safety precautions for dangerous products."), false);
    const searchMessages = [{ role: "user", content: "Search the web for current Kaggle CPU limits." }];
    let searchQuery = "";
    let pageReadCount = 0;
    const preparedResearch = await prepareSearchMessages(searchMessages[0].content, searchMessages, {
        searchRouter: {
            config: { enabled: true },
            async web_search(query, options) {
                searchQuery = query;
                assert.equal(options.limit, 4);
                return {
                    providers_used: ["serper"],
                    results: [{
                        title: "Official notebook documentation",
                        url: "https://docs.example.test/notebooks",
                        snippet: "Notebook sessions have runtime limits."
                    }]
                };
            }
        },
        async webpageReader(url) {
            pageReadCount++;
            assert.equal(url, "https://docs.example.test/notebooks");
            return {
                title: "Official notebook documentation",
                url,
                source_url: url,
                text: "The page explains CPU notebook session limits and interactive idling.",
                images: [{ alt: "Notebook settings", url: "https://images.example.test/notebook.png" }]
            };
        }
    });
    assert.equal(searchQuery, "current Kaggle CPU limits.");
    assert.equal(pageReadCount, 1);
    assert.equal(preparedResearch.searched, true);
    assert.equal(preparedResearch.providers[0], "serper");
    assert.equal(preparedResearch.messages.length, 2);
    assert.match(preparedResearch.messages[1].content, /UNTRUSTED WEB RESULTS/);
    assert.match(preparedResearch.messages[1].content, /https:\/\/docs\.example\.test\/notebooks/);
    assert.match(preparedResearch.messages[1].content, /https:\/\/images\.example\.test\/notebook\.png/);
    assert.ok(preparedResearch.messages[1].content.length <= 2000);
    const disabledResearch = await prepareSearchMessages(searchMessages[0].content, searchMessages, {
        searchRouter: { config: { enabled: false } }
    });
    assert.equal(disabledResearch.searched, false);
    assert.equal(disabledResearch.error, "disabled");

    const searchApp = createTestServer({
        searchRouter: {
            config: { enabled: true },
            async web_search(query) {
                assert.equal(query, "current notebook information.");
                return {
                    providers_used: ["serper"],
                    results: [{
                        title: "Search result",
                        url: "https://docs.example.test/search-result",
                        snippet: "Verified information."
                    }]
                };
            }
        },
        async webpageReader(url) {
            return { title: "Search result", url, source_url: url, text: "A verified source excerpt.", images: [{ alt: "Search result image", url: "https://images.example.test/search-result.png" }] };
        },
        modelClient: {
            async generate(messages) {
                assert.match(messages[messages.length - 1].content, /UNTRUSTED WEB RESULTS/);
                assert.match(messages[messages.length - 1].content, /https:\/\/docs\.example\.test\/search-result/);
                return { reply: "Here is what I found. [Source](https://docs.example.test/search-result)" };
            }
        }
    });
    await new Promise((resolve, reject) => { searchApp.once("error", reject); searchApp.listen(0, HOST, resolve); });
    try {
        const response = await fetch("http://" + HOST + ":" + searchApp.address().port + "/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                message: "Search the web for current notebook information.",
                tier: "mini",
                messages: [{ role: "user", content: "Search the web for current notebook information." }]
            })
        });
        assert.equal(response.status, 200);
        const searchReply = (await response.json()).reply;
        assert.match(searchReply, /Here is what I found/);
        assert.match(searchReply, /!\[Search result image\]\(https:\/\/images\.example\.test\/search-result\.png\)/);
    } finally {
        await new Promise(resolve => searchApp.close(resolve));
    }

    const dictionaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "ari-server-wordnet-"));
    try {
        fs.writeFileSync(path.join(dictionaryDir, "index.noun"),
            "persistence n 1 0 1 1 00000000\n");
        fs.writeFileSync(path.join(dictionaryDir, "data.noun"),
            "00000000 00 n 01 persistence 0 000 | the act or condition of persisting\n");

        const dictionary = new WordNetDictionary({ dictDir: dictionaryDir });
        const definition = respondToMessage("What does persistence mean?", { dictionary });
        assert.match(definition.reply, /condition of persisting/);
        assert.match(definition.mode, /WordNet dictionary/);
    } finally {
        fs.rmSync(dictionaryDir, { recursive: true, force: true });
    }

    const workspaceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ari-workspace-http-"));
    const analyticsStore = createAriAnalyticsStore({ dataDir: workspaceDirectory });
    const app = createTestServer({
        env: { ARI_PUBLIC_ORIGIN: "https://ari.example.test" },
        workspaceStore: createAriWorkspaceStore({ dataDir: workspaceDirectory }),
        analyticsStore
    });
    await new Promise((resolve, reject) => {
        app.once("error", reject);
        app.listen(0, HOST, resolve);
    });

    try {
        const address = app.address();
        const baseUrl = `http://${HOST}:${address.port}`;

        const page = await fetch(baseUrl + "/");
        assert.equal(page.status, 200);
        const html = await page.text();
        const homepageResponse = await fetch(baseUrl + "/homepage");
        assert.equal(homepageResponse.status, 200);
        const homepageHtml = await homepageResponse.text();
        assert.match(homepageHtml, /id="landing-screen"/);
        assert.ok(homepageHtml.includes("<title>Ari by Zorex AI | AI workspace for conversations and projects</title>"));
        assert.ok(homepageHtml.includes("About Ari by Zorex AI"));
        assert.ok(homepageHtml.includes("Nigerian developer with a laptop"));
        assert.ok(homepageHtml.includes('href="/about"'));
        assert.ok(homepageHtml.includes('href="https://ari.example.test/"'));
        const aboutResponse = await fetch(baseUrl + "/about");
        assert.equal(aboutResponse.status, 200);
        const aboutHtml = await aboutResponse.text();
        assert.ok(aboutHtml.includes("<title>About Ari | Zorex AI</title>"));
        assert.ok(aboutHtml.includes("Nigerian developer, a laptop"));
        assert.ok(aboutHtml.toLowerCase().includes("what ari can do today"));
        assert.ok(aboutHtml.toLowerCase().includes("document contents and understanding or transcribing audio are not yet available"));
        assert.ok(aboutHtml.includes("application/ld+json"));
        const robotsResponse = await fetch(baseUrl + "/robots.txt");
        assert.equal(robotsResponse.status, 200);
        const robotsText = await robotsResponse.text();
        assert.ok(robotsText.includes("Disallow: /api/"));
        assert.ok(robotsText.includes("Sitemap: https://ari.example.test/sitemap.xml"));
        const sitemapResponse = await fetch(baseUrl + "/sitemap.xml");
        assert.equal(sitemapResponse.status, 200);
        const sitemapText = await sitemapResponse.text();
        assert.ok(sitemapText.includes("https://ari.example.test/about"));
        const scriptStart = html.indexOf("<script>");
        const scriptEnd = html.indexOf("</script>", scriptStart + 8);
        assert.ok(scriptStart >= 0 && scriptEnd > scriptStart, "Ari's inline application script must exist.");
        assert.doesNotThrow(() => new Function(html.slice(scriptStart + 8, scriptEnd)), "Ari's browser script must be syntactically valid.");
        const htmlIds = html.split(' id="').slice(1).map(part => part.split('"', 1)[0]);
        assert.equal(new Set(htmlIds).size, htmlIds.length, "Ari's page must not contain duplicate element IDs.");
        assert.match(html, /Welcome back/);
        assert.match(html, /id="landing-screen"/);
        assert.match(html, /A calmer space for thinking, creating and getting things done/);
        assert.match(html, /id="auth-tabs" data-mode="login"/);
        assert.match(html, /id="login-tab"/);
        assert.match(html, /id="signup-tab"/);
        assert.match(html, /auth-tabs\[data-mode="signup"\]/);
        assert.match(html, /window.location.pathname === "\/homepage"/);
        assert.match(html, /registrationMode !== "open"/);
        assert.match(html, /Continue with Google/);
        assert.doesNotMatch(html, /Phone \/ SMS|verification code|one-time code/i);
        assert.match(html, /Create your account with a verified Google account/);
        assert.doesNotMatch(html, /invited developers only|invited Google account/i);
        assert.match(html, /<link rel="icon" type="image\/png" href="\/ari-favicon\.png">/);
        const favicon = await fetch(baseUrl + "/ari-favicon.png");
        assert.equal(favicon.status, 200);
        assert.equal(favicon.headers.get("content-type"), "image/png");
        assert.ok(Number(favicon.headers.get("content-length")) > 1000);
        assert.match(html, /Where should we begin/);
        assert.match(html, /ari-playground-chats-v1/);
        assert.match(html, /id="chat-list"/);
        assert.match(html, /--sidebar-width: 268px/);
        assert.match(html, /Newsreader/);
        assert.match(html, /id="library-nav"/);
        assert.match(html, /id="projects-nav"/);
        assert.match(html, /id="account-menu"/);
        assert.match(html, /Profile \/ About You/);
        assert.match(html, /data-account-view="memory"/);
        assert.match(html, /data-account-view="settings"/);
        assert.match(html, /id="workspace-screen"/);
        assert.match(html, /id="attachment-preview"/);
        assert.match(html, /id="paste-card"/);
        assert.match(html, /Copy response/);
        assert.match(html, /function appendMessageText/);
        assert.match(html, /message-image/);
        assert.match(html, /referrerPolicy = "no-referrer"/);
        assert.match(html, /function renderAriContent/);
        assert.match(html, /message-code-copy/);
        assert.match(html, /navigator\.clipboard\.writeText\(codeText\)/);
        assert.match(html, /function showWorkspaceView/);
        assert.match(html, /async function loadProjectsView/);
        assert.match(html, /function openProjectDetail/);
        assert.match(html, /filter\(chat => !chat\.projectId\)/);
        assert.match(html, /projectId: activeProjectId \|\| null/);
        assert.match(html, /Create project/);
        assert.match(html, /async function loadMemoryView/);
        assert.match(html, /Review mode is active/);
        assert.match(html, /Automatic model-generated suggestions are not connected yet/);
        assert.match(html, /Ari does not yet have the verification and account-data deletion endpoint/);
        assert.match(html, /Delete this conversation from this browser/);
        assert.doesNotMatch(html, /class="history-delete"|textContent = "×"/);
        assert.match(html, /contextmenu/);
        assert.match(html, /event\.pointerType !== "touch"/);
        assert.match(html, /Unpin chat/);
        assert.match(html, /target\.pinned = !target\.pinned/);
        assert.match(html, /Create a short chat-list title from this exchange/);
        assert.match(html, /function generateChatTitle/);
        assert.match(html, /Ari is working…/);
        assert.match(html, /Thought for/);
        assert.match(html, /function readAriChatResponse/);
        assert.match(html, /message-activity-list/);
        assert.match(html, /message-rating/);
        assert.doesNotMatch(html, /Ari is replying/);
        assert.match(html, /id="sidebar-toggle"/);
        assert.match(html, /sidebar-collapsed/);
        assert.match(html, /id="attach-menu" role="menu" hidden/);
        assert.match(html, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
        assert.match(html, /min-height: 98px/);
        assert.match(html, /data-picker="image-input"/);
        assert.match(html, /Photos and images/);
        assert.match(html, /data-picker="audio-input"/);
        assert.match(html, /<span>Audio<\/span>/);
        assert.match(html, /data-picker="file-input"/);
        assert.match(html, /Documents and files/);
        assert.match(html, /This file is saved in your Library, but Ari cannot analyse documents or audio yet/);
        assert.ok(html.includes("localStorage.setItem"));
        assert.doesNotMatch(html, /id="model-status"|id="chat-controls"|Kaggle|Cloudflare|Checking Ari-0/);
        assert.match(html, /id="attach-button"/);
        assert.match(html, /attachButton\.addEventListener\("click", \(\) => setAttachMenuOpen\(attachMenu\.hidden\)\)/);
        assert.match(html, /id="tier-select"/);
        assert.match(html, /id="image-input"/);
        assert.match(html, /#image-input, #audio-input, #file-input \{ display: none; \}/);
        assert.match(html, /id="think-toggle" type="button" aria-pressed="false"/);
        assert.match(html, /Ari is AI and can make mistakes\. Please double-check important information\./);
        assert.match(html, /resizeComposer\(\)/);
        assert.match(html, /reader\.readAsDataURL\(file\)/);
        assert.match(html, /data_base64/);
        assert.match(html, /<option value="medium">Medium<\/option>/);
        assert.doesNotMatch(html, /Qwen|Gemma|Alibaba Cloud|Cloudflare|Kaggle|NVIDIA|cuda:\d/);

        const initialWorkspace = await fetch(baseUrl + "/api/workspace/chats");
        assert.equal(initialWorkspace.status, 200);
        assert.deepEqual((await initialWorkspace.json()).chats, []);

        const timestamp = Date.now();
        const sampleChats = [{
            id: "persisted-chat-1",
            title: "Workspace persistence",
            createdAt: timestamp,
            updatedAt: timestamp,
            pinned: true,
            projectId: null,
            messages: [
                { role: "user", text: "Save this conversation.", createdAt: timestamp },
                { role: "ari", text: "This conversation is saved per account.", id: "response-1", createdAt: timestamp + 1 }
            ]
        }];
        const savedWorkspace = await fetch(baseUrl + "/api/workspace/chats", {
            method: "PUT",
            headers: {
                "Content-Type": "application/json",
                "Origin": baseUrl,
                "X-Ari-CSRF": "test-csrf"
            },
            body: JSON.stringify({ chats: sampleChats })
        });
        assert.equal(savedWorkspace.status, 200);
        assert.equal((await savedWorkspace.json()).saved, true);
        const loadedWorkspace = await fetch(baseUrl + "/api/workspace/chats");
        assert.deepEqual((await loadedWorkspace.json()).chats, sampleChats);

        const feedbackResponse = await fetch(baseUrl + "/api/feedback", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Origin": baseUrl,
                "X-Ari-CSRF": "test-csrf"
            },
            body: JSON.stringify({ chatId: "persisted-chat-1", messageId: "response-1", rating: "like" })
        });
        assert.equal(feedbackResponse.status, 200);
        assert.equal((await feedbackResponse.json()).saved, true);
        assert.equal(analyticsStore.getDashboard().responses.likeRate, 100);
        const changedFeedback = await fetch(baseUrl + "/api/feedback", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Origin": baseUrl,
                "X-Ari-CSRF": "test-csrf"
            },
            body: JSON.stringify({ chatId: "persisted-chat-1", messageId: "response-1", rating: "dislike" })
        });
        assert.equal(changedFeedback.status, 200);
        assert.equal(analyticsStore.getDashboard().responses.totalRatings, 1);
        assert.equal(analyticsStore.getDashboard().responses.dislikeRate, 100);

        const initialProjects = await fetch(baseUrl + "/api/workspace/projects");
        assert.equal(initialProjects.status, 200);
        assert.deepEqual((await initialProjects.json()).projects, []);

        const createdProjectResponse = await fetch(baseUrl + "/api/workspace/projects", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Origin": baseUrl,
                "X-Ari-CSRF": "test-csrf"
            },
            body: JSON.stringify({ name: "Ari website", description: "The Ari workspace." })
        });
        assert.equal(createdProjectResponse.status, 201);
        const createdProject = (await createdProjectResponse.json()).project;
        assert.equal(createdProject.name, "Ari website");

        const projectChats = sampleChats.map(chat => ({ ...chat, projectId: createdProject.id }));
        const savedProjectChats = await fetch(baseUrl + "/api/workspace/chats", {
            method: "PUT",
            headers: {
                "Content-Type": "application/json",
                "Origin": baseUrl,
                "X-Ari-CSRF": "test-csrf"
            },
            body: JSON.stringify({ chats: projectChats })
        });
        assert.equal(savedProjectChats.status, 200);
        assert.equal((await savedProjectChats.json()).chats[0].projectId, createdProject.id);

        const renamedProjectResponse = await fetch(baseUrl + "/api/workspace/projects/" + createdProject.id, {
            method: "PATCH",
            headers: {
                "Content-Type": "application/json",
                "Origin": baseUrl,
                "X-Ari-CSRF": "test-csrf"
            },
            body: JSON.stringify({ name: "Ari product", description: "The updated workspace." })
        });
        assert.equal(renamedProjectResponse.status, 200);
        assert.equal((await renamedProjectResponse.json()).project.name, "Ari product");

        const removedProjectResponse = await fetch(baseUrl + "/api/workspace/projects/" + createdProject.id, {
            method: "DELETE",
            headers: { "Origin": baseUrl, "X-Ari-CSRF": "test-csrf" }
        });
        assert.equal(removedProjectResponse.status, 200);
        assert.equal((await removedProjectResponse.json()).unassignedChats, 1);
        const historyAfterProjectDelete = await fetch(baseUrl + "/api/workspace/chats");
        assert.equal((await historyAfterProjectDelete.json()).chats[0].projectId, null);

        const initialMemories = await fetch(baseUrl + "/api/workspace/memory");
        assert.equal(initialMemories.status, 200);
        assert.deepEqual((await initialMemories.json()).memories, []);

        const createdMemoryResponse = await fetch(baseUrl + "/api/workspace/memory", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Origin": baseUrl,
                "X-Ari-CSRF": "test-csrf"
            },
            body: JSON.stringify({ text: "Prefers practical, step-by-step answers." })
        });
        assert.equal(createdMemoryResponse.status, 201);
        const createdMemory = (await createdMemoryResponse.json()).memory;
        assert.equal(createdMemory.status, "active");

        const editedMemoryResponse = await fetch(baseUrl + "/api/workspace/memory/" + createdMemory.id, {
            method: "PATCH",
            headers: {
                "Content-Type": "application/json",
                "Origin": baseUrl,
                "X-Ari-CSRF": "test-csrf"
            },
            body: JSON.stringify({ text: "Prefers concise, practical explanations." })
        });
        assert.equal(editedMemoryResponse.status, 200);
        assert.equal((await editedMemoryResponse.json()).memory.text, "Prefers concise, practical explanations.");

        const unsafeMemoryResponse = await fetch(baseUrl + "/api/workspace/memory", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Origin": baseUrl,
                "X-Ari-CSRF": "test-csrf"
            },
            body: JSON.stringify({ text: "password: do-not-save-this" })
        });
        assert.equal(unsafeMemoryResponse.status, 400);

        const deletedMemoryResponse = await fetch(baseUrl + "/api/workspace/memory/" + createdMemory.id, {
            method: "DELETE",
            headers: { "Origin": baseUrl, "X-Ari-CSRF": "test-csrf" }
        });
        assert.equal(deletedMemoryResponse.status, 200);
        assert.equal((await fetch(baseUrl + "/api/workspace/memory").then(response => response.json())).memories.length, 0);

        const invalidWorkspace = await fetch(baseUrl + "/api/workspace/chats", {
            method: "PUT",
            headers: {
                "Content-Type": "application/json",
                "Origin": baseUrl,
                "X-Ari-CSRF": "test-csrf"
            },
            body: JSON.stringify({ chats: null })
        });
        assert.equal(invalidWorkspace.status, 400);

        const health = await fetch(baseUrl + "/api/health");
        assert.equal(health.status, 200);
        const healthBody = await health.json();
        assert.equal(healthBody.ok, true);
        assert.equal(healthBody.aiModelConnected, false);
        assert.equal(healthBody.gpu.connected, false);
        assert.equal(healthBody.gpu.ready, false);
        assert.equal(JSON.stringify(healthBody).includes("wordNetAvailable"), false);

        const chat = await fetch(baseUrl + "/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: "1 + 1" })
        });
        assert.equal(chat.status, 200);
        const chatBody = await chat.json();
        assert.equal(chatBody.reply, "2");
        assert.match(chatBody.mode, /no AI API/i);

        const greetingChat = await fetch(baseUrl + "/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: "Hi Ari" })
        });
        assert.equal(greetingChat.status, 200);
        assert.match((await greetingChat.json()).reply, /Hi!/);

        const creatorQuestion = await fetch(baseUrl + "/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: "Who created you?", tier: "medium" })
        });
        assert.equal(creatorQuestion.status, 200);
        assert.equal((await creatorQuestion.json()).reply, "I'm Ari, an AI assistant created by Zorex AI.");

        const empty = await fetch(baseUrl + "/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: "   " })
        });
        assert.equal(empty.status, 400);

        console.log("PASS: Ari playground serves persistent history and handles local arithmetic and greetings over HTTP.");
    } finally {
        await new Promise(resolve => app.close(resolve));
        fs.rmSync(workspaceDirectory, { recursive: true, force: true });
    }
    const modelCalls = [];
    const modelApp = createTestServer({
        modelClient: {
            async health() {
                return { connected: true, model: "Ari-0 BPE v3", mode: "fine-tuned", step: 500, parameters: 1874688 };
            },
            async generate(messages) {
                modelCalls.push(messages);
                return { reply: "Generated by our v3 checkpoint.", model: "Ari-0 BPE v3", step: 500 };
            }
        }
    });
    await new Promise((resolve, reject) => {
        modelApp.once("error", reject);
        modelApp.listen(0, HOST, resolve);
    });

    try {
        const baseUrl = `http://${HOST}:${modelApp.address().port}`;
        const health = await (await fetch(baseUrl + "/api/health")).json();
        assert.equal(health.aiModelConnected, true);
        assert.equal(Object.hasOwn(health, "model"), false);
        assert.equal(JSON.stringify(health).includes("Ari-0 BPE v3"), false);

        const response = await fetch(baseUrl + "/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                message: "Hello Ari",
                messages: [
                    { role: "user", content: "Hi there" },
                    { role: "assistant", content: "Hello!" },
                    { role: "user", content: "Hello Ari" }
                ]
            })
        });
        assert.equal(response.status, 200);
        const generated = await response.json();
        assert.equal(generated.reply, "Generated by our v3 checkpoint.");
        assert.equal(generated.mode, "Mini");
        assert.equal(modelCalls.length, 1);
        assert.equal(modelCalls[0].length, 3);
        assert.equal(modelCalls[0][1].role, "assistant");

        const math = await fetch(baseUrl + "/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: "2 + 2" })
        });
        assert.equal((await math.json()).reply, "4");
        assert.equal(modelCalls.length, 1, "deterministic maths should not call the language model");

        const streamed = await fetch(baseUrl + "/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: "Explain gradient descent.", stream: true })
        });
        assert.equal(streamed.status, 200);
        assert.match(streamed.headers.get("content-type"), /text\/event-stream/);
        const streamText = await streamed.text();
        assert.match(streamText, /event: progress/);
        assert.match(streamText, /Understanding your request/);
        assert.match(streamText, /Generating a response/);
        assert.match(streamText, /event: final/);
        assert.match(streamText, /Generated by our v3 checkpoint/);
        assert.doesNotMatch(streamText, /chain.of.thought|private reasoning/i);
        assert.equal(modelCalls.length, 2);

        console.log("PASS: Ari streams safe progress events, stores feedback, and preserves deterministic maths.");
    } finally {
        await new Promise(resolve => modelApp.close(resolve));
    }

    const gpuCalls = [];
    const gpuApp = createTestServer({
        gpuClient: {
            async health() {
                return {
                    configured: true,
                    connected: true,
                    models: { qwen3_4b: { id: "Qwen/Qwen3-4B" } },
                    tiers: { medium: { text_ready: true, model: "Qwen/Qwen3-4B", device: "cuda:1" } },
                    gpus: [{ name: "NVIDIA Tesla T4", device: "cuda:1" }]
                };
            },
            async chat(payload) {
                gpuCalls.push(payload);
                return { reply: "Kaggle response.", model: "Qwen/Qwen3-4B", tier: payload.tier };
            }
        }
    });
    await new Promise((resolve, reject) => {
        gpuApp.once("error", reject);
        gpuApp.listen(0, HOST, resolve);
    });
    try {
        const baseUrl = `http://${HOST}:${gpuApp.address().port}`;
        const health = await (await fetch(baseUrl + "/api/health")).json();
        assert.equal(health.gpu.connected, true);
        assert.equal(health.gpu.ready, true);
        assert.equal(Object.hasOwn(health.gpu, "tiers"), false);
        assert.equal(JSON.stringify(health).includes("Qwen"), false);
        assert.equal(JSON.stringify(health).includes("cuda:1"), false);
        assert.equal(JSON.stringify(health).includes("T4"), false);

        const remote = await fetch(baseUrl + "/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                message: "Explain photosynthesis.",
                tier: "medium",
                messages: [{ role: "user", content: "Explain photosynthesis." }],
                image: null,
                options: { thinking: false, max_new_tokens: 32 }
            })
        });
        assert.equal(remote.status, 200);
        const remoteBody = await remote.json();
        assert.equal(remoteBody.reply, "Kaggle response.");
        assert.equal(remoteBody.mode, "Medium");
        assert.equal(JSON.stringify(remoteBody).includes("Qwen"), false);
        assert.equal(gpuCalls[0].tier, "medium");
        assert.equal(gpuCalls[0].messages.length, 1);
        assert.equal(gpuCalls[0].options.thinking, false);
        assert.equal(Object.hasOwn(await (await fetch(baseUrl + "/api/health")).json(), "model"), false);

        const thinkingResponse = await fetch(baseUrl + "/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                message: "Compare these two ideas carefully.",
                tier: "medium",
                options: { thinking: true, max_new_tokens: 1024 }
            })
        });
        assert.equal(thinkingResponse.status, 200);
        assert.equal(gpuCalls[1].options.thinking, true);
        assert.equal(gpuCalls[1].options.max_new_tokens, 1024);

        const imageBytes = Buffer.from("mock-image").toString("base64");
        const remoteImage = await fetch(baseUrl + "/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                message: "What is in this image?",
                tier: "ultra",
                messages: [{ role: "user", content: "What is in this image?" }],
                image: { mime_type: "image/png", data_base64: imageBytes },
                options: { thinking: false, max_new_tokens: 32 }
            })
        });
        assert.equal(remoteImage.status, 200);
        assert.equal(gpuCalls[2].tier, "ultra");
        assert.equal(gpuCalls[2].image.mime_type, "image/png");

        const unsupportedImage = await fetch(baseUrl + "/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                message: "What is in this image?",
                tier: "mini",
                messages: [{ role: "user", content: "What is in this image?" }],
                image: { mime_type: "image/png", data_base64: imageBytes }
            })
        });
        assert.equal(unsupportedImage.status, 400);

        const noGpuApp = createTestServer();
        await new Promise((resolve, reject) => {
            noGpuApp.once("error", reject);
            noGpuApp.listen(0, HOST, resolve);
        });
        try {
            const response = await fetch(`http://${HOST}:${noGpuApp.address().port}/api/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    message: "Explain photosynthesis.",
                    tier: "medium",
                    messages: [{ role: "user", content: "Explain photosynthesis." }]
                })
            });
            assert.equal(response.status, 503);
            assert.match((await response.json()).error, /primary model and text backup are both unavailable/i);
        } finally {
            await new Promise(resolve => noGpuApp.close(resolve));
        }

        const failureApp = createTestServer({
            gpuClient: {
                async health() { return { configured: true, connected: false, tiers: {} }; },
                async chat() {
                    const error = new Error("Qwen failed at https://secret-tunnel.trycloudflare.com with private details");
                    error.statusCode = 502;
                    error.code = "GPU_HTTP_500";
                    throw error;
                }
            }
        });
        await new Promise((resolve, reject) => {
            failureApp.once("error", reject);
            failureApp.listen(0, HOST, resolve);
        });
        const originalConsoleError = console.error;
        console.error = () => {};
        try {
            const response = await fetch(`http://${HOST}:${failureApp.address().port}/api/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ message: "hello", tier: "medium" })
            });
            const failure = await response.json();
            assert.equal(response.status, 503);
            assert.match(failure.error, /primary model and text backup are both unavailable/i);
            assert.equal(JSON.stringify(failure).includes("Qwen"), false);
            assert.equal(JSON.stringify(failure).includes("trycloudflare"), false);
        } finally {
            console.error = originalConsoleError;
            await new Promise(resolve => failureApp.close(resolve));
        }

        const defaultMini = await fetch(baseUrl + "/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: "1 + 1" })
        });
        assert.equal((await defaultMini.json()).reply, "2");
        assert.equal(gpuCalls.length, 3);
        console.log("PASS: Ari routes selected GPU tiers independently and preserves Mini and local maths.");
    } finally {
        await new Promise(resolve => gpuApp.close(resolve));
    }

    const directClient = new AriGpuClient({
        env: { ARI_GPU_BASE_URL: "https://fixture.trycloudflare.com", ARI_GPU_API_KEY: "fixture-secret" },
        fetchImpl: async url => {
            if (url.endsWith("/health")) {
                return new Response(JSON.stringify({ status: "ok", models: {}, tiers: { medium: { text_ready: true } }, gpus: [] }), { status: 200 });
            }
            return new Response(JSON.stringify({ ok: true, tier: "medium", answer: "ARI CONNECTION OK" }), { status: 200 });
        }
    });
    const browserPathApp = createTestServer({ gpuClient: directClient });
    await new Promise((resolve, reject) => {
        browserPathApp.once("error", reject);
        browserPathApp.listen(0, HOST, resolve);
    });
    try {
        const response = await fetch(`http://${HOST}:${browserPathApp.address().port}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: "Say the connection is okay.", tier: "medium" })
        });
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.reply, "ARI CONNECTION OK");
        assert.equal(result.mode, "Medium");
        assert.equal(JSON.stringify(result).includes("Qwen"), false);
        console.log("PASS: Browser chat route accepts the verified Kaggle answer response shape.");
    } finally {
        await new Promise(resolve => browserPathApp.close(resolve));
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
