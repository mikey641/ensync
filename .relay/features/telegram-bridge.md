---
name: Telegram bridge
description: Secure remote chat access through a paired private bot.
---

# Telegram bridge

Telegram is an alternate client for Ensync Host. It is never an independent model transport and never makes direct model API calls.

`host/telegram.mjs` implements the Telegram Bot API transport. Setup verifies a BotFather token with `getMe`, then keeps the token only in host process memory. Ensync does not claim encrypted storage: disconnect and host restart forget the token, and BotFather remains the only place to rotate or revoke the bot token. The token must never be logged, persisted as plaintext, or returned through host status or error responses.

Pairing uses a cryptographically random, short-lived code. The host long-polls `getUpdates` with an abort signal, an advancing update offset, and an allowlist containing only `message` and `callback_query`. Only `/pair CODE` from a private, non-bot account can bind a connection. The binding records exactly one Telegram user ID and private chat ID; every other sender and chat is rejected. Status can report a host-issued connection ID, confirmation timestamp, bot identity, and paired account identity only after this exchange succeeds. Bot API behavior follows [Telegram's official Bot API](https://core.telegram.org/bots/api).

Real outbound delivery uses `sendMessage` to the bound chat only. There is no host method that accepts an arbitrary Telegram chat ID. Local disconnect clears polling, connection state, pending approvals, task context, and the in-memory token. The UI must describe this as a local revoke, not claim that the BotFather token was rotated.

Each accepted ordinary message resolves an exact selected project ID, project label/path, Ensync conversation ID, provider, and local-or-verified-SSH execution target. It creates a pending approval showing those fields plus the complete action and expiry. Approve/reject callback payloads stay inside Telegram's 64-byte `callback_data` limit, are HMAC-authenticated, allowlisted against a live approval, bound to the paired account/chat and originating message, one-shot, and expiry-enforced. Callback queries are always answered so Telegram does not leave a progress indicator active.

Approval invokes only the Ensync subscription chat router using this contract: `source`, `connectionId`, `approvalId`, `approvedAt`, `approvedByTelegramUserId`, `projectId`, `projectPath`, `conversationId`, `provider`, `prompt`, the optional validated `executionTarget`, `approvalScope: task_start_only`, `toolApprovalMode: host_required`, and `safeFallback: host_router_pre_mutation_only`. The task-start approval never grants later destructive tool calls. The router owns bounded in-memory transcript/session continuity and safe automatic fallback. When the selected target is SSH, both the first run and fallback remain on that verified worker. If no runner is connected, the bot says explicitly that nothing executed.

Destructive or high-impact actions never inherit approval from a normal chat message; the bot must show a separate confirmation with project, command/action, and expiry.

The setup UI links directly to Telegram's BotFather flow and asks the user to return with the issued token. Ensync Host mounts real loopback pair, status, context, disconnect, and send routes; `src/telegram-client.ts` defines that contract. `TelegramSetup` clears its browser token state after the host accepts it, displays the pairing command, polls real host status, restores an existing host-confirmed connection, supports real delivery checks, and disconnects through the host. A button click or local timer never produces a paired or connected state; success requires the host connection ID and confirmation timestamp.
