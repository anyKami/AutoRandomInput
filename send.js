import { SETTINGS_KEY, createRollRecord, processMessage, removeLegacyMarkers } from './core.js';
import { effectiveRandomSettings } from './oracle-auto-state.js';
import { mvuApi } from './mvu-skills.js';
import { NARRATIVE_KEY, foldNarrative, narrativeConfig, prepareNarrativeTurn, refreshNarrativeScene, saveNarrativeConfig } from './narrative.js';

export async function installSendHooks(getContext, onChange, getInput = () => document.getElementById('send_textarea'),
    isRendered = id => !!document.querySelector(`#chat .mes[mesid="${id}"]`), skills = null) {
    let pending, groupWrapper = false;
    const setNarrativePrompt = (current, record) => current.setExtensionPrompt?.(
        'auto_random_input_narrative', record?.narrative?.promptInjectionVersion === 1 && !record.narrative.promptSuppressed ? record.narrative.prompt : '', 1, 0, false, 0);
    let countedMessages = new WeakSet();
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
        const settings = effectiveRandomSettings(current);
        const config = narrativeConfig(current);
        let record;
        if (config.enabled) {
            let data;
            try { if (beforeId > 0) data = mvuApi()?.getMvuData({ type: 'message', message_id: beforeId - 1 }); } catch { /* MVU unavailable */ }
            const ready = !!data?.stat_data;
            refreshNarrativeScene(current, config, data);
            const state = { ...foldNarrative(current.chat, beforeId), ready, stat: data?.stat_data };
            const applicable = settings.enabled ? config : { ...config, longGroupId: null, sceneGroupId: null };
            record = prepareNarrativeTurn(settings, applicable, state);
        } else record = settings.enabled ? createRollRecord(settings) : { groupId: null, groupName: '技能检定', rolls: [], block: '', display: '' };
        record = skills?.prepare(record, beforeId) ?? record;
        if (record.narrative) { record.narrative.fullBlock = record.block; record.narrative.fullDisplay = record.display; }
        return record;
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
        if (dryRun || params?.automatic_trigger) { setNarrativePrompt(getContext(), null); return; }
        if (['regenerate', 'swipe', 'continue'].includes(type)) {
            const current = getContext();
            const id = current.chat.findLastIndex(message => message?.is_user && !message.is_system);
            const message = current.chat[id], record = message?.extra?.[SETTINGS_KEY];
            const ids = [];
            setNarrativePrompt(current, record);
            if (record?.narrative?.injected && !record.block && record.narrative.fullBlock && !message.mes.includes(record.narrative.fullBlock)) {
                record.block = record.narrative.fullBlock; record.display = record.narrative.fullDisplay;
                message.mes += record.block; delete message.extra.token_count; ids.push(id);
            } else if (!record?.narrative) ids.push(...(skills?.restore?.() ?? []));
            if (ids.length) await refresh(getContext(), ids);
            return;
        }
        if (![undefined, 'normal'].includes(type)) { setNarrativePrompt(getContext(), null); return; }
        const current = getContext();
        const settings = current.extensionSettings[SETTINGS_KEY];
        setNarrativePrompt(current, null);
        const input = getInput();
        if (!input?.value.trim()) {
            if (groupWrapper) {
                const message = current.chat.findLast(item => item?.is_user && !item.is_system);
                setNarrativePrompt(current, message?.extra?.[SETTINGS_KEY]);
            }
            return;
        }
        if (!settings.enabled && !skills?.enabled() && !narrativeConfig(current).enabled) return;
        // A cancelled send or the group's inner generation may reuse this same draft.
        if (pending?.chat === current.chat && pending.messageId === current.chat.length &&
            (pending.record.narrative || pending.skillRevision === skills?.revision?.()) &&
            input.value.includes(pending.record.block || pending.text)) { setNarrativePrompt(current, pending.record); return; }
        discardDraft();
        if (!input.value.trim()) return;
        const record = makeRecord(current, current.chat.length);
        setNarrativePrompt(current, record);
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
        const outcome = processMessage(current.chat, messageId, effectiveRandomSettings(current), Math.random, prepared,
            (skills?.enabled() || narrativeConfig(current).enabled) ? () => makeRecord(current, messageId) : null);
        if (outcome?.record.narrative && prepared?.block && !outcome.record.block) {
            // An input processor removed or rewrote the prepared block; do not
            // reintroduce its candidate instructions through the hidden prompt.
            outcome.record.narrative.promptSuppressed = true;
        }
        if (outcome?.record.narrative) setNarrativePrompt(current, outcome.record);
        if (outcome?.record.narrative) outcome.record.narrative.injected = !!outcome.record.block;
        if (outcome) await refresh(current, outcome.changedIds, messageId);
        if (message?.is_user && !message.is_system && !countedMessages.has(message)) {
            if (current.chatMetadata?.[NARRATIVE_KEY]) {
                if (!outcome) await current.saveChat();
                const config = narrativeConfig(current);
                if ((outcome?.record ?? message.extra?.[SETTINGS_KEY])?.narrative?.quiet) config.quietNext = false;
                for (const topic of Object.keys(config.blockedTopics)) {
                    config.blockedTopics[topic] = Math.max(0, config.blockedTopics[topic] - 1);
                    if (!config.blockedTopics[topic]) delete config.blockedTopics[topic];
                }
                saveNarrativeConfig(current, config);
                onChange();
            }
            countedMessages.add(message);
        }
    };
    const onChatChanged = async () => {
        discardDraft();
        const current = getContext();
        setNarrativePrompt(current, null);
        groupWrapper = false;
        countedMessages = new WeakSet(current.chat);
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
    for (const name of ['GENERATION_ENDED', 'GENERATION_STOPPED']) {
        if (ctx.eventTypes[name]) ctx.eventSource.on(ctx.eventTypes[name], () => setNarrativePrompt(getContext(), null));
    }
    if (ctx.eventTypes.GROUP_WRAPPER_STARTED) ctx.eventSource.on(ctx.eventTypes.GROUP_WRAPPER_STARTED, () => { groupWrapper = true; });
    if (ctx.eventTypes.GROUP_WRAPPER_FINISHED) ctx.eventSource.on(ctx.eventTypes.GROUP_WRAPPER_FINISHED, () => {
        groupWrapper = false; setNarrativePrompt(getContext(), null);
    });
    for (const event of ['MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MESSAGE_EDITED']) {
        if (ctx.eventTypes[event]) ctx.eventSource.on(ctx.eventTypes[event], safely(() => {
            // Narrative sends use the already prepared immutable branch snapshot.
            // The legacy skill-only workflow keeps its existing draft refresh behavior.
            if (!pending?.record.narrative) discardDraft();
            onChange();
        }));
    }
    await safely(onChatChanged)();
}
