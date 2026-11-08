export const SKILL_SETTINGS_KEY = 'auto_random_input_skills';
export const SKILL_DICE = [10, 20, 100];
export const SKILL_NAMESPACE = '随机指令工作台';
export const SKILL_FIELD = '技能判定';
export const SKILL_PATH = `${SKILL_NAMESPACE}.${SKILL_FIELD}`;

export const newSkillId = () => globalThis.crypto?.randomUUID?.() ?? `ari_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
export const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
export function unwrap(value) {
    return Array.isArray(value) && (value.length === 1 || value.length === 2 && typeof value[1] === 'string') ? unwrap(value[0]) : value;
}

export function normalizeSkillSettings(value = {}) {
    return {
        version: 1,
        enabled: value?.enabled === true,
        diceSides: SKILL_DICE.includes(value?.diceSides) ? value.diceSides : 20,
        mode: value?.mode === 'every' ? 'every' : 'challenge',
        maxChecks: [1, 2, 3].includes(value?.maxChecks) ? value.maxChecks : 1,
        skills: (Array.isArray(value?.skills) ? value.skills : []).filter(isObject).map(skill => ({
            id: typeof skill.id === 'string' && skill.id ? skill.id : newSkillId(),
            name: typeof skill.name === 'string' ? skill.name : '',
            value: skill.value ?? null,
        })),
    };
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
        if (!Number.isInteger(skill.value) || skill.value < 0 || skill.value > settings.diceSides) {
            errors.push(`“${name || `技能 ${index + 1}`}”的技能值须为 0～${settings.diceSides} 的整数。`);
        }
    }
    return errors;
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
    const issues = [];
    if (!isObject(value) || value.请求ID !== request?.id || !Array.isArray(value.待判定)) {
        return { 请求ID: request?.id ?? '', 待判定: [], issues: ['AI 未返回本轮有效的技能选择，等待下一次选择。'] };
    }
    const selected = [];
    const seen = new Set();
    for (const item of value.待判定) {
        const name = typeof item?.技能名 === 'string' ? item.技能名.trim() : '';
        const action = typeof item?.对应事件 === 'string' ? item.对应事件.trim() : '';
        const skill = request.skills.find(skill => skill.name === name);
        if (!skill || !action) { issues.push('已跳过未知技能或未说明对应事件的选择。'); continue; }
        if (seen.has(skill.id)) { issues.push(`已跳过重复技能“${name}”。`); continue; }
        seen.add(skill.id);
        if (selected.length >= request.maxChecks) { issues.push('已忽略超过本轮上限的选择。'); continue; }
        selected.push({ 技能名: name, 对应事件: action, skillId: skill.id });
    }
    if (request.mode === 'every' && !selected.length) issues.push('每轮判定模式下，AI 尚未选择可用技能。');
    return { 请求ID: request.id, 待判定: selected, issues: [...new Set(issues)] };
}

export function readSkillSelection(chat, variables, settings, beforeId = chat.length) {
    let index = beforeId - 1;
    while (index >= 0 && chat[index]?.is_system) index--;
    const message = chat[index];
    if (!message || message.is_user) return { checks: [], issues: ['等待 AI 回复并选择下一轮技能。'] };
    const request = requestBefore(chat, index);
    if (!request) return { checks: [], issues: ['首次启用：下一次发送将让 AI 选择技能。'] };
    const packet = unwrap(unwrap(variables?.stat_data?.[SKILL_NAMESPACE])?.[SKILL_FIELD]);
    const source = packet?._source;
    if (!packet || packet.请求ID !== request.id || source?.messageId !== index ||
        source.swipeId !== (message.swipe_id ?? 0) || source.fingerprint !== replyFingerprint(message.mes)) {
        return { checks: [], issues: ['当前回复尚无有效的 MVU 技能选择，或回复已被修改。'] };
    }
    const issues = Array.isArray(packet.issues) ? [...packet.issues] : [];
    const checks = [];
    const seen = new Set();
    for (const item of Array.isArray(packet.待判定) ? packet.待判定 : []) {
        const skill = settings.skills.find(skill => skill.id === item.skillId && skill.name.trim() === item.技能名);
        if (!skill) { issues.push(`“${item.技能名 || '未知技能'}”已删除或改名，本次跳过。`); continue; }
        if (seen.has(skill.id)) continue;
        seen.add(skill.id);
        if (checks.length >= settings.maxChecks) { issues.push('本次按当前检定上限执行。'); break; }
        checks.push({ skillId: skill.id, name: skill.name.trim(), value: skill.value, action: item.对应事件 });
    }
    return { checks, issues: [...new Set(issues)], source: { ...source, requestId: request.id } };
}

export function rollSkill(sides, value, random = Math.random) {
    if (!SKILL_DICE.includes(sides) || !Number.isInteger(value) || value < 0 || value > sides) throw new RangeError('技能骰型或技能值无效');
    const result = Math.floor(random() * sides) + 1;
    return { sides, value, result, passed: result <= value };
}

export function createSkillTurn(settings, selection, random = Math.random, id = newSkillId()) {
    return {
        request: { id, mode: settings.mode, maxChecks: settings.maxChecks,
            skills: settings.skills.map(skill => ({ id: skill.id, name: skill.name.trim(), value: skill.value })) },
        results: selection.checks.map(check => ({ ...check, ...rollSkill(settings.diceSides, check.value, random) })),
        source: selection.source ?? null,
        issues: selection.issues,
        diceSides: settings.diceSides,
    };
}

export function skillPrompt(turn) {
    const request = turn.request;
    const count = request.mode === 'every' ? `1～${request.maxChecks}` : `0～${request.maxChecks}`;
    const resultLines = turn.results.map((result, index) => `${index + 1}. 技能：${result.name}；对应事件：${result.action}；骰子：d${result.sides}；技能值：${result.value}；骰点：${result.result}；结果：${result.passed ? '通过' : '失败'}。`);
    return [
        '[随机指令工作台 2.0 · 技能检定]',
        '先根据用户本轮真实行动，逐项判断以下检定是否适用。不相关或未执行的行动可以不使用结果，不要强行让用户执行预定行动。',
        ...resultLines,
        turn.results.length ? '决定采用某项结果后，必须据此生成新剧情。通过就是该项行动通过，失败就是未达成该项目标；可合理推进后果，但不能反转结果。各项可分别采用，混合成败分别处理；对对应行动的成败，本结果优先于其他随机剧情指令。禁止自行重掷、改骰点或改技能值。' : '本轮没有可用的预先检定，正常回应用户，不得虚构骰点或成败。',
        '完成本轮剧情后，为下一次用户发言选择技能：',
        `统一骰型为 d${turn.diceSides}，骰点 ≤ 技能值通过，相等也通过。只有插件投骰，AI 不自行检定。`,
        `仅从以下技能表中按剧情相关性选 ${count} 项不同技能，每项说明具体对应事件；不要为了容易成功而挑技能。${request.mode === 'challenge' ? '没有明确的不确定行动或挑战时选择空列表。' : '有可用技能时，每轮至少选择一项。'}`,
        `技能表（用户维护，AI 不得更改）：${JSON.stringify(request.skills.map(({ name, value }) => ({ 技能名: name, 技能值: value })))}`,
        `请沿用角色卡的 MVU 更新格式，将下面结构的完整对象写入 ${SKILL_PATH}（JSON Patch 路径 /${SKILL_NAMESPACE}/${SKILL_FIELD}）。技能名必须与技能表完全一致，事件写简短说明。此处提供的是结构示例，不是让你固定选择空列表。`,
        JSON.stringify({ 请求ID: request.id, 待判定: [{ 技能名: '从技能表选取', 对应事件: '下一轮可能需要检定的具体行动' }] }),
        request.mode === 'every' ? '每轮判定模式：必须至少选择一项有效技能，待判定列表不能留空。'
            : `无需检定时也必须写入 {"请求ID":${JSON.stringify(request.id)},"待判定":[]}。`,
        '必须使用本次请求ID，不得沿用上一轮选择，不要输出 _source 或修改角色卡其他变量的规则。',
    ].join('\n');
}

export function skillBlocks(turn, stealth) {
    const summary = turn.results.map(result => `> - ${result.name}｜${result.action}｜d${result.sides} = ${result.result}，技能值 ${result.value}：**${result.passed ? '通过' : '失败'}**`).join('\n');
    const display = !stealth && summary ? `\n\n> **技能检定 · 由 AI 判断是否适用**\n${summary}` : '';
    // Selection instructions stay out of the rendered conversation, while remaining in the model input.
    return { display, block: `${display}\n\n<!--\n${skillPrompt(turn).replaceAll('--', '-&#45;')}\n-->` };
}
