import assert from 'node:assert/strict';
import test from 'node:test';
import { installSkillService } from '../mvu-skills.js';
import { SKILL_SETTINGS_KEY, normalizeSkillSettings } from '../skills.js';
import { SETTINGS_KEY, normalizeSettings } from '../core.js';
import { installSendHooks } from '../send.js';
import { createSkillGroup, loadSkillGroup } from '../skill-groups.js';

function fixture() {
    const listeners = new Map();
    const ctx = { chat: [], chatMetadata: { [SKILL_SETTINGS_KEY]: normalizeSkillSettings({ version: 2, pointLimit: 20, enabled: true, maxChecks: 3, skills: [
        { id: 'lock', name: '撬锁', modifier: 20 }, { id: 'eye', name: '侦查', modifier: 0 },
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
        const commands = [{ type: 'set', args: ["'场景.回合'", '2'] }, { type: 'set', args: ["'随机指令工作台.技能判定'", JSON.stringify({ 规则版本: 2, 本轮处理: [], 请求ID: req.id, 待判定: [{ 技能名: '撬锁', 对应事件: '打开门锁', 判定条件: '普通门锁与正常光照，无干扰', DC: 15 }, { 技能名: '侦查', 对应事件: '发现门外的人', 判定条件: '普通门锁与正常光照，无干扰', DC: 15 }] })] }];
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

test('parent namespace writes accept skill packets and preserve unrelated commands and sibling fields', async () => {
    const h = fixture(); await h.install();
    await h.ctx.eventSource.emit('before', 'normal'); await h.commit();
    const req = h.reply();
    const value = { 技能判定: { 规则版本: 2, 请求ID: req.id, 本轮处理: [], 待判定: [
        { 技能名: '侦查', 对应事件: '观察走廊', 判定条件: '光照昏暗', DC: 14 },
    ] } };
    for (const command of [
        { op: 'add', path: '/随机指令工作台', value },
        { type: 'insert', args: ['', '"随机指令工作台"', JSON.stringify(value)] },
        { type: 'set', args: ["'随机指令工作台'", JSON.stringify({ ...value, 其他字段: 7 })] },
    ]) {
        const variables = { stat_data: { 场景: { 回合: 1 } }, schema: {} };
        const cardCommand = { type: 'set', args: ["'场景.回合'", '2'] };
        const commands = [cardCommand, command];
        await h.ctx.eventSource.emit('mag_command_parsed', variables, commands, h.ctx.chat.at(-1).mes);
        assert.equal(commands[0], cardCommand);
        if (command.type === 'set') assert.deepEqual(JSON.parse(commands[1].args.at(-1)), { 其他字段: 7 });
        else assert.equal(commands.length, 1);
        await h.ctx.eventSource.emit('mag_before_message_update', { variables }); h.data.set(1, variables);
        assert.equal(h.service.view().selection.checks[0]?.dc, 14);
    }
});

test('display extensions changing a reply between MVU parse and write do not discard its pending checks', async () => {
    const h = fixture(); await h.install();
    await h.ctx.eventSource.emit('before', 'normal'); await h.commit();
    const req = h.reply();
    h.ctx.chat.at(-1).mes = '<故事导演自检>格式完整。</故事导演自检>\n<content>\n门外有脚步。\n</content>';
    const { variables } = await h.parse(req);
    h.ctx.chat.at(-1).mes = '<content>\n[igs-img:1]\n门外有脚步。\n</content>';
    await h.ctx.eventSource.emit('mag_before_message_update', { variables }); h.data.set(1, variables);
    assert.equal(h.service.view().selection.checks.length, 2);
    h.input.value = '尝试撬锁并侦查';
    await h.ctx.eventSource.emit('before', 'normal');
    const user = await h.commit();
    assert.equal(user.extra[SETTINGS_KEY].skills.results.length, 2);
});

test('MVU omissions keep pending checks, and manually provided checks need neither a request nor a schema', async () => {
    const h = fixture(); await h.install();
    h.ctx.chat.push({ mes: '手动配置', swipe_id: 0 });
    const variables = { stat_data: { 场景: {} } };
    await h.ctx.eventSource.emit('mag_command_parsed', variables, [{ op: 'replace', path: '/随机指令工作台/技能判定', value: {
        待判定: [{ 技能名: '侦查', DC: '14' }],
    } }], h.ctx.chat[0].mes);
    await h.ctx.eventSource.emit('mag_before_message_update', { variables }); h.data.set(0, variables);
    assert.equal(h.service.view().selection.checks.length, 1);
    await h.ctx.eventSource.emit('mag_command_parsed', variables, [], h.ctx.chat[0].mes);
    assert.equal(variables.stat_data.随机指令工作台, undefined);
    await h.ctx.eventSource.emit('mag_before_message_update', { variables });
    assert.equal(h.service.view().selection.checks[0].dc, 14);
    await h.ctx.eventSource.emit('mag_command_parsed', variables, [{ op: 'replace', path: '/随机指令工作台/技能判定', value: { 待判定: [] } }], h.ctx.chat[0].mes);
    await h.ctx.eventSource.emit('mag_before_message_update', { variables });
    assert.equal(h.service.view().selection.checks.length, 0);
});

test('changing swipe while a prepared send is cancelled removes only its own pending draft block', async () => {
    const h = fixture(); await h.install();
    h.input.value = '行动<!-- unrelated -->';
    await h.ctx.eventSource.emit('before', 'normal');
    assert.ok(h.input.value.includes('请求ID'));
    await h.ctx.eventSource.emit('swipe', 0);
    assert.equal(h.input.value, '行动<!-- unrelated -->');
    await h.ctx.eventSource.emit('before', 'normal');
    assert.equal(h.input.value.split('[随机指令工作台 · 技能检定协议 v2').length, 2);
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

test('loading another skill group refreshes the draft with current modifiers while keeping pending checks', async t => {
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
    assert.equal(message.extra[SETTINGS_KEY].skills.results.length, 2);
    assert.equal(random.mock.callCount(), 4);
    assert.equal(message.mes.split('[随机指令工作台 · 技能检定协议 v2').length, 2);
});

test('an overspent point budget remains guidance and does not block skill requests', async t => {
    const h = fixture(); await h.install();
    h.ctx.chatMetadata[SKILL_SETTINGS_KEY].pointLimit = 0;
    const random = t.mock.method(Math, 'random', () => { throw new Error('must not roll'); });
    await h.ctx.eventSource.emit('before', 'normal');
    const message = await h.commit();
    assert.ok(message.mes.includes('技能检定协议'));
    assert.equal(message.extra[SETTINGS_KEY].skills.results.length, 0);
    assert.match(h.service.view().errors.join(), /超过总加值预算/);
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
    }
    const variables = { stat_data: { 场景: {} }, schema: {} };
    await h.ctx.eventSource.emit('mag_command_parsed', variables, [{ op: 'replace', path: '/随机指令工作台/技能判定', value: { 规则版本: 2, 本轮处理: [], 请求ID: req.id, 待判定: [{ 技能名: '撬锁', 对应事件: '开锁', 判定条件: '普通门锁与正常光照，无干扰', DC: 15 }] } }], h.ctx.chat.at(-1).mes);
    await h.ctx.eventSource.emit('mag_before_message_update', { variables }); h.data.set(1, variables);
    assert.equal(h.service.view().selection.checks.length, 1);
    const translated = [{ type: 'insert', reason: 'json_patch', args: ['["随机指令工作台"]', '"技能判定"', JSON.stringify({ 规则版本: 2, 本轮处理: [], 请求ID: req.id, 待判定: [{ 技能名: '侦查', 对应事件: '观察走廊', 判定条件: '普通门锁与正常光照，无干扰', DC: 15 }] })] }];
    await h.ctx.eventSource.emit('mag_command_parsed', variables, translated, h.ctx.chat.at(-1).mes);
    assert.equal(translated.length, 0);
    await h.ctx.eventSource.emit('mag_before_message_update', { variables });
    assert.equal(h.service.view().selection.checks[0].name, '侦查');
});

test('migration persists before first send even if the skill UI has never opened', () => {
    const h = fixture();
    const old = { version: 1, enabled: true, skills: [{ id: 'a', name: '观察', value: 20 }] };
    h.ctx.chatMetadata[SKILL_SETTINGS_KEY] = old;
    h.ctx.chat.push({ mes: '开场' });
    let saved = 0;
    h.ctx.saveMetadataDebounced = () => saved++;
    assert.equal(h.service.settings().skills[0].modifier, 3);
    assert.equal(h.ctx.chatMetadata[SKILL_SETTINGS_KEY].version, 2);
    h.ctx.chatMetadata[SKILL_SETTINGS_KEY].skills[0].modifier = -4;
    assert.equal(h.service.settings().skills[0].modifier, -4);
    assert.equal(saved, 1);
    assert.deepEqual(h.service.settings().migrationSnapshot, old);
});

test('recent adoption reports read the corresponding MVU data without reply-edit or swipe restrictions', async () => {
    const h = fixture(); await h.install();
    await h.ctx.eventSource.emit('before', 'normal'); await h.commit();
    const first = await h.parse(h.reply());
    await h.ctx.eventSource.emit('mag_before_message_update', { variables: first.variables }); h.data.set(1, first.variables);
    h.input.value = '开锁并观察'; await h.ctx.eventSource.emit('before', 'normal');
    const user = await h.commit();
    const req = h.reply();
    const variables = { stat_data: { 场景: { 回合: 2 } }, schema: {} };
    const payload = { 规则版本: 2, 请求ID: req.id, 待判定: [], 本轮处理: req.checks.map((c, i) => ({ 检定ID: c.id, 处理: i ? '未执行' : '采用检定', 说明: '按本轮实际行动处理' })) };
    await h.ctx.eventSource.emit('mag_command_parsed', variables, [{ op: 'add', path: '/随机指令工作台/技能判定', value: payload }], h.ctx.chat.at(-1).mes);
    await h.ctx.eventSource.emit('mag_before_message_update', { variables }); h.data.set(3, variables);
    assert.deepEqual(h.service.recent().reports.map(r => r.处理), ['采用检定', '未执行']);
    h.input.value = '离开'; await h.ctx.eventSource.emit('before', 'normal'); await h.commit();
    assert.equal(h.ctx.chat.at(-1).extra.auto_random_input.skills.results.length, 0);
    h.reply();
    assert.equal(h.service.recent().turn.request.id, user.extra.auto_random_input.skills.request.id);
    assert.equal(h.service.recent().reports.length, 2);
    h.ctx.chat[3].swipe_id = 1;
    assert.equal(h.service.recent().reports.length, 2);
    h.ctx.chat[3].swipe_id = 0; h.ctx.chat[3].mes += '修改';
    assert.equal(h.service.recent().reports.length, 2);
});

test('changing dice during a cancelled draft uses the new die with the existing DC selection', async t => {
    const h = fixture(); await h.install();
    await h.ctx.eventSource.emit('before', 'normal'); await h.commit();
    const { variables } = await h.parse(h.reply());
    await h.ctx.eventSource.emit('mag_before_message_update', { variables }); h.data.set(1, variables);
    const random = t.mock.method(Math, 'random', () => 0.5);
    h.input.value = '行动'; await h.ctx.eventSource.emit('before', 'normal');
    assert.equal(random.mock.callCount(), 2);
    h.ctx.chatMetadata[SKILL_SETTINGS_KEY].diceSides = 100;
    await h.ctx.eventSource.emit('before', 'normal');
    const message = await h.commit();
    assert.equal(message.extra.auto_random_input.skills.results.length, 2);
    assert.equal(message.extra.auto_random_input.skills.results[0].sides, 100);
    assert.equal(message.extra.auto_random_input.skills.results[0].result, 51);
    assert.equal(random.mock.callCount(), 4);
    assert.equal(message.mes.split('[随机指令工作台 · 技能检定协议 v2').length, 2);
});

test('regenerating a historical threshold batch restores the old rule once without changing its snapshot', async t => {
    const h = fixture(); await h.install();
    const legacy = { request: { id: 'legacy-request', diceSides: 20, mode: 'challenge', maxChecks: 1,
        skills: [{ id: 'old-lock', name: '撬锁', value: 13 }] },
        results: [{ skillId: 'old-lock', name: '撬锁', action: '打开旧门锁', sides: 20, value: 13, result: 12, passed: true }],
        diceSides: 20, source: null, issues: [] };
    const snapshot = JSON.stringify(legacy);
    h.ctx.chat.push({ is_user: true, mes: '历史行动', extra: { auto_random_input: { block: '', display: '', rolls: [], skills: legacy } } }, { mes: '旧回复' });
    const random = t.mock.method(Math, 'random', () => { throw Error('Historical batches must not reroll'); });
    await h.ctx.eventSource.emit('before', 'regenerate');
    assert.match(h.ctx.chat[0].mes, /旧版技能检定历史批次/);
    assert.match(h.ctx.chat[0].mes, /骰点 ≤ 技能值/);
    assert.match(h.ctx.chat[0].mes, /旧技能值 13/);
    const restoredText = h.ctx.chat[0].mes;
    await h.ctx.eventSource.emit('before', 'regenerate');
    assert.equal(h.ctx.chat[0].mes, restoredText);
    assert.equal(JSON.stringify(h.ctx.chat[0].extra.auto_random_input.skills), snapshot);
    assert.equal(random.mock.callCount(), 0);
});

test('regenerating an existing user message notifies HTML renderers after restoring its saved skill contract', async () => {
    const h = fixture();
    h.ctx.eventTypes.MESSAGE_UPDATED = 'updated';
    const lifecycle = [];
    h.ctx.updateMessageBlock = id => lifecycle.push(`render:${id}`);
    h.ctx.eventSource.on('updated', id => lifecycle.push(`updated:${id}`));
    await installSendHooks(() => h.ctx, () => {}, () => h.input, () => true, h.service);
    await h.ctx.eventSource.emit('before', 'normal');
    const message = await h.commit();
    const record = message.extra[SETTINGS_KEY];
    message.mes = '继续'; record.block = ''; record.display = '';
    await h.ctx.eventSource.emit('before', 'regenerate');
    assert.deepEqual(lifecycle, ['render:0', 'updated:0']);
    await h.ctx.eventSource.emit('before', 'regenerate');
    assert.deepEqual(lifecycle, ['render:0', 'updated:0']);
});

test('regeneration reuses the protocol left inside recall after a regex edits its example tags', async () => {
    const h = fixture(); await h.install();
    await h.ctx.eventSource.emit('before', 'normal');
    const message = await h.commit();
    const record = message.extra[SETTINGS_KEY];
    message.mes = `以下是用户的本轮输入：\n<本轮用户输入>\n${message.mes}\n</本轮用户输入>\n<recall>已有召回</recall>`
        .replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/g, '');
    record.block = ''; record.display = '';
    const original = message.mes;
    await h.ctx.eventSource.emit('before', 'regenerate');
    assert.equal(message.mes, original);
    assert.equal(message.mes.split('[随机指令工作台 · 技能检定协议 v2]').length, 2);
});

test('a parsed narrative report cannot attach to a different swipe before MVU write', async () => {
    const h = fixture();
    const { NARRATIVE_KEY, foldNarrative } = await import('../narrative.js');
    const turn = { turnId: 'turn', newThreadId: 'thread', baseRevision: foldNarrative([]).revision, candidates: [] };
    h.ctx.chat.push({ is_user: true, mes: '查看蓝签', extra: { [SETTINGS_KEY]: { narrative: turn } } });
    const reply = { mes: '他发现一枚蓝签。', swipe_id: 0, extra: {} };
    h.ctx.chat.push(reply);
    const report = {
        version: 1, turnId: turn.turnId, baseRevision: turn.baseRevision, uses: [], updates: [],
        newThread: { title: '蓝签来历', cause: '发现蓝签', question: '谁留下的？', evidence: '他发现一枚蓝签。' },
    };
    const variables = { stat_data: { 场景: { 回合: 1 } }, schema: {} };
    const commands = [{ op: 'replace', path: '/随机指令工作台/剧情回报', value: report }];
    await h.ctx.eventSource.emit('mag_command_parsed', variables, commands, reply.mes);
    assert.equal(commands.length, 0);
    reply.swipe_id = 1;
    await h.ctx.eventSource.emit('mag_before_message_update', { variables });
    assert.deepEqual(foldNarrative(h.ctx.chat).threads, []);
    assert.equal(reply.extra[NARRATIVE_KEY]?.swipes?.[1], undefined);
    assert.equal(variables.stat_data.随机指令工作台?.剧情回报, undefined);
});

test('reparsed narrative edits clear stale reports but preserve actions on the same swipe', async () => {
    const h = fixture();
    const { NARRATIVE_KEY, foldNarrative } = await import('../narrative.js');
    const turn = { turnId: 'edit-turn', newThreadId: 'thread', baseRevision: foldNarrative([]).revision, candidates: [] };
    h.ctx.chat.push({ is_user: true, mes: '查看蓝签', extra: { [SETTINGS_KEY]: { narrative: turn } } });
    const report = { version: 1, turnId: turn.turnId, baseRevision: turn.baseRevision, uses: [], updates: [],
        newThread: { title: '蓝签来历', cause: '发现蓝签', question: '谁留下的？', evidence: '他发现一枚蓝签。' } };
    const actions = [{ type: 'pause', threadId: 'thread' }];
    const data = { uid: 'edited-reply', swipes: { 0: { report, actions }, 1: { report } } };
    const message = { mes: '他发现一枚蓝签。', swipe_id: 0, extra: { [NARRATIVE_KEY]: data } };
    h.ctx.chat.push(message);
    const parse = async commands => {
        const variables = { stat_data: { 场景: { 回合: 1 } }, schema: {} };
        await h.ctx.eventSource.emit('mag_command_parsed', variables, commands, message.mes);
        return variables;
    };
    const absent = await parse([]);
    message.swipe_id = 1;
    await h.ctx.eventSource.emit('mag_before_message_update', { variables: absent });
    assert.deepEqual(data.swipes[1].report, report);
    message.swipe_id = 0;
    await h.ctx.eventSource.emit('mag_before_message_update', { variables: await parse([]) });
    assert.deepEqual(data.swipes[0], { actions });
    data.swipes[0].report = report;
    const wrongTurn = await parse([{ op: 'replace', path: '/随机指令工作台/剧情回报',
        value: { ...report, turnId: 'old-turn' } }]);
    await h.ctx.eventSource.emit('mag_before_message_update', { variables: wrongTurn });
    assert.deepEqual(data.swipes[0], { actions });
    assert.equal(wrongTurn.stat_data.随机指令工作台?.剧情回报, undefined);
});
