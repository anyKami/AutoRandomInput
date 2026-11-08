import assert from 'node:assert/strict';
import test from 'node:test';
import { SETTINGS_KEY, activeGroup, createGroup, createRule, createRollRecord, normalizeSettings, processMessage, validateCommandRanges } from '../core.js';

const ranges = () => [
    { range: '1-14', command: '第一种事件' },
    { range: '15-31', command: '第二种事件' },
    { range: '32-89', command: '第三种事件' },
];
function configured(rows = ranges()) {
    const settings = normalizeSettings({ enabled: true, includeRollResult: true });
    const rule = activeGroup(settings).rules[0];
    rule.diceSides = 100;
    rule.ranges = rows;
    rule.commands[0] = '保留的编号指令';
    return settings;
}
const rollPoint = (settings, point) => createRollRecord(settings, () => (point - 0.5) / 100);
const user = mes => ({ is_user: true, mes, extra: {} });

test('d100 covers inclusive intervals without changing their probabilities or rerolling gaps', () => {
    const settings = configured();
    const counts = [0, 0, 0, 0];
    for (let point = 1; point <= 100; point++) {
        let calls = 0;
        const record = createRollRecord(settings, () => { calls++; return (point - 0.5) / 100; });
        const roll = record.rolls[0];
        assert.equal(calls, 1);
        assert.equal(roll.result, point);
        assert.equal(roll.sides, 100);
        const expected = point <= 14 ? 0 : point <= 31 ? 1 : point <= 89 ? 2 : 3;
        counts[expected]++;
        if (expected === 3) {
            assert.equal(roll.uncovered, true);
            assert.equal(roll.skipped, true);
            assert.equal(roll.rangeIndex, null);
            assert.equal(record.block, '');
        } else {
            assert.equal(roll.rangeIndex, expected);
            assert.equal(roll.range, ranges()[expected].range);
            assert.equal(roll.skipped, false);
            assert.ok(record.block.includes(ranges()[expected].command));
            assert.ok(record.block.includes(`d100 = ${point}`));
        }
        assert.ok(!record.block.includes('保留的编号指令'));
    }
    assert.deepEqual(counts, [14, 17, 58, 11]);
    assert.equal(validateCommandRanges(ranges()).coveredCount, 89);
});

test('singletons, unordered rows, spaces and common dashes retain inclusive endpoints', () => {
    const rows = [
        { range: '100', command: '末尾' },
        { range: ' 15 – 31 ', command: '中间' },
        { range: '01-14', command: '开头' },
        { range: '32－50', command: '全角' },
        { range: '51—89', command: '长横线' },
    ];
    assert.equal(validateCommandRanges(rows).valid, true);
    const settings = configured(rows);
    for (const [point, index, label] of [[1, 2, '1-14'], [14, 2, '1-14'], [15, 1, '15-31'], [100, 0, '100']]) {
        const roll = rollPoint(settings, point).rolls[0];
        assert.equal(roll.rangeIndex, index);
        assert.equal(roll.range, label);
    }
});

test('invalid ranges are rejected without silently truncating, sorting or fixing saved input', () => {
    for (const range of ['', '0-10', '90-101', '14-1', '-1', '1.5-14', '1e1', '1-14-20', '1,14', '101', 'Infinity', '99999999999999999999']) {
        const rows = [{ range, command: '事件' }];
        const validation = validateCommandRanges(rows);
        assert.equal(validation.valid, false, range);
        assert.deepEqual(validation.errors[0].indexes, [0]);
        assert.equal(rows[0].range, range);
    }
});

test('shared endpoints, duplicate and nested ranges invalidate both rows, including blank commands', () => {
    for (const second of ['14-31', '1-14', '5-8', '1-100']) {
        const validation = validateCommandRanges([
            { range: '1-14', command: '事件' },
            { range: second, command: '' },
        ]);
        assert.equal(validation.valid, false, second);
        assert.deepEqual(validation.errors[0].indexes, [0, 1]);
        assert.match(validation.errors[0].message, /重叠/);
    }
    assert.equal(validateCommandRanges([{ range: '1-14', command: '' }, { range: '15-31', command: '' }]).valid, true);
});

test('blank rows are harmless; blank commands and empty tables skip without injecting roll annotations', () => {
    for (const rows of [[], [{ range: ' ', command: ' ' }], [{ range: '1-100', command: ' \n' }]]) {
        const record = rollPoint(configured(rows), 50);
        assert.equal(validateCommandRanges(rows).valid, true);
        assert.equal(record.rolls[0].result, 50);
        assert.equal(record.rolls[0].skipped, true);
        assert.equal(record.block, '');
    }
    assert.equal(rollPoint(configured([{ range: '1-100', command: '' }]), 100).rolls[0].uncovered, false);
});

