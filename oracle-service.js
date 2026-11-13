import { SETTINGS_KEY } from './core.js';
import { SKILL_GROUPS_KEY, loadSkillGroup } from './skill-groups.js';
import { SKILL_SETTINGS_KEY, normalizeSkillSettings } from './skills.js';
import { importConfigBundle } from './config-transfer.js';
import { mvuApi } from './mvu-skills.js';
import { normalizeOracleSettings, oracleMessages, parseOracleReply, validateGeneratedConfig } from './oracle-config.js';
import { selectRandomGroup } from './oracle-auto-state.js';

export function oracleCapabilities(api) {
    const missing = ['run', 'context.buildCardSection', 'context.buildTranscript', 'context.buildWorldInfo']
        .filter(path => typeof path.split('.').reduce((v, key) => v?.[key], api) !== 'function');
    let compatible = false;
    try { compatible = typeof api?.isCompatible === 'function' && api.isCompatible(1); } catch { /* faulty dependency stays optional */ }
    if (!compatible) missing.unshift('Hook API v1');
    let connection = '';
    try {
        const s = api?.context?.getSettings?.();
        if (s) connection = s.mode === 'direct' ? `直连 · ${s.model || '未选择模型'}` : '使用神谕的连接配置';
    } catch { /* optional display only */ }
    return { ready: !missing.length, missing, connection };
}

