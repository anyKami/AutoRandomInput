import { SKILL_NARRATION_RULES } from './skill-prompt.js';

// Historical threshold batches retain their original contract when regenerated.
// New sends never consume their pending selections.
export function validateLegacySelection(value, request) {
    const issues = [];
    if (!value || value.请求ID !== request?.id || !Array.isArray(value.待判定)) {
        return { 请求ID: request?.id ?? '', 待判定: [], issues: ['AI 未返回本轮有效的旧版技能选择。'] };
    }
    const selected = [], seen = new Set();
    for (const item of value.待判定) {
        const name = typeof item?.技能名 === 'string' ? item.技能名.trim() : '';
        const action = typeof item?.对应事件 === 'string' ? item.对应事件.trim() : '';
        const skill = request.skills.find(skill => skill.name === name);
        if (!skill || !action || seen.has(skill.id) || selected.length >= request.maxChecks) continue;
        seen.add(skill.id);
        selected.push({ 技能名: name, 对应事件: action, skillId: skill.id });
    }
    if (request.mode === 'every' && !selected.length) issues.push('每轮判定模式下，AI 尚未选择可用技能。');
    return { 请求ID: request.id, 待判定: selected, issues };
}

export function legacySkillPrompt(turn) {
    const request = turn.request;
    const count = request.mode === 'every' ? `1～${request.maxChecks}` : `0～${request.maxChecks}`;
    return [
        '[随机指令工作台 · 旧版技能检定历史批次]',
        '这是历史消息的固定检定，按当时的骰点 ≤ 技能值规则恢复；不得改成加值与 DC 检定或重新投骰。',
        '先根据用户本轮真实行动，逐项判断以下检定是否适用。不相关或未执行的行动可以不使用结果，不要强行让用户执行预定行动。',
        ...turn.results.map((r, i) => `${i + 1}. 技能：${r.name}；对应事件：${r.action}；骰子：d${r.sides}；技能值：${r.value}；骰点：${r.result}；结果：${r.passed ? '通过' : '失败'}。`),
        '决定采用某项结果后，必须据此生成新剧情。通过就是该项行动通过，失败就是未达成该项目标；可合理推进后果，但不能反转结果。各项分别处理；对应行动的成败优先于其他随机剧情指令。禁止自行重掷、改骰点或改技能值。',
        SKILL_NARRATION_RULES,
        `完成本轮剧情后，仅从以下技能表选择 ${count} 项不同技能，说明下一轮的具体对应事件。没有明确挑战时，挑战模式允许空列表。`,
        `技能表：${JSON.stringify(request.skills.map(({ name, value }) => ({ 技能名: name, 技能值: value })))}`,
        `沿用角色卡 MVU 更新格式，将完整对象写入 随机指令工作台.技能判定（JSON Patch 路径 /随机指令工作台/技能判定）。请求ID必须为 ${JSON.stringify(request.id)}，待判定为包含技能名和对应事件的数组，不要输出 _source。保留角色卡原有变量更新。`,
    ].join('\n');
}
