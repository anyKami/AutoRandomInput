import { dcSkillPrompt } from './skill-prompt.js';
import { legacySkillPrompt } from './skill-legacy.js';

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
    if (typeof value.freshSelectionSkillId === 'string' && value.freshSelectionSkillId) config.freshSelectionSkillId = value.freshSelectionSkillId;
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

export function requestBefore(chat, messageId) {
    for (let i = messageId - 1; i >= 0; i--) {
        if (chat[i]?.is_system) continue;
        if (chat[i]?.is_user) return chat[i].extra?.auto_random_input?.skills?.request ?? null;
    }
    return null;
}

export function validateSelection(value, request = {}) {
    const issues = [];
    const packet = { 规则版本: SKILL_VERSION, 请求ID: value?.请求ID ?? request.id ?? '', 本轮处理: [], 待判定: [], issues };
    if (!isObject(value)) {
        issues.push('MVU 尚未提供待判定技能。');
        return packet;
    }
    for (const item of Array.isArray(value.待判定) ? value.待判定 : []) {
        const name = typeof item?.技能名 === 'string' ? item.技能名.trim() : '';
        const action = typeof item?.对应事件 === 'string' ? item.对应事件.trim() : name;
        const conditions = typeof item?.判定条件 === 'string' ? item.判定条件.trim() : '';
        const dc = typeof item?.DC === 'string' && item.DC.trim() ? Number(item.DC) : item?.DC;
        if (!name || !Number.isFinite(dc)) {
            issues.push(`“${name || '未命名技能'}”缺少技能名或数值 DC，无法投骰。`); continue;
        }
        const skill = request.skills?.find(skill => skill.id === item.skillId || skill.name === name);
        packet.待判定.push({ 技能名: name, 对应事件: action, 判定条件: conditions, DC: dc, skillId: skill?.id ?? item.skillId ?? name });
    }
    packet.本轮处理 = (Array.isArray(value.本轮处理) ? value.本轮处理 : []).filter(isObject)
        .map(report => ({ 检定ID: report.检定ID, 处理: report.处理 ?? '采用检定', 说明: report.说明 ?? '' }));
    return packet;
}

export const skillPacket = variables => unwrap(unwrap(variables?.stat_data?.[SKILL_NAMESPACE])?.[SKILL_FIELD]);

export function readSkillSelection(chat, variables, settings, beforeId = chat.length) {
    const packet = skillPacket(variables);
    const previousRequest = requestBefore(chat, beforeId);
    if (settings.freshSelectionSkillId && !previousRequest?.skills?.some(skill => skill.id === settings.freshSelectionSkillId)) {
        return { checks: [], issues: ['已载入新的神谕技能表，下一次发送将请求新的技能选择。'], source: null };
    }
    const request = previousRequest ?? settings;
    const validated = validateSelection(packet, request);
    const checks = validated.待判定.slice(0, settings.maxChecks).map(item => {
        const skill = settings.skills.find(skill => skill.id === item.skillId) ?? settings.skills.find(skill => skill.name.trim() === item.技能名);
        const modifier = Number(skill?.modifier);
        return { skillId: skill?.id ?? item.skillId, name: skill?.name.trim() || item.技能名, modifier: Number.isFinite(modifier) ? modifier : 0,
            action: item.对应事件, conditions: item.判定条件, dc: item.DC };
    });
    return { checks, issues: validated.issues, source: packet?._source ?? null };
}

export function rollSkill(sides, modifier, dc, random = Math.random) {
    if (!SKILL_DICE.includes(sides) || !Number.isFinite(modifier) || !Number.isFinite(dc)) throw new RangeError('技能骰型、加值或 DC 无法用于计算');
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