// Read-only cleaning: no macro evaluator or template engine is invoked on model/context text.
export function cleanOracleText(text) {
    return String(text ?? '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<%(?:[\s\S]*?)%>/g, '')
        .replace(/<(UpdateVariable|update|script|style|status_current_variables)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/\{\{\s*(?:get|set)(?:_message_)?var(?:iable)?\b[\s\S]*?\}\}/gi, '');
}

const scopeKey = (ctx, automatic) => JSON.stringify([automatic && ctx.groupId != null ? null : ctx.characterId, ctx.groupId, ctx.chatId]);
const chatSignature = chat => JSON.stringify((chat ?? []).map(m => [m.is_user, m.is_system, m.swipe_id, m.mes]));

function scopeOf(ctx, automatic) {
    return { chat: ctx.chat, metadata: ctx.chatMetadata, key: scopeKey(ctx, automatic),
        signature: automatic ? null : chatSignature(ctx.chat) };
}
function sameChat(scope, ctx, automatic) {
    return scope.chat === ctx.chat && scope.metadata === ctx.chatMetadata && scope.key === scopeKey(ctx, automatic);
}

export async function collectOracleContext(api, ctx, options, host = globalThis) {
    const blocks = [], notes = [];
    const add = (title, raw, max, tail = false) => {
        let text = cleanOracleText(raw).replace(/\{\{user\}\}/gi, () => ctx.name1 || '用户')
            .replace(/\{\{char\}\}/gi, () => ctx.name2 || '角色').trim();
        if (!text) { notes.push(`${title}：未读到内容。`); return; }
        if (text.length > max) { text = tail ? text.slice(-max) : text.slice(0, max); notes.push(`${title}已截取至 ${max} 字符。`); }
        blocks.push(`=== ${title} ===\n${text}`);
    };
    if (options.includeCard) add('角色卡及人设', await api.context.buildCardSection(ctx), 16000);
    if (options.includeTranscript) {
        const context = { ...ctx, chat: ctx.chat.map(message => {
            const block = message.extra?.[SETTINGS_KEY]?.block;
            return { ...message, mes: block && message.mes?.includes(block) ? message.mes.replace(block, '') : message.mes };
        }) };
        add('近期对话', await api.context.buildTranscript(context, { keepMechanism: false }), options.transcriptLimit, true);
    }
    if (options.worldInfo !== 'off') add('世界书相关条目', await api.context.buildWorldInfo({ forceMode: options.worldInfo }), options.worldInfoLimit);
    if (options.includeMvu) {
        try {
            let index = ctx.chat.length - 1;
            while (index >= 0 && ctx.chat[index]?.is_system) index--;
            const data = index >= 0 ? mvuApi(host)?.getMvuData({ type: 'message', message_id: index }) : null;
            if (data?.stat_data) {
                const copy = JSON.parse(JSON.stringify(data.stat_data));
                delete copy.随机指令工作台;
                add('当前 MVU 状态', JSON.stringify(copy), 12000);
            } else notes.push('当前聊天未读到 MVU 状态。');
        } catch { notes.push('MVU 状态读取失败，本次未附带。'); }
    }
    if (!blocks.length) throw new Error('没有可用的剧情资料。请打开聊天或在设置中开启上下文读取。');
    return { blocks, notes };
}

export function createOracleRequestGate() {
    let owner;
    const listeners = new Set();
    const changed = () => { for (const listener of listeners) listener(); };
    return {
        get busy() { return !!owner; },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        acquire(token) {
            if (owner) throw new Error('正在生成，请等待或先取消。');
            owner = token; changed();
        },
        release(token) { if (owner === token) { owner = null; changed(); } },
    };
}

export function createOracleService(getContext, skillService, host = globalThis,
    { gate = createOracleRequestGate(), automatic = false } = {}) {
    let current, draft, sequence = 0;
    const isCurrent = scope => {
        const ctx = getContext();
        return sameChat(scope, ctx, automatic) && (automatic || scope.signature === chatSignature(ctx.chat));
    };
    const cancel = () => { sequence++; current?.abort(); current = null; draft = null; };
    const valid = () => !!draft && !draft.applied && isCurrent(draft.scope);
    return {
        cancel, valid,
        get busy() { return gate.busy; },
        subscribe: gate.subscribe,
        get draft() { return draft; },
        capabilities: () => oracleCapabilities(host.StoryOracleAPI),
        async generate(target, values, requirements = '', onProgress = () => {}, automaticOptions = {}) {
            if (gate.busy) throw new Error('正在生成，请等待或先取消。');
            const api = host.StoryOracleAPI;
            const caps = oracleCapabilities(api);
            if (!caps.ready) throw new Error(`故事神谕接口不可用：${caps.missing.join('、')}。请安装或启用故事神谕。`);
            const ctx = getContext();
            if (!ctx.chat?.length) throw new Error('请先打开一个聊天。');
            const scope = scopeOf(ctx, automatic), options = normalizeOracleSettings(values);
            const source = automatic ? { ...ctx, chat: structuredClone(ctx.chat) } : ctx;
            const id = ++sequence;
            const ctl = new AbortController(); current = ctl; draft = null;
            gate.acquire(ctl);
            let timedOut = false;
            const timeout = setTimeout(() => { timedOut = true; ctl.abort(); }, options.timeoutSeconds * 1000);
            const check = () => {
                if (id !== sequence || ctl.signal.aborted) throw new Error(timedOut ? '神谕请求超时，请调整超时或输出长度后重试。' : '已取消本次生成。');
                if (!isCurrent(scope)) throw new Error(automatic ? '已切换聊天，本次自动生成已取消。' : '聊天或来源消息已变化，本次结果已作废，请重新生成。');
            };
            const cancelled = new Promise((_, reject) => ctl.signal.addEventListener('abort', () => {
                reject(new Error(timedOut ? '神谕请求超时，请重试。' : '已取消本次生成。'));
            }, { once: true }));
            const work = async () => {
                const context = await collectOracleContext(api, source, options, host); check();
                const messages = oracleMessages(target, options, requirements, context.blocks, { automatic, ...automaticOptions });
                const raw = await api.run(messages, { signal: ctl.signal, maxTokens: options.maxTokens,
                    onDelta: full => {
                        // Progress only needs the active chat; check() validates its contents after the stream.
                        if (id === sequence && !ctl.signal.aborted && sameChat(scope, getContext(), automatic)) onProgress(String(full ?? '').length);
                    },
                });
                check();
                draft = { id, scope, target, options, notes: context.notes, messages, raw: String(raw ?? ''), applied: false };
                try { draft.value = parseOracleReply(raw); validateGeneratedConfig(draft.value, target, options); }
                catch (error) { draft.error = error.message; }
                return draft;
            };
            try { return await Promise.race([work(), cancelled]); }
            finally { clearTimeout(timeout); if (current === ctl) current = null; gate.release(ctl); }
        },
        apply(value, { enableRandom = false, enableSkills = false, saveOnly = false } = {}) {
            if (!valid()) throw new Error('预览已过期或已经保存，请重新生成。');
            const bundle = validateGeneratedConfig(value, draft.target, draft.options);
            const ctx = getContext();
            const hasSkills = !!bundle.skillGroups.length;
            if (!saveOnly && hasSkills && !skillService.view().ready) throw new Error('MVU 尚未就绪，请先仅保存到组库。');
            // Prepare both libraries and the sheet before mutating either store.
            const random = structuredClone(ctx.extensionSettings[SETTINGS_KEY]);
            const library = structuredClone(ctx.extensionSettings[SKILL_GROUPS_KEY]);
            const added = importConfigBundle(bundle, random, library);
            let sheet;
            if (!saveOnly) {
                if (added.randomGroups.length) {
                    random.activeGroupId = added.randomGroups[0].id;
                    if (enableRandom) random.enabled = true;
                }
                if (hasSkills) {
                    sheet = loadSkillGroup(ctx.chatMetadata[SKILL_SETTINGS_KEY] ?? normalizeSkillSettings(), added.skillGroups[0]);
                    sheet.freshSelectionSkillId = sheet.skills[0].id;
                    if (enableSkills) sheet.enabled = true;
                }
            }
            ctx.extensionSettings[SETTINGS_KEY] = random;
            ctx.extensionSettings[SKILL_GROUPS_KEY] = library;
            if (!saveOnly && added.randomGroups.length) selectRandomGroup(ctx, added.randomGroups[0].id);
            if (sheet) { ctx.chatMetadata[SKILL_SETTINGS_KEY] = sheet; skillService.resetSheet(); }
            // Commit once even if a host save callback fails; a second click must not duplicate groups.
            draft.applied = true;
            ctx.saveSettingsDebounced();
            if (sheet) {
                if (ctx.saveMetadataDebounced) ctx.saveMetadataDebounced();
                else if (ctx.saveMetadata) void ctx.saveMetadata();
            }
            return added;
        },
    };
}
