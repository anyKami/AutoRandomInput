import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSkillSettings, skillDcOffset, createSkillTurn, rollSkill, skillFormula, skillOutcome, skillPrompt } from '../skills.js';
import { createSkillGroup, loadSkillGroup, skillGroupMatches } from '../skill-groups.js';
import { SKILL_REPORTS_KEY, collectSkillStatistics, reportsForSkillTurn } from '../skill-stats.js';
import { validateConfigBundle, serializeConfigFile, parseConfigFile } from '../config-transfer.js';

const base = (patch = {}) => normalizeSkillSettings({
    version: 2, enabled: true, diceSides: 20,
    skills: [{ id: 'lock', name: '开锁', modifier: 3 }], ...patch,
});

test('default settings use ordinary difficulty and enabled natural criticals without migrating v2 sheets', () => {
    const config = base();
    assert.equal(config.version, 2);
    assert.equal(config.difficulty, 'normal');
    assert.equal(config.criticalEnabled, true);
    assert.deepEqual(normalizeSkillSettings(config), config);
    assert.equal(normalizeSkillSettings({ ...config, difficulty: '__invalid', criticalEnabled: 'false' }).difficulty, 'normal');
    assert.equal(normalizeSkillSettings({ ...config, criticalEnabled: 'false' }).criticalEnabled, true);
    assert.equal(normalizeSkillSettings({ ...config, criticalEnabled: false }).criticalEnabled, false);
});

test('all five DC difficulties scale exactly between d10, d20 and d100', () => {
    const values = [
        ['easy', -1, -2, -10], ['normal', 0, 0, 0], ['harder', 1, 2, 10],
        ['hard', 2, 4, 20], ['extreme', 3, 6, 30],
    ];
    for (const [difficulty, d10, d20, d100] of values) {
        assert.equal(skillDcOffset(10, difficulty), d10);
        assert.equal(skillDcOffset(20, difficulty), d20);
        assert.equal(skillDcOffset(100, difficulty), d100);
    }
    assert.equal(skillDcOffset(20, 'unknown'), 0);
});

test('difficulty affects only new rolls, preserving original DC and saved results', () => {
    const config = base({ difficulty: 'hard', criticalEnabled: false });
    const check = { skillId: 'lock', name: '开锁', modifier: 3, dc: 15, action: '开门', conditions: '' };
    const selection = { checks: [check], issues: [] };
    const turn = createSkillTurn(config, selection, () => 0.5, 'turn');
    assert.equal(check.dc, 15);
    assert.equal(turn.results[0].originalDc, 15);
    assert.equal(turn.results[0].dcOffset, 4);
    assert.equal(turn.results[0].dc, 19);
    assert.equal(turn.results[0].passed, false);
    assert.match(skillFormula(turn.results[0]), /DC 19.*原始 DC 15.*\+4/);
    const snapshot = JSON.stringify(turn);
    config.difficulty = 'easy';
    assert.equal(JSON.stringify(turn), snapshot);
    assert.match(skillPrompt(turn), /普通难度选择下一轮的原始 DC/);
});

for (const sides of [10, 20, 100]) {
    test(`d${sides} natural extremes override DC only when enabled`, () => {
        const minimum = rollSkill(sides, sides, 0, () => 0, true);
        assert.equal(minimum.numericPassed, true);
        assert.equal(minimum.critical, 'failure');
        assert.equal(minimum.passed, false);
        assert.equal(skillOutcome(minimum), '大失败');
        const maximum = rollSkill(sides, -sides, sides * 2, () => 0.999999, true);
        assert.equal(maximum.numericPassed, false);
        assert.equal(maximum.critical, 'success');
        assert.equal(maximum.passed, true);
        assert.equal(skillOutcome(maximum), '大成功');
        assert.match(skillFormula(maximum), /</, 'formula must retain arithmetic rather than rewrite comparison');
        assert.equal(rollSkill(sides, sides, 0, () => 0, false).passed, true);
        assert.equal(rollSkill(sides, -sides, sides * 2, () => 0.999999, false).passed, false);
        const ordinary = rollSkill(sides, 0, Math.floor(sides / 2), () => 0.5, true);
        assert.equal(ordinary.critical, null);
    });
}

