import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSkillSettings, skillErrors, validateSelection, readSkillSelection, rollSkill, createSkillTurn,
    skillPrompt, skillBlocks, minSkillModifier, skillFormula } from '../skills.js';

const skills = [{ id: 'lock', name: '撬锁', modifier: 3 }, { id: 'eye', name: '侦查', modifier: 20 }, { id: 'talk', name: '说服', modifier: -4 }];
const config = (patch = {}) => normalizeSkillSettings({ version: 2, enabled: true, pointLimit: 60, skills, ...patch });
const request = (patch = {}) => createSkillTurn(config(patch), { checks: [], issues: [] }, Math.random, 'r1').request;
const choice = (name, DC = 15) => ({ 技能名: name, 对应事件: `执行${name}`, 判定条件: '标准工具，无外界干扰', DC });
const packet = (items, req = request(), reports = []) => validateSelection({ 规则版本: 2, 请求ID: 'r1', 待判定: items, 本轮处理: reports }, req);
function fixture() {
    const req = request({ maxChecks: 3 });
    const chat = [{ is_user: true, mes: '行动', extra: { auto_random_input: { skills: { request: req } } } }, { mes: '剧情', swipe_id: 0 }];
    const p = packet(skills.map(s => choice(s.name)), req);
    p._source = { messageId: 1, swipeId: 0, fingerprint: 'saved-signature' };
    return { chat, p, data: { stat_data: { 随机指令工作台: { 技能判定: p } } } };
}

test('configuration guidance remains explicit and switching dice never clamps modifiers', () => {
    const defaults = normalizeSkillSettings();
    assert.deepEqual([defaults.version, defaults.enabled, defaults.diceSides, defaults.mode, defaults.maxChecks], [2, false, 20, 'challenge', 1]);
    const changed = config({ diceSides: 10 });
    assert.equal(changed.skills[1].modifier, 20);
    assert.match(skillErrors(changed).join(), /-2～\+10/);
    assert.ok(skillErrors(config({ skills: [{ name: ' ', modifier: 1.2 }, { name: 'a', modifier: -5 }, { name: 'a', modifier: 21 }] })).length >= 5);
    assert.equal(skillErrors(config()).length, 0);
});

for (const sides of [10, 20, 100]) {
    test(`d${sides}: local math supports free bonuses and DCs without natural-1/maximum overrides`, () => {
        const minimum = minSkillModifier(sides);
        assert.deepEqual(rollSkill(sides, minimum, 1, () => 0), { sides, modifier: minimum, dc: 1, result: 1, total: 1 + minimum, passed: false });
        assert.equal(rollSkill(sides, sides, sides + 1, () => 0).passed, true);
        assert.equal(rollSkill(sides, sides, sides * 2, () => 0.999999).passed, true);
        assert.equal(rollSkill(sides, sides, sides * 2 + 1, () => 0.999999).passed, false);
        assert.equal(rollSkill(sides, 0, sides / 2, () => (sides / 2 - 1) / sides).passed, true);
        assert.equal(rollSkill(sides, sides + 5, 0, () => 0).passed, true);
        assert.equal(rollSkill(sides, -50.5, -49.5, () => 0).passed, true);
        for (const modifier of [NaN, Infinity, undefined]) assert.throws(() => rollSkill(sides, modifier, 5), RangeError);
        for (const dc of [undefined, null, '15', NaN, Infinity]) assert.throws(() => rollSkill(sides, 0, dc), RangeError);
        assert.throws(() => rollSkill(sides, 0, 5, () => 1), RangeError);
    });
}

for (const maxChecks of [1, 2, 3]) {
    test(`user cap ${maxChecks}: keep selection order, new skills and repeated checks`, () => {
        const { chat, data, p } = fixture();
        p.待判定 = [choice('新技能'), choice('侦查'), choice('侦查'), choice('说服')];
        const result = readSkillSelection(chat, data, config({ maxChecks }));
        assert.deepEqual(result.checks.map(x => x.name), ['新技能', '侦查', '侦查'].slice(0, maxChecks));
        assert.deepEqual(result.checks.map(x => x.modifier), [0, 20, 20].slice(0, maxChecks));
        assert.equal(result.issues.length, 0);
    });
}

