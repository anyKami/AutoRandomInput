import assert from 'node:assert/strict';
import test from 'node:test';
import { SETTINGS_KEY, activeGroup, createGroup, createRule, createSampleGroup, displayMessage, normalizeSettings, processMessage, removeLegacyMarkers, rollDice } from '../core.js';

const firstRule = settings => activeGroup(settings).rules[0];
const user = mes => ({ is_user: true, is_system: false, mes, extra: {} });
function configured() {
    const settings = normalizeSettings();
    settings.enabled = true;
    firstRule(settings).commands = Array.from({ length: 10 }, (_, index) => `命令内容 ${index + 1}`);
    return settings;
}

test('fresh settings are disabled, visible, with ten blank slots and d10', () => {
    const settings = normalizeSettings();
    assert.equal(settings.enabled, false);
    assert.equal(settings.stealthMode, false);
    assert.equal(firstRule(settings).diceSides, 10);
    assert.deepEqual(firstRule(settings).commands, Array(10).fill(''));
});

test('each d1–d10 maps equal intervals to the corresponding slots, including boundaries', () => {
    for (let sides = 1; sides <= 10; sides++) {
        assert.equal(rollDice(sides, () => 0), 1);
        assert.equal(rollDice(sides, () => 1 - Number.EPSILON), sides);
        const counts = Array(sides).fill(0);
        for (let i = 0; i < sides * 100; i++) counts[rollDice(sides, () => (i + 0.5) / (sides * 100)) - 1]++;
        assert.deepEqual(counts, Array(sides).fill(100));
    }
    for (const sides of [0, -1, 11, 1.2, NaN, '6']) assert.throws(() => rollDice(sides), RangeError);
});

test('d10 → d6 → reload → d10 retains hidden commands; copies are independent', () => {
    let settings = configured();
    firstRule(settings).diceSides = 6;
    const copied = createGroup('副本', activeGroup(settings));
    settings.groups.push(copied);
    settings = normalizeSettings(JSON.parse(JSON.stringify(settings)));
    assert.equal(firstRule(settings).diceSides, 6);
    firstRule(settings).diceSides = 10;
    assert.equal(firstRule(settings).commands[9], '命令内容 10');
    firstRule(settings).commands[9] = '修改原组';
    settings.activeGroupId = copied.id;
    assert.equal(firstRule(settings).commands[9], '命令内容 10');
    assert.equal(firstRule(settings).diceSides, 6);
});

test('a send keeps the original text intact and never selects hidden slots', () => {
    const settings = configured();
    firstRule(settings).diceSides = 6;
    const chat = [user('  原始消息 \n')];
    const outcome = processMessage(chat, 0, settings, () => 0.999);
    assert.equal(outcome.record.rolls[0].result, 6);
    assert.ok(chat[0].mes.startsWith('  原始消息 \n'));
    assert.ok(chat[0].mes.includes('命令内容 6'));
    assert.ok(!chat[0].mes.includes('命令内容 10'));
    assert.deepEqual(outcome.changedIds, [0]);
});

test('the next send removes only the recorded fragment, preserving AIA blocks and outside edits', () => {
    const settings = configured();
    const original = '原文\n<!--AIA_VISIBLE_START-->其他插件内容<!--AIA_VISIBLE_END-->\n<!-- [System Note]\n原插件隐身内容-->';
    const chat = [user(original)];
    processMessage(chat, 0, settings, () => 0);
    chat[0].mes = '手动前缀\n' + chat[0].mes + '\n手动后缀';
    settings.stealthMode = true;
    chat.push(user('下一条'));
    const outcome = processMessage(chat, 1, settings, () => 0.5);
    assert.equal(chat[0].mes, '手动前缀\n' + original + '\n手动后缀');
    assert.equal(chat[0].extra[SETTINGS_KEY].block, '');
    assert.equal(displayMessage(chat[1].mes, outcome.record), '下一条');
    assert.ok(chat[1].mes.includes('命令内容 6'));
    assert.deepEqual(outcome.changedIds, [0, 1]);
});

