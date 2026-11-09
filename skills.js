import { dcSkillPrompt } from './skill-prompt.js';
import { legacySkillPrompt, validateLegacySelection } from './skill-legacy.js';

export const SKILL_SETTINGS_KEY = 'auto_random_input_skills';
export const SKILL_VERSION = 2;
export const SKILL_DICE = [10, 20, 100];
export const SKILL_NAMESPACE = '随机指令工作台';
export const SKILL_FIELD = '技能判定';
export const SKILL_PATH = `${SKILL_NAMESPACE}.${SKILL_FIELD}`;

export const newSkillId = () => globalThis.crypto?.randomUUID?.() ?? `ari_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
export const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
export function unwrap(value) {
    return Array.isArray(value) && (value.length === 1 || value.length === 2 && typeof value[1] === 'string') ? unwrap(value[0]) : value;
}

export const defaultSkillModifier = sides => Math.round(3 * sides / 20);
export const minSkillModifier = sides => -sides / 5;
export const signedModifier = value => value >= 0 ? `+${value}` : String(value);
export const recommendedPointLimit = settings => settings.skills.length * defaultSkillModifier(settings.diceSides);
export const skillPointTotal = settings => settings.skills.reduce((sum, skill) => sum + (Number.isSafeInteger(skill.modifier) ? skill.modifier : 0), 0);
export const syncSkillBudget = settings => {
    if (settings.pointLimitMode === 'auto') settings.pointLimit = recommendedPointLimit(settings);
    return settings;
};

export function normalizeSkillSettings(value = {}) {
    value = isObject(value) ? value : {};
    const legacy = value.version !== SKILL_VERSION && (Array.isArray(value.skills) || Object.hasOwn(value, 'pointLimit'));
    const diceSides = SKILL_DICE.includes(value.diceSides) ? value.diceSides : 20;
    const config = {
        version: SKILL_VERSION,
        groupId: typeof value?.groupId === 'string' ? value.groupId : '',
        enabled: value?.enabled === true,
        diceSides,
        mode: value?.mode === 'every' ? 'every' : 'challenge',
        maxChecks: [1, 2, 3].includes(value?.maxChecks) ? value.maxChecks : 1,
        skills: (Array.isArray(value?.skills) ? value.skills : []).filter(isObject).map(skill => ({
            id: typeof skill.id === 'string' && skill.id ? skill.id : newSkillId(),
            name: typeof skill.name === 'string' ? skill.name : '',
            modifier: legacy ? defaultSkillModifier(diceSides) : skill.modifier ?? null,
        })),
        pointLimitMode: legacy || value.pointLimitMode === 'auto' || !Object.hasOwn(value, 'pointLimit') ? 'auto' : 'custom',
        pointLimit: value.pointLimit,
    };
    // Keep the original persisted sheet once. A v2 normalization never remigrates it.
    if (legacy) config.migrationSnapshot = JSON.parse(JSON.stringify(value));
    else if (isObject(value.migrationSnapshot)) config.migrationSnapshot = JSON.parse(JSON.stringify(value.migrationSnapshot));
    return syncSkillBudget(config);
}

export function skillErrors(settings) {
    const errors = [];
    const names = new Set();
    if (!settings.skills.length) errors.push('请先添加至少一项技能。');
    for (const [index, skill] of settings.skills.entries()) {
        const name = skill.name.trim();
        if (!name) errors.push(`第 ${index + 1} 项技能名称不能为空。`);
        else if (names.has(name)) errors.push(`技能名称“${name}”重复。`);
        names.add(name);
        if (!Number.isSafeInteger(skill.modifier) || skill.modifier < minSkillModifier(settings.diceSides) || skill.modifier > settings.diceSides) {
            errors.push(`“${name || `技能 ${index + 1}`}”的技能加值须为 ${minSkillModifier(settings.diceSides)}～+${settings.diceSides} 的整数。`);
        }
    }
    if (!SKILL_DICE.includes(settings.diceSides)) errors.push('技能骰型须为 d10、d20 或 d100。');
    const limit = settings.pointLimitMode === 'auto' ? recommendedPointLimit(settings) : settings.pointLimit;
    if (!Number.isSafeInteger(limit) || limit < 0) errors.push('总加值预算须为非负整数。');
    else if (skillPointTotal(settings) > limit) errors.push(`技能加值合计 ${skillPointTotal(settings)} 超过总加值预算 ${limit}，请调整或随机分配。`);
    return errors;
}

export function randomizeSkillModifiers(settings, random = Math.random) {
    const limit = settings.pointLimitMode === 'auto' ? recommendedPointLimit(settings) : settings.pointLimit;
    if (!SKILL_DICE.includes(settings.diceSides) || !Number.isSafeInteger(limit) || limit < 0) {
        throw new RangeError('请先填写有效骰型及非负整数的总加值预算。');
    }
    const minimum = minSkillModifier(settings.diceSides);
    const skills = settings.skills.map(skill => ({ ...skill, modifier: minimum }));
    const eligible = skills.map((_, index) => index);
    const points = Math.min(limit, skills.length * settings.diceSides) - skills.length * minimum;
    // Each point goes to a randomly selected skill that still has capacity.
    for (let remaining = points; remaining > 0; remaining--) {
        const sample = random();
        if (!(sample >= 0 && sample < 1)) throw new RangeError('随机源须返回 0（含）至 1（不含）之间的值。');
        const slot = Math.floor(sample * eligible.length);
        const skill = skills[eligible[slot]];
        if (++skill.modifier === settings.diceSides) eligible.splice(slot, 1);
    }
    return skills;
}

// Ignore only MVU's generated placeholders, so editing an actual reply invalidates its selection.
export function replyFingerprint(text = '') {
    const normalized = text.replace(/<StatusPlaceHolderImpl\s*\/>/g, '')
        .replace(/<status_current_variable>[\s\S]*?<\/status_current_variable>/g, '').trim();
    let hash = 2166136261;
    for (let i = 0; i < normalized.length; i++) hash = Math.imul(hash ^ normalized.charCodeAt(i), 16777619);
    return `${normalized.length}:${(hash >>> 0).toString(16)}`;
}

export function requestBefore(chat, messageId) {
    for (let i = messageId - 1; i >= 0; i--) {
        if (chat[i]?.is_system) continue;
        if (chat[i]?.is_user) return chat[i].extra?.auto_random_input?.skills?.request ?? null;
    }
    return null;
}

export function validateSelection(value, request) {
    if (request?.version !== SKILL_VERSION) return validateLegacySelection(value, request);
    const issues = [];
    const packet = { 规则版本: SKILL_VERSION, 请求ID: request.id, 本轮处理: [], 待判定: [], issues };
    if (!isObject(value) || value.规则版本 !== SKILL_VERSION || value.请求ID !== request.id) {
        issues.push('AI 未返回本轮有效的 v2 技能回报，等待下一次选择。');
        return packet;
    }
    const selected = packet.待判定;
    const seen = new Set();
    if (!Array.isArray(value.待判定)) issues.push('待判定必须是数组，本轮未接收下一轮选择。');
    for (const item of Array.isArray(value.待判定) ? value.待判定 : []) {
        const name = typeof item?.技能名 === 'string' ? item.技能名.trim() : '';
        const action = typeof item?.对应事件 === 'string' ? item.对应事件.trim() : '';
        const conditions = typeof item?.判定条件 === 'string' ? item.判定条件.trim() : '';
        const skill = request.skills.find(skill => skill.name === name);
        if (!skill || !action) { issues.push('已跳过未知技能或未说明对应事件的选择。'); continue; }
        if (!conditions || !Number.isSafeInteger(item.DC) || item.DC < 1) {
            issues.push(`“${name}”缺少判定条件或有效的正整数 DC，已跳过。`); continue;
        }
        if (seen.has(skill.id)) { issues.push(`已跳过重复技能“${name}”。`); continue; }
        seen.add(skill.id);
        if (selected.length >= request.maxChecks) { issues.push('已忽略超过本轮上限的选择。'); continue; }
        selected.push({ 技能名: name, 对应事件: action, 判定条件: conditions, DC: item.DC, skillId: skill.id });
    }
    if (request.mode === 'every' && !selected.length) issues.push('每轮判定模式下，AI 尚未选择可用技能。');
    const reports = Array.isArray(value.本轮处理) ? value.本轮处理 : [];
    if (!Array.isArray(value.本轮处理)) issues.push('缺少本轮处理数组，检定采用情况未确认。');
    const checks = request.checks ?? [];
    for (const report of reports) {
        if (!checks.some(check => check.id === report?.检定ID)) issues.push('已忽略未知的检定ID。');
    }
    for (const check of checks) {
        const matches = reports.filter(report => report?.检定ID === check.id);
        const report = matches[0];
        if (matches.length !== 1 || !['采用检定', '延后检定', '叙事结算', '未执行'].includes(report?.处理) ||
            typeof report?.说明 !== 'string' || !report.说明.trim()) {
            issues.push(`“${check.name}”的处理缺失、重复或无效，采用情况未确认。`); continue;
        }
        if (report.处理 === '延后检定' && !selected.some(item => item.skillId === check.skillId)) {
            issues.push(`“${check.name}”声明延后但没有对应的下一轮选择，采用情况未确认。`); continue;
        }
        packet.本轮处理.push({ 检定ID: check.id, 处理: report.处理, 说明: report.说明.trim() });
    }
    packet.issues = [...new Set(issues)];
    return packet;
}

export function packetMatchesReply(packet, request, message, messageId) {
    const source = packet?._source;
    return !!message && packet?.请求ID === request?.id && source?.messageId === messageId &&
        source.swipeId === (message.swipe_id ?? 0) && source.fingerprint === replyFingerprint(message.mes);
}

export const skillPacket = variables => unwrap(unwrap(variables?.stat_data?.[SKILL_NAMESPACE])?.[SKILL_FIELD]);

export function readSkillSelection(chat, variables, settings, beforeId = chat.length) {
    let index = beforeId - 1;
    while (index >= 0 && chat[index]?.is_system) index--;
    const message = chat[index];
    if (!message || message.is_user) return { checks: [], issues: ['等待 AI 回复并选择下一轮技能。'] };
    const request = requestBefore(chat, index);
    if (!request) return { checks: [], issues: ['首次启用：下一次发送将让 AI 选择技能。'] };
    if (request.version !== SKILL_VERSION) return { checks: [], issues: ['旧版选择没有 DC，下一次发送将请求新的加值检定。'] };
    if (request.diceSides !== settings.diceSides) return { checks: [], issues: ['骰型已改变，旧骰型的 DC 已失效，等待 AI 重新选择。'] };
    const packet = skillPacket(variables);
    const source = packet?._source;
    if (packet?.规则版本 !== SKILL_VERSION || !packetMatchesReply(packet, request, message, index)) {
        return { checks: [], issues: ['当前回复尚无有效的 MVU 技能选择，或回复已被修改。'] };
    }
    const issues = Array.isArray(packet.issues) ? [...packet.issues] : [];
    const checks = [];
    const seen = new Set();
    const validated = validateSelection(packet, request);
    issues.push(...validated.issues);
    for (const item of validated.待判定) {
        const skill = settings.skills.find(skill => skill.id === item.skillId && skill.name.trim() === item.技能名);
        if (!skill) { issues.push(`“${item.技能名 || '未知技能'}”已删除或改名，本次跳过。`); continue; }
        if (seen.has(skill.id)) continue;
        seen.add(skill.id);
        if (checks.length >= settings.maxChecks) { issues.push('本次按当前检定上限执行。'); break; }
        checks.push({ skillId: skill.id, name: skill.name.trim(), modifier: skill.modifier,
            action: item.对应事件, conditions: item.判定条件, dc: item.DC });
    }
    return { checks, issues: [...new Set(issues)], source: { ...source, requestId: request.id } };
}

export function rollSkill(sides, modifier, dc, random = Math.random) {
    if (!SKILL_DICE.includes(sides) || !Number.isSafeInteger(modifier) || modifier < minSkillModifier(sides) || modifier > sides ||
        !Number.isSafeInteger(dc) || dc < 1) throw new RangeError('技能骰型、加值或 DC 无效');
    const sample = random();
    if (!(sample >= 0 && sample < 1)) throw new RangeError('随机源须返回 0（含）至 1（不含）之间的值。');
    const result = Math.floor(sample * sides) + 1;
    const total = result + modifier;
    return { sides, modifier, dc, result, total, passed: total >= dc };
}

export function createSkillTurn(settings, selection, random = Math.random, id = newSkillId()) {
    const results = selection.checks.map((check, i) => ({ ...check, id: `${id}:${i + 1}`,
        ...rollSkill(settings.diceSides, check.modifier, check.dc, random) }));
    return {
        request: { version: SKILL_VERSION, id, diceSides: settings.diceSides, mode: settings.mode, maxChecks: settings.maxChecks,
            skills: settings.skills.map(skill => ({ id: skill.id, name: skill.name.trim(), modifier: skill.modifier })),
            checks: results.map(({ id, skillId, name }) => ({ id, skillId, name })) },
        results,
        source: selection.source ?? null,
        issues: selection.issues,
        diceSides: settings.diceSides,
    };
}

export function skillPrompt(turn) {
    return turn.request.version === SKILL_VERSION ? dcSkillPrompt(turn) : legacySkillPrompt(turn);
}

export const skillFormula = result => `d${result.sides} 骰点 ${result.result} ＋ 加值（${signedModifier(result.modifier)}）＝ ${result.total} ${result.passed ? '≥' : '<'} DC ${result.dc}`;

export function skillBlocks(turn, stealth) {
    const legacy = turn.request.version !== SKILL_VERSION;
    const summary = turn.results.map(r => `> - ${r.name}｜${r.action}｜${legacy ? `d${r.sides} = ${r.result}，旧技能值 ${r.value}` : skillFormula(r)}：**候选${r.passed ? '通过' : '失败'}**`).join('\n');
    const display = !stealth && summary ? `\n\n> **${legacy ? '旧版' : ''}技能检定 · 待 AI 确认是否采用**\n${summary}` : '';
    // Selection instructions stay out of the rendered conversation, while remaining in the model input.
    return { display, block: `${display}\n\n<!--\n${skillPrompt(turn).replaceAll('--', '-&#45;')}\n-->` };
}
