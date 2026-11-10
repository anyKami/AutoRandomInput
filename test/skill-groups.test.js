import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSkillSettings, createSkillTurn, validateSelection, readSkillSelection } from '../skills.js';
import { DND5E_SKILLS, SKILL_TEMPLATES, addSkillTemplate, createSkillTemplateGroup, normalizeSkillGroups, createSkillGroup, create5eSkillGroup, loadSkillGroup,
    saveSkillGroup, skillGroupMatches, uniqueSkillGroupName } from '../skill-groups.js';

const sheet = () => normalizeSkillSettings({ version: 2, pointLimit: 120, enabled: true, diceSides: 100, mode: 'every', maxChecks: 3,
    skills: [{ id: 'eye', name: '察觉', modifier: 55 }, { id: 'hide', name: '隐匿', modifier: 0 }] });

test('old chat skill sheets survive unchanged when the shared group library starts empty', () => {
    const old = sheet();
    assert.deepEqual(normalizeSkillGroups(), { version: 2, groups: [] });
    assert.deepEqual(normalizeSkillSettings(JSON.parse(JSON.stringify(old))), old);
    assert.equal(old.groupId, '');
});

test('5e sample has the 18 standard skills, editable modifier defaults and independent identities', () => {
    const first = create5eSkillGroup();
    const second = create5eSkillGroup();
    assert.equal(first.diceSides, 20);
    assert.equal(first.mode, 'challenge');
    assert.equal(first.maxChecks, 1);
    assert.deepEqual(first.skills.map(s => s.name), DND5E_SKILLS);
    assert.equal(new Set(first.skills.map(s => s.name)).size, 18);
    assert.ok(first.skills.every(s => s.modifier === 3));
    assert.equal(first.pointLimit, 54);
    assert.equal(first.skills.some(s => s.name === '撬锁'), false);
    assert.notEqual(first.id, second.id);
    assert.notEqual(first.skills[0].id, second.skills[0].id);
    first.skills[0].modifier = 1;
    assert.equal(second.skills[0].modifier, 3);
});

test('loading copies a snapshot, keeps the per-chat enable switch and isolates other chats', () => {
    const group = createSkillGroup('斥候', sheet());
    const a = loadSkillGroup(normalizeSkillSettings({ enabled: false }), group);
    const b = loadSkillGroup(sheet(), group);
    assert.deepEqual([a.enabled, a.diceSides, a.mode, a.maxChecks, a.groupId], [false, 100, 'every', 3, group.id]);
    assert.equal(b.enabled, true);
    assert.notEqual(a.skills[0].id, b.skills[0].id);
    a.skills[0].modifier = 1;
    a.skills.push({ id: 'x', name: '运动', modifier: 10 });
    assert.equal(group.skills[0].modifier, 55);
    assert.equal(b.skills[0].modifier, 55);
    assert.equal(group.skills.length, 2);
});

test('saving preserves group identity, survives serialization and does not alter loaded chats', () => {
    const group = createSkillGroup('斥候', sheet());
    const library = { groups: [group] };
    const a = loadSkillGroup(sheet(), group);
    const b = loadSkillGroup(sheet(), group);
    const skillId = a.skills[0].id;
    a.skills[0].modifier = 65; a.maxChecks = 2;
    saveSkillGroup(library, group.id, a);
    assert.equal(a.skills[0].id, skillId);
    assert.equal(b.skills[0].modifier, 55);
    const restored = normalizeSkillGroups(JSON.parse(JSON.stringify(library)));
    assert.deepEqual(restored.groups[0], group);
    assert.equal(group.name, '斥候');
    assert.equal(group.skills[0].modifier, 65);
    assert.equal(group.maxChecks, 2);
    assert.equal(Object.hasOwn(group, 'enabled'), false);
    assert.equal(Object.hasOwn(group, 'groupId'), false);
});

test('invalid edits cannot overwrite a saved group; changed die values are not clamped', () => {
    const group = createSkillGroup('斥候', sheet());
    const library = { groups: [group] };
    const original = JSON.stringify(group);
    const edited = loadSkillGroup(sheet(), group);
    edited.diceSides = 20;
    assert.throws(() => saveSkillGroup(library, group.id, edited), /-4～\+20/);
    assert.equal(edited.skills[0].modifier, 55);
    assert.equal(JSON.stringify(group), original);
    edited.diceSides = 100; edited.skills[1].name = '察觉';
    assert.throws(() => saveSkillGroup(library, group.id, edited), /重复/);
    assert.throws(() => saveSkillGroup(library, 'missing', sheet()), /先选择/);
});