test('blank hits still clean the old command, and duplicate events never reroll', () => {
    const settings = configured();
    firstRule(settings).commands[1] = ' \n\t';
    const chat = [user('第一条')];
    let rolls = 0;
    processMessage(chat, 0, settings, () => { rolls++; return 0; });
    chat.push(user('第二条'));
    const outcome = processMessage(chat, 1, settings, () => { rolls++; return 0.15; });
    assert.equal(outcome.record.rolls[0].skipped, true);
    assert.equal(chat[0].mes, '第一条');
    assert.equal(chat[1].mes, '第二条');
    assert.equal(processMessage(chat, 1, settings, () => { rolls++; return 0; }), null);
    assert.equal(processMessage(chat, 0, settings, () => { rolls++; return 0; }), null);
    assert.equal(rolls, 2);
});

test('disabled, blank, assistant and system messages do not roll or clean history', () => {
    const settings = configured();
    const chat = [user('原文')];
    processMessage(chat, 0, settings, () => 0);
    const retained = chat[0].mes;
    const neverRoll = () => { throw new Error('unexpected roll'); };
    for (const message of [user(' \n '), { ...user('助手'), is_user: false }, { ...user('系统'), is_system: true }]) {
        chat.push(message);
        assert.equal(processMessage(chat, chat.length - 1, settings, neverRoll), null);
    }
    settings.enabled = false;
    chat.push(user('已关闭'));
    assert.equal(processMessage(chat, chat.length - 1, settings, neverRoll), null);
    assert.equal(chat[0].mes, retained);
});

test('persisted metadata cleans old mode/group fragments after a reload', () => {
    let settings = configured();
    settings.stealthMode = true;
    let chat = [user('旧组消息')];
    processMessage(chat, 0, settings, () => 0);
    settings.groups.push(createGroup('另一个组', activeGroup(settings)));
    settings.activeGroupId = settings.groups[1].id;
    settings.stealthMode = false;
    settings = normalizeSettings(JSON.parse(JSON.stringify(settings)));
    chat = JSON.parse(JSON.stringify(chat));
    chat.push(user('新组消息'));
    const { record } = processMessage(chat, 1, settings, () => 0.99);
    assert.equal(chat[0].mes, '旧组消息');
    assert.equal(record.groupName, '另一个组');
    assert.equal(record.rolls[0].result, 10);
});

test('edited command fragments are not removed by broad matching', () => {
    const settings = configured();
    const chat = [user('消息')];
    processMessage(chat, 0, settings, () => 0);
    chat[0].mes = chat[0].mes.replace('命令内容 1', '手工改写的内容');
    const edited = chat[0].mes;
    chat.push(user('下一条'));
    processMessage(chat, 1, settings, () => 0);
    assert.equal(chat[0].mes, edited);
});

test('multiline commands and replacement syntax remain literal; display hooks only change the view', () => {
    const settings = configured();
    firstRule(settings).diceSides = 1;
    firstRule(settings).commands[0] = '第一行 $&\n<content>第二行</content>\n/send 不应执行';
    const chat = [user('正文')];
    const { record } = processMessage(chat, 0, settings);
    const raw = chat[0].mes;
    const shown = displayMessage(raw, record);
    assert.ok(shown.includes('第一行 $&'));
    assert.ok(shown.includes('/send 不应执行'));
    assert.ok(!shown.includes('<!-- ARI:'));
    assert.ok(!raw.includes('<!--'));
    assert.equal(chat[0].mes, raw);
});

test('hidden comments escape closing delimiters; rendering hides commands even inside a code block', () => {
    const settings = configured();
    settings.stealthMode = true;
    firstRule(settings).diceSides = 1;
    firstRule(settings).commands[0] = '测试 --> <script>内容</script> --!> <!-- 嵌套 -->';
    const original = '正文\n```text\n尚未闭合的代码';
    const chat = [user(original)];
    const { record } = processMessage(chat, 0, settings);
    assert.equal((record.block.match(/-->/g) ?? []).length, 1);
    assert.equal((record.block.match(/<!--/g) ?? []).length, 1);
    assert.ok(!record.block.includes('--!>'));
    assert.ok(!record.block.includes('ARI:'));
    assert.ok(chat[0].mes.includes('测试'));
    assert.equal(displayMessage(chat[0].mes, record), original);
});

