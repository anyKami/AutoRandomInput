import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createGroup, createRule, normalizeSettings } from '../core.js';
import { createSkillGroup, loadSkillGroup, normalizeSkillGroups } from '../skill-groups.js';
import { normalizeSkillSettings } from '../skills.js';
import { importConfigBundle, parseConfigFile, previewConfigImport, serializeConfigFile, validateConfigBundle } from '../config-transfer.js';

const exampleText = await readFile(new URL('../templates/config-example.json', import.meta.url), 'utf8');
const example = () => JSON.parse(exampleText);
const stores = () => ({ random: normalizeSettings(), skills: normalizeSkillGroups() });
const ids = groups => groups.flatMap(group => [group.id, ...(group.rules ?? group.skills).map(item => item.id)]);

test('downloadable mixed example validates and expands commands without losing range gaps or blanks', () => {
    const config = parseConfigFile('\uFEFF' + exampleText);
    assert.equal(config.randomGroups[0].rules[0].commands.length, 20);
    assert.equal(config.randomGroups[0].rules[0].commands[19], '');
    assert.equal(config.randomGroups[0].rules[1].ranges[1].command, '');
    assert.equal(config.skillGroups[0].skills[0].modifier, 4);
});

test('mixed round trip preserves order, disabled rules, Chinese multiline text, negative modifiers and hidden drafts', () => {
    const rule = createRule('隐藏内容', { enabled: false, diceSides: 2,
        commands: ['中文\n第二行 "引号" \\ 路径', ' ', ...Array(17).fill(''), '第二十条'],
        ranges: [{ range: '编辑中的草稿', command: '暂未完成' }] });
    const group = createGroup('往返', { rules: [rule, createRule('范围', { diceSides: 100,
        commands: ['旧骰型命令'], ranges: [{ range: '3-8', command: '事件' }, { range: '10', command: '' }] })] });
    const skill = createSkillGroup('往返', { version: 2, diceSides: 20, mode: 'every', maxChecks: 3,
        pointLimitMode: 'custom', pointLimit: 5, skills: [{ name: '观察', modifier: 8 }, { name: '交涉', modifier: -3 }] });
    const { random, skills } = stores();
    const text = serializeConfigFile([group], [skill]);
    const imported = importConfigBundle(parseConfigFile(text), random, skills);
    assert.equal(serializeConfigFile(imported.randomGroups, imported.skillGroups), text);
    assert.equal(imported.skillGroups[0].version, 2);
    assert.equal(imported.skillGroups[0].skills[0].modifier, 8);
    assert.equal(imported.randomGroups[0].rules[0].commands[19], '第二十条');
    assert.equal(imported.randomGroups[0].rules[0].ranges[0].range, '编辑中的草稿');
    assert.ok(ids([...imported.randomGroups, ...imported.skillGroups]).every(id => !ids([group, skill]).includes(id)));
});

test('current edited sheet exports unsaved changes without modifying its saved group or current state', () => {
    const saved = createSkillGroup('探索', { ...example().skillGroups[0], version: 2 });
    const current = loadSkillGroup(normalizeSkillSettings({ enabled: true }), saved);
    current.skills[0].modifier = 3;
    current.maxChecks = 2;
    current.migrationSnapshot = { private: '不应分享' };
    const before = JSON.stringify({ saved, current });
    const exported = parseConfigFile(serializeConfigFile([], [{ ...current, name: '分享用名称' }]));
    assert.equal(exported.skillGroups[0].skills[0].modifier, 3);
    assert.equal(exported.skillGroups[0].maxChecks, 2);
    assert.equal(exported.skillGroups[0].name, '分享用名称');
    assert.equal(parseConfigFile(serializeConfigFile([], [saved])).skillGroups[0].skills[0].modifier, 4);
    assert.equal(JSON.stringify({ saved, current }), before);
    for (const field of ['id', 'groupId', 'enabled', 'version', 'migrationSnapshot']) {
        assert.equal(Object.hasOwn(exported.skillGroups[0], field), false);
    }
    assert.equal(Object.hasOwn(exported.skillGroups[0].skills[0], 'id'), false);
});

test('repeat imports reserve names within each library and batch without switching settings or editing existing objects', () => {
    const { random, skills } = stores();
    const existing = random.groups[0];
    const active = random.activeGroupId;
    const options = { enabled: random.enabled, theme: random.theme, stealthMode: random.stealthMode, includeRollResult: random.includeRollResult };
    const bundle = example();
    bundle.randomGroups.push(structuredClone(bundle.randomGroups[0]));
    const preview = previewConfigImport(bundle, random.groups, skills.groups);
    assert.deepEqual(preview.randomGroups.map(group => group.name), ['剧情示例', '剧情示例 2']);
    assert.equal(random.groups.length, 1);
    assert.equal(bundle.randomGroups[1].name, '剧情示例');
    const first = importConfigBundle(bundle, random, skills);
    const second = importConfigBundle(bundle, random, skills);
    assert.deepEqual(second.randomGroups.map(group => group.name), ['剧情示例 3', '剧情示例 4']);
    assert.equal(second.skillGroups[0].name, '探索技能 2');
    const allIds = ids([...first.randomGroups, ...first.skillGroups, ...second.randomGroups, ...second.skillGroups]);
    assert.equal(new Set(allIds).size, allIds.length);
    assert.equal(random.groups[0], existing);
    assert.equal(random.activeGroupId, active);
    for (const [key, value] of Object.entries(options)) assert.equal(random[key], value);
    second.skillGroups[0].skills[0].modifier = 1;
    assert.equal(first.skillGroups[0].skills[0].modifier, 4);
});

