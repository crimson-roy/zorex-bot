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
- For privacy, v1 seeds the world from the creator's recent Chloe memory in the same group only. It does not import creator or guest DMs, and it never imports a guest's private history. If the creator's established story currently exists only in a private chat, it is not automatically carried into the world in v1 and needs an explicit, privacy-safe story-seed flow before public release.
- Random illustration generation, home/family scene rendering, and subscription-based image quotas are later stages, not implemented in this branch.

## Validation

The automated test test/sharedWorld.test.js checks identity alias ordering, default character, duplicate-companion rejection, invitation/acceptance, character locking, observer isolation, owner-only disband, member exit, creator inactivity expiry, and free/paid member-limit lookup. .github/workflows/shared-world-tests.yml runs Node 20 syntax checks and this test without installing dependencies; this project currently has a pre-existing mismatch between package.json and package-lock.json.

## Pre-public-launch checklist

1. Approve and add three more distinct NPC profiles; do not invent their canon.
2. Decide how a creator explicitly shares the relevant, minimal parts of a private companion story without leaking unrelated DMs.
3. Implement trusted .sus subscription activation/payment verification; the current subscription helper is not a payment system.
4. Add output validation/redrafting to further guard against the model narrating human actions.
5. Run a live WhatsApp staging test for Baileys mention/LID behaviour and verify moderation, ordinary commands, games, and observer messages still route correctly.