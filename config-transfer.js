import { createGroup, DICE_SIDES, MAX_COMMANDS, uniqueName, validateCommandRanges } from './core.js';
import { createSkillGroup } from './skill-groups.js';
import { isObject, recommendedPointLimit, skillErrors, SKILL_DICE, SKILL_VERSION } from './skills.js';

export const CONFIG_FORMAT = 'auto-random-input';
export const CONFIG_FORMAT_VERSION = 1;

function requireValue(condition, path, message) {
    if (!condition) throw new Error(`${path}：${message}`);
}

function nameOf(value, path) {
    requireValue(typeof value === 'string' && value.trim(), path, '名称不能为空，且须为文字。');
    return value.trim();
}

function arrayOf(value, path, optional = false) {
    if (optional && value === undefined) return [];
    requireValue(Array.isArray(value), path, '须为数组。');
    return value;
}

function randomGroup(group, index) {
    const path = `随机指令组 ${index + 1}`;
    requireValue(isObject(group), path, '须为对象。');
    const name = nameOf(group.name, path);
    const rules = arrayOf(group.rules, `“${name}”的 rules`);
    requireValue(rules.length > 0, `“${name}”`, '至少需要一套骰子指令。');
    return { name, rules: rules.map((rule, slot) => {
        const location = `“${name}”第 ${slot + 1} 套指令`;
        requireValue(isObject(rule), location, '须为对象。');
        const ruleName = nameOf(rule.name, location);
        requireValue(DICE_SIDES.includes(rule.diceSides), location, 'diceSides 须为 1–10、20 或 100。');
        requireValue(rule.enabled === undefined || typeof rule.enabled === 'boolean', location, 'enabled 须为 true 或 false。');
        const commands = arrayOf(rule.commands, `${location}的 commands`, true);
        requireValue(commands.length <= MAX_COMMANDS, location, `commands 最多 ${MAX_COMMANDS} 条。`);
        commands.forEach((command, i) => requireValue(typeof command === 'string', `${location}命令 ${i + 1}`, '须为文字，可留空。'));
        const ranges = arrayOf(rule.ranges, `${location}的 ranges`, true).map((row, i) => {
            requireValue(isObject(row) && typeof row.range === 'string' && typeof row.command === 'string',
                `${location}范围 ${i + 1}`, 'range 和 command 均须为文字。');
            return { range: row.range, command: row.command };
        });
        // Inactive range drafts must survive a round trip, just as they do in the editor.
        if (rule.diceSides === 100) {
            const validation = validateCommandRanges(ranges);
            requireValue(validation.valid, location, validation.errors.map(error => error.message).join('\n'));
        }
        return { name: ruleName, enabled: rule.enabled ?? true, diceSides: rule.diceSides,
            commands: Array.from({ length: MAX_COMMANDS }, (_, i) => commands[i] ?? ''), ranges };
    }) };
}

function skillGroup(group, index) {
    const path = `技能配置组 ${index + 1}`;
    requireValue(isObject(group), path, '须为对象。');
    const name = nameOf(group.name, path);
    const location = `技能配置组“${name}”`;
    requireValue(SKILL_DICE.includes(group.diceSides), location, 'diceSides 须为 10、20 或 100。');
    const mode = group.mode === undefined ? 'challenge' : group.mode;
    const maxChecks = group.maxChecks === undefined ? 1 : group.maxChecks;
    const pointLimitMode = group.pointLimitMode === undefined ? 'auto' : group.pointLimitMode;
    requireValue(['challenge', 'every'].includes(mode), location, 'mode 须为 challenge 或 every。');
    requireValue([1, 2, 3].includes(maxChecks), location, 'maxChecks 须为 1、2 或 3。');
    requireValue(['auto', 'custom'].includes(pointLimitMode), location, 'pointLimitMode 须为 auto 或 custom。');
    if (pointLimitMode === 'custom' || group.pointLimit !== undefined) {
        requireValue(Number.isSafeInteger(group.pointLimit) && group.pointLimit >= 0, location, 'pointLimit 须为非负整数。');
    }
    const skills = arrayOf(group.skills, `${location}的 skills`).map((skill, i) => {
        const position = `${location}第 ${i + 1} 项技能`;
        requireValue(isObject(skill), position, '须为对象。');
        const skillName = nameOf(skill.name, position);
        requireValue(Number.isSafeInteger(skill.modifier), position, 'modifier 须为整数加值。');
        return { name: skillName, modifier: skill.modifier };
    });
    const config = { name, diceSides: group.diceSides, mode, maxChecks, pointLimitMode, skills };
    config.pointLimit = pointLimitMode === 'auto' ? recommendedPointLimit(config) : group.pointLimit;
    const errors = skillErrors(config);
    requireValue(!errors.length, location, errors.join('\n'));
    return config;
}

// Whitelist portable fields. Do not normalize untrusted data or allocate IDs before validation.
export function validateConfigBundle(value) {
    requireValue(isObject(value), '配置文件', '根节点须为对象。');
    requireValue(value.format === CONFIG_FORMAT, '配置文件', `format 须为 ${CONFIG_FORMAT}。`);
    requireValue(value.formatVersion === CONFIG_FORMAT_VERSION, '配置文件', '仅支持 formatVersion 为 1 的文件。');
    const randomGroups = arrayOf(value.randomGroups, 'randomGroups', true).map(randomGroup);
    const skillGroups = arrayOf(value.skillGroups, 'skillGroups', true).map(skillGroup);
    requireValue(randomGroups.length + skillGroups.length > 0, '配置文件', '至少选择或填写一个配置组。');
    return { format: CONFIG_FORMAT, formatVersion: CONFIG_FORMAT_VERSION, randomGroups, skillGroups };
}

export function parseConfigFile(text) {
    let value;
    try { value = JSON.parse(text.replace(/^\uFEFF/, '')); }
    catch { throw new Error('配置文件不是有效的 JSON，请检查引号、逗号和括号。'); }
    return validateConfigBundle(value);
}

export function serializeConfigFile(randomGroups = [], skillGroups = []) {
    return JSON.stringify(validateConfigBundle({ format: CONFIG_FORMAT, formatVersion: CONFIG_FORMAT_VERSION,
        randomGroups, skillGroups }), null, 2) + '\n';
}

export function previewConfigImport(bundle, randomGroups, skillGroups) {
    const validated = validateConfigBundle(bundle);
    const rename = (incoming, existing) => {
        const reserved = existing.map(group => ({ name: group.name }));
        return incoming.map(group => {
            const name = uniqueName(reserved, group.name);
            reserved.push({ name });
            return { ...group, name };
        });
    };
    return { ...validated, randomGroups: rename(validated.randomGroups, randomGroups),
        skillGroups: rename(validated.skillGroups, skillGroups) };
}

export function importConfigBundle(bundle, randomSettings, skillLibrary) {
    const preview = previewConfigImport(bundle, randomSettings.groups, skillLibrary.groups);
    const randomGroups = preview.randomGroups.map(group => createGroup(group.name, group));
    // Construct saved groups using the current skill rules format.
    const skillGroups = preview.skillGroups.map(group => createSkillGroup(group.name, { ...group, version: SKILL_VERSION }));
    const nextRandom = [...randomSettings.groups, ...randomGroups];
    const nextSkills = [...skillLibrary.groups, ...skillGroups];
    randomSettings.groups = nextRandom;
    skillLibrary.groups = nextSkills;
    return { randomGroups, skillGroups };
}
