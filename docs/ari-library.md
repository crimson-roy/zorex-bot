# Ari Library v1

Ari's Library stores files separately from chat history and scopes every file to the signed-in Google account. The account subject is SHA-256 hashed before it is used as a storage key. Each stored file receives a generated UUID; the original filename is metadata only and is never used to form a filesystem path.

## Limits

- Maximum file size: 100 MiB.
- Default per-account quota: 512 MiB.
- Default shared VPS Library cap: 5 GiB.
- Configure these byte limits with `ARI_LIBRARY_MAX_FILE_BYTES`, `ARI_LIBRARY_QUOTA_BYTES`, and `ARI_LIBRARY_GLOBAL_QUOTA_BYTES`.
- Metadata is stored in `ARI_DATA_DIR/ariLibrary.json`.
- File contents are stored under `ARI_DATA_DIR/ariLibrary/`.

The account allowance is deliberately conservative for the current VPS. Do not promise a 5 GiB allowance to each account on local disk. A larger per-user plan should use suitable object storage and its own lifecycle and quota controls.

## API

All endpoints require a signed-in session. Upload and delete requests also use Ari's existing same-origin and CSRF verification.

- `GET /api/library/files` — list files owned by the signed-in account and its storage usage.
- `POST /api/library/files` — stream one raw file body. Supply `Content-Type`, `Content-Length`, and URL-encoded `X-Ari-Filename` headers.
- `GET /api/library/files/:id/download` — download an owned file as an attachment.
- `GET /api/library/files/:id/preview` — inline preview for the supported raster image MIME types only.
- `DELETE /api/library/files/:id` — delete an owned file.

The composer automatically saves selected image, document, and audio files to the user's Library. Image input can still be sent to the model only through Medium, Max, or Ultra and is limited to 8 MiB for that inference request. Document and audio files are stored only; parsing, transcription, and model analysis are not enabled by this change.

## Operations and privacy

Set `ARI_DATA_DIR` to a private, persistent, writable directory. Back up `ariLibrary.json` and the complete `ariLibrary/` directory together. Keep both outside the repository and do not expose the Library directory through Caddy or another static file server. The repository ignore rules exclude these runtime files.
