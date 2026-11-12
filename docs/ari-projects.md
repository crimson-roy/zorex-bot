# Ari Projects v1

Projects are account-scoped workspaces stored in the existing private `ariWorkspace.json` data file. Project records and chats are stored together under the account's hashed key.

## Project behaviour

- A signed-in account can create up to 100 projects.
- Project names are required and limited to 80 characters.
- Descriptions are optional and limited to 500 characters.
- Conversations carry a nullable `projectId`.
- The sidebar's Recent Chats list excludes conversations with a project ID.
- Opening a project shows only its conversations and provides a New project chat action.
- The sidebar's global New Chat action always starts a general conversation.
- Deleting a project does not delete its conversations. They are reassigned to general history so no conversation is silently lost.

Existing workspace records remain compatible: chats without a project ID are normalized as general conversations.

## API

All endpoints require a signed-in session. Create, update and delete requests use the existing same-origin and CSRF checks.

- `GET /api/workspace/projects` — list projects belonging to the current account.
- `POST /api/workspace/projects` — create a project using JSON `name` and optional `description`.
- `PATCH /api/workspace/projects/:id` — update the project name and/or description.
- `DELETE /api/workspace/projects/:id` — remove the project and move its chats to general history.

Project identifiers are generated UUIDs. A chat cannot be saved with a project identifier that does not belong to its account.