test('optional fields have documented defaults; current auto budget is recalculated', () => {
    const bundle = example();
    delete bundle.randomGroups[0].rules[0].enabled;
    const group = bundle.skillGroups[0];
    for (const key of ['mode', 'maxChecks', 'pointLimitMode', 'pointLimit']) delete group[key];
    const validated = validateConfigBundle(bundle);
    assert.equal(validated.randomGroups[0].rules[0].enabled, true);
    assert.equal(validated.skillGroups[0].mode, 'challenge');
    assert.equal(validated.skillGroups[0].maxChecks, 1);
    assert.equal(validated.skillGroups[0].pointLimitMode, 'auto');
    assert.equal(validated.skillGroups[0].pointLimit, 6);
    group.pointLimitMode = 'auto'; group.pointLimit = 999;
    assert.equal(validateConfigBundle(bundle).skillGroups[0].pointLimit, 6);
    for (const key of ['randomGroups', 'skillGroups']) {
        const single = example(); delete single[key];
        assert.doesNotThrow(() => validateConfigBundle(single));
    }
});

const invalidCases = [
    ['wrong format', b => { b.format = 'other'; }, /format/],
    ['unsupported version', b => { b.formatVersion = 2; }, /formatVersion/],
    ['string version', b => { b.formatVersion = '1'; }, /formatVersion/],
    ['empty file', b => { b.randomGroups = []; b.skillGroups = []; }, /至少/],
    ['bad group container', b => { b.randomGroups = null; }, /数组/],
    ['null group', b => { b.randomGroups = [null]; }, /对象/],
    ['empty group name', b => { b.skillGroups[0].name = ' '; }, /名称/],
    ['empty rules', b => { b.randomGroups[0].rules = []; }, /至少/],
    ['invalid random die', b => { b.randomGroups[0].rules[0].diceSides = 12; }, /diceSides/],
    ['invalid flag', b => { b.randomGroups[0].rules[0].enabled = 'false'; }, /enabled/],
    ['too many commands', b => { b.randomGroups[0].rules[0].commands = Array(21).fill(''); }, /20/],
    ['invalid command', b => { b.randomGroups[0].rules[0].commands = [null]; }, /命令 1/],
    ['invalid range shape', b => { b.randomGroups[0].rules[0].ranges = [{ range: 3, command: '' }]; }, /range/],
    ['overlapping ranges', b => { b.randomGroups[0].rules[1].ranges[1].range = '20-100'; }, /重叠/],
    ['reversed range', b => { b.randomGroups[0].rules[1].ranges[0].range = '20-1'; }, /第 1 行/],
    ['invalid skill die', b => { b.skillGroups[0].diceSides = 6; }, /diceSides/],
    ['invalid mode', b => { b.skillGroups[0].mode = 'other'; }, /mode/],
    ['invalid maxChecks', b => { b.skillGroups[0].maxChecks = 4; }, /maxChecks/],
    ['invalid budget mode', b => { b.skillGroups[0].pointLimitMode = 'other'; }, /pointLimitMode/],
    ['negative budget', b => { b.skillGroups[0].pointLimit = -1; }, /pointLimit/],
    ['missing custom budget', b => { delete b.skillGroups[0].pointLimit; }, /pointLimit/],
    ['no skills', b => { b.skillGroups[0].skills = []; }, /至少/],
    ['duplicate skill names', b => { b.skillGroups[0].skills[1].name = ' 察觉 '; }, /重复/],
    ['missing modifier', b => { delete b.skillGroups[0].skills[0].modifier; }, /modifier/],
    ['string modifier', b => { b.skillGroups[0].skills[0].modifier = '4'; }, /modifier/],
    ['fractional modifier', b => { b.skillGroups[0].skills[0].modifier = 1.5; }, /modifier/],
    ['modifier below range', b => { b.skillGroups[0].skills[0].modifier = -5; }, /加值/],
    ['overspent budget', b => { b.skillGroups[0].skills[0].modifier = 5; }, /超过/],
];
for (const [name, change, error] of invalidCases) {
    test(`invalid ${name} rejects the complete import and export without changing either library`, () => {
        const bundle = example(); change(bundle);
        const { random, skills } = stores();
        const before = JSON.stringify({ random, skills });
        assert.throws(() => importConfigBundle(bundle, random, skills), error);
        assert.equal(JSON.stringify({ random, skills }), before);
        if (bundle.format === 'auto-random-input' && bundle.formatVersion === 1) {
            assert.throws(() => serializeConfigFile(bundle.randomGroups, bundle.skillGroups), error);
        }
    });
}

test('invalid JSON and non-object roots have readable errors; extra fields cannot enter configuration state', () => {
    for (const text of ['', '{', '{"a":1,}']) assert.throws(() => parseConfigFile(text), /JSON/);
    for (const text of ['null', '[]', '3']) assert.throws(() => parseConfigFile(text), /根节点/);
    const bundle = example();
    bundle.theme = 'paper'; bundle.chat = ['private']; bundle.activeGroupId = 'external';
    bundle.skillGroups[0].migrationSnapshot = { note: 'private' };
    const parsed = parseConfigFile(JSON.stringify(bundle));
    assert.deepEqual(Object.keys(parsed), ['format', 'formatVersion', 'randomGroups', 'skillGroups']);
    assert.equal(Object.hasOwn(parsed.skillGroups[0], 'migrationSnapshot'), false);
    const { random, skills } = stores();
    importConfigBundle(parsed, random, skills);
    assert.equal(random.theme, 'navy');
});
