import fs from "node:fs";
import path from "node:path";
const CARD_PREVIEW_CHARS = 1200;
const FULL_CHUNK_CHARS = 3500;
const PENDING_REPLY_TTL_MS = 5 * 60 * 1000;
const MAX_CARDS = 400;
const MAX_SESSION_BUTTONS = 10;
const CALLBACK_PREFIX = "ls:";
const TERMINAL_STATUSES = new Set(["completed", "failed", "stopped"]);
function escapeHtml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}
function shortRef(seed) {
    let hash = 0;
    for (let i = 0; i < seed.length; i += 1) {
        hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(36).padStart(7, "0").slice(0, 7);
}
function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0)
        return "—";
    const totalSec = Math.round(ms / 1000);
    if (totalSec < 60)
        return `${totalSec}s`;
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec % 60;
    if (minutes < 60)
        return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remMin = minutes % 60;
    return remMin ? `${hours}h ${remMin}m` : `${hours}h`;
}
function runnerLabel(runner) {
    if (runner === "claude")
        return "Claude";
    if (runner === "cursor")
        return "Cursor";
    return "Codex";
}
function statusMeta(status) {
    if (status === "completed")
        return { emoji: "✅", label: "completed" };
    if (status === "failed")
        return { emoji: "❌", label: "failed" };
    return { emoji: "⏹", label: "stopped" };
}
function statusEmoji(status) {
    if (status === "completed")
        return "✅";
    if (status === "failed")
        return "❌";
    if (status === "running")
        return "🔄";
    if (status === "queued")
        return "📥";
    return "⏸️";
}
/** Keep Telegram inline buttons visually full-width (trailing spaces are trimmed). */
function padButtonLabel(label, width = 36) {
    const chars = Array.from(label);
    if (chars.length > width) {
        return `${chars.slice(0, Math.max(1, width - 1)).join("")}…`;
    }
    if (chars.length >= width)
        return chars.join("");
    return `${label}${"\u00A0".repeat(width - chars.length)}`;
}
function displaySessionTitle(title, sessionId, collidingTitles) {
    const base = title.replace(/\s+/g, " ").trim() || "Session";
    if (!collidingTitles.has(base.toLowerCase()))
        return base;
    const shortId = sessionId.replace(/-/g, "").slice(0, 6);
    return `${base} · ${shortId}`;
}
function truncateText(text, maxChars) {
    const normalized = text.replace(/\s+$/g, "").trim();
    if (normalized.length <= maxChars)
        return { text: normalized, truncated: false };
    const slice = normalized.slice(0, maxChars);
    const breakAt = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
    const cut = breakAt > maxChars * 0.6 ? slice.slice(0, breakAt) : slice;
    return { text: `${cut.trimEnd()}\n…`, truncated: true };
}
function truncateButtonLabel(title, maxLen = 58) {
    const collapsed = title.replace(/\s+/g, " ").trim() || "Session";
    if (collapsed.length <= maxLen)
        return collapsed;
    return `${collapsed.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}
function receiveStateKey(chatId, threadId) {
    return threadId ? `${chatId}:${threadId}` : `${chatId}:*`;
}
function sanitizeDownloadedFileName(name) {
    const cleaned = name.replace(/[^\w.\- ()[\]]+/g, "_").trim() || "telegram-file";
    return cleaned.slice(0, 180);
}
function toCardStatus(status) {
    if (status === "failed")
        return "failed";
    if (status === "stopped")
        return "stopped";
    return "completed";
}
export function isSessionTelegramBridgeConfigured() {
    return Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim()
        && process.env.TELEGRAM_CHAT_ID?.trim()
        && process.env.TELEGRAM_SESSIONS_THREAD_ID?.trim());
}
export function createSessionTelegramBridge(deps) {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
    const chatId = String(process.env.TELEGRAM_CHAT_ID || "").trim();
    const sessionsThreadId = String(process.env.TELEGRAM_SESSIONS_THREAD_ID || "").trim();
    const apiBase = (process.env.TELEGRAM_API_BASE || "https://api.telegram.org").trim().replace(/\/+$/, "");
    const allowedUserIds = new Set((process.env.TELEGRAM_ALLOWED_USER_IDS || "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean));
    const stateDir = path.join(deps.rootDir, "data", "telegram-mcp");
    const mappingPath = path.join(stateDir, "session-bridge.json");
    const receiveStatePath = process.env.TELEGRAM_RECEIVE_STATE_PATH
        || path.join(stateDir, "receive-state.json");
    const ownerPath = path.join(stateDir, "updates-owner.json");
    let mapping = loadMapping();
    const pendingReplies = new Map();
    const notifiedRunIds = new Set();
    let pollTimer = null;
    let polling = false;
    let stopped = false;
    let started = false;
    function loadMapping() {
        try {
            if (!fs.existsSync(mappingPath)) {
                return { version: 1, cardsByRef: {}, messageIdToRef: {}, sessionPickerRefs: {} };
            }
            const parsed = JSON.parse(fs.readFileSync(mappingPath, "utf8"));
            if (!parsed || parsed.version !== 1 || typeof parsed.cardsByRef !== "object") {
                return { version: 1, cardsByRef: {}, messageIdToRef: {}, sessionPickerRefs: {} };
            }
            return {
                version: 1,
                cardsByRef: parsed.cardsByRef || {},
                messageIdToRef: parsed.messageIdToRef || {},
                sessionPickerRefs: parsed.sessionPickerRefs || {},
            };
        }
        catch {
            return { version: 1, cardsByRef: {}, messageIdToRef: {}, sessionPickerRefs: {} };
        }
    }
    function persistMapping() {
        fs.mkdirSync(stateDir, { recursive: true });
        const refs = Object.values(mapping.cardsByRef).sort((a, b) => b.createdAt - a.createdAt);
        if (refs.length > MAX_CARDS) {
            const keep = new Set(refs.slice(0, MAX_CARDS).map((card) => card.ref));
            const nextCards = {};
            const nextMessageMap = {};
            for (const card of refs) {
                if (!keep.has(card.ref))
                    continue;
                nextCards[card.ref] = card;
            }
            for (const [messageId, ref] of Object.entries(mapping.messageIdToRef)) {
                if (keep.has(ref))
                    nextMessageMap[messageId] = ref;
            }
            mapping = {
                version: 1,
                cardsByRef: nextCards,
                messageIdToRef: nextMessageMap,
                sessionPickerRefs: mapping.sessionPickerRefs,
            };
        }
        fs.writeFileSync(mappingPath, `${JSON.stringify(mapping, null, 2)}\n`, "utf8");
    }
    function claimUpdatesOwnership() {
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(ownerPath, `${JSON.stringify({
            owner: "server-session-bridge",
            pid: process.pid,
            claimedAt: new Date().toISOString(),
            sessionsThreadId,
        }, null, 2)}\n`, "utf8");
    }
    function releaseUpdatesOwnership() {
        try {
            if (!fs.existsSync(ownerPath))
                return;
            const parsed = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
            if (parsed.owner === "server-session-bridge" && parsed.pid === process.pid) {
                fs.unlinkSync(ownerPath);
            }
        }
        catch {
            // ignore
        }
    }
    async function callTelegram(method, body) {
        const response = await fetch(`${apiBase}/bot${token}/${method}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body || {}),
        });
        let payload;
        try {
            payload = (await response.json());
        }
        catch (error) {
            throw new Error(`Telegram ${method} returned non-JSON (HTTP ${response.status}): ${String(error)}`);
        }
        if (!response.ok || !payload.ok || payload.result === undefined) {
            throw new Error(payload.description || `Telegram ${method} failed (HTTP ${response.status})`);
        }
        return payload.result;
    }
    function isAllowedUser(userId) {
        if (!userId)
            return false;
        if (allowedUserIds.size === 0)
            return true;
        return allowedUserIds.has(String(userId));
    }
    function pendingKey(userId) {
        return `${chatId}:${userId}`;
    }
    function rememberCard(card) {
        mapping.cardsByRef[card.ref] = card;
        if (card.telegramMessageId != null) {
            mapping.messageIdToRef[String(card.telegramMessageId)] = card.ref;
        }
        persistMapping();
    }
    function cardByMessageId(messageId) {
        if (messageId == null)
            return null;
        const ref = mapping.messageIdToRef[String(messageId)];
        if (!ref)
            return null;
        return mapping.cardsByRef[ref] || null;
    }
    function buildKeyboard(card, truncated) {
        const row1 = [
            { text: "💬 Reply", callback_data: `${CALLBACK_PREFIX}r:${card.ref}` },
        ];
        if (truncated || card.fullText.length > CARD_PREVIEW_CHARS) {
            row1.push({ text: "📄 Full", callback_data: `${CALLBACK_PREFIX}f:${card.ref}` });
        }
        if (card.runId && card.runId !== "none") {
            row1.push({ text: "🔁 Rerun", callback_data: `${CALLBACK_PREFIX}u:${card.ref}` });
        }
        const rows = [row1];
        if (deps.webBaseUrl) {
            const url = `${deps.webBaseUrl.replace(/\/+$/, "")}/?session=${encodeURIComponent(card.sessionId)}`;
            rows.push([{ text: "🌐 Open in Luma", url }]);
        }
        return { inline_keyboard: rows };
    }
    function buildCardText(args) {
        const meta = statusMeta(args.status);
        const section = args.status === "failed" ? "What went wrong" : "Latest reply";
        const body = args.body.trim()
            ? escapeHtml(args.body)
            : "<i>No message body.</i>";
        const truncNote = args.truncated ? "\n<i>Truncated — tap Full for the rest.</i>" : "";
        const shortId = args.sessionId.length > 12 ? `${args.sessionId.slice(0, 8)}…` : args.sessionId;
        return [
            `${meta.emoji}  <b>${escapeHtml(args.title)}</b>`,
            `${escapeHtml(runnerLabel(args.runner))} · ${meta.label}${args.durationLabel ? ` · ${escapeHtml(args.durationLabel)}` : ""}${args.sourceHint ? ` · ${escapeHtml(args.sourceHint)}` : ""}`,
            "",
            `<b>${section}</b>`,
            "────────────",
            body,
            truncNote,
            "",
            `<code>session · ${escapeHtml(shortId)}</code>`,
        ].filter((line, index, arr) => !(line === "" && arr[index - 1] === "")).join("\n");
    }
    async function sendSessionsMessage(args) {
        const threadNumeric = Number(sessionsThreadId);
        const payload = {
            chat_id: chatId,
            message_thread_id: Number.isFinite(threadNumeric) ? threadNumeric : sessionsThreadId,
            text: args.text.slice(0, 4096),
            parse_mode: "HTML",
            disable_web_page_preview: true,
        };
        if (args.disableNotification !== undefined)
            payload.disable_notification = args.disableNotification;
        if (args.replyMarkup)
            payload.reply_markup = args.replyMarkup;
        if (args.replyToMessageId != null)
            payload.reply_to_message_id = args.replyToMessageId;
        return callTelegram("sendMessage", payload);
    }
    async function answerCallback(callbackQueryId, text) {
        await callTelegram("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: text?.slice(0, 200),
            show_alert: false,
        });
    }
    async function readReceiveState() {
        try {
            if (!fs.existsSync(receiveStatePath)) {
                return { version: 1, last_candidates: {}, last_saved_files: {} };
            }
            const parsed = JSON.parse(await fs.promises.readFile(receiveStatePath, "utf8"));
            if (!parsed || parsed.version !== 1) {
                return { version: 1, last_candidates: {}, last_saved_files: {} };
            }
            return {
                version: 1,
                next_update_offset: parsed.next_update_offset,
                last_candidates: parsed.last_candidates || {},
                last_saved_files: parsed.last_saved_files || {},
            };
        }
        catch {
            return { version: 1, last_candidates: {}, last_saved_files: {} };
        }
    }
    async function writeReceiveState(state) {
        fs.mkdirSync(path.dirname(receiveStatePath), { recursive: true });
        await fs.promises.writeFile(receiveStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    }
    function rememberDocumentCandidate(state, update) {
        const message = update.message || update.channel_post;
        if (!message?.document)
            return;
        const candidate = {
            update_id: update.update_id,
            message_id: message.message_id,
            chat_id: String(message.chat.id),
            message_thread_id: message.message_thread_id === undefined ? null : String(message.message_thread_id),
            sent_at: new Date(message.date * 1000).toISOString(),
            sender_id: message.from ? String(message.from.id) : null,
            sender_username: message.from?.username || null,
            caption: message.caption?.trim() || null,
            file_id: message.document.file_id,
            file_unique_id: message.document.file_unique_id || null,
            file_name: sanitizeDownloadedFileName(message.document.file_name || `telegram-file-${message.message_id}`),
            mime_type: message.document.mime_type || null,
            file_size: Number.isSafeInteger(message.document.file_size) ? message.document.file_size ?? null : null,
        };
        for (const key of [
            receiveStateKey(candidate.chat_id, candidate.message_thread_id),
            receiveStateKey(candidate.chat_id, null),
        ]) {
            const existing = state.last_candidates[key];
            if (!existing || candidate.update_id > existing.update_id) {
                state.last_candidates[key] = candidate;
            }
        }
    }
    async function postSessionResultCard(args) {
        const session = args.session;
        const run = args.run || null;
        const status = args.status || toCardStatus(session.status);
        const title = (session.title || run?.summary || "Session").trim() || "Session";
        const runner = session.runner || run?.config.runner || "codex";
        const durationLabel = run ? formatDuration(Math.max(0, run.updatedAt - run.createdAt)) : "";
        const sourceHint = session.scheduled ? "scheduled" : "";
        const runId = run?.id || session.latestRunId || "none";
        const result = deps.getLatestResultText(session.id, runId);
        let body = result?.text || "";
        if (!body && status === "failed")
            body = run?.lastError || "Run failed.";
        if (!body && status === "stopped")
            body = "Run was stopped.";
        if (!body)
            body = session.lastMessagePreview || "No latest reply yet.";
        const { text: preview, truncated } = truncateText(body, CARD_PREVIEW_CHARS);
        const ref = shortRef(`${session.id}:${runId}:${Date.now()}`);
        const card = {
            ref,
            sessionId: session.id,
            runId,
            title,
            status,
            fullText: body,
            telegramMessageId: null,
            createdAt: Date.now(),
        };
        const text = buildCardText({
            status,
            title,
            runner,
            durationLabel,
            sourceHint,
            body: preview,
            truncated,
            sessionId: session.id,
        });
        const sent = await sendSessionsMessage({
            text,
            disableNotification: args.disableNotification,
            replyMarkup: buildKeyboard(card, truncated),
            replyToMessageId: args.replyToMessageId,
        });
        card.telegramMessageId = sent.message_id;
        rememberCard(card);
        return card;
    }
    async function notifyRunFinished(event) {
        if (event.kind !== "completed" && event.kind !== "failed" && event.kind !== "stopped")
            return;
        if (notifiedRunIds.has(event.run.id)) {
            // eslint-disable-next-line no-console
            console.log(`[luma-assistant/telegram-sessions] skip duplicate notify run=${event.run.id}`);
            return;
        }
        const sessionId = deps.resolveSessionId(event.run);
        if (!sessionId) {
            // eslint-disable-next-line no-console
            console.warn(`[luma-assistant/telegram-sessions] skip notify: no sessionId for run=${event.run.id} kind=${event.kind}`);
            return;
        }
        const session = deps.getSession(sessionId);
        if (!session) {
            // eslint-disable-next-line no-console
            console.warn(`[luma-assistant/telegram-sessions] skip notify: session missing id=${sessionId} run=${event.run.id}`);
            return;
        }
        notifiedRunIds.add(event.run.id);
        // eslint-disable-next-line no-console
        console.log(`[luma-assistant/telegram-sessions] notifying kind=${event.kind} run=${event.run.id} session=${sessionId} title=${JSON.stringify(session.title)}`);
        await postSessionResultCard({
            session,
            run: event.run,
            status: event.kind,
            // Make completed visible while validating the feature.
            disableNotification: false,
        });
    }
    async function sendFullText(card, replyToMessageId) {
        const full = card.fullText.trim();
        if (!full) {
            await sendSessionsMessage({
                text: "No additional text for this session.",
                replyToMessageId,
                disableNotification: true,
            });
            return;
        }
        if (full.length <= FULL_CHUNK_CHARS) {
            await sendSessionsMessage({
                text: `<b>${escapeHtml(card.title)}</b> — full reply\n\n${escapeHtml(full)}`.slice(0, 4096),
                replyToMessageId,
                disableNotification: true,
            });
            return;
        }
        let offset = 0;
        let part = 1;
        const totalParts = Math.ceil(full.length / FULL_CHUNK_CHARS);
        while (offset < full.length) {
            const chunk = full.slice(offset, offset + FULL_CHUNK_CHARS);
            offset += FULL_CHUNK_CHARS;
            await sendSessionsMessage({
                text: `<b>${escapeHtml(card.title)}</b> — full (${part}/${totalParts})\n\n${escapeHtml(chunk)}`.slice(0, 4096),
                replyToMessageId: part === 1 ? replyToMessageId : undefined,
                disableNotification: true,
            });
            part += 1;
        }
    }
    async function handleSendToSession(args) {
        const result = deps.sendToSession(args.sessionId, args.text);
        if (!result.ok) {
            await sendSessionsMessage({
                text: `⚠️ Could not send to <b>${escapeHtml(args.title)}</b>\n${escapeHtml(result.error)}`,
                replyToMessageId: args.replyToMessageId,
            });
            return;
        }
        await sendSessionsMessage({
            text: `📨 Sent to <b>${escapeHtml(args.title)}</b>\nQueued…`,
            replyToMessageId: args.replyToMessageId,
            disableNotification: true,
        });
    }
    async function handleSessionsList(replyToMessageId) {
        const sessions = deps.listSessions()
            .filter((session) => !session.historyOnly)
            .slice(0, MAX_SESSION_BUTTONS);
        if (sessions.length === 0) {
            await sendSessionsMessage({
                text: "No sessions yet.",
                replyToMessageId,
                disableNotification: true,
            });
            return;
        }
        const titleCounts = new Map();
        for (const session of sessions) {
            const key = (session.title || "Session").replace(/\s+/g, " ").trim().toLowerCase();
            titleCounts.set(key, (titleCounts.get(key) || 0) + 1);
        }
        const collidingTitles = new Set([...titleCounts.entries()].filter(([, count]) => count > 1).map(([title]) => title));
        const pickerRefs = {};
        const lines = [];
        const buttons = [];
        sessions.forEach((session, index) => {
            const n = index + 1;
            const title = displaySessionTitle(session.title || "Session", session.id, collidingTitles);
            const ref = shortRef(`pick:${session.id}:${session.updatedAt}`);
            pickerRefs[ref] = session.id;
            lines.push(`<b>${n}.</b> ${statusEmoji(session.status)} <b>${escapeHtml(title)}</b>\n`
                + `<i>${escapeHtml(runnerLabel(session.runner))} · ${escapeHtml(session.status)}</i>`);
            buttons.push([{
                    text: padButtonLabel(`${n}. ${truncateButtonLabel(title, 30)}`),
                    callback_data: `${CALLBACK_PREFIX}o:${ref}`,
                }]);
        });
        mapping.sessionPickerRefs = { ...mapping.sessionPickerRefs, ...pickerRefs };
        persistMapping();
        await sendSessionsMessage({
            text: [
                "<b>Select a session</b>",
                "<i>Same names as in the Luma app</i>",
                "",
                lines.join("\n\n"),
                "",
                "Tap a button to open the latest reply — then reply to that card.",
            ].join("\n"),
            replyToMessageId,
            disableNotification: true,
            replyMarkup: { inline_keyboard: buttons },
        });
    }
    async function openSessionFromPicker(ref, replyToMessageId) {
        const sessionId = mapping.sessionPickerRefs[ref];
        if (!sessionId) {
            await sendSessionsMessage({
                text: "That session button expired. Send /sessions again.",
                replyToMessageId,
                disableNotification: true,
            });
            return;
        }
        const session = deps.getSession(sessionId);
        if (!session) {
            await sendSessionsMessage({
                text: "Session not found anymore. Send /sessions again.",
                replyToMessageId,
                disableNotification: true,
            });
            return;
        }
        await postSessionResultCard({
            session,
            status: toCardStatus(session.status),
            disableNotification: true,
            replyToMessageId,
        });
    }
    async function handleCallback(query) {
        if (!isAllowedUser(query.from.id)) {
            await answerCallback(query.id, "Not allowed");
            return;
        }
        const data = query.data || "";
        if (!data.startsWith(CALLBACK_PREFIX)) {
            await answerCallback(query.id);
            return;
        }
        const action = data.slice(CALLBACK_PREFIX.length, CALLBACK_PREFIX.length + 1);
        const ref = data.slice(CALLBACK_PREFIX.length + 2);
        if (action === "o") {
            await answerCallback(query.id, "Opening session");
            await openSessionFromPicker(ref, query.message?.message_id);
            return;
        }
        if (action === "m") {
            await answerCallback(query.id, "Loading sessions");
            await handleSessionsList(query.message?.message_id);
            return;
        }
        const card = mapping.cardsByRef[ref];
        if (!card) {
            await answerCallback(query.id, "Card expired");
            return;
        }
        if (action === "r") {
            pendingReplies.set(pendingKey(query.from.id), {
                sessionId: card.sessionId,
                title: card.title,
                expiresAt: Date.now() + PENDING_REPLY_TTL_MS,
            });
            await answerCallback(query.id, "Send your message");
            await sendSessionsMessage({
                text: `💬 Reply to <b>${escapeHtml(card.title)}</b>\nSend your next message in this topic.`,
                replyToMessageId: query.message?.message_id,
                replyMarkup: {
                    force_reply: true,
                    selective: true,
                    input_field_placeholder: `Message for ${card.title.slice(0, 40)}`,
                },
                disableNotification: true,
            });
            return;
        }
        if (action === "f") {
            await answerCallback(query.id, "Sending full reply");
            await sendFullText(card, query.message?.message_id);
            return;
        }
        if (action === "u") {
            const rerun = deps.rerun(card.runId);
            if (!rerun.ok) {
                await answerCallback(query.id, "Rerun failed");
                await sendSessionsMessage({
                    text: `⚠️ Rerun failed for <b>${escapeHtml(card.title)}</b>\n${escapeHtml(rerun.error)}`,
                    replyToMessageId: query.message?.message_id,
                });
                return;
            }
            await answerCallback(query.id, "Rerun started");
            await sendSessionsMessage({
                text: `🔁 Rerun started for <b>${escapeHtml(card.title)}</b>`,
                replyToMessageId: query.message?.message_id,
                disableNotification: true,
            });
            return;
        }
        await answerCallback(query.id);
    }
    function resolveSessionFromCommand(token) {
        const trimmed = token.trim();
        if (!trimmed)
            return null;
        const exact = deps.getSession(trimmed);
        if (exact)
            return exact;
        const sessions = deps.listSessions();
        const byPrefix = sessions.find((session) => session.id.startsWith(trimmed) || session.id.includes(trimmed));
        if (byPrefix)
            return byPrefix;
        const needle = trimmed.toLowerCase();
        const titled = sessions.filter((session) => session.title.toLowerCase().includes(needle));
        if (titled.length === 1)
            return titled[0];
        if (titled.length > 1) {
            const running = titled.find((session) => session.status === "running" || session.status === "queued");
            return running || titled[0];
        }
        return null;
    }
    async function handleTextMessage(message) {
        if (String(message.chat.id) !== chatId)
            return;
        if (message.message_thread_id === undefined || String(message.message_thread_id) !== sessionsThreadId)
            return;
        if (message.from?.is_bot)
            return;
        if (!isAllowedUser(message.from?.id))
            return;
        const text = (message.text || "").trim();
        if (!text)
            return;
        // Strip @bot suffix from group commands.
        const command = text.split(/\s+/, 1)[0]?.replace(/@\w+$/, "") || text;
        if (command === "/help" || command === "/start") {
            await sendSessionsMessage({
                text: [
                    "<b>Luma Sessions</b>",
                    "",
                    "When a session finishes, you get a result card here.",
                    "",
                    "<b>Easy ways to continue</b>",
                    "• Tap <b>/sessions</b> and pick a session",
                    "• Reply directly to a result card",
                    "• Tap <b>💬 Reply</b> on a card",
                    "",
                    "<b>Commands</b>",
                    "<code>/sessions</code> — pick a session",
                    "<code>/ask &lt;title&gt; message</code> — send without reply",
                    "<code>/help</code> — this guide",
                ].join("\n"),
                replyToMessageId: message.message_id,
                disableNotification: true,
                replyMarkup: {
                    inline_keyboard: [[{ text: "📋 Recent sessions", callback_data: `${CALLBACK_PREFIX}m:1` }]],
                },
            });
            return;
        }
        if (command === "/sessions") {
            await handleSessionsList(message.message_id);
            return;
        }
        if (text.startsWith("/ask ") || text.startsWith("/ask@")) {
            const withoutCmd = text.replace(/^\/ask(?:@\w+)?\s+/, "");
            const match = withoutCmd.match(/^(\S+)\s+([\s\S]+)$/);
            if (!match) {
                await sendSessionsMessage({
                    text: "Usage: <code>/ask &lt;session-id-or-title&gt; your message</code>",
                    replyToMessageId: message.message_id,
                    disableNotification: true,
                });
                return;
            }
            const session = resolveSessionFromCommand(match[1]);
            if (!session) {
                await sendSessionsMessage({
                    text: `Session not found for <code>${escapeHtml(match[1])}</code>`,
                    replyToMessageId: message.message_id,
                });
                return;
            }
            await handleSendToSession({
                sessionId: session.id,
                title: session.title,
                text: match[2].trim(),
                replyToMessageId: message.message_id,
            });
            return;
        }
        const repliedCard = cardByMessageId(message.reply_to_message?.message_id);
        if (repliedCard) {
            await handleSendToSession({
                sessionId: repliedCard.sessionId,
                title: repliedCard.title,
                text,
                replyToMessageId: message.message_id,
            });
            return;
        }
        const pending = pendingReplies.get(pendingKey(message.from.id));
        if (pending && pending.expiresAt >= Date.now()) {
            pendingReplies.delete(pendingKey(message.from.id));
            await handleSendToSession({
                sessionId: pending.sessionId,
                title: pending.title,
                text,
                replyToMessageId: message.message_id,
            });
        }
    }
    async function processUpdate(update, receiveState) {
        rememberDocumentCandidate(receiveState, update);
        if (update.callback_query) {
            try {
                await handleCallback(update.callback_query);
            }
            catch (error) {
                // eslint-disable-next-line no-console
                console.error("[luma-assistant/telegram-sessions] callback failed", error);
            }
            return;
        }
        const message = update.message || update.channel_post;
        if (!message)
            return;
        try {
            await handleTextMessage(message);
        }
        catch (error) {
            // eslint-disable-next-line no-console
            console.error("[luma-assistant/telegram-sessions] inbound message failed", error);
        }
    }
    async function pollOnce() {
        if (polling || stopped)
            return;
        polling = true;
        try {
            const receiveState = await readReceiveState();
            const offset = receiveState.next_update_offset ?? -100;
            const updates = await callTelegram("getUpdates", {
                offset,
                timeout: 25,
                limit: 50,
                allowed_updates: ["message", "channel_post", "callback_query"],
            });
            if (updates.length > 0) {
                for (const update of updates) {
                    await processUpdate(update, receiveState);
                }
                const highest = Math.max(...updates.map((update) => update.update_id));
                receiveState.next_update_offset = highest + 1;
                await writeReceiveState(receiveState);
            }
        }
        catch (error) {
            // eslint-disable-next-line no-console
            console.error("[luma-assistant/telegram-sessions] poll failed", error);
            await new Promise((resolve) => setTimeout(resolve, 3000));
        }
        finally {
            polling = false;
        }
    }
    function schedulePoll() {
        if (stopped)
            return;
        pollTimer = setTimeout(() => {
            void pollOnce().finally(() => schedulePoll());
        }, 250);
    }
    function maybeNotifyFromLifecycle(event) {
        if (!token || !chatId || !sessionsThreadId)
            return;
        let kind = null;
        if (event.kind === "completed" || event.kind === "failed" || event.kind === "stopped") {
            kind = event.kind;
        }
        else if (event.kind === "updated"
            && event.previous
            && !TERMINAL_STATUSES.has(event.previous.status)
            && TERMINAL_STATUSES.has(event.run.status)) {
            kind = toCardStatus(event.run.status);
        }
        if (!kind)
            return;
        const synthetic = { kind, run: event.run, previous: event.previous };
        // Defer so MessageProjector can persist the final assistant/error text.
        setTimeout(() => {
            void notifyRunFinished(synthetic).catch((error) => {
                // eslint-disable-next-line no-console
                console.error("[luma-assistant/telegram-sessions] notify failed", error);
            });
        }, 400);
    }
    return {
        enabled: Boolean(token && chatId && sessionsThreadId),
        start() {
            if (!token || !chatId || !sessionsThreadId || started)
                return;
            started = true;
            stopped = false;
            claimUpdatesOwnership();
            // eslint-disable-next-line no-console
            console.log(`[luma-assistant/telegram-sessions] bridge active → chat ${chatId} topic ${sessionsThreadId}`
                + (allowedUserIds.size ? ` (allowlist ${allowedUserIds.size})` : " (all chat members)"));
            schedulePoll();
            void sendSessionsMessage({
                text: [
                    "<b>Sessions bridge is live</b>",
                    "Finished runs will post here.",
                    "Tap below to pick a session and reply.",
                ].join("\n"),
                disableNotification: true,
                replyMarkup: {
                    inline_keyboard: [[{ text: "📋 Recent sessions", callback_data: `${CALLBACK_PREFIX}m:1` }]],
                },
            }).catch((error) => {
                // eslint-disable-next-line no-console
                console.error("[luma-assistant/telegram-sessions] startup message failed", error);
            });
        },
        stop() {
            stopped = true;
            if (pollTimer) {
                clearTimeout(pollTimer);
                pollTimer = null;
            }
            releaseUpdatesOwnership();
        },
        onRunLifecycle(event) {
            maybeNotifyFromLifecycle(event);
        },
    };
}
//# sourceMappingURL=session-telegram-bridge.js.map