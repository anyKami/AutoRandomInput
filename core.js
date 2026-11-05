export const SETTINGS_KEY = 'auto_random_input';
export const THEMES = { navy: '深海蓝', graphite: '石墨黑', forest: '森林绿', plum: '暮紫', paper: '暖白' };

// These are local identifiers, not security tokens; allow ordinary HTTP deployments too.
function newId() {
    return globalThis.crypto?.randomUUID?.() ?? `ari_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export function createRule(name, source) {
    return {
        id: newId(),
        name,
        enabled: source?.enabled !== false,
        diceSides: source?.diceSides ?? 10,
        commands: Array.from({ length: 10 }, (_, index) => source?.commands?.[index] ?? ''),
    };
}

export function createGroup(name, source) {
    return {
        id: newId(),
        name,
        rules: source?.rules?.map(rule => createRule(rule.name, rule)) ?? [createRule('骰子指令 1')],
    };
}

export function createSampleGroup() {
    const group = createGroup('通用剧情样板');
    group.rules = [
        createRule('自动肘击', { diceSides: 1, commands: [[
            '- 仅针对 <content></content> 标签内的内容生效：请生成2500字以上的长文。要求合并细碎段落，保持长短段错落有致，全文中“只有一句话的段落”上限为5个。',
            '- 必须在末尾输出最新 MVU。严禁复制旧数据或仅做简单更改！强行遍历所有规则清单，根据当前最新互动，对每一个变量进行深度重算。',
            '- 拒绝性格极端化！设定仅为“偏向”而非“绝对”。强制展现人物灰度，在合理情境中自然流露性格的模糊地带与细腻侧面。禁止生硬反转，打破非黑即白，深挖复杂人性的真实底色。',
        ].join('\n')] }),
        createRule('进展判定', { diceSides: 6, commands: [
            '让当前行动遭遇失败，未能达成预期目标，失败原因应符合已有情境。',
            '让当前行动遇到意料之外的阻力，需要克服新的障碍才能继续推进。',
            '让当前行动出现一点小问题，但整体仍能继续推进。',
            '让当前行动按预期推进，取得正常、合理的结果。',
            '让当前行动顺利推进，并带来一项小小的意外收获。',
            '让当前行动取得远超预期的成果，带来显著且合理的额外收益。',
        ] }),
        createRule('情绪氛围', { diceSides: 4, commands: [
            '让对话的氛围更加轻松，用自然的幽默拉近人物之间的距离。',
            '增加一点含蓄的紧张感，用停顿与眼神交流来表现。',
            '让人物坦诚地表达此刻的感受，保持情绪变化自然。',
            '为场景增添温暖的细节，展现人物彼此关心的一面。',
        ] }),
        createRule('叙事节奏', { diceSides: 3, commands: [
            '适当加快叙事节奏，推动情节进入下一个自然的节点。',
            '适当放慢节奏，细致描写动作与环境之间的互动。',
            '保持当前节奏，为用户的下一次回应留下空间。',
        ] }),
    ];
    return group;
}

export function normalizeSettings(value = {}) {
    const groups = (Array.isArray(value?.groups) ? value.groups : [])
        .filter(group => group && typeof group.id === 'string' && typeof group.name === 'string')
        .map(group => ({
            id: group.id,
            name: group.name,
            // Previous single-die groups become one rule without losing their hidden slots.
            rules: (Array.isArray(group.rules) && group.rules.length ? group.rules : [group]).map((rule, index) => ({
                id: typeof rule?.id === 'string' && rule !== group ? rule.id : newId(),
                name: typeof rule?.name === 'string' && rule !== group && rule.name.trim() ? rule.name : `骰子指令 ${index + 1}`,
                enabled: rule?.enabled !== false,
                diceSides: Number.isInteger(rule?.diceSides) && rule.diceSides >= 1 && rule.diceSides <= 10 ? rule.diceSides : 10,
                commands: Array.from({ length: 10 }, (_, slot) => typeof rule?.commands?.[slot] === 'string' ? rule.commands[slot] : ''),
            })),
        }));
    if (!groups.length) groups.push(createGroup('默认配置'));
    return {
        enabled: value?.enabled === true,
        stealthMode: value?.stealthMode === true,
        includeRollResult: value?.includeRollResult === true,
        theme: Object.hasOwn(THEMES, value?.theme) ? value.theme : 'navy',
        activeGroupId: groups.some(group => group.id === value?.activeGroupId) ? value.activeGroupId : groups[0].id,
        groups,
    };
}

export function activeGroup(settings) {
    return settings.groups.find(group => group.id === settings.activeGroupId) ?? settings.groups[0];
}

export function uniqueGroupName(settings, base) {
    return uniqueName(settings.groups, base);
}

export function uniqueName(items, base) {
    let name = base;
    for (let suffix = 2; items.some(item => item.name === name); suffix++) name = `${base} ${suffix}`;
    return name;
}

export function rollDice(sides, random = Math.random) {
    if (!Number.isInteger(sides) || sides < 1 || sides > 10) throw new RangeError('骰子面数必须为 1–10');
    return Math.floor(random() * sides) + 1;
}

function makeBlock(command, stealth) {
    if (!command.trim()) return { block: '', display: '' };
    if (stealth) {
        // HTML comments must never contain a closing delimiter, including --!>.
        const escaped = command.replaceAll('--', '-&#45;');
        return { block: `\n\n<!--\n${escaped}\n-->`, display: '' };
    }
    const display = `\n\n> **本轮指令**\n> ${command.split('\n').join('\n> ')}`;
    return { block: display, display };
}

// Match the exact recorded fragment, never generic HTML comments or another plugin's tags.
function replaceBlock(text, record, replacement = '') {
    if (!record?.block || typeof text !== 'string') return text;
    const start = text.lastIndexOf(record.block);
    if (start < 0 || text.indexOf(record.block) !== start) return text;
    return text.slice(0, start) + replacement + text.slice(start + record.block.length);
}

export function displayMessage(text, record) {
    return replaceBlock(text, record, record?.display ?? '');
}

export function createRollRecord(settings, random = Math.random) {
    const group = activeGroup(settings);
    const commands = [];
    const rolls = group.rules.filter(rule => rule.enabled).map(rule => {
        const result = rollDice(rule.diceSides, random);
        const command = rule.commands[result - 1];
        const skipped = !command.trim();
        if (!skipped) commands.push(settings.includeRollResult ? `${command}\n（投掷结果：d${rule.diceSides} = ${result}）` : command);
        return { ruleId: rule.id, ruleName: rule.name, result, sides: rule.diceSides, skipped };
    });
    return { groupId: group.id, groupName: group.name, rolls,
        ...makeBlock(commands.join('\n\n'), settings.stealthMode) };
}

export function processMessage(chat, messageId, settings, random = Math.random, preparedRecord = null) {
    const message = chat[messageId];
    if ((!settings.enabled && !preparedRecord) || !message?.is_user || message.is_system ||
        typeof message.mes !== 'string' || !message.mes.trim() || message.extra?.[SETTINGS_KEY]) return null;

    const record = preparedRecord ? { ...preparedRecord } : createRollRecord(settings, random);
    // Prepared commands have already passed through recall and the host's input processing.
    // If another processor rewrote them, retain the roll without appending or claiming new text.
    if (preparedRecord && record.block && !message.mes.includes(record.block)) {
        record.block = '';
        record.display = '';
    }
    const changedIds = [];

    chat.forEach((old, index) => {
        if (index === messageId || !old?.is_user || old.is_system) return;
        const previous = old.extra?.[SETTINGS_KEY];
        const cleaned = replaceBlock(old.mes, previous);
        if (cleaned === old.mes) return;
        old.mes = cleaned;
        previous.block = '';
        previous.display = '';
        delete old.extra.token_count;
        changedIds.push(index);
    });

    message.extra ??= {};
    message.extra[SETTINGS_KEY] = record;
    if (!preparedRecord) message.mes += record.block;
    if (record.block) delete message.extra.token_count;
    changedIds.push(messageId);
    return { changedIds, record };
}

export function removeLegacyMarkers(chat) {
    const changedIds = [];
    chat.forEach((message, index) => {
        if (!message?.is_user || message.is_system) return;
        const record = message.extra?.[SETTINGS_KEY];
        if (!record?.block) return;
        const visible = record.block.match(/^\n\n<!-- ARI:([^\s>]+) -->([\s\S]*)\n<!-- \/ARI:\1 -->$/);
        const hidden = record.block.match(/^\n\n<!-- ARI:([^\s>]+)\n([\s\S]*)\n\/ARI:\1 -->$/);
        if (!visible && !hidden) return;
        const block = visible ? visible[2] : `\n\n<!--\n${hidden[2]}\n-->`;
        const cleaned = replaceBlock(message.mes, record, block);
        if (cleaned === message.mes) return;
        message.mes = cleaned;
        record.block = block;
        record.display = visible ? block : '';
        delete message.extra.token_count;
        changedIds.push(index);
    });
    return changedIds;
}
