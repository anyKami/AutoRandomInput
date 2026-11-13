import { SETTINGS_KEY, makeBlock, normalizeCommandMetadata, rollDice, validateCommandRanges } from './core.js';

export const NARRATIVE_KEY = 'auto_random_input_narrative';
export const REPORT_FIELD = '剧情回报';
export const REPORT_PATH = `随机指令工作台.${REPORT_FIELD}`;
export const narrativeId = () => globalThis.crypto?.randomUUID?.() ?? `ari_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const budget = value => Number.isInteger(value) && value >= 0 && value <= 3 ? value : 1;
export function summarizeThreads(threads) {
    const active = threads.filter(item => item.status === 'active').slice(0, 3);
    const lines = active.map(thread => thread.id);
    for (const [index, thread] of active.entries()) {
        for (const part of [`：${thread.title}`, `；起因：${thread.cause}`, `；未解决：${thread.question}`, ...thread.facts.map(f => `；已记录：${f.fact}`)]) {
            const next = [...lines]; next[index] += part;
            if (next.join('\n').length <= 1500) lines[index] += part;
        }
    }
    return lines.join('\n');
}
export function normalizeNarrativeConfig(value = {}) {
    if (!object(value)) value = {};
    return { enabled: value.enabled === true, threadsEnabled: value.threadsEnabled === true,
        longGroupId: typeof value.longGroupId === 'string' ? value.longGroupId : null,
        sceneGroupId: typeof value.sceneGroupId === 'string' ? value.sceneGroupId : null,
        sceneRevision: typeof value.sceneRevision === 'string' ? value.sceneRevision : 'initial',
        sceneGroupRevision: typeof value.sceneGroupRevision === 'string' ? value.sceneGroupRevision : null,
        scenePath: typeof value.scenePath === 'string' ? value.scenePath : '',
        sceneValue: value.sceneValue ?? null, labels: Array.isArray(value.labels) ? value.labels.filter(x => typeof x === 'string') : [],
        eventBudget: budget(value.eventBudget), detailBudget: budget(value.detailBudget),
        quietNext: value.quietNext === true, preferences: typeof value.preferences === 'string' ? value.preferences : '',
        topicPreferences: object(value.topicPreferences) ? { ...value.topicPreferences } : {},
        blockedTopics: object(value.blockedTopics) ? { ...value.blockedTopics } : {},
        configVersion: Number.isSafeInteger(value.configVersion) ? value.configVersion : 0 };
}
export const narrativeConfig = ctx => normalizeNarrativeConfig(ctx.chatMetadata?.[NARRATIVE_KEY]);
export function saveNarrativeConfig(ctx, value) {
    ctx.chatMetadata[NARRATIVE_KEY] = normalizeNarrativeConfig(value);
    if (ctx.saveMetadataDebounced) ctx.saveMetadataDebounced(); else if (ctx.saveMetadata) void ctx.saveMetadata();
}
export function refreshNarrativeScene(ctx, config, data) {
    const value = config.scenePath && data?.stat_data ? readStatPath(data.stat_data, config.scenePath) : undefined;
    if (value !== undefined && JSON.stringify(value) !== JSON.stringify(config.sceneValue)) {
        config.sceneValue = structuredClone(value); config.sceneRevision = narrativeId(); config.configVersion++;
        saveNarrativeConfig(ctx, config);
    }
    return config;
}

// No expression evaluation: paths are exact property names and every operand is typed.
export function readStatPath(stat, path, preserveList = false) {
    if (typeof path !== 'string' || !path.startsWith('stat_data.')) return undefined;
    const parts = path.slice(10).split('.');
    if (!parts.length || parts.some(part => !part || ['__proto__', 'prototype', 'constructor'].includes(part))) return undefined;
    let value = stat;
    for (const [index, part] of parts.entries()) {
        if (!object(value) || !Object.hasOwn(value, part)) return undefined;
        value = value[part];
        if (Array.isArray(value) && value.length === 2 && typeof value[1] === 'string' && !(preserveList && index === parts.length - 1 && !Array.isArray(value[0]))) value = value[0];
    }
    return value;
}
export function checkConditions(conditions, { stat, ready, labels = [], threads = [] }) {
    if (!Array.isArray(conditions)) return false;
    return conditions.every(condition => {
        if (!object(condition)) return false;
        if (condition.type === 'label') return typeof condition.value === 'string' && labels.includes(condition.value);
        if (condition.type === 'thread') return typeof condition.threadId === 'string' &&
            threads.some(thread => thread.id === condition.threadId && thread.status === condition.status);
        if (condition.type !== 'stat' || !ready) return false;
        const actual = readStatPath(stat, condition.path, condition.op === 'contains'), expected = condition.value;
        if (condition.op === 'contains') return Array.isArray(actual) && actual.some(item => typeof item === typeof expected && item === expected);
        if (!['string', 'number', 'boolean'].includes(typeof expected) || typeof actual !== typeof expected) return false;
        switch (condition.op) {
        case 'eq': return actual === expected;
        case 'ne': return actual !== expected;
        case 'gt': return typeof actual === 'number' && actual > expected;
        case 'gte': return typeof actual === 'number' && actual >= expected;
        case 'lt': return typeof actual === 'number' && actual < expected;
        case 'lte': return typeof actual === 'number' && actual <= expected;
        default: return false;
        }
    });
}

export function prepareNarrativeTurn(settings, config, state, random = Math.random) {
    const turnId = narrativeId(), newThreadId = narrativeId(), rolls = [], eligible = [], persistent = [];
    const selectedGroups = [config.longGroupId, config.sceneGroupId !== config.longGroupId ? config.sceneGroupId : null];
    for (const [groupIndex, id] of selectedGroups.entries()) {
        const group = settings.groups.find(item => item.id === id);
        if (!group || (groupIndex === 1 && config.sceneGroupRevision !== config.sceneRevision)) continue;
        for (const rule of group.rules.filter(item => item.enabled)) {
            const ranges = rule.diceSides === 100 ? validateCommandRanges(rule.ranges) : null;
            if (ranges && !ranges.valid) { rolls.push({ groupId: id, ruleId: rule.id, reason: 'invalid_ranges', result: null }); continue; }
            const result = rollDice(rule.diceSides, random), match = ranges?.entries.find(row => result >= row.start && result <= row.end);
            const command = ranges ? match?.command ?? '' : rule.commands[result - 1] ?? '';
            const meta = normalizeCommandMetadata(ranges ? match?.metadata : rule.commandMetadata?.[result - 1]);
            const candidate = { candidateId: narrativeId(), groupId: id, ruleId: rule.id, ruleName: rule.name, result,
                sides: rule.diceSides, command, metadata: meta, reason: '' };
            rolls.push(candidate);
            if (!command.trim()) candidate.reason = 'blank';
            else if (meta.needsBinding) candidate.reason = 'needs_binding';
            else if (meta.threadId && !state.threads.some(thread => thread.id === meta.threadId && thread.status === 'active')) candidate.reason = 'thread_inactive';
            else if (!checkConditions(meta.conditions, { ...state, labels: config.labels })) candidate.reason = 'conditions';
            else if (meta.topic !== 'general' && (config.blockedTopics[meta.topic] ?? 0) > 0) candidate.reason = 'blocked_topic';
            else if (meta.effect === 'event' && meta.topic !== 'general' && (state.cooldowns[meta.topic] ?? 0) > 0 && !(meta.persistent && rule.diceSides === 1)) candidate.reason = 'cooldown';
            else if (meta.persistent && rule.diceSides === 1) persistent.push(candidate);
            else eligible.push(candidate);
        }
    }
    for (let i = eligible.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [eligible[i], eligible[j]] = [eligible[j], eligible[i]]; }
    const counts = { event: 0, detail: 0 }, topics = new Set(), threadIds = new Set(), selected = [];
    for (const candidate of eligible) {
        const { effect, topic, threadId } = candidate.metadata;
        const limit = effect === 'event' && config.quietNext ? 0 : config[`${effect}Budget`];
        if (counts[effect] >= limit) candidate.reason = 'budget';
        else if (topic !== 'general' && topics.has(topic)) candidate.reason = 'duplicate_topic';
        else if (threadId && threadIds.has(threadId)) candidate.reason = 'duplicate_thread';
        else { candidate.reason = 'selected'; selected.push(candidate); counts[effect]++; if (topic !== 'general') topics.add(topic); if (threadId) threadIds.add(threadId); }
    }
    persistent.forEach(item => { item.reason = 'persistent'; });
    const chosen = [...persistent, ...selected];
    const instructions = chosen.map(item => `[候选 ${item.candidateId} | ${item.metadata.effect} | 关联线 ${item.metadata.threadId ?? '无'}] ${item.command}`).join('\n\n');
    const threadSummary = summarizeThreads(state.threads);
    const example = { version: 1, turnId, baseRevision: state.revision,
        uses: chosen.map(item => ({ candidateId: item.candidateId, status: 'ignored' })), updates: [], newThread: null };
    const patchExample = JSON.stringify([{ op: 'add', path: '/随机指令工作台/剧情回报', value: example }]);
    const request = config.threadsEnabled && state.ready ? `\n\n剧情记录协议 v1：当前活跃线（AI 根据正文记录）：\n${threadSummary || '无'}\n本轮预分配的新线 ID：${newThreadId}。沿用角色卡原有 MVU 更新格式，在正文之后通过 MVU 写入 stat_data.随机指令工作台.剧情回报，值为一个 JSON 对象；不要仅在普通代码块展示。每条 AI 回复都必须独立写入当前 turnId 和 baseRevision 的完整剧情回报；群聊中后续角色也必须单独回报，不能用其他角色的回报代替。没有剧情变化时，uses 仍逐项填写，updates 为 []，newThread 为 null。如果角色卡使用 JSON Patch，合法的完整命令数组示例（其中已包含本轮真实 ID）为：${patchExample}。本插件的剧情回报操作必须有 op、path、value 三个键，op 的值使用 add 或 replace，绝不能把 replace 或 add 当作键；角色卡其他变量操作沿用原协议。如果角色卡使用 XML 包裹 JSON Patch，必须完整输出成对的 <UpdateVariable><JSONPatch>合法 JSON 数组</JSONPatch></UpdateVariable>，结束标签必须有斜杠；检查数组与对象括号完整闭合，不能多出括号。把本操作加入角色卡原有的 MVU 更新块，继续输出本轮其他应更新的变量，不能省略或覆盖它们。如果角色卡使用 _.set，继续沿用卡的 _.set 原语法，路径为“随机指令工作台.剧情回报”，值使用上述命令中的 value 对象，不要强制改成 JSON Patch。uses 中把实际采用的候选 status 改为 adopted；updates 项为 {"threadId":"已有活跃线ID","action":"advance|pause|complete","fact":"已经发生的事实变化","evidence":"本次正文原文"}；如需新建一线，将 newThread 替换为 {"title":"标题","cause":"已发生起因","question":"未解决问题","evidence":"本次正文原文"}，系统自动使用上面的预分配 ID。证据只能逐字引用自己当前这条回复的正文，不能引用其他角色的回复；前面角色已记录的新线不要重复提议。只记录已经发生的事实，不把传闻和猜测当确定事实；至多新建一线。不得恢复用户暂停或结束的线。只输出角色卡要求的最终正文及 MVU，不输出协议解释、自检、修正草稿或重复正文。正文不要播报骰点、DC或剧情线状态，保持角色卡原有格式和 content 标签。` : '';
    const blocks = makeBlock(instructions + request, settings.stealthMode);
    return { groupId: config.longGroupId, groupName: '剧情增强', rolls, ...blocks,
        narrative: { version: 1, turnId, newThreadId, configVersion: config.configVersion, baseRevision: state.revision,
            sceneRevision: config.sceneRevision, candidates: chosen.map(item => item.candidateId), prompt: blocks.block,
            quiet: config.quietNext, snapshot: structuredClone(config) } };
}

function revisionOf(events) {
    // Stable across reloads, and sensitive to both the visible branch and edits.
    const text = JSON.stringify(events); let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return `r${(hash >>> 0).toString(36)}`;
}
const nonempty = value => typeof value === 'string' && !!value.trim();
export function validateNarrativeReport(report, turn, body) {
    const issues = [];
    if (!object(report) || report.version !== 1 || report.turnId !== turn.turnId || report.baseRevision !== turn.baseRevision)
        return { valid: false, issues: ['回报协议、轮次或基础版本不匹配。'] };
    if (!Array.isArray(report.uses) || !Array.isArray(report.updates)) return { valid: false, issues: ['回报数组缺失。'] };
    const prose = typeof body === 'string' ? body.replace(/<(UpdateVariable|update|status_current_variables)\b[^>]*>[\s\S]*?<\/\1>/gi, '') : '';
    const evidence = value => nonempty(value) && prose.includes(value);
    const uses = report.uses.filter(use => object(use) && turn.candidates.includes(use.candidateId) && ['adopted', 'ignored'].includes(use.status));
    if (uses.length !== report.uses.length || new Set(uses.map(use => use.candidateId)).size !== uses.length) issues.push('部分指令采用回报无效。');
    const updates = report.updates.filter(update => object(update) && nonempty(update.threadId) &&
        ['advance', 'pause', 'complete'].includes(update.action) && nonempty(update.fact) && evidence(update.evidence));
    if (updates.length !== report.updates.length) issues.push('部分剧情线回报缺少正文证据或格式无效。');
    let newThread = null;
    if (report.newThread != null) {
        const next = report.newThread;
        if (object(next) && nonempty(next.title) && nonempty(next.cause) && nonempty(next.question) && evidence(next.evidence))
            newThread = { title: next.title, cause: next.cause, question: next.question, evidence: next.evidence };
        else issues.push('新剧情线缺少正文证据或必要内容。');
    }
    return { valid: true, uses, updates, newThread, issues };
}

// Rebuild from the current visible branch; reports are scoped to the reply's
// swipe and the originating user's immutable base revision.
export function foldNarrative(chat, until = chat.length) {
    const threads = [], cooldowns = {}, events = [];
    let currentTurn = null, validBase = false, created = false;
    for (const message of chat.slice(0, until)) {
        if (!message || message.is_system) continue;
        if (message.is_user) {
            for (const key of Object.keys(cooldowns)) cooldowns[key] = Math.max(0, cooldowns[key] - 1);
            const record = message.extra?.[SETTINGS_KEY], turn = record?.narrative;
            if (!turn) { currentTurn = null; continue; }
            validBase = turn.baseRevision === revisionOf(events); currentTurn = turn; created = false;
            for (const item of record.rolls ?? []) if (turn.injected !== false && item.reason === 'selected' && item.metadata?.effect === 'event' && item.metadata.topic !== 'general') cooldowns[item.metadata.topic] = 2;
            continue;
        }
        const data = message.extra?.[NARRATIVE_KEY], swipe = String(message.swipe_id ?? 0);
        // A reply or swipe change is itself part of the branch, including when
        // no narrative report was emitted. Older messages without our UID get a
        // deterministic content fingerprint until a persisted UID exists.
        events.push(['reply', data?.uid ?? revisionOf([message.name ?? '', message.mes ?? '']), swipe, message.mes ?? '']);
        const entry = data?.swipes?.[swipe];
        if (!entry) continue;
        if (currentTurn && validBase && entry.report) {
            const checked = validateNarrativeReport(entry.report, currentTurn, message.mes);
            if (checked.valid) {
                for (const update of checked.updates) {
                    const thread = threads.find(item => item.id === update.threadId);
                    if (!thread || thread.status !== 'active') continue;
                    thread.facts.push({ fact: update.fact, evidence: update.evidence });
                    if (update.action === 'pause') thread.status = 'paused';
                    if (update.action === 'complete') thread.status = 'completed';
                    events.push(['update', data.uid, swipe, update]);
                }
                if (checked.newThread && !created && threads.filter(item => item.status === 'active').length < 3) {
                    threads.push({ id: currentTurn.newThreadId, ...checked.newThread, status: 'active', facts: [] });
                    created = true; events.push(['create', data.uid, swipe, currentTurn.newThreadId, checked.newThread]);
                }
            }
        }
        for (const action of entry.actions ?? []) {
            // A user action belongs to the exact visible prefix at its anchor,
            // including this reply and any prior actions on the same swipe.
            if (action.baseRevision !== revisionOf(events)) continue;
            const thread = threads.find(item => item.id === action.threadId);
            if (!thread) continue;
            if (action.type === 'pause' && thread.status === 'active') thread.status = 'paused';
            else if (action.type === 'resume' && thread.status === 'paused' && threads.filter(item => item.status === 'active').length < 3) thread.status = 'active';
            else if (action.type === 'complete' && thread.status !== 'completed') thread.status = 'completed';
            else if (action.type === 'correct' && nonempty(action.fact)) {
                if (action.target === 'cause') { thread.cause = action.fact; thread.evidence = ''; thread.causeUserCorrected = true; }
                else if (action.target === 'question') thread.question = action.fact;
                else if (Number.isInteger(action.factIndex) && action.factIndex >= 0 && action.factIndex < thread.facts.length)
                    thread.facts[action.factIndex] = { fact: action.fact, user: true };
                else thread.facts.push({ fact: action.fact, user: true });
            }
            else continue;
            events.push(['user', data.uid, swipe, action]);
        }
    }
    return { threads, cooldowns, revision: revisionOf(events) };
}
