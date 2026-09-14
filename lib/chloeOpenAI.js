// Dedicated OpenAI client for Chloe.
// Keeps Chloe separate from Zorex's other AI commands/providers.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";

async function callAI(systemPrompt, messages) {
    if (!OPENAI_API_KEY) {
        throw new Error(
            "OPENAI_API_KEY is not set. Add it to your .env file."
        );
    }

    const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: OPENAI_MODEL,
                max_completion_tokens: 800,
                messages: [
                    {
                        role: "developer",
                        content: systemPrompt
                    },
                    ...messages.map(m => ({
                        role: m.role,
                        content: m.content
                    }))
                ]
            })
        }
    );

    if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(
            `OpenAI API error ${response.status}: ${errText}`
        );
    }

    const data = await response.json();

    const text =
        data.choices?.[0]?.message?.content;

    return text ? text.trim() : "...";
}

module.exports = { callAI };