test('loading a group keeps pending selections and uses the new sheet modifiers', () => {
    const current = sheet();
    const request = createSkillTurn(current, { checks: [], issues: [] }, Math.random, 'r').request;
    const chat = [{ is_user: true, extra: { auto_random_input: { skills: { request } } } }, { mes: '需要察觉', swipe_id: 0 }];
    const packet = validateSelection({ 规则版本: 2, 本轮处理: [], 请求ID: 'r', 待判定: [{ 技能名: '察觉', 对应事件: '发现跟踪者', 判定条件: '街道光线正常', DC: 50 }] }, request);
    const variables = { stat_data: { 随机指令工作台: { 技能判定: packet } } };
    assert.equal(readSkillSelection(chat, variables, current).checks.length, 1);
    const next = loadSkillGroup(current, createSkillGroup('同名技能表', current));
    next.skills[0].modifier = 7;
    assert.equal(readSkillSelection(chat, variables, next).checks.length, 1);
    assert.equal(readSkillSelection(chat, variables, next).checks[0].modifier, 7);
});

test('dirty comparison ignores runtime identities and enable state, but tracks all reusable settings', () => {
    const group = createSkillGroup('斥候', sheet());
    const current = loadSkillGroup(normalizeSkillSettings(), group);
    assert.ok(skillGroupMatches(current, group));
    current.enabled = !current.enabled;
    assert.ok(skillGroupMatches(current, group));
    current.skills[0].modifier++;
    assert.equal(skillGroupMatches(current, group), false);
    current.skills[0].modifier--; current.mode = 'challenge';
    assert.equal(skillGroupMatches(current, group), false);
});

test('duplicate sample additions receive distinct names without replacing existing groups', () => {
    const first = create5eSkillGroup();
    const library = { groups: [first] };
    const next = create5eSkillGroup();
    next.name = uniqueSkillGroupName(library, next.name); library.groups.push(next);
    assert.equal(next.name, '5e 标准技能 2');
    assert.equal(library.groups[0], first);
    const restored = normalizeSkillGroups({ groups: [null, first, first, { id: 'bad', name: ' ' }, next] });
    assert.equal(restored.groups.length, 2);
});

test('all 12 genre templates have distinct valid skills and independent editable snapshots', () => {
    assert.equal(SKILL_TEMPLATES.length, 12);
    assert.equal(new Set(SKILL_TEMPLATES.map(t => t.id)).size, 12);
    assert.ok(['日常', '修仙', '侦探'].every(name => SKILL_TEMPLATES.some(t => t.name === name)));
    for (const template of SKILL_TEMPLATES) {
        const group = createSkillTemplateGroup(template.id);
        assert.ok(group.skills.length >= 18 && group.skills.length <= 24);
        assert.equal(new Set(group.skills.map(s => s.name)).size, group.skills.length);
        assert.ok(group.skills.every(s => s.name.trim() && s.modifier === 3));
        assert.equal(group.pointLimit, group.skills.length * 3);
        assert.equal(group.diceSides, 20);
        group.skills[0].name = '修改的名称';
        assert.notEqual(createSkillTemplateGroup(template.id).skills[0].name, '修改的名称');
    }
    assert.throws(() => createSkillTemplateGroup('missing'), RangeError);
});

test('adding a selected template preserves existing content, names copies uniquely and rejects unknown templates', () => {
    const library = { groups: [createSkillGroup('日常', sheet())] };
    const original = JSON.stringify(library.groups[0]);
    const added = addSkillTemplate(library, 'daily');
    assert.equal(library.groups.length, 2);
    assert.equal(added.name, '日常 2');
    assert.equal(JSON.stringify(library.groups[0]), original);
    assert.equal(new Set(library.groups.map(g => g.id)).size, 2);
    const before = JSON.stringify(library);
    assert.throws(() => addSkillTemplate(library, 'missing'), RangeError);
    assert.equal(JSON.stringify(library), before);
});

test('unversioned legacy groups migrate once, including a recoverable original snapshot', () => {
    const old = { id: 'old', name: '旧配置组', diceSides: 20, mode: 'every', maxChecks: 2, pointLimit: 90,
        skills: [{ id: 'a', name: '观察', value: 20 }, { id: 'b', name: '隐匿', value: 0 }] };
    const library = normalizeSkillGroups({ version: 1, groups: [old] });
    const group = library.groups[0];
    assert.equal(library.version, 2);
    assert.equal(group.version, 2);
    assert.equal(group.name, old.name);
    assert.deepEqual(group.migrationSnapshot, old);
    assert.deepEqual(group.skills.map(s => s.modifier), [3, 3]);
    assert.equal(group.pointLimit, 6);
    assert.deepEqual(loadSkillGroup(normalizeSkillSettings(), old).skills.map(s => s.modifier), [3, 3]);
    group.skills[0].modifier = -4;
    assert.deepEqual(normalizeSkillGroups(JSON.parse(JSON.stringify(library))), library);
});