test('request metadata and optional descriptions never block checks; only missing names or numeric DCs are skipped', () => {
    assert.equal(packet([], request({ mode: 'every' })).issues.length, 0);
    const p = validateSelection({ 请求ID: 'different', 待判定: [{ 技能名: '撬锁', DC: '15' }] });
    assert.equal(p.待判定[0].DC, 15);
    assert.equal(p.待判定[0].对应事件, '撬锁');
    assert.equal(p.待判定[0].判定条件, '');
    assert.equal(packet([{ ...choice('撬锁'), 判定条件: '' }]).待判定.length, 1);
    for (const dc of [0, -1, 2.5]) assert.equal(packet([choice('撬锁', dc)]).待判定.length, 1);
    for (const dc of [undefined, null, '', 'abc', NaN, Infinity]) assert.equal(packet([{ ...choice('撬锁'), DC: dc }]).待判定.length, 0);
    assert.equal(packet([{ DC: 15 }]).待判定.length, 0);
});

test('edits, swipes, dice, renamed/deleted skills, old IDs and absent provenance do not invalidate MVU selections', () => {
    const { chat, data, p } = fixture();
    const renamed = config({ skills: [{ ...skills[0], name: '开锁', modifier: -3 }] });
    assert.equal(readSkillSelection(chat, data, renamed).checks[0].name, '开锁');
    assert.equal(readSkillSelection(chat, data, renamed).checks[0].modifier, -3);
    assert.equal(readSkillSelection(chat, data, config({ diceSides: 100 })).checks.length, 1);
    chat[1].swipe_id = 1;
    chat[1].mes = '用户自由编辑后的剧情\n[igs-img:1]\n<StatusPlaceHolderImpl/>';
    p.请求ID = 'different'; p.规则版本 = 999;
    assert.equal(readSkillSelection(chat, data, config()).checks.length, 1);
    delete p._source;
    assert.equal(readSkillSelection([], data, config()).checks.length, 1);
    assert.equal(readSkillSelection(chat, data, config({ skills: [] })).checks[0].modifier, 0);
    p.待判定[0].DC = 10;
    assert.equal(readSkillSelection(chat, data, config()).checks[0].dc, 10);
});

test('mixed outcomes remain snapshots and the prompt follows free use without applicability restrictions', () => {
    const { chat, data } = fixture();
    const cfg = config({ maxChecks: 3 });
    const samples = [0.55, 0.95, 0];
    const turn = createSkillTurn(cfg, readSkillSelection(chat, data, cfg), () => samples.shift(), 'r2');
    assert.deepEqual(turn.results.map(r => [r.result, r.total, r.passed]), [[12, 15, true], [20, 40, true], [1, -3, false]]);
    assert.deepEqual(turn.request.checks.map(c => c.id), ['r2:1', 'r2:2', 'r2:3']);
    cfg.skills[0].modifier = 1;
    assert.equal(turn.results[0].modifier, 3);
    const text = skillPrompt(turn);
    for (const rule of ['以用户最新要求为准', '沿用、重复、修改或忽略检定', '采用检定', '每轮检定上限：3', '外层标签名为 UpdateVariable', '内层标签名为 JSONPatch', '不得覆盖整个 stat_data']) assert.ok(text.includes(rule), rule);
    assert.ok(!/<\/?(?:content|UpdateVariable|JSONPatch)>/.test(text));
    assert.ok(!text.includes('旧检定均不适用'));
    assert.ok(skillBlocks(turn, false).display.includes('候选失败'));
    assert.equal(skillBlocks(turn, true).display, '');
    assert.match(skillFormula(turn.results[2]), /-4.*-3.*DC 15/);
});

test('optional adoption reports accept free descriptions and do not gate the next selection', () => {
    const req = request();
    const reports = [{ 检定ID: 'custom', 处理: '用户要求沿用' }, { 检定ID: 'custom', 处理: '延后检定' }];
    const p = packet([choice('侦查')], req, reports);
    assert.equal(p.本轮处理.length, 2);
    assert.equal(p.本轮处理[0].说明, '');
    assert.equal(p.待判定.length, 1);
    assert.equal(p.issues.length, 0);
    assert.equal(validateSelection({ 待判定: [choice('侦查')] }, req).待判定.length, 1);
});

test('historical threshold results remain displayable without rewriting saved outcomes', () => {
    const legacy = { request: { id: 'old', skills: [{ id: 'lock', name: '撬锁', value: 13 }], mode: 'challenge', maxChecks: 1 },
        results: [{ name: '撬锁', action: '开门', sides: 20, result: 12, value: 13, passed: true }], diceSides: 20 };
    const saved = JSON.stringify(legacy);
    assert.match(skillPrompt(legacy), /骰点 ≤ 技能值/);
    assert.match(skillBlocks(legacy).display, /旧技能值 13/);
    assert.equal(JSON.stringify(legacy), saved);
});
