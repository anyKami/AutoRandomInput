import { SETTINGS_KEY, createGroup, createRule, uniqueGroupName } from './core.js';
import { ORACLE_SETTINGS_KEY, validateGeneratedConfig } from './oracle-config.js';
import { autoOracleState, saveAutoOracleState } from './oracle-auto-state.js';

const SAME_FLOOR = new Set(['regenerate', 'swipe', 'continue', 'append', 'appendFinal', 'first_message', 'quiet', 'impersonate']);
const chatKey = ctx => JSON.stringify([ctx.groupId != null ? null : ctx.characterId, ctx.groupId, ctx.chatId]);

export function installAutoOracle(getContext, service, {
    onChange = () => {}, onApply = () => {}, onChatChange = () => {},
    notify = (kind, message) => globalThis.toastr?.[kind]?.(message, '自动生成随机指令'),
} = {}) {
    let context = getContext();
    let seen = new WeakSet(context.chat ?? []), generationType;
    let lastFloor = (context.chat?.length ?? 0) - 1;
    let queued = false, task = null, mainBusy = false;
    const sameChat = ctx => ctx.chat === getContext().chat && ctx.chatMetadata === getContext().chatMetadata
        && chatKey(ctx) === chatKey(getContext());
    const state = () => autoOracleState(getContext());
    const save = value => saveAutoOracleState(getContext(), value);

    function cancel(reason) {
        queued = false;
        if (!task || task.cancelled) return;
        task.cancelled = true;
        service.cancel();
        notify('info', reason);
    }

    async function pump() {
        if (!queued || task || mainBusy || service.busy || !state().enabled || !getContext().chat?.length) return;
        queued = false;
        const ctx = getContext(), settings = state();
        // Count the next interval from this attempt, including when the API fails.
        settings.progress = 0;
        save(settings);
        const job = { cancelled: false };
        task = job; onChange();
        try {
            const draft = await service.generate('random', { ...ctx.extensionSettings[ORACLE_SETTINGS_KEY], randomDice: settings.diceSides, ruleCount: settings.ruleCount }, settings.prompt, undefined, { commandCount: settings.commandCount });
            if (job.cancelled || !sameChat(ctx)) return;
            if (draft.error) throw new Error(draft.error);
            const generated = validateGeneratedConfig(draft.value, 'random', draft.options).randomGroups[0];
            for (const rule of generated.rules) {
                const commands = settings.diceSides === 100
                    ? rule.ranges.map((row, i) => row.range === String(i + 1) ? row.command : '')
                    : rule.commands.slice(0, settings.commandCount);
                const extra = settings.diceSides === 100 ? rule.ranges.length !== settings.commandCount || rule.commands.some(command => command.trim())
                    : rule.ranges.length > 0 || rule.commands.slice(settings.commandCount).some(command => command.trim());
                if (commands.length !== settings.commandCount || commands.some(command => !command.trim()) || extra) {
                    throw new Error(`每套骰子须按顺序提供 ${settings.commandCount} 条非空指令，且不能包含额外指令。`);
                }
                rule.commands = Array(20).fill('');
                rule.ranges = [];
                commands.forEach((command, i) => {
                    const from = settings.mapping === 'even' ? Math.floor(i * settings.diceSides / settings.commandCount) + 1 : i + 1;
                    const to = settings.mapping === 'even' ? Math.floor((i + 1) * settings.diceSides / settings.commandCount) : from;
                    if (settings.diceSides === 100) rule.ranges.push({ range: from === to ? String(from) : `${from}-${to}`, command });
                    else for (let point = from; point <= to; point++) rule.commands[point - 1] = command;
                });
            }
            const store = ctx.extensionSettings[SETTINGS_KEY];
            const next = state();
            let group = store.groups.find(item => item.id === next.groupId);
            if (group) {
                const rules = generated.rules.map(rule => createRule(rule.name, rule));
                group.rules = rules;
            } else {
                const label = String(ctx.chatId || ctx.name2 || '当前聊天').replace(/\.jsonl$/i, '').slice(0, 60);
                group = createGroup(uniqueGroupName(store, `神谕自动 · ${label}`), generated);
                store.groups.push(group);
            }
            next.groupId = group.id;
            next.useGroup = true;
            job.applied = true;
            const message = `已更新并选用“${group.name}”，共 ${group.rules.length} 套指令。${store.enabled ? '' : '随机指令总开关关闭，发送时不会追加。'}`;
            next.lastResult = { kind: 'success', message, at: Date.now() };
            ctx.saveSettingsDebounced(); save(next);
            onApply(); notify('success', message);
        } catch (error) {
            if (job.cancelled) return;
            const message = job.applied ? `配置已更新，但保存或界面刷新失败：${error.message}`
                : `自动生成失败：${error.message} 原配置已保留，不自动重试。`;
            if (sameChat(ctx)) {
                const next = state();
                next.lastResult = { kind: 'error', message, at: Date.now() }; save(next);
            }
            notify('error', message);
        } finally {
            if (task === job) task = null;
            onChange();
            // At most one pending update, even when several intervals elapsed while busy.
            if (queued) queueMicrotask(pump);
        }
    }

    function receive(id, type) {
        const ctx = getContext(), message = ctx.chat?.[id];
        if (!message || message.is_user || message.is_system || !message.mes?.trim() || seen.has(message)) return;
        seen.add(message);
        // Group regeneration deletes and recreates its replies with type "normal".
        // Replacements at existing floors do not count; a new user turn resets the baseline.
        const replacesFloor = id <= lastFloor;
        lastFloor = Math.max(lastFloor, id);
        if (!state().enabled || replacesFloor || SAME_FLOOR.has(type) || SAME_FLOOR.has(generationType)) return;
        const next = state();
        next.progress = Math.min(next.interval, next.progress + 1);
        save(next);
        if (next.progress >= next.interval) queued = true;
        onChange();
        // Never make the host's message event wait for a model request.
        void pump();
    }

    const { eventSource, eventTypes } = context;
    eventSource.on(eventTypes.GENERATION_STARTED, (type, params, dryRun) => {
        // Oracle's own quiet requests must not change the main reply's generation type.
        if (!dryRun && type !== 'quiet' && type !== 'impersonate') { generationType = type; mainBusy = true; }
    });
    for (const name of ['GENERATION_ENDED', 'GENERATION_STOPPED']) {
        if (eventTypes[name]) eventSource.on(eventTypes[name], () => { mainBusy = false; void pump(); });
    }
    const receivedEvent = eventTypes.CHARACTER_MESSAGE_RENDERED ?? eventTypes.MESSAGE_RECEIVED;
    if (receivedEvent) eventSource.on(receivedEvent, receive);
    if (eventTypes.MESSAGE_SENT) eventSource.on(eventTypes.MESSAGE_SENT, () => { lastFloor = getContext().chat.length - 1; });
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        cancel('已切换聊天，本次自动生成已取消。');
        context = getContext();
        seen = new WeakSet(context.chat ?? []); generationType = undefined; mainBusy = false; lastFloor = (context.chat?.length ?? 0) - 1;
        onChatChange(); onChange();
    });
    service.subscribe(() => { onChange(); if (!service.busy) queueMicrotask(pump); });

    return {
        state,
        get busy() { return !!task && !task.cancelled; },
        get pending() { return queued; },
        start({ interval, prompt, commandCount = state().commandCount, ruleCount = state().ruleCount, diceSides = state().diceSides, mapping = state().mapping }) {
            if (!getContext().chat?.length) throw new Error('请先打开一个聊天。');
            if (!Number.isSafeInteger(interval) || interval < 1) throw new Error('生成间隔须为大于等于 1 的整数。');
            if (![1,2,3,4,5,6,7,8,9,10,20,100].includes(diceSides) || !Number.isSafeInteger(commandCount) || commandCount < 1 || commandCount > diceSides || !Number.isSafeInteger(ruleCount) || ruleCount < 1 || ruleCount > 10 || !['first', 'even'].includes(mapping)) throw new Error('骰子数量须为 1 到 10，指令条数须为 1 到骰子面数。');
            const next = state();
            Object.assign(next, { enabled: true, interval, prompt, commandCount, ruleCount, diceSides, mapping, progress: 0 });
            save(next); seen = new WeakSet(getContext().chat); lastFloor = getContext().chat.length - 1; queued = true;
            onChange(); return pump();
        },
        stop() {
            const next = state(); next.enabled = false; save(next);
            cancel('自动生成已关闭，本次请求已取消，已有配置保留。');
            onChange();
        },
        update({ interval, prompt, commandCount = state().commandCount, ruleCount = state().ruleCount, diceSides = state().diceSides, mapping = state().mapping }) {
            if (!Number.isSafeInteger(interval) || interval < 1) throw new Error('生成间隔须为大于等于 1 的整数。');
            if (![1,2,3,4,5,6,7,8,9,10,20,100].includes(diceSides) || !Number.isSafeInteger(commandCount) || commandCount < 1 || commandCount > diceSides || !Number.isSafeInteger(ruleCount) || ruleCount < 1 || ruleCount > 10 || !['first', 'even'].includes(mapping)) throw new Error('骰子数量须为 1 到 10，指令条数须为 1 到骰子面数。');
            const next = state();
            if (next.interval !== interval) { next.progress = 0; queued = false; }
            Object.assign(next, { interval, prompt, commandCount, ruleCount, diceSides, mapping }); save(next); onChange();
        },
    };
}
