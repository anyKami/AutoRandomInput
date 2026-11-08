import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultSkillValue, normalizeSkillSettings, randomizeSkillValues, recommendedPointLimit, skillErrors, skillPointTotal } from '../skills.js';
import { create5eSkillGroup, createSkillGroup, loadSkillGroup, normalizeSkillGroups, saveSkillGroup, skillGroupMatches } from '../skill-groups.js';

const sheet = (diceSides, pointLimit) => normalizeSkillSettings({ diceSides, pointLimit,
    skills: ['观察', '运动', '交涉'].map((name, index) => ({ id: `s${index}`, name, value: 0 })) });

for (const [sides, initial] of [[10, 6], [20, 13], [100, 66]]) {
    test(`d${sides} uses two-thirds defaults and never exceeds the per-skill cap`, () => {
        assert.equal(defaultSkillValue(sides), initial);
        const current = sheet(sides, Math.floor(sides * 3 * 2 / 3));
        assert.equal(recommendedPointLimit(current), current.pointLimit);
        for (const limit of [0, 1, sides, current.pointLimit, sides * 3, sides * 3 + 100]) {
            current.pointLimit = limit;
            for (const sample of [0, 0.5, 0.999999]) {
                const skills = randomizeSkillValues(current, () => sample);
                assert.equal(skillPointTotal({ skills }), Math.min(limit, sides * 3));
                assert.ok(skills.every(s => Number.isInteger(s.value) && s.value >= 0 && s.value <= sides));
                assert.deepEqual(skills.map(s => [s.id, s.name]), current.skills.map(s => [s.id, s.name]));
                assert.equal(skillPointTotal(current), 0);
            }
        }
    });
}

test('existing sheets retain their scores even when above the recommended default budget', () => {
    const current = normalizeSkillSettings({ diceSides: 20, skills: [{ name: '侦查', value: 20 }, { name: '隐匿', value: 20 }] });
    assert.equal(recommendedPointLimit(current), 26);
    assert.equal(current.pointLimit, 40);
    assert.equal(skillErrors(current).length, 0);
    const restored = normalizeSkillSettings(JSON.parse(JSON.stringify(current)));
    assert.deepEqual(restored, current);
});

test('a custom zero limit is retained; invalid limits and overspending are reported, not clamped', () => {
    const current = sheet(20, 0);
    assert.equal(normalizeSkillSettings(current).pointLimit, 0);
    current.skills[0].value = 1;
    assert.match(skillErrors(current).join(), /合计 1 超过.*0/);
    for (const value of [null, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
        current.pointLimit = value;
        assert.match(skillErrors(current).join(), /上限须为非负整数/);
        assert.throws(() => randomizeSkillValues(current), RangeError);
    }
    assert.throws(() => randomizeSkillValues(sheet(20, 1), () => 1), RangeError);
});

test('the 5e sample budget is 240; a feasible random distribution spends it without exceeding 20', () => {
    const group = create5eSkillGroup();
    assert.equal(group.pointLimit, 240);
    assert.equal(skillPointTotal(group), 234);
    let state = 17;
    const random = () => ((state = Math.imul(state, 1664525) + 1013904223 >>> 0) / 2 ** 32);
    const skills = randomizeSkillValues(group, random);
    assert.equal(skillPointTotal({ skills }), 240);
    assert.ok(skills.every(s => s.value >= 0 && s.value <= 20));
    assert.ok(new Set(skills.map(s => s.value)).size > 1);
});

test('groups persist custom point budgets and loaded chats stay independent', () => {
    const group = createSkillGroup('测试组', sheet(100, 120));
    const library = { groups: [group] };
    const a = loadSkillGroup(normalizeSkillSettings(), group);
    const b = loadSkillGroup(normalizeSkillSettings(), group);
    a.pointLimit = 150; a.skills = randomizeSkillValues(a, () => 0);
    assert.equal(skillGroupMatches(a, group), false);
    saveSkillGroup(library, group.id, a);
    assert.equal(group.pointLimit, 150);
    assert.equal(b.pointLimit, 120);
    assert.equal(skillPointTotal(b), 0);
    assert.equal(normalizeSkillGroups(JSON.parse(JSON.stringify(library))).groups[0].pointLimit, 150);
    a.pointLimit = 100;
    assert.throws(() => saveSkillGroup(library, group.id, a), /超过/);
});
