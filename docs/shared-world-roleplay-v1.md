# Shared-world roleplay v1

## Intent

A shared world exists inside one WhatsApp group. Human participants speak as themselves. Each accepted member brings one selected NPC companion. The creator's world is the continuity foundation; guests do not bring private companion transcripts into the group.

## Commands

- .character list — show configured companions.
- .character status — show the current companion.
- .character select <name> — select a companion; existing users default to Chloe.
- .chat join @user — the creator starts a pending world invitation by tagging one person in the group.
- .chat join accept — the intended tagged user accepts.
- .chat add @user — creator-only invite into an active world; acceptance required.
- .chat members / .chat status — membership and status.
- .chat exit — a non-owner member leaves.
- .chat disband — creator-only world deletion.
- .chat seed private — preview the most recent messages in the creator's own private Chloe thread.
- .chat seed private confirm — explicitly share the previewed snapshot with the world's model context.
- .chat seed private cancel — cancel a pending preview.

Invitations expire after 10 minutes. A user can belong to only one world at a time. A character choice is locked while the user is a member; the creator is also locked while their initial invitation is pending. The creator cannot exit their own world. A world is removed when the creator has been inactive for 30 days; expiry is enforced when shared-world state is next accessed.

## Access and character rules

Free creators get a two-human-member capacity. A creator with an active Standard, Pro, or Ultra subscription gets capacity up to five. The current registry contains Chloe and a provisional Crescent starter profile only. Because each world requires unique companion assignments, only two distinct-companion members can join until more approved companion profiles are added.

lib/subscriptionStore.js provides lookup and explicit set/revoke helpers, but does not implement .sus, payment verification, or owner activation yet. All users default to Free until an active subscription record is added by a later, trusted activation workflow.

## Message and memory rules

- Only accepted world members' ordinary messages enter the shared world or trigger NPC roleplay. Other people in the WhatsApp group can watch but their messages cannot affect the story.
- Normal group messages from world members can trigger a scene turn; they don't need .chat say.
- The AI selects which present NPCs are relevant and emits one WhatsApp message with separately labelled NPC actions/dialogue.
- The prompt prohibits generating human users' actions, speech, thoughts, or emotions; NPCs control only themselves. An NPC not assigned to a world member does not appear automatically.
- A world reply is serialized per world. The full event history remains stored until the world is disbanded; only recent events are fed to the model per turn to bound prompt size.
- For privacy, the creator's private Chloe DMs are never imported automatically. The creator can use a two-step flow in the world group: preview with .chat seed private, then explicitly confirm with .chat seed private confirm within two minutes. The preview exposes only a message count; it does not display or copy message contents. Confirmation snapshots at most the eight latest messages from the creator's own DM thread into a separate creator-approved story-seed field. Guest DMs and unrelated group messages are never included. This is a one-time snapshot, so later DMs remain private unless the creator repeats the flow.
- Random illustration generation, home/family scene rendering, and subscription-based image quotas are later stages, not implemented in this branch.

## Validation

The automated test test/sharedWorld.test.js checks identity alias ordering, default character, duplicate-companion rejection, invitation/acceptance, character locking, observer isolation, owner-only disband, member exit, creator inactivity expiry, free/paid member-limit lookup, and explicit creator-only private-story import. .github/workflows/shared-world-tests.yml runs Node 20 syntax checks and this test without installing dependencies; this project currently has a pre-existing mismatch between package.json and package-lock.json.

## Pre-public-launch checklist

1. Approve and add three more distinct NPC profiles; do not invent their canon.
2. Decide how a creator explicitly shares the relevant, minimal parts of a private companion story without leaking unrelated DMs.
3. Implement trusted .sus subscription activation/payment verification; the current subscription helper is not a payment system.
4. Add output validation/redrafting to further guard against the model narrating human actions.
5. Run a live WhatsApp staging test for Baileys mention/LID behaviour and verify moderation, ordinary commands, games, and observer messages still route correctly.