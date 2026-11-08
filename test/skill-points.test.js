import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultSkillModifier, minSkillModifier, normalizeSkillSettings, randomizeSkillModifiers, recommendedPointLimit, skillErrors, skillPointTotal, syncSkillBudget } from '../skills.js';
import { create5eSkillGroup, createSkillGroup, loadSkillGroup, normalizeSkillGroups, saveSkillGroup, skillGroupMatches } from '../skill-groups.js';

const sheet = (diceSides, pointLimit) => normalizeSkillSettings({ version: 2, diceSides, pointLimit,
    skills: ['观察', '运动', '交涉'].map((name, index) => ({ id: `s${index}`, name, modifier: 0 })) });

for (const [sides, initial] of [[10, 2], [20, 3], [100, 15]]) {
    test(`d${sides}: scaled defaults, signed random allocation and individual bounds`, () => {
        assert.equal(defaultSkillModifier(sides), initial);
        const current = sheet(sides, initial * 3);
        assert.equal(recommendedPointLimit(current), current.pointLimit);
        for (const limit of [0, 1, sides, current.pointLimit, sides * 3, sides * 3 + 100]) {
            current.pointLimit = limit;
            for (const sample of [0, 0.5, 0.999999]) {
                const skills = randomizeSkillModifiers(current, () => sample);
                assert.equal(skillPointTotal({ skills }), Math.min(limit, sides * 3));
                assert.ok(skills.every(s => Number.isInteger(s.modifier) && s.modifier >= minSkillModifier(sides) && s.modifier <= sides));
                assert.deepEqual(skills.map(s => [s.id, s.name]), current.skills.map(s => [s.id, s.name]));
                assert.equal(skillPointTotal(current), 0);
            }
        }
        assert.ok(randomizeSkillModifiers(sheet(sides, 0), () => 0).some(s => s.modifier < 0));
    });
}

test('legacy sheets reset once to defaults and preserve exact independent migration snapshots', () => {
    for (const [diceSides, expected] of [[10, 2], [20, 3], [100, 15]]) {
        const old = { version: 1, diceSides, enabled: true, pointLimit: 999, skills: [{ id: 'a', name: '侦查', value: 0 }, { id: 'b', name: '隐匿', value: diceSides }] };
        const current = normalizeSkillSettings(old);
        assert.deepEqual(current.migrationSnapshot, old);
        assert.deepEqual(current.skills.map(s => s.modifier), [expected, expected]);
        assert.equal(current.pointLimit, expected * 2);
        assert.equal(current.pointLimitMode, 'auto');
        current.skills[0].modifier = -1;
        const restored = normalizeSkillSettings(JSON.parse(JSON.stringify(current)));
        assert.deepEqual(restored, current);
        assert.equal(old.skills[0].value, 0);
        assert.notEqual(restored.migrationSnapshot, current.migrationSnapshot);
    }
});

test('automatic budget follows count/die; custom budget stays fixed; negative modifiers refund points', () => {
    const current = normalizeSkillSettings();
    current.skills.push({ name: 'a', modifier: 3 }); syncSkillBudget(current);
    assert.equal(current.pointLimit, 3);
    current.skills.push({ name: 'b', modifier: -4 }); syncSkillBudget(current);
    assert.equal(current.pointLimit, 6);
    current.skills[0].modifier = 10;
    assert.equal(skillErrors(current).length, 0);
    current.pointLimitMode = 'custom'; current.pointLimit = 0;
    assert.match(skillErrors(current).join(), /合计 6 超过.*0/);
    current.diceSides = 100; syncSkillBudget(current);
    assert.equal(current.pointLimit, 0);
    assert.equal(current.skills[0].modifier, 10);
    current.pointLimitMode = 'auto'; syncSkillBudget(current);
    assert.equal(current.pointLimit, 30);
    current.skills.pop(); syncSkillBudget(current);
    assert.equal(current.pointLimit, 15);
});

test('invalid limits are reported, not clamped; empty randomization is safe', () => {
    const current = sheet(20, 0);
    assert.equal(normalizeSkillSettings(current).pointLimit, 0);
    for (const value of [null, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
        current.pointLimit = value;
        assert.match(skillErrors(current).join(), /预算须为非负整数/);
        assert.throws(() => randomizeSkillModifiers(current), RangeError);
    }
    assert.throws(() => randomizeSkillModifiers(sheet(20, 1), () => 1), RangeError);
    assert.deepEqual(randomizeSkillModifiers(normalizeSkillSettings()), []);
});

test('5e default is eighteen +3 modifiers and 54 points; randomization spends net budget', () => {
    const group = create5eSkillGroup();
    assert.equal(group.pointLimit, 54);
    assert.equal(skillPointTotal(group), 54);
    let state = 17;
    const random = () => ((state = Math.imul(state, 1664525) + 1013904223 >>> 0) / 2 ** 32);
    const skills = randomizeSkillModifiers(group, random);
    assert.equal(skillPointTotal({ skills }), 54);
    assert.ok(skills.every(s => s.modifier >= -4 && s.modifier <= 20));
    assert.ok(new Set(skills.map(s => s.modifier)).size > 1);
});

test('groups persist signed bonuses, custom budgets and independent loaded chats', () => {
    const group = createSkillGroup('测试组', sheet(100, 120));
    const library = { groups: [group] };
    const a = loadSkillGroup(normalizeSkillSettings(), group);
    const b = loadSkillGroup(normalizeSkillSettings(), group);
    a.pointLimit = 150; a.skills = randomizeSkillModifiers(a, () => 0);
    assert.equal(skillGroupMatches(a, group), false);
    saveSkillGroup(library, group.id, a);
    assert.equal(group.pointLimit, 150);
    assert.equal(b.pointLimit, 120);
    assert.equal(skillPointTotal(b), 0);
    assert.equal(normalizeSkillGroups(JSON.parse(JSON.stringify(library))).groups[0].pointLimit, 150);
    a.pointLimit = 100;
    assert.throws(() => saveSkillGroup(library, group.id, a), /超过/);
});
