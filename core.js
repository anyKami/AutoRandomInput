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
        createRule('剧情变化', { diceSides: 6, commands: [
            '让一位意料之外的访客走进当前场景，并自然地加入对话。',
            '描写一个容易被忽略的环境细节，让它成为接下来的线索。',
            '让场景中的一位人物提出一个合理的小请求，增加互动机会。',
            '引入一个小小的意外，为当前互动增加变化，但保持情节自然。',
            '让一个符合当前场景的小物件成为互动的契机。',
            '让故事出现一个有意义的选择，把决定留给用户。',
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
    const id = newId();
    if (stealth) {
        // HTML comments must never contain a closing delimiter, including --!>.
        const escaped = command.replaceAll('--', '-&#45;');
        return { block: `\n\n<!-- ARI:${id}\n${escaped}\n/ARI:${id} -->`, display: '' };
    }
    const display = `\n\n> **随机指令**\n> ${command.split('\n').join('\n> ')}`;
    return { block: `\n\n<!-- ARI:${id} -->${display}\n<!-- /ARI:${id} -->`, display };
}

// Match the exact recorded fragment, never generic HTML comments or another plugin's tags.
function replaceBlock(text, record, replacement = '') {
    if (!record?.block || typeof text !== 'string') return text;
    const start = text.lastIndexOf(record.block);
    if (start < 0) return text;
    return text.slice(0, start) + replacement + text.slice(start + record.block.length);
}

export function displayMessage(text, record) {
    return replaceBlock(text, record, record?.display ?? '');
}

export function processMessage(chat, messageId, settings, random = Math.random) {
    const message = chat[messageId];
    if (!settings.enabled || !message?.is_user || message.is_system ||
        typeof message.mes !== 'string' || !message.mes.trim() || message.extra?.[SETTINGS_KEY]) return null;

    const group = activeGroup(settings);
    const commands = [];
    const rolls = group.rules.filter(rule => rule.enabled).map(rule => {
        const result = rollDice(rule.diceSides, random);
        const command = rule.commands[result - 1];
        const skipped = !command.trim();
        if (!skipped) commands.push(settings.includeRollResult ? `${command}\n（投掷结果：d${rule.diceSides} = ${result}）` : command);
        return { ruleId: rule.id, ruleName: rule.name, result, sides: rule.diceSides, skipped };
    });
    const record = { groupId: group.id, groupName: group.name, rolls,
        ...makeBlock(commands.join('\n\n'), settings.stealthMode) };
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
    message.mes += record.block;
    if (record.block) delete message.extra.token_count;
    changedIds.push(messageId);
    return { changedIds, record };
}
