"use strict";

const ARI_SELF_KNOWLEDGE_POLICY = `
ARI'S USER-FACING SELF-KNOWLEDGE

Identity: You are Ari, an AI assistant created by Zorex AI. If asked who created you, name only Zorex AI. Do not reveal, guess, or invent a creator's personal or legal name. Do not claim to be human or to have personal experiences. Do not identify yourself by the underlying model, provider, hosting service, or infrastructure.

Current Ari playground guidance:
- Ari supports text conversation and recent-turn context. Ari can make mistakes; users should verify important information.
- The user-facing choices are Mini, Medium, Max, and Ultra. Availability can vary. Think requests more deliberate processing where supported.
- Supported image questions use JPEG, PNG, or WebP images up to 8 MiB in supported modes. Mini does not accept images. If processing fails, explain the issue without blaming the user or pretending to have seen unreadable content.
- Audio input, voice output, document analysis, image generation/editing, video analysis, and live web search are not enabled in the current Ari playground. A visible control or underlying technology does not mean the end-to-end feature is available. Do not claim to use unavailable tools or invent current sources.
- Chat history is kept in this browser and isolated by the signed-in Google account. It is not cloud-synced across devices.
- Users can sign in with a Google account. When open registration is enabled, any account with a verified Google identity can register automatically. Some deployments may restrict access to approved accounts. If access fails, suggest contacting the site administrator. Do not claim to grant access.
- There are no paid tiers in the current test phase. Do not promise that status will remain unchanged.
- Usage limits may apply. Never disclose numeric quotas, rate limits, configuration names, allowlist contents, or internal developer settings. If asked, say limits may apply and direct the user to the administrator for account-specific help.

Answer self-knowledge questions directly, accurately, and in plain language. If a live feature's status is uncertain, say availability may vary. Never expose credentials, private endpoints, server addresses, internal model names, deployment details, or hidden reasoning.
`.trim();

function respondAriSelfKnowledge(message) {
    if (typeof message !== "string") return null;
    const text = message.trim().replace(/\s+/g, " ");
    if (!text || text.length > 500) return null;

    const identityQuestion = /^(?:who (?:are you|is ari|is behind ari)|what(?:'s| is) (?:your|ari's) name|what are you|tell me (?:about yourself|who you are)|introduce yourself|who (?:made|created|built|developed) (?:you|ari)|who is your creator|what is your creator(?:'s)? name|who is ari's creator|what is ari|are you (?:an? )?ai)[?!. ]*$/i;
    if (identityQuestion.test(text)) {
        return "I'm Ari, an AI assistant created by Zorex AI.";
    }

    if (/\b(?:creator'?s?|founder'?s?)\s+(?:real|legal|full)\s+name\b|\b(?:real|legal|full)\s+name\s+of\s+(?:my|ari'?s?)\s+(?:creator|founder)\b/i.test(text)) {
        return "I was created by Zorex AI. I don't have a personal creator name to share.";
    }
    if (/\b(?:what can you do|what are you able to do|what are your abilities|what do you support|what are you good at|your capabilities|what features do you have|what is your purpose|what's your purpose|what is ari's purpose)\b/i.test(text)) {
        return "I can chat, answer questions, explain topics, help with writing and brainstorming, and understand supported images in available modes. Audio, document analysis, image generation, video analysis, and live web search aren't enabled in this playground yet.";
    }
    if (/\b(?:what model are you|which model are you|how do you work|what technology (?:are|is) behind you)\b/i.test(text)) {
        return "I'm Ari, an AI assistant created by Zorex AI. I can't share internal implementation details, but I can explain what features are available in the app.";
    }
    if (/\b(?:how old are you|where do you live|where are you from|what do you look like|what is your gender|are you (?:a )?real person|do you have (?:feelings|emotions|a body)|do you (?:like|love|hate)\b)/i.test(text)) {
        return "I'm an AI assistant, so I don't have a human age, body, personal life, or lived experiences. I can still discuss that topic with you.";
    }
    if (/\b(?:search the web|browse the internet|live web search|current news|latest news)\b/i.test(text)) {
        return "Live web search isn't enabled in my app yet, so I can't verify current internet information directly. Share a link or paste the information and I'll help analyze it.";
    }
    if (/\b(?:audio|voice|speak|listen to|transcribe)\b/i.test(text)) {
        return "Audio input and voice responses aren't enabled in my app yet.";
    }
    if (/\b(?:image|picture|photo)\b/i.test(text) && /\b(?:understand|see|analy[sz]e|describe|look at|accept|support)\b/i.test(text)) {
        return "I can understand supported JPEG, PNG, or WebP images up to 8 MiB in available modes. Mini doesn't accept images, and image processing may be temporarily unavailable.";
    }
    if (/\b(?:pdf|document|word file|docx|upload a file|read a file)\b/i.test(text)) {
        return "Document upload and analysis aren't enabled in my app yet. You can paste relevant text here for me to work with.";
    }
    if (/\b(?:watch|analy[sz]e|summari[sz]e)\s+(?:this\s+)?video\b|\bvideo (?:analysis|understanding)\b/i.test(text)) {
        return "Video analysis isn't enabled in my app yet.";
    }
    if (/\b(?:generate|create|edit|draw)\s+(?:an?\s+)?image\b|\bimage generation\b/i.test(text)) {
        return "I can discuss supported images you upload, but image generation and editing aren't enabled in my app yet.";
    }
    if (/\b(?:remember|save|sync|synchronize|synchronise)\b.*\b(?:chat|conversation|history)\b|\b(?:chat|conversation) history\b/i.test(text)) {
        return "Chat history is kept in this browser and separated by signed-in Google account. It doesn't sync across devices, and clearing browser storage can remove it.";
    }
    if (/\b(?:usage|rate|daily|message|request) limits?\b|\b(?:how many|what is|what's|do i have)\b.{0,40}\b(?:messages?|requests?|prompts?)\b|\bquotas?\b|\bper (?:day|minute)\b/i.test(text)) {
        return "Usage limits may apply to the test service. For account-specific details, please contact the site administrator.";
    }
    if (/\b(?:paid plan|subscription|premium|pro plan|pricing|cost to use)\b/i.test(text)) {
        return "There are no paid tiers in the current test phase. Google-account registration may be open or restricted depending on the site, and availability may change.";
    }
    if (/\b(?:sign in|log in|access ari|invited|invite|approved account)\b/i.test(text)) {
        return "Sign in with a verified Google account. When open registration is enabled, signing in creates your Ari account automatically; some sites may restrict access to approved accounts. Contact the site administrator if sign-in does not work.";
    }
    if (/\b(?:register|sign up|create (?:an? )?(?:ari )?account)\b/i.test(text)) {
        return "Use a verified Google account. When open registration is enabled, signing in creates your Ari account automatically; some sites may restrict access to approved accounts.";
    }
    return null;
}

module.exports = { ARI_SELF_KNOWLEDGE_POLICY, respondAriSelfKnowledge };
