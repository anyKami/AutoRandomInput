import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSkillSettings, skillErrors, validateSelection, readSkillSelection, rollSkill, createSkillTurn, skillPrompt, skillBlocks, replyFingerprint } from '../skills.js';

const skills = [{ id: 'lock', name: '撬锁', value: 10 }, { id: 'eye', name: '侦查', value: 20 }, { id: 'talk', name: '说服', value: 0 }];
const config = (patch = {}) => normalizeSkillSettings({ enabled: true, skills, ...patch });
const request = (patch = {}) => createSkillTurn(config(patch), { checks: [], issues: [] }, Math.random, 'r1').request;
const choice = name => ({ 技能名: name, 对应事件: `执行${name}` });
const packet = (items, req = request()) => validateSelection({ 请求ID: 'r1', 待判定: items }, req);
function fixture() {
    const chat = [{ is_user: true, mes: '行动', extra: { auto_random_input: { skills: { request: request({ maxChecks: 3 }) } } } }, { mes: '剧情', swipe_id: 0 }];
    const p = packet(skills.map(s => choice(s.name)), request({ maxChecks: 3 }));
    p._source = { messageId: 1, swipeId: 0, fingerprint: replyFingerprint('剧情') };
    return { chat, p, data: { stat_data: { 随机指令工作台: { 技能判定: p } } } };
}

test('skill defaults are independent and switching die preserves invalid scores for correction', () => {
    const defaults = normalizeSkillSettings();
    assert.deepEqual([defaults.enabled, defaults.diceSides, defaults.mode, defaults.maxChecks], [false, 20, 'challenge', 1]);
    const changed = config({ diceSides: 10 });
    assert.equal(changed.skills[1].value, 20);
    assert.match(skillErrors(changed).join(), /0～10/);
    assert.ok(skillErrors(config({ skills: [{ name: ' ', value: 1.2 }, { name: 'a', value: -1 }, { name: 'a', value: 21 }] })).length >= 5);
    assert.equal(skillErrors(config()).length, 0);
});

for (const sides of [10, 20, 100]) {
    test(`d${sides} boundaries, equality and independent score snapshots`, () => {
        assert.deepEqual(rollSkill(sides, 0, () => 0), { sides, value: 0, result: 1, passed: false });
        assert.deepEqual(rollSkill(sides, sides, () => 0.999999), { sides, value: sides, result: sides, passed: true });
        assert.equal(rollSkill(sides, sides / 2, () => (sides / 2 - 1) / sides).passed, true);
        assert.equal(rollSkill(sides, sides / 2, () => 0.5).passed, false);
        assert.throws(() => rollSkill(sides, sides + 1), RangeError);
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

test('challenge permits none; every mode exposes missing choice; stale request never rolls', () => {
    assert.equal(packet([]).issues.length, 0);
    assert.match(packet([], request({ mode: 'every' })).issues.join(), /每轮判定/);
    assert.equal(validateSelection({ 请求ID: 'old', 待判定: [choice('撬锁')] }, request()).待判定.length, 0);
    const prompt = skillPrompt(createSkillTurn(config({ mode: 'every' }), { checks: [], issues: [] }));
    assert.match(prompt, /列表不能留空/);
    assert.ok(!prompt.includes('无需检定时'));
});

test('selection survives JSON save/reload, is bound to reply/swipe/request and current skill identity', () => {
    const { chat, data, p } = fixture();
    const reloaded = JSON.parse(JSON.stringify({ chat, data }));
    assert.equal(readSkillSelection(reloaded.chat, reloaded.data, config({ maxChecks: 3 })).checks.length, 3);
    assert.equal(readSkillSelection(chat, data, config({ maxChecks: 1 })).checks.length, 1);
    assert.equal(readSkillSelection(chat, data, config({ skills: [{ ...skills[0], name: '开锁' }] })).checks.length, 0);
    chat[1].swipe_id = 1;
    assert.equal(readSkillSelection(chat, data, config()).checks.length, 0);
    chat[1].swipe_id = 0; chat[1].mes = '编辑后的剧情';
    assert.equal(readSkillSelection(chat, data, config()).checks.length, 0);
    chat[1].mes = '剧情<StatusPlaceHolderImpl/>';
    assert.equal(readSkillSelection(chat, data, config()).checks.length, 1);
    p.请求ID = 'expired';
    assert.equal(readSkillSelection(chat, data, config()).checks.length, 0);
});

test('mixed outcomes preserve values and instruct AI to decide applicability and honor adopted outcomes', () => {
    const { chat, data } = fixture();
    const cfg = config({ maxChecks: 3 });
    const samples = [0.45, 0.95, 0];
    const turn = createSkillTurn(cfg, readSkillSelection(chat, data, cfg), () => samples.shift(), 'r2');
    assert.deepEqual(turn.results.map(r => [r.result, r.passed]), [[10, true], [20, true], [1, false]]);
    cfg.skills[0].value = 1;
    assert.equal(turn.results[0].value, 10);
    const text = skillPrompt(turn);
    assert.match(text, /不相关或未执行的行动可以不使用/);
    assert.match(text, /本结果优先于其他随机剧情指令/);
    assert.match(text, /0～3/);
    assert.ok(skillBlocks(turn, false).display.includes('失败'));
    assert.equal(skillBlocks(turn, true).display, '');
    assert.equal(turn.source.swipeId, 0);
});
