import assert from 'node:assert/strict';
import test from 'node:test';
import { installSkillService } from '../mvu-skills.js';
import { SKILL_SETTINGS_KEY, normalizeSkillSettings } from '../skills.js';
import { SETTINGS_KEY, normalizeSettings } from '../core.js';
import { installSendHooks } from '../send.js';
import { createSkillGroup, loadSkillGroup } from '../skill-groups.js';

function fixture() {
    const listeners = new Map();
    const ctx = { chat: [], chatMetadata: { [SKILL_SETTINGS_KEY]: normalizeSkillSettings({ enabled: true, maxChecks: 3, skills: [
        { id: 'lock', name: '撬锁', value: 20 }, { id: 'eye', name: '侦查', value: 0 },
    ] }) }, extensionSettings: { [SETTINGS_KEY]: normalizeSettings() },
    eventTypes: { GENERATION_AFTER_COMMANDS: 'before', MESSAGE_SENT: 'sent', CHAT_CHANGED: 'chat', MESSAGE_SWIPED: 'swipe', MESSAGE_DELETED: 'delete' },
    eventSource: { on(event, fn) { const all = listeners.get(event) ?? []; all.push(fn); listeners.set(event, all); },
        async emit(event, ...args) { for (const fn of listeners.get(event) ?? []) await fn(...args); } },
    saveChat: async () => {}, updateMessageBlock() {} };
    const data = new Map();
    const service = installSkillService(() => ctx, () => {}, { TavernHelper: { getVariables: ({ message_id }) => data.get(message_id) } });
    const input = { value: '查看门锁', dispatchEvent() {} };
    const commit = async () => { const id = ctx.chat.push({ is_user: true, mes: input.value, extra: {} }) - 1; input.value = ''; await ctx.eventSource.emit('sent', id); return ctx.chat[id]; };
    const reply = () => { ctx.chat.push({ mes: '门锁复杂，门外有脚步。', swipe_id: 0 }); return ctx.chat.at(-2).extra[SETTINGS_KEY].skills.request; };
    const parse = async (req, patch = {}) => {
        const variables = { stat_data: { 场景: { 回合: 1 } }, schema: {}, ...patch };
        const commands = [{ type: 'set', args: ["'场景.回合'", '2'] }, { type: 'set', args: ["'随机指令工作台.技能判定'", JSON.stringify({ 请求ID: req.id, 待判定: [{ 技能名: '撬锁', 对应事件: '打开门锁' }, { 技能名: '侦查', 对应事件: '发现门外的人' }] })] }];
        await ctx.eventSource.emit('mag_command_parsed', variables, commands, ctx.chat.at(-1).mes);
        return { variables, commands };
    };
    return { ctx, data, service, input, commit, reply, parse, install: () => installSendHooks(() => ctx, () => {}, () => input, () => false, service) };
}

test('MVU event contract: detach inherited fields, keep card commands, merge after strict schema', async () => {
    const h = fixture(); await h.install();
    await h.ctx.eventSource.emit('before', 'normal'); await h.commit();
    const req = h.reply();
    const { variables, commands } = await h.parse(req, { stat_data: { 场景: { 回合: 1 }, 随机指令工作台: { 技能判定: { 请求ID: 'old' } } } });
    assert.equal(commands.length, 1);
    assert.deepEqual(Object.keys(variables.stat_data), ['场景']);
    // A strict card schema accepts only its own root, and then updates its field.
    variables.stat_data = { 场景: { 回合: 2 } };
    await h.ctx.eventSource.emit('mag_before_message_update', { variables });
    assert.equal(variables.stat_data.场景.回合, 2);
    assert.equal(variables.stat_data.随机指令工作台.技能判定.待判定.length, 2);
    h.data.set(1, variables);
    assert.equal(h.service.view().selection.checks.length, 2);
});

test('changing swipe while a prepared send is cancelled removes only its own pending draft block', async () => {
    const h = fixture(); await h.install();
    h.input.value = '行动<!-- unrelated -->';
    await h.ctx.eventSource.emit('before', 'normal');
    assert.ok(h.input.value.includes('请求ID'));
    await h.ctx.eventSource.emit('swipe', 0);
    assert.equal(h.input.value, '行动<!-- unrelated -->');
    await h.ctx.eventSource.emit('before', 'normal');
    assert.equal(h.input.value.split('[随机指令工作台 2.0').length, 2);
});

