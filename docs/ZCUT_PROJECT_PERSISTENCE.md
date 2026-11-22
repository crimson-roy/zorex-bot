# Z_Cut project persistence

## Storage model

- The browser keeps local recovery copies in IndexedDB, with a localStorage fallback.
- Signed-in Ari users can sync project JSON and media-reference metadata to their Zorex account through `/api/workspace/zcut-projects`.
- Cloud sync never uploads source video, audio, or image bytes.
- A `.zcut` file is a portable JSON project. The normal export contains project structure and media references only. The optional **Export with media** action embeds source files in the package (250 MB client-side cap).
- On another device, opening a project shows its media references. Use **Relink media** to select the original files. Exact filename matches are linked automatically; when only one item is missing, the selected file can be linked to it even if renamed.

## API

All routes are same-origin and scoped to the authenticated Ari account.

- `GET /api/workspace/zcut-projects` — list project summaries.
- `PUT /api/workspace/zcut-projects` — create or replace one project. Requires the Ari CSRF header.
- `GET /api/workspace/zcut-projects/:id` — fetch one project.
- `DELETE /api/workspace/zcut-projects/:id` — delete one project. Requires the Ari CSRF header.

The server stores project metadata under the configured Ari data directory in `zcutProjects/`, using a SHA-256 account filename and restrictive file permissions. Current limits are 50 projects per account, 2 MiB per project and 8 MiB per account.

## Recovery and navigation

- Meaningful edits schedule an autosave after a short debounce; a 60-second interval is a backup.
- Local recovery remains available when the account is signed out or the network is unavailable.
- The Projects panel lists local recovery copies and cloud projects.
- Returning to Ari prompts when edits are still pending.
- Timeline zoom has buttons, Ctrl/Command + wheel, and two-finger pinch zoom. The Fit button frames the current composition duration.

## Browser file access

The project save action requests a destination through `showSaveFilePicker` when the browser supports it. Otherwise it falls back to a standard download. Import and media relinking use explicit browser file pickers; the editor does not receive silent, unrestricted filesystem access.
