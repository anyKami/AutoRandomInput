import { SETTINGS_KEY, createRollRecord, processMessage, removeLegacyMarkers } from './core.js';

export async function installSendHooks(getContext, onChange, getInput = () => document.getElementById('send_textarea'),
    isRendered = id => !!document.querySelector(`#chat .mes[mesid="${id}"]`), skills = null) {
    let pending;
    const ctx = getContext();
    const discardDraft = () => {
        const block = pending?.record.block;
        pending = null;
        const input = getInput();
        if (!block || !input) return;
        const index = input.value.indexOf(block);
        if (index < 0 || index !== input.value.lastIndexOf(block)) return;
        input.value = input.value.slice(0, index) + input.value.slice(index + block.length);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const makeRecord = (current, beforeId) => {
        const settings = current.extensionSettings[SETTINGS_KEY];
        const record = settings.enabled ? createRollRecord(settings) : { groupId: null, groupName: '技能检定', rolls: [], block: '', display: '' };
        return skills?.prepare(record, beforeId) ?? record;
    };
    const safely = handler => async (...args) => {
        try { await handler(...args); }
        catch (error) {
            console.error('[AutoRandomInput] 消息处理失败', error);
            globalThis.toastr?.error('随机指令处理或保存失败，请检查当前消息。', '随机指令');
        }
    };
    const refresh = async (current, ids, newMessageId = -1) => {
        // MESSAGE_SENT precedes addOneMessage. Older messages may also be outside the rendered page.
        for (const id of ids) {
            if (id !== newMessageId && isRendered(id)) {
                current.updateMessageBlock(id, current.chat[id]);
                await current.eventSource.emit(current.eventTypes.MESSAGE_UPDATED ?? 'message_updated', id);
            }
        }
        onChange();
        if (ids.length) await current.saveChat();
    };
    const beforeGeneration = async (type, params = {}, dryRun = false) => {
        if (dryRun || params?.automatic_trigger) return;
        if (['regenerate', 'swipe', 'continue'].includes(type)) {
            const ids = skills?.restore?.() ?? [];
            if (ids.length) await refresh(getContext(), ids);
            return;
        }
        if (![undefined, 'normal'].includes(type)) return;
        const current = getContext();
        const settings = current.extensionSettings[SETTINGS_KEY];
        const input = getInput();
        if ((!settings.enabled && !skills?.enabled()) || !input?.value.trim()) return;
        // A cancelled send or the group's inner generation may reuse this same draft.
        if (pending?.chat === current.chat && pending.messageId === current.chat.length &&
            pending.skillRevision === skills?.revision?.() &&
            input.value.includes(pending.record.block || pending.text)) return;
        discardDraft();
        if (!input.value.trim()) return;
        const record = makeRecord(current, current.chat.length);
        pending = { chat: current.chat, messageId: current.chat.length, skillRevision: skills?.revision?.(), record, text: input.value + record.block };
        input.value = pending.text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const onMessageSent = async messageId => {
        const current = getContext();
        const message = current.chat[messageId];
        const prepared = pending?.chat === current.chat && pending.messageId === messageId &&
            message?.is_user && !message.is_system ? pending.record : null;
        if (prepared) pending = null;
        const outcome = processMessage(current.chat, messageId, current.extensionSettings[SETTINGS_KEY], Math.random, prepared,
            skills?.enabled() ? () => makeRecord(current, messageId) : null);
        if (outcome) await refresh(current, outcome.changedIds, messageId);
    };
    const onChatChanged = async () => {
        discardDraft();
        const current = getContext();
        await refresh(current, removeLegacyMarkers(current.chat));
        skills?.reset();
        onChange();
    };
    const first = (type, handler) => (ctx.eventSource.makeFirst ?? ctx.eventSource.on)
        .call(ctx.eventSource, type, safely(handler));
    // The database reads the draft in GENERATION_AFTER_COMMANDS, before MESSAGE_SENT.
    // Slash commands have already completed, so appended text cannot execute as a command.
    if (ctx.eventTypes.GENERATION_AFTER_COMMANDS) first(ctx.eventTypes.GENERATION_AFTER_COMMANDS, beforeGeneration);
    first(ctx.eventTypes.MESSAGE_SENT, onMessageSent);
    ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, safely(onChatChanged));
    for (const event of ['MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MESSAGE_EDITED']) {
        if (ctx.eventTypes[event]) ctx.eventSource.on(ctx.eventTypes[event], safely(() => { discardDraft(); onChange(); }));
    }
    await safely(onChatChanged)();
}
