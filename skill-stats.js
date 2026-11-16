// Local statistics are derived from immutable user-message rolls and the selected
// swipe of each AI reply. Never use inherited MVU reports as new adoptions.
export const SKILL_REPORTS_KEY = 'auto_random_input_skill_reports';

export function skillReportsForReply(message, messageId, turn, legacyReport = null) {
    const saved = message?.extra?.[SKILL_REPORTS_KEY]?.swipes?.[String(message.swipe_id ?? 0)];
    if (saved && saved.requestId === turn?.request?.id) {
        return Array.isArray(saved.reports) ? saved.reports : [];
    }
    return legacyReport?.(message, messageId, turn) ?? null;
}

export function reportsForSkillTurn(chat, userIndex, legacyReport = null) {
    const turn = chat[userIndex]?.extra?.auto_random_input?.skills;
    if (!turn?.results?.length) return { reports: [], found: false };
    const checkIds = new Set(turn.results.map(result => result.id));
    const reports = new Map();
    let found = false;
    for (let i = userIndex + 1; i < chat.length; i++) {
        const message = chat[i];
        if (!message || message.is_system) continue;
        if (message.is_user) break;
        const provided = skillReportsForReply(message, i, turn, legacyReport);
        if (!Array.isArray(provided)) continue;
        found = true;
        for (const report of provided) {
            if (!report || !checkIds.has(report.检定ID) || typeof report.处理 !== 'string') continue;
            reports.set(report.检定ID, { 检定ID: report.检定ID, 处理: report.处理, 说明: typeof report.说明 === 'string' ? report.说明 : '' });
        }
    }
    return { reports: [...reports.values()], found };
}

// Scan the current visible chat branch, not chat-level lifetime counters.
// Duplicate send events and re-generations share the same saved roll IDs.
export function collectSkillStatistics(chat, legacyReport = null) {
    const bySkill = new Map();
    const seenRolls = new Set();
    for (let i = 0; i < chat.length; i++) {
        const message = chat[i];
        if (!message?.is_user || message.is_system) continue;
        const turn = message.extra?.auto_random_input?.skills;
        if (!Array.isArray(turn?.results) || !turn.results.length) continue;
        const { reports } = reportsForSkillTurn(chat, i, legacyReport);
        const adopted = new Set(reports.filter(report => report.处理 === '采用检定').map(report => report.检定ID));
        for (const result of turn.results) {
            if (!result || typeof result.id !== 'string' || seenRolls.has(result.id)) continue;
            seenRolls.add(result.id);
            const skillId = typeof result.skillId === 'string' && result.skillId ? result.skillId : '';
            const name = typeof result.name === 'string' ? result.name : '';
            const key = skillId ? `id:${skillId}` : `name:${name}`;
            if (!bySkill.has(key)) bySkill.set(key, { key, skillId, name, uses: 0, adopted: 0, successes: 0,
                longestFailureStreak: 0, currentFailureStreak: 0 });
            const stat = bySkill.get(key);
            if (name) stat.name = name;
            stat.uses++;
            if (!adopted.has(result.id)) continue;
            stat.adopted++;
            if (result.passed === true) {
                stat.successes++;
                stat.currentFailureStreak = 0;
            } else if (result.passed === false) {
                stat.currentFailureStreak++;
                stat.longestFailureStreak = Math.max(stat.longestFailureStreak, stat.currentFailureStreak);
            }
        }
    }
    return [...bySkill.values()].map(stat => ({ ...stat,
        successRate: stat.adopted ? stat.successes / stat.adopted * 100 : null }));
}