test('one invalid d100 rule does not roll or suppress other valid dice', () => {
    const settings = configured([{ range: '1-14', command: '错误一' }, { range: '14-31', command: '错误二' }]);
    activeGroup(settings).rules.push(createRule('固定指令', { diceSides: 1, commands: ['正常指令'] }));
    activeGroup(settings).rules.push(createRule('有效范围', { diceSides: 100, ranges: [{ range: '100', command: '末尾指令' }] }));
    let calls = 0;
    const record = createRollRecord(settings, () => { calls++; return 1 - Number.EPSILON; });
    assert.equal(calls, 2);
    assert.equal(record.rolls[0].result, null);
    assert.match(record.rolls[0].error, /重叠/);
    assert.deepEqual(record.rolls.slice(1).map(roll => roll.result), [1, 100]);
    assert.ok(record.block.includes('正常指令'));
    assert.ok(record.block.includes('末尾指令'));
    assert.ok(!record.block.includes('错误'));
});

test('d100 ranges and d20 slots survive switches, reload, rule and group copies independently', () => {
    let settings = configured();
    activeGroup(settings).rules[0].commands[19] = '二十面指令';
    activeGroup(settings).rules[0].diceSides = 20;
    settings = normalizeSettings(JSON.parse(JSON.stringify(settings)));
    let rule = activeGroup(settings).rules[0];
    const groupCopy = createGroup('组副本', activeGroup(settings));
    const ruleCopy = createRule('指令副本', rule);
    assert.ok(createRollRecord(settings, () => 0.999).block.includes('二十面指令'));
    rule.diceSides = 100;
    settings = normalizeSettings(JSON.parse(JSON.stringify(settings)));
    rule = activeGroup(settings).rules[0];
    assert.equal(rule.diceSides, 100);
    assert.ok(rollPoint(settings, 14).block.includes('第一种事件'));
    rule.ranges[0].range = 'invalid draft';
    rule.ranges[0].command = '改动';
    rule.commands[19] = '改动';
    for (const copied of [groupCopy.rules[0], ruleCopy]) {
        assert.deepEqual(copied.ranges, ranges());
        assert.equal(copied.commands[19], '二十面指令');
    }
    const restored = normalizeSettings(JSON.parse(JSON.stringify(settings)));
    assert.equal(activeGroup(restored).rules[0].ranges[0].range, 'invalid draft');
    assert.equal(validateCommandRanges(activeGroup(restored).rules[0].ranges).valid, false);
});

test('old settings gain empty ranges and malformed persisted rows fail safely', () => {
    const legacy = normalizeSettings({ groups: [{ id: 'legacy', name: '旧配置', diceSides: 6, commands: ['旧指令'] }] });
    assert.deepEqual(activeGroup(legacy).rules[0].ranges, []);
    assert.equal(activeGroup(legacy).rules[0].commands[0], '旧指令');
    const settings = configured([null, { range: 123, command: '不能执行' }]);
    const restored = normalizeSettings(JSON.parse(JSON.stringify(settings)));
    const record = createRollRecord(restored, () => assert.fail('invalid table must not roll'));
    assert.ok(record.rolls[0].error);
    assert.equal(record.block, '');
});

test('gap outcomes clean earlier injected commands; duplicate events keep the original snapshot', () => {
    const settings = configured();
    const chat = [user('第一轮')];
    processMessage(chat, 0, settings, () => 0);
    const snapshot = JSON.parse(JSON.stringify(chat[0].extra[SETTINGS_KEY].rolls));
    activeGroup(settings).rules[0].ranges[0].range = '2-14';
    assert.equal(processMessage(chat, 0, settings, () => assert.fail('must not reroll')), null);
    assert.deepEqual(chat[0].extra[SETTINGS_KEY].rolls, snapshot);
    chat.push(user('第二轮'));
    processMessage(chat, 1, settings, () => 0.95);
    assert.equal(chat[0].mes, '第一轮');
    assert.equal(chat[1].mes, '第二轮');
    assert.equal(chat[1].extra[SETTINGS_KEY].rolls[0].uncovered, true);
});

test('d100 respects disabled rules, the result toggle and hidden sending', () => {
    const settings = configured([{ range: '1-100', command: '隐藏--指令' }]);
    settings.includeRollResult = false;
    assert.ok(!rollPoint(settings, 100).block.includes('投掷结果'));
    settings.stealthMode = true;
    settings.includeRollResult = true;
    const hidden = rollPoint(settings, 100);
    assert.equal(hidden.display, '');
    assert.ok(hidden.block.includes('<!--'));
    assert.ok(hidden.block.includes('隐藏-&#45;指令'));
    assert.ok(hidden.block.includes('d100 = 100'));
    activeGroup(settings).rules[0].enabled = false;
    assert.deepEqual(createRollRecord(settings, () => assert.fail('disabled rule must not roll')).rolls, []);
});
