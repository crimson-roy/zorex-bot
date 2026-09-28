// lib/documentReader.js
//
// Azure Document Intelligence reader for Zorex.
//
// Default credentials reuse the existing Azure AI resource:
//   AZURE_DOCUMENT_ENDPOINT || AZURE_AI_ENDPOINT
//   AZURE_DOCUMENT_KEY      || AZURE_AI_KEY
//
// Uses Document Intelligence v4.0 (2024-11-30) prebuilt-read.
// Supported cloud extraction includes PDF, DOCX, XLSX, PPTX, HTML,
// JPEG/PNG/BMP/TIFF/HEIF. Plain text-like files are decoded locally.

"use strict";

const API_VERSION =
    "2024-11-30";

const ENDPOINT =
    String(
        process.env.AZURE_DOCUMENT_ENDPOINT ||
        process.env.AZURE_AI_ENDPOINT ||
        ""
    ).replace(/\/+$/, "");

const KEY =
    process.env.AZURE_DOCUMENT_KEY ||
    process.env.AZURE_AI_KEY;

const REQUEST_TIMEOUT_MS =
    Number(
        process.env.AZURE_DOCUMENT_TIMEOUT_MS ||
        90000
    );

const POLL_INTERVAL_MS =
    1000;

const LOCAL_TEXT_MIME_TYPES =
    new Set([
        "text/plain",
        "text/csv",
        "text/markdown",
        "text/html",
        "application/json",
        "application/xml",
        "text/xml"
    ]);

const LOCAL_TEXT_EXTENSIONS =
    new Set([
        ".txt",
        ".csv",
        ".md",
        ".markdown",
        ".json",
        ".xml"
    ]);

const AZURE_DOCUMENT_MIME_TYPES =
    new Set([
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "text/html",
        "image/jpeg",
        "image/png",
        "image/bmp",
        "image/tiff",
        "image/heif"
    ]);

function sleep(ms) {
    return new Promise(
        resolve =>
            setTimeout(
                resolve,
                ms
            )
    );
}

function extensionOf(fileName) {
    const value =
        String(
            fileName ||
            ""
        ).toLowerCase();

    const index =
        value.lastIndexOf(".");

    return index >= 0
        ? value.slice(index)
        : "";
}

function isLocalTextDocument(
    mimeType,
    fileName
) {
    return (
        LOCAL_TEXT_MIME_TYPES.has(
            String(
                mimeType ||
                ""
            ).toLowerCase()
        ) ||
        LOCAL_TEXT_EXTENSIONS.has(
            extensionOf(
                fileName
            )
        )
    );
}

function isAzureDocumentType(
    mimeType,
    fileName
) {
    const mime =
        String(
            mimeType ||
            ""
        ).toLowerCase();

    const ext =
        extensionOf(
            fileName
        );

    if (
        AZURE_DOCUMENT_MIME_TYPES.has(
            mime
        )
    ) {
        return true;
    }

    return [
        ".pdf",
        ".docx",
        ".xlsx",
        ".pptx",
        ".html",
        ".htm",
        ".jpg",
        ".jpeg",
        ".png",
        ".bmp",
        ".tif",
        ".tiff",
        ".heif"
    ].includes(ext);
}

function decodeLocalText(buffer) {
    return Buffer.from(
        buffer
    )
        .toString("utf8")
        .replace(
            /\u0000/g,
            ""
        )
        .trim();
}

async function fetchWithTimeout(
    url,
    options,
    timeoutMs =
        REQUEST_TIMEOUT_MS
) {
    const controller =
        new AbortController();

    const timer =
        setTimeout(
            () =>
                controller.abort(),
            timeoutMs
        );

    try {
        return await fetch(
            url,
            {
                ...options,
                signal:
                    controller.signal
            }
        );
    } finally {
        clearTimeout(
            timer
        );
    }
}

