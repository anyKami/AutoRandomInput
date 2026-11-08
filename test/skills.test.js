import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSkillSettings, skillErrors, validateSelection, readSkillSelection, rollSkill, createSkillTurn,
    skillPrompt, skillBlocks, replyFingerprint, minSkillModifier, skillFormula } from '../skills.js';

const skills = [{ id: 'lock', name: '撬锁', modifier: 3 }, { id: 'eye', name: '侦查', modifier: 20 }, { id: 'talk', name: '说服', modifier: -4 }];
const config = (patch = {}) => normalizeSkillSettings({ version: 2, enabled: true, pointLimit: 60, skills, ...patch });
const request = (patch = {}) => createSkillTurn(config(patch), { checks: [], issues: [] }, Math.random, 'r1').request;
const choice = (name, DC = 15) => ({ 技能名: name, 对应事件: `执行${name}`, 判定条件: '标准工具，无外界干扰', DC });
const packet = (items, req = request(), reports = []) => validateSelection({ 规则版本: 2, 请求ID: 'r1', 待判定: items, 本轮处理: reports }, req);
function fixture() {
    const req = request({ maxChecks: 3 });
    const chat = [{ is_user: true, mes: '行动', extra: { auto_random_input: { skills: { request: req } } } }, { mes: '剧情', swipe_id: 0 }];
    const p = packet(skills.map(s => choice(s.name)), req);
    p._source = { messageId: 1, swipeId: 0, fingerprint: replyFingerprint('剧情') };
    return { chat, p, data: { stat_data: { 随机指令工作台: { 技能判定: p } } } };
}

test('defaults, signed modifiers and invalid edits are explicit; switching dice never clamps', () => {
    const defaults = normalizeSkillSettings();
    assert.deepEqual([defaults.version, defaults.enabled, defaults.diceSides, defaults.mode, defaults.maxChecks], [2, false, 20, 'challenge', 1]);
    const changed = config({ diceSides: 10 });
    assert.equal(changed.skills[1].modifier, 20);
    assert.match(skillErrors(changed).join(), /-2～\+10/);
    assert.ok(skillErrors(config({ skills: [{ name: ' ', modifier: 1.2 }, { name: 'a', modifier: -5 }, { name: 'a', modifier: 21 }] })).length >= 5);
    assert.equal(skillErrors(config()).length, 0);
});