test('skill group snapshots and portable config round trip include difficulty and critical switch', () => {
    const group = createSkillGroup('A', base({ difficulty: 'extreme', criticalEnabled: false }));
    const loaded = loadSkillGroup(base(), group);
    assert.equal(loaded.difficulty, 'extreme');
    assert.equal(loaded.criticalEnabled, false);
    assert.equal(skillGroupMatches(loaded, group), true);
    const json = serializeConfigFile([], [group]);
    const restored = parseConfigFile(json).skillGroups[0];
    assert.equal(restored.difficulty, 'extreme');
    assert.equal(restored.criticalEnabled, false);
    assert.throws(() => validateConfigBundle({
        format: 'auto-random-input', formatVersion: 2, randomGroups: [],
        skillGroups: [{ ...restored, criticalEnabled: 'false' }],
    }), /criticalEnabled/);
});

const roll = (id, name, passed, skillId = 'lock') => ({ id, name, skillId, passed });
const user = (id, results) => ({ is_user: true, extra: { auto_random_input: { skills: {
    request: { id }, results,
} } } });
const ai = (swipe, requestId, reports) => ({ is_user: false, swipe_id: swipe, extra: {
    [SKILL_REPORTS_KEY]: { swipes: { [String(swipe)]: { requestId, reports } } },
} });
const report = (id, status) => ({ 检定ID: id, 处理: status });

test('stats count rolls but only explicitly adopted success and failure, preserving streaks', () => {
    const chat = [
        user('a', [roll('r1', '开锁', false), roll('r2', '开锁', true)]),
        ai(0, 'a', [report('r1', '采用检定'), report('r2', '未执行')]),
        user('b', [roll('r3', '开锁', false)]),
        ai(0, 'b', [report('r3', '采用检定')]),
        user('c', [roll('r4', '开锁', true)]),
        ai(0, 'c', [report('r4', '采用检定')]),
        user('d', [roll('r5', '开锁', false)]),
        ai(0, 'd', []),
        user('e', [roll('r6', '启锁', false)]),
        ai(0, 'e', [report('r6', '采用检定')]),
    ];
    let stat = collectSkillStatistics(chat)[0];
    assert.equal(stat.name, '启锁', 'stable skill ID survives rename');
    assert.equal(stat.uses, 6);
    assert.equal(stat.adopted, 4);
    assert.equal(stat.successes, 1);
    assert.equal(stat.successRate, 25);
    assert.equal(stat.longestFailureStreak, 2);
    assert.equal(stat.currentFailureStreak, 1);
    chat.splice(-2);
    stat = collectSkillStatistics(chat)[0];
    assert.equal(stat.adopted, 3, 'deleted messages no longer contribute');
    assert.equal(stat.currentFailureStreak, 0);
});

test('selected AI swipes isolate adoption reports without re-counting immutable rolls', () => {
    const answer = ai(0, 'u', [report('r', '采用检定')]);
    answer.extra[SKILL_REPORTS_KEY].swipes['1'] = { requestId: 'u', reports: [report('r', '未执行')] };
    const chat = [user('u', [roll('r', '开锁', false)]), answer];
    assert.equal(collectSkillStatistics(chat)[0].adopted, 1);
    answer.swipe_id = 1;
    assert.equal(collectSkillStatistics(chat)[0].adopted, 0);
    assert.equal(collectSkillStatistics(chat)[0].uses, 1);
    answer.swipe_id = 0;
    assert.equal(collectSkillStatistics(chat)[0].adopted, 1);
    const duplicate = user('u', [roll('r', '开锁', false)]);
    chat.push(duplicate, ai(0, 'u', [report('r', '采用检定')]));
    assert.equal(collectSkillStatistics(chat)[0].uses, 1, 'replayed roll ID cannot count twice');
});

test('missing reports, mismatched IDs and inherited MVU data cannot produce phantom adoption', () => {
    const chat = [user('new', [roll('new:1', '侦查', true, 'eye')]),
        ai(0, 'old', [report('new:1', '采用检定')])];
    assert.equal(collectSkillStatistics(chat)[0].adopted, 0);
    assert.equal(reportsForSkillTurn(chat, 0).found, false);
    const legacy = () => null;
    assert.equal(collectSkillStatistics(chat, legacy)[0].adopted, 0);
    chat[1].extra[SKILL_REPORTS_KEY].swipes[0] = { requestId: 'new', reports: [report('unrelated', '采用检定')] };
    assert.equal(collectSkillStatistics(chat)[0].adopted, 0);
});