async function readWithAzure(
    buffer,
    mimeType
) {
    if (!ENDPOINT) {
        throw new Error(
            "AZURE_DOCUMENT_ENDPOINT/AZURE_AI_ENDPOINT is not set."
        );
    }

    if (!KEY) {
        throw new Error(
            "AZURE_DOCUMENT_KEY/AZURE_AI_KEY is not set."
        );
    }

    const url =
        `${ENDPOINT}/documentintelligence/documentModels/prebuilt-read:analyze?api-version=${API_VERSION}&outputContentFormat=markdown`;

    const response =
        await fetchWithTimeout(
            url,
            {
                method:
                    "POST",
                headers: {
                    "Content-Type":
                        mimeType ||
                        "application/octet-stream",
                    "Ocp-Apim-Subscription-Key":
                        KEY
                },
                body:
                    buffer
            }
        );

    if (
        response.status !== 202 &&
        !response.ok
    ) {
        const errorText =
            await response
                .text()
                .catch(
                    () => ""
                );

        throw new Error(
            `Azure Document Intelligence error ${response.status}: ${errorText}`
        );
    }

    const operationLocation =
        response.headers.get(
            "operation-location"
        ) ||
        response.headers.get(
            "Operation-Location"
        );

    if (!operationLocation) {
        throw new Error(
            "Azure Document Intelligence returned no operation-location header."
        );
    }

    const deadline =
        Date.now() +
        REQUEST_TIMEOUT_MS;

    while (
        Date.now() <
        deadline
    ) {
        await sleep(
            POLL_INTERVAL_MS
        );

        const poll =
            await fetchWithTimeout(
                operationLocation,
                {
                    method:
                        "GET",
                    headers: {
                        "Ocp-Apim-Subscription-Key":
                            KEY
                    }
                },
                Math.min(
                    30000,
                    REQUEST_TIMEOUT_MS
                )
            );

        if (!poll.ok) {
            const errorText =
                await poll
                    .text()
                    .catch(
                        () => ""
                    );

            throw new Error(
                `Azure Document Intelligence poll error ${poll.status}: ${errorText}`
            );
        }

        const data =
            await poll.json();

        const status =
            String(
                data.status ||
                ""
            ).toLowerCase();

        if (
            status === "succeeded"
        ) {
            const content =
                String(
                    data.analyzeResult
                        ?.content ||
                    ""
                ).trim();

            if (!content) {
                throw new Error(
                    "Azure Document Intelligence found no readable text."
                );
            }

            return {
                text:
                    content,
                pages:
                    data.analyzeResult
                        ?.pages ||
                    [],
                paragraphs:
                    data.analyzeResult
                        ?.paragraphs ||
                    []
            };
        }

        if (
            status === "failed"
        ) {
            const message =
                data.error
                    ?.message ||
                data.analyzeResult
                    ?.errors?.[0]
                    ?.message ||
                "document analysis failed";

            throw new Error(
                `Azure Document Intelligence failed: ${message}`
            );
        }
    }

    throw new Error(
        "Azure Document Intelligence timed out."
    );
}

async function readDocument(
    buffer,
    {
        mimeType = "",
        fileName = ""
    } = {}
) {
    if (!Buffer.isBuffer(buffer)) {
        throw new Error(
            "Document input must be a Buffer."
        );
    }

    if (
        isLocalTextDocument(
            mimeType,
            fileName
        )
    ) {
        const text =
            decodeLocalText(
                buffer
            );

        if (!text) {
            throw new Error(
                "The text document is empty or unreadable."
            );
        }

        return {
            text,
            source:
                "local-text"
        };
    }

    if (
        !isAzureDocumentType(
            mimeType,
            fileName
        )
    ) {
        throw new Error(
            `Unsupported document type: ${mimeType || extensionOf(fileName) || "unknown"}`
        );
    }

    const result =
        await readWithAzure(
            buffer,
            mimeType ||
            "application/octet-stream"
        );

    return {
        ...result,
        source:
            "azure-document-intelligence"
    };
}

module.exports = {
    readDocument,
    isLocalTextDocument,
    isAzureDocumentType
};