test('multiple dice roll independently and append their own selected commands in order', () => {
    const settings = configured();
    const group = activeGroup(settings);
    group.rules[0].diceSides = 6;
    const mood = createRule('情绪');
    mood.diceSides = 4;
    mood.commands = ['情绪一', '情绪二', '情绪三', '情绪四', ...Array(6).fill('')];
    const disabled = createRule('暂停的指令', group.rules[0]);
    disabled.enabled = false;
    group.rules.push(mood, disabled);
    const randomValues = [0.999, 0];
    const chat = [user('用户消息')];
    const { record } = processMessage(chat, 0, settings, () => randomValues.shift());
    assert.deepEqual(record.rolls.map(roll => [roll.sides, roll.result]), [[6, 6], [4, 1]]);
    assert.equal(randomValues.length, 0);
    assert.ok(chat[0].mes.indexOf('命令内容 6') < chat[0].mes.indexOf('情绪一'));
    assert.ok(!chat[0].mes.includes('投掷结果'));
});

test('result annotations follow their own command; empty results do not produce annotations', () => {
    const settings = configured();
    settings.includeRollResult = true;
    firstRule(settings).diceSides = 6;
    const second = createRule('第二套');
    second.diceSides = 4;
    second.commands[3] = '第二套命令';
    activeGroup(settings).rules.push(second, createRule('空白套'));
    const values = [0, 0.999, 0.5];
    const chat = [user('原文')];
    const { record } = processMessage(chat, 0, settings, () => values.shift());
    assert.ok(chat[0].mes.includes('命令内容 1\n> （投掷结果：d6 = 1）'));
    assert.ok(chat[0].mes.includes('第二套命令\n> （投掷结果：d4 = 4）'));
    assert.ok(!chat[0].mes.includes('投掷结果：d10'));
    assert.deepEqual(record.rolls.map(roll => roll.skipped), [false, false, true]);
});

test('hidden mode hides commands and result annotations together while keeping the payload', () => {
    const settings = configured();
    settings.includeRollResult = true;
    settings.stealthMode = true;
    const chat = [user('原文')];
    const { record } = processMessage(chat, 0, settings, () => 0.3);
    assert.ok(chat[0].mes.includes('投掷结果：d10 = 4'));
    assert.equal(displayMessage(chat[0].mes, record), '原文');
});

test('all disabled rules perform no rolls and still clear the preceding extension fragment', () => {
    const settings = configured();
    const chat = [user('旧消息')];
    processMessage(chat, 0, settings, () => 0);
    firstRule(settings).enabled = false;
    chat.push(user('新消息'));
    const { record } = processMessage(chat, 1, settings, () => { throw new Error('disabled rules must not roll'); });
    assert.deepEqual(record.rolls, []);
    assert.equal(chat[0].mes, '旧消息');
    assert.equal(chat[1].mes, '新消息');
});

test('legacy groups migrate into one rule with all ten commands preserved', () => {
    const legacy = { enabled: true, stealthMode: true, activeGroupId: 'old', groups: [
        { id: 'old', name: '旧组', diceSides: 6, commands: Array.from({ length: 10 }, (_, i) => `旧命令 ${i + 1}`) },
    ] };
    const settings = normalizeSettings(legacy);
    assert.equal(activeGroup(settings).rules.length, 1);
    assert.equal(firstRule(settings).diceSides, 6);
    assert.equal(firstRule(settings).commands[9], '旧命令 10');
    assert.equal(settings.includeRollResult, false);
    assert.equal(settings.theme, 'navy');
});