for (const sides of [10, 20, 100]) {
    test(`d${sides}: negative totals, equality, DC above die, no natural-1/maximum override`, () => {
        const minimum = minSkillModifier(sides);
        assert.deepEqual(rollSkill(sides, minimum, 1, () => 0), { sides, modifier: minimum, dc: 1, result: 1, total: 1 + minimum, passed: false });
        assert.equal(rollSkill(sides, sides, sides + 1, () => 0).passed, true);
        assert.equal(rollSkill(sides, sides, sides * 2, () => 0.999999).passed, true);
        assert.equal(rollSkill(sides, sides, sides * 2 + 1, () => 0.999999).passed, false);
        assert.equal(rollSkill(sides, 0, sides / 2, () => (sides / 2 - 1) / sides).passed, true);
        assert.equal(rollSkill(sides, 0, sides / 2 + 1, () => (sides / 2 - 1) / sides).passed, false);
        for (const modifier of [minimum - 1, sides + 1, 1.5, NaN]) assert.throws(() => rollSkill(sides, modifier, 5), RangeError);
        for (const dc of [0, -1, 1.5, '15', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => rollSkill(sides, 0, dc), RangeError);
        assert.throws(() => rollSkill(sides, 0, 5, () => 1), RangeError);
    });
}

for (const maxChecks of [1, 2, 3]) {
    test(`cap ${maxChecks}: preserve order, skip unknown and duplicates`, () => {
        const p = packet([choice('不存在'), choice('侦查'), choice('侦查'), choice('说服'), choice('撬锁')], request({ maxChecks }));
        assert.deepEqual(p.待判定.map(x => x.技能名), ['侦查', '说服', '撬锁'].slice(0, maxChecks));
        assert.match(p.issues.join(), /未知技能/);
        assert.match(p.issues.join(), /重复技能/);
    });
}

test('challenge/every counts, stale requests, missing conditions and invalid DC never become rolls', () => {
    assert.equal(packet([]).issues.length, 0);
    assert.match(packet([], request({ mode: 'every' })).issues.join(), /每轮判定/);
    assert.equal(validateSelection({ 规则版本: 2, 请求ID: 'old', 待判定: [choice('撬锁')] }, request()).待判定.length, 0);
    assert.equal(packet([{ ...choice('撬锁'), 判定条件: '' }]).待判定.length, 0);
    for (const dc of [undefined, null, '15', 0, -1, 2.5, NaN, Infinity]) assert.equal(packet([{ ...choice('撬锁'), DC: dc }]).待判定.length, 0);
    assert.match(skillPrompt(createSkillTurn(config({ mode: 'every' }), { checks: [], issues: [] })), /列表不能留空/);
});

test('selection binds request, active reply, swipe, dice and skill identity; current bonus is used', () => {
    const { chat, data, p } = fixture();
    const reloaded = JSON.parse(JSON.stringify({ chat, data }));
    assert.equal(readSkillSelection(reloaded.chat, reloaded.data, config({ maxChecks: 3 })).checks.length, 3);
    assert.equal(readSkillSelection(chat, data, config({ maxChecks: 1 })).checks.length, 1);
    assert.equal(readSkillSelection(chat, data, config({ skills: [{ ...skills[0], name: '开锁' }] })).checks.length, 0);
    const changed = config(); changed.skills[0].modifier = -3;
    assert.equal(readSkillSelection(chat, data, changed).checks[0].modifier, -3);
    assert.match(readSkillSelection(chat, data, config({ diceSides: 100 })).issues.join(), /骰型已改变/);
    chat[1].swipe_id = 1;
    assert.equal(readSkillSelection(chat, data, config()).checks.length, 0);
    chat[1].swipe_id = 0; chat[1].mes = '编辑后的剧情';
    assert.equal(readSkillSelection(chat, data, config()).checks.length, 0);
    chat[1].mes = '剧情<StatusPlaceHolderImpl/>';
    assert.equal(readSkillSelection(chat, data, config()).checks.length, 1);
    p.请求ID = 'expired';
    assert.equal(readSkillSelection(chat, data, config()).checks.length, 0);
});

test('mixed outcomes are immutable snapshots and prompt includes the complete model contract', () => {
    const { chat, data } = fixture();
    const cfg = config({ maxChecks: 3 });
    const samples = [0.55, 0.95, 0];
    const turn = createSkillTurn(cfg, readSkillSelection(chat, data, cfg), () => samples.shift(), 'r2');
    assert.deepEqual(turn.results.map(r => [r.result, r.total, r.passed]), [[12, 15, true], [20, 40, true], [1, -3, false]]);
    assert.deepEqual(turn.request.checks.map(c => c.id), ['r2:1', 'r2:2', 'r2:3']);
    cfg.skills[0].modifier = 1;
    assert.equal(turn.results[0].modifier, 3);
    const text = skillPrompt(turn);
    for (const rule of ['采用检定', '延后检定', '叙事结算', '未执行', '升高或降低', '不得依据骰点好坏', '其他随机剧情指令不得反转', '不得将旧骰点套用到新 DC', '0～3', '不得覆盖整个 stat_data']) assert.ok(text.includes(rule), rule);
    assert.ok(!text.includes('{{'));
    assert.ok(!text.includes('从技能表选取'));
    assert.ok(text.includes('</JSONPatch></UpdateVariable>'));
    assert.ok(text.includes('不能用 MVU、检定回报或规则说明凑字数'));
    assert.ok(skillBlocks(turn, false).display.includes('候选失败'));
    assert.equal(skillBlocks(turn, true).display, '');
    assert.match(skillFormula(turn.results[2]), /-4.*-3.*DC 15/);
    assert.equal(turn.source.swipeId, 0);
});

test('reports validate every candidate independently; deferred requires a valid next selection', () => {
    const req = request({ maxChecks: 3 });
    req.checks = skills.map((s, i) => ({ id: `c${i}`, skillId: s.id, name: s.name }));
    const report = (i, 处理 = '采用检定') => ({ 检定ID: `c${i}`, 处理, 说明: '目标和关键条件相符' });
    const p = packet([choice('侦查')], req, [report(0), report(1, '延后检定'), report(2, '叙事结算')]);
    assert.equal(p.本轮处理.length, 3);
    for (const disposition of ['未执行', '叙事结算', '采用检定']) assert.equal(packet([], req, [report(0, disposition)]).本轮处理[0].处理, disposition);
    const invalid = packet([choice('侦查')], req, [report(0), report(0), report(1, '延后检定'), report(2, '乱写'), { 检定ID: 'unknown', 处理: '采用检定', 说明: 'x' }]);
    assert.deepEqual(invalid.本轮处理.map(x => x.检定ID), ['c1']);
    assert.equal(invalid.待判定.length, 1);
    assert.match(invalid.issues.join(), /未确认/);
    assert.equal(packet([], req, [report(0, '延后检定')]).本轮处理.length, 0);
    const withoutNext = validateSelection({ 规则版本: 2, 请求ID: req.id, 本轮处理: [report(0)] }, req);
    assert.equal(withoutNext.本轮处理.length, 1);
    assert.equal(withoutNext.待判定.length, 0);
});

test('legacy history keeps threshold outcomes and is never consumed by a new DC send', () => {
    const legacy = { request: { id: 'old', skills: [{ id: 'lock', name: '撬锁', value: 13 }], mode: 'challenge', maxChecks: 1 },
        results: [{ name: '撬锁', action: '开门', sides: 20, result: 12, value: 13, passed: true }], diceSides: 20 };
    const saved = JSON.stringify(legacy);
    assert.match(skillPrompt(legacy), /骰点 ≤ 技能值/);
    assert.match(skillBlocks(legacy).display, /旧技能值 13/);
    assert.equal(JSON.stringify(legacy), saved);
    const chat = [{ is_user: true, extra: { auto_random_input: { skills: legacy } } }, { mes: '旧回复' }];
    assert.match(readSkillSelection(chat, {}, config()).issues.join(), /旧版选择没有 DC/);
});
