import { SKILL_FIELD, SKILL_NAMESPACE, SKILL_PATH, SKILL_SETTINGS_KEY, createSkillTurn, isObject, normalizeSkillSettings,
    readSkillSelection, replyFingerprint, requestBefore, skillBlocks, skillErrors, unwrap, validateSelection,
    SKILL_VERSION, packetMatchesReply, skillPacket } from './skills.js';

export function mvuApi(host = globalThis) {
    if (typeof host.Mvu?.getMvuData === 'function') return host.Mvu;
    if (typeof host.TavernHelper?.getVariables === 'function') return { getMvuData: options => host.TavernHelper.getVariables(options) };
    return null;
}

// MVU has already parsed the command. Never evaluate model-produced JavaScript.
function parseValue(value) {
    if (typeof value !== 'string') return value;
    return JSON.parse(value);
}
function commandPath(command) {
    let path = command.args?.[0] ?? command.path;
    if (typeof path !== 'string') return '';
    if ((path.startsWith("'") && path.endsWith("'")) || (path.startsWith('"') && path.endsWith('"'))) path = path.slice(1, -1);
    path = path.replace(/\[(["'])(.*?)\1\]/g, (_, quote, key) => `.${key}`)
        .replace(/^\./, '').replace(/^stat_data\./, '').replace(/^\//, '').replaceAll('/', '.');
    // MVU translates JSON Patch add into insert(parentPath, key, value).
    if (command.type === 'insert' && command.args?.length >= 3) {
        let key = command.args[1];
        try { key = parseValue(key); } catch { key = key.replace(/^['"]|['"]$/g, ''); }
        path += `${path ? '.' : ''}${key}`;
    }
    return path;
}
function writePacket(variables, packet) {
    const root = variables.stat_data;
    if (!isObject(root)) return false;
    if (!Object.hasOwn(root, SKILL_NAMESPACE)) root[SKILL_NAMESPACE] = {};
    const namespace = unwrap(root[SKILL_NAMESPACE]);
    if (!isObject(namespace)) return false;
    namespace[SKILL_FIELD] = packet;
    return true;
}

export function installSkillService(getContext, onChange = () => {}, host = globalThis) {
    const frames = new WeakMap();
    let lastError = '';
    let sheetRevision = 0;
    const settings = () => {
        const ctx = getContext();
        const saved = ctx.chatMetadata?.[SKILL_SETTINGS_KEY];
        const config = normalizeSkillSettings(saved);
        if (ctx.chatMetadata && ctx.chat.length && saved?.version !== SKILL_VERSION) {
            ctx.chatMetadata[SKILL_SETTINGS_KEY] = config;
            if (ctx.saveMetadataDebounced) ctx.saveMetadataDebounced();
            else if (ctx.saveMetadata) void ctx.saveMetadata();
        }
        return config;
    };
    const recent = () => {
        const ctx = getContext();
        const index = ctx.chat.findLastIndex(message => message.is_user && !message.is_system && message.extra?.auto_random_input?.skills?.results?.length);
        const turn = ctx.chat[index]?.extra.auto_random_input.skills;
        if (!turn || turn.request.version !== SKILL_VERSION) return { turn, reports: [], issues: [] };
        const api = mvuApi(host);
        // Read the response to this batch, not the latest turn's unrelated MVU packet.
        for (let i = index + 1; i < ctx.chat.length; i++) {
            const message = ctx.chat[i];
            if (message.is_system) continue;
            if (message.is_user) break;
            let packet;
            try { packet = skillPacket(api?.getMvuData({ type: 'message', message_id: i })); } catch { continue; }
            if (packet?.规则版本 === SKILL_VERSION && packetMatchesReply(packet, turn.request, message, i)) {
                const checked = validateSelection(packet, turn.request);
                return { turn, reports: checked.本轮处理, issues: [...new Set([...(packet.issues ?? []), ...checked.issues])] };
            }
        }
        return { turn, reports: [], issues: ['等待该次检定对应的 AI 回复回报采用情况。'] };
    };
    const view = (beforeId = getContext().chat.length) => {
        const ctx = getContext();
        const config = settings();
        const errors = skillErrors(config);
        const api = mvuApi(host);
        let data;
        let index = beforeId - 1;
        while (index >= 0 && ctx.chat[index]?.is_system) index--;
        try { if (api && index >= 0) data = api.getMvuData({ type: 'message', message_id: index }); }
        catch { lastError = '读取 MVU 变量失败。'; }
        const ready = !!api && isObject(data?.stat_data) && data.schema !== undefined;
        const selection = ready ? readSkillSelection(ctx.chat, data, config, beforeId)
            : { checks: [], issues: ['等待 MVU 初始化当前聊天变量。'] };
        return { config, ready, errors, selection, error: lastError };
    };
    const prepare = (record, beforeId, random = Math.random) => {
        const state = view(beforeId);
        if (!state.config.enabled || state.errors.length) return record;
        const turn = createSkillTurn(state.config, state.selection, random);
        const blocks = skillBlocks(turn, getContext().extensionSettings.auto_random_input.stealthMode);
        return { ...record, skills: turn, block: record.block + blocks.block, display: record.display + blocks.display };
    };
    const restore = () => {
        if (!settings().enabled) return [];
        const ctx = getContext();
        const index = ctx.chat.findLastIndex(message => message.is_user && !message.is_system);
        const message = ctx.chat[index];
        const record = message?.extra?.auto_random_input;
        // Later sends remove old injected text, but retain the immutable skill batch.
        // Returning to that round must restore its contract without rolling again.
        if (!record?.skills || record.block) return [];
        const blocks = skillBlocks(record.skills, ctx.extensionSettings.auto_random_input.stealthMode);
        Object.assign(record, blocks);
        message.mes += blocks.block;
        delete message.extra.token_count;
        return [index];
    };
    const parsed = (variables, commands, content) => {
        if (!isObject(variables) || !Array.isArray(commands)) return;
        // Previous message data also passes through the card schema. Detach our inherited
        // field so strict schemas cannot reject it before the new selection is merged back.
        const inherited = unwrap(variables.stat_data?.[SKILL_NAMESPACE]);
        if (isObject(inherited) && Object.hasOwn(inherited, SKILL_FIELD)) {
            delete inherited[SKILL_FIELD];
            if (!Object.keys(inherited).length) delete variables.stat_data[SKILL_NAMESPACE];
        }
        const owned = commands.filter(command => {
            const path = commandPath(command);
            return path === SKILL_PATH || path.startsWith(SKILL_PATH + '.');
        });
        // Remove only our commands before the card's Zod schema processes the other variables.
        for (let i = commands.length - 1; i >= 0; i--) if (owned.includes(commands[i])) commands.splice(i, 1);
        if (!settings().enabled) return;
        const ctx = getContext();
        const index = ctx.chat.findLastIndex(message => !message.is_user && !message.is_system && typeof message.mes === 'string' &&
            replyFingerprint(message.mes) === replyFingerprint(content));
        if (index < 0) return;
        const message = ctx.chat[index];
        const request = requestBefore(ctx.chat, index);
        if (!request) return;
        let value;
        for (const command of owned) {
            if (commandPath(command) !== SKILL_PATH || !['set', 'replace', 'insert', 'add'].includes(command.type ?? command.op)) continue;
            try { value = parseValue(command.value ?? command.args?.at(-1)); }
            catch { lastError = '技能选择须使用合法 JSON 对象；本轮无效选择已跳过。'; }
        }
        const packet = validateSelection(value, request);
        packet._source = { messageId: index, swipeId: message.swipe_id ?? 0, fingerprint: replyFingerprint(content) };
        frames.set(variables, { chat: ctx.chat, message, packet });
    };
    const beforeWrite = context => {
        const frame = frames.get(context?.variables);
        if (!frame) return;
        frames.delete(context.variables);
        const ctx = getContext();
        const { packet, message } = frame;
        if (ctx.chat !== frame.chat || ctx.chat[packet._source.messageId] !== message ||
            (message.swipe_id ?? 0) !== packet._source.swipeId || replyFingerprint(message.mes) !== packet._source.fingerprint) return;
        // This event follows the card's Zod validation. Preserve all non-owned fields.
        if (!writePacket(context.variables, packet)) lastError = 'MVU 中的随机指令工作台字段不是对象，未覆盖原值。';
        else lastError = '';
        setTimeout(onChange, 0);
    };
    const events = getContext().eventSource;
    events.on('mag_command_parsed', parsed);
    events.on('mag_before_message_update', beforeWrite);
    return { settings, view, prepare, restore, recent,
        revision: () => {
            const { migrationSnapshot, ...config } = settings();
            return `${sheetRevision}:${JSON.stringify(config)}`;
        },
        resetSheet: () => { sheetRevision++; onChange(); },
        enabled: () => settings().enabled,
        reset: () => { lastError = ''; onChange(); },
    };
}