test('copying a group copies every rule and assigns independent identities and arrays', () => {
    const settings = configured();
    activeGroup(settings).rules.push(createRule('第二套', firstRule(settings)));
    const original = activeGroup(settings);
    const copied = createGroup('整组副本', original);
    assert.equal(copied.rules.length, 2);
    copied.rules.forEach((rule, index) => {
        assert.notEqual(rule.id, original.rules[index].id);
        assert.deepEqual(rule.commands, original.rules[index].commands);
        assert.notEqual(rule.commands, original.rules[index].commands);
    });
});

test('themes and result preference persist independently of the active group', () => {
    let settings = configured();
    settings.theme = 'paper';
    settings.includeRollResult = true;
    settings.groups.push(createGroup('另一个组'));
    settings.activeGroupId = settings.groups[1].id;
    settings = normalizeSettings(JSON.parse(JSON.stringify(settings)));
    assert.equal(settings.theme, 'paper');
    assert.equal(settings.includeRollResult, true);
    assert.equal(normalizeSettings({ ...settings, theme: 'invalid' }).theme, 'navy');
});

test('the sample group contains three independent, fully filled dice with thirteen outcomes', () => {
    const group = createSampleGroup();
    assert.equal(group.name, '通用剧情样板');
    assert.deepEqual(group.rules.map(rule => rule.diceSides), [6, 4, 3]);
    assert.equal(group.rules.reduce((count, rule) => count + rule.commands.filter(text => text.trim()).length, 0), 13);
    assert.ok(group.rules.every(rule => rule.enabled && rule.commands.length === 10 && rule.commands.slice(0, rule.diceSides).every(text => text.trim())));
    const another = createSampleGroup();
    group.rules[0].commands[0] = '修改样板';
    assert.notEqual(group.id, another.id);
    assert.notEqual(group.rules[0].id, another.rules[0].id);
    assert.notEqual(group.rules[0].commands[0], another.rules[0].commands[0]);
});

test('legacy visible and hidden wrappers migrate without changing commands or recall text', () => {
    const display = '\n\n> **随机指令**\n> 旧命令';
    const visible = `\n\n<!-- ARI:old-visible -->${display}\n<!-- /ARI:old-visible -->`;
    const hidden = '\n\n<!-- ARI:old-hidden\n隐身旧命令\n/ARI:old-hidden -->';
    const recall = '\n<recall>原有召回内容</recall>';
    const chat = [user('用户输入' + visible + recall), user('另一条' + hidden)];
    chat[0].extra[SETTINGS_KEY] = { block: visible, display };
    chat[1].extra[SETTINGS_KEY] = { block: hidden, display: '' };
    assert.deepEqual(removeLegacyMarkers(chat), [0, 1]);
    assert.equal(chat[0].mes, '用户输入' + display + recall);
    assert.equal(chat[1].mes, '另一条\n\n<!--\n隐身旧命令\n-->');
    assert.equal(displayMessage(chat[1].mes, chat[1].extra[SETTINGS_KEY]), '另一条');
    assert.deepEqual(removeLegacyMarkers(chat), []);
    chat.push(user('下一条'));
    processMessage(chat, 2, configured(), () => 0);
    assert.equal(chat[0].mes, '用户输入' + recall);
    assert.equal(chat[1].mes, '另一条');
});

test('migration leaves untracked comments and manually edited legacy fragments intact', () => {
    const block = '\n\n<!-- ARI:old -->\n\n> 旧命令\n<!-- /ARI:old -->';
    const chat = [user('未记录' + block), user('手工编辑' + block.replace('旧命令', '新内容'))];
    chat[1].extra[SETTINGS_KEY] = { block, display: '\n\n> 旧命令' };
    const before = JSON.stringify(chat);
    assert.deepEqual(removeLegacyMarkers(chat), []);
    assert.equal(JSON.stringify(chat), before);
});

test('ambiguous copies of a recorded fragment are preserved during cleanup', () => {
    const chat = [user('用户原文')];
    const { record } = processMessage(chat, 0, configured(), () => 0);
    chat[0].mes += '\n用户复制的内容：' + record.block;
    const edited = chat[0].mes;
    chat.push(user('新消息'));
    processMessage(chat, 1, configured(), () => 0);
    assert.equal(chat[0].mes, edited);
});