test('skill-only sends, cancellation, duplicate events and regeneration never reroll persisted results', async t => {
    const h = fixture(); await h.install();
    await h.ctx.eventSource.emit('before', 'normal');
    const initial = h.input.value;
    await h.ctx.eventSource.emit('before', 'normal');
    assert.equal(h.input.value, initial);
    const first = await h.commit();
    assert.equal(first.extra[SETTINGS_KEY].skills.results.length, 0);
    const { variables } = await h.parse(h.reply());
    await h.ctx.eventSource.emit('mag_before_message_update', { variables }); h.data.set(1, variables);
    const random = t.mock.method(Math, 'random', () => 0.5);
    h.input.value = '尝试撬锁并侦查';
    await h.ctx.eventSource.emit('before', 'normal');
    await h.ctx.eventSource.emit('before', 'normal');
    const second = await h.commit();
    assert.equal(random.mock.callCount(), 2);
    assert.deepEqual(second.extra[SETTINGS_KEY].skills.results.map(r => r.passed), [true, false]);
    await h.ctx.eventSource.emit('sent', 2);
    await h.ctx.eventSource.emit('before', 'regenerate');
    assert.equal(random.mock.callCount(), 2);
    assert.equal(second.extra[SETTINGS_KEY].skills.source.messageId, 1);
    assert.ok(!first.mes.includes('请求ID'));
    const snapshot = JSON.stringify(second.extra[SETTINGS_KEY].skills);
    h.ctx.chat = JSON.parse(JSON.stringify(h.ctx.chat));
    await h.ctx.eventSource.emit('chat');
    await h.ctx.eventSource.emit('sent', 2);
    assert.equal(JSON.stringify(h.ctx.chat[2].extra[SETTINGS_KEY].skills), snapshot);
    h.ctx.chat.splice(2);
    const olderRequest = h.ctx.chat[0].extra[SETTINGS_KEY].skills.request.id;
    await h.ctx.eventSource.emit('before', 'regenerate');
    assert.ok(h.ctx.chat[0].mes.includes(olderRequest));
    assert.equal(random.mock.callCount(), 2);
});

test('chat switch during MVU update cannot write the old frame to a different chat', async () => {
    const h = fixture(); await h.install();
    await h.ctx.eventSource.emit('before', 'normal'); await h.commit();
    const { variables } = await h.parse(h.reply());
    h.ctx.chat = [];
    await h.ctx.eventSource.emit('mag_before_message_update', { variables });
    assert.equal(variables.stat_data.随机指令工作台, undefined);
});

test('loading another skill group discards cancelled draft results from the old sheet', async t => {
    const h = fixture(); await h.install();
    await h.ctx.eventSource.emit('before', 'normal'); await h.commit();
    const { variables } = await h.parse(h.reply());
    await h.ctx.eventSource.emit('mag_before_message_update', { variables }); h.data.set(1, variables);
    const random = t.mock.method(Math, 'random', () => 0.5);
    h.input.value = '尝试行动';
    await h.ctx.eventSource.emit('before', 'normal');
    assert.equal(random.mock.callCount(), 2);
    const old = h.ctx.chatMetadata[SKILL_SETTINGS_KEY];
    h.ctx.chatMetadata[SKILL_SETTINGS_KEY] = loadSkillGroup(old, createSkillGroup('新技能表', old));
    h.service.resetSheet();
    await h.ctx.eventSource.emit('before', 'normal');
    const message = await h.commit();
    assert.equal(message.extra[SETTINGS_KEY].skills.results.length, 0);
    assert.equal(random.mock.callCount(), 2);
    assert.equal(message.mes.split('[随机指令工作台 2.0').length, 2);
});

test('an overspent point budget does not inject a skill request or roll dice', async t => {
    const h = fixture(); await h.install();
    h.ctx.chatMetadata[SKILL_SETTINGS_KEY].pointLimit = 0;
    const random = t.mock.method(Math, 'random', () => { throw new Error('must not roll'); });
    await h.ctx.eventSource.emit('before', 'normal');
    const message = await h.commit();
    assert.equal(message.mes, '查看门锁');
    assert.equal(message.extra[SETTINGS_KEY].skills, undefined);
    assert.match(h.service.view().errors.join(), /超过总能力值上限/);
    assert.equal(random.mock.callCount(), 0);
});

test('JSON Patch is accepted; absent, malicious or partial commands do not produce dice', async () => {
    const h = fixture(); await h.install();
    await h.ctx.eventSource.emit('before', 'normal'); await h.commit();
    const req = h.reply();
    for (const value of [undefined, '(()=>{throw Error()})()', { 请求ID: 'old', 待判定: [] }]) {
        const variables = { stat_data: { 场景: {} }, schema: {} };
        const commands = value === undefined ? [] : [{ op: 'replace', path: '/随机指令工作台/技能判定', value }];
        await h.ctx.eventSource.emit('mag_command_parsed', variables, commands, h.ctx.chat.at(-1).mes);
        await h.ctx.eventSource.emit('mag_before_message_update', { variables }); h.data.set(1, variables);
        assert.equal(h.service.view().selection.checks.length, 0);
        assert.ok(h.service.view().selection.issues.length);
    }
    const variables = { stat_data: { 场景: {} }, schema: {} };
    await h.ctx.eventSource.emit('mag_command_parsed', variables, [{ op: 'replace', path: '/随机指令工作台/技能判定', value: { 请求ID: req.id, 待判定: [{ 技能名: '撬锁', 对应事件: '开锁' }] } }], h.ctx.chat.at(-1).mes);
    await h.ctx.eventSource.emit('mag_before_message_update', { variables }); h.data.set(1, variables);
    assert.equal(h.service.view().selection.checks.length, 1);
    const translated = [{ type: 'insert', reason: 'json_patch', args: ['["随机指令工作台"]', '"技能判定"', JSON.stringify({ 请求ID: req.id, 待判定: [{ 技能名: '侦查', 对应事件: '观察走廊' }] })] }];
    await h.ctx.eventSource.emit('mag_command_parsed', variables, translated, h.ctx.chat.at(-1).mes);
    assert.equal(translated.length, 0);
    await h.ctx.eventSource.emit('mag_before_message_update', { variables });
    assert.equal(h.service.view().selection.checks[0].name, '侦查');
});
