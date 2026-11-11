import assert from 'node:assert/strict';
import test from 'node:test';
import { SETTINGS_KEY, activeGroup, createRule, normalizeSettings, processMessage } from '../core.js';
import { installSendHooks } from '../send.js';
import { AUTO_ORACLE_KEY } from '../oracle-auto-state.js';

const user = mes => ({ is_user: true, is_system: false, mes, extra: {} });
function host() {
    const settings = normalizeSettings();
    settings.enabled = true;
    settings.includeRollResult = true;
    const rule = activeGroup(settings).rules[0];
    rule.diceSides = 6;
    rule.commands = Array.from({ length: 10 }, (_, i) => `剧情命令 ${i + 1}`);
    activeGroup(settings).rules.push(createRule('情绪', { diceSides: 4, commands: ['情绪命令', '', '', '其他情绪'] }));
    const listeners = new Map();
    const input = { value: '用户输入', notifications: 0, dispatchEvent() { this.notifications++; } };
    const saved = [];
    const updated = [];
    const rendered = new Set();
    const ctx = {
        chat: [], extensionSettings: { [SETTINGS_KEY]: settings },
        eventTypes: { GENERATION_AFTER_COMMANDS: 'before', MESSAGE_SENT: 'sent', CHAT_CHANGED: 'chat', MESSAGE_UPDATED: 'updated' },
        eventSource: {
            on(type, fn) { const list = listeners.get(type) ?? []; list.push(fn); listeners.set(type, list); },
            makeFirst(type, fn) { const list = listeners.get(type) ?? []; list.unshift(fn); listeners.set(type, list); },
            async emit(type, ...args) { for (const fn of [...(listeners.get(type) ?? [])]) await fn(...args); },
        },
        updateMessageBlock(id, message) {
            // The real host accesses getAttribute on the message's DOM node.
            if (!rendered.has(id)) throw new TypeError("Cannot read properties of undefined (reading 'getAttribute')");
            assert.equal(message, this.chat[id]);
            updated.push(id);
        },
        async saveChat() { saved.push(JSON.stringify(this.chat)); },
    };
    return { ctx, input, settings, saved, updated, rendered,
        install: () => installSendHooks(() => ctx, () => {}, () => input, id => rendered.has(id)),
        before: (type = 'normal', params = {}, dryRun = false) => ctx.eventSource.emit('before', type, params, dryRun),
        async commit(text = input.value) {
            input.value = '';
            const id = ctx.chat.push(user(text)) - 1;
            await ctx.eventSource.emit('sent', id);
            rendered.add(id);
            return ctx.chat[id];
        },
    };
}

test('a chat automatic group reaches the prepared input and saved roll without changing the shared selection', async () => {
    const h = host(), manualId = h.settings.activeGroupId;
    const group = { id: 'chat-auto-group', name: '聊天自动配置', rules: [createRule('当前阶段', { diceSides: 1, commands: ['自动剧情指令'] })] };
    h.settings.groups.push(group);
    h.ctx.chatMetadata = { [AUTO_ORACLE_KEY]: { groupId: group.id, useGroup: true } };
    await h.install(); await h.before();
    assert.ok(h.input.value.includes('自动剧情指令'));
    const message = await h.commit();
    assert.equal(message.extra[SETTINGS_KEY].groupId, group.id);
    assert.equal(h.settings.activeGroupId, manualId);
});

test('d100 reaches recall once, reuses its range snapshot on retries, and saves the same result', async t => {
    const h = host();
    const rule = activeGroup(h.settings).rules[0];
    rule.diceSides = 100;
    rule.ranges = [{ range: '1-14', command: '范围事件' }, { range: '15-31', command: '另一个事件' }];
    activeGroup(h.settings).rules = [rule];
    const random = t.mock.method(Math, 'random', () => 0.135);
    let recallInput;
    h.ctx.eventSource.on('before', () => { recallInput = h.input.value; });
    await h.install();
    await h.before();
    assert.ok(recallInput.includes('范围事件\n> （投掷结果：d100 = 14）'));
    rule.ranges[0] = { range: '1-100', command: '编辑后的事件' };
    await h.before();
    const message = await h.commit();
    await h.ctx.eventSource.emit('sent', 0);
    await h.before('regenerate');
    assert.equal(random.mock.callCount(), 1);
    assert.equal(message.extra[SETTINGS_KEY].rolls[0].range, '1-14');
    assert.equal(message.extra[SETTINGS_KEY].rolls[0].result, 14);
    assert.ok(!message.mes.includes('编辑后的事件'));
    assert.equal(JSON.parse(h.saved[0])[0].extra[SETTINGS_KEY].rolls[0].range, '1-14');
});

test('d100 uncovered outcomes pass unchanged through recall and repeated generation events', async t => {
    const h = host();
    const rule = activeGroup(h.settings).rules[0];
    rule.diceSides = 100;
    rule.ranges = [{ range: '1-89', command: '范围事件' }];
    activeGroup(h.settings).rules = [rule];
    const random = t.mock.method(Math, 'random', () => 0.995);
    await h.install();
    await h.before();
    assert.equal(h.input.value, '用户输入');
    h.input.value = `<本轮用户输入>${h.input.value}</本轮用户输入>\n<recall>记忆</recall>`;
    await h.before();
    const message = await h.commit();
    assert.equal(random.mock.callCount(), 1);
    assert.equal(message.extra[SETTINGS_KEY].rolls[0].result, 100);
    assert.equal(message.extra[SETTINGS_KEY].rolls[0].uncovered, true);
    assert.ok(!message.mes.includes('本轮指令'));
});

test('new messages are saved before the host creates their DOM nodes', async t => {
    const h = host();
    const errors = t.mock.method(console, 'error', () => {});
    await h.install();
    await h.before();
    const message = await h.commit();
    assert.equal(errors.mock.callCount(), 0);
    assert.deepEqual(h.updated, []);
    assert.equal(h.saved.length, 1);
    assert.ok(JSON.parse(h.saved[0])[0].extra[SETTINGS_KEY]);
    assert.ok(message.mes.includes('本轮指令'));
});

test('recall reads all independently rolled commands before building its result, without a second roll on save', async t => {
    const h = host();
    const values = [0.999, 0];
    t.mock.method(Math, 'random', () => { assert.ok(values.length, 'unexpected extra roll'); return values.shift(); });
    let recallInput;
    let recordedBeforeOtherListeners = false;
    // Register recall first, as when the database has already loaded.
    h.ctx.eventSource.on('before', () => {
        recallInput = h.input.value;
        h.input.value = `<本轮用户输入>\n${recallInput}\n</本轮用户输入>\n<recall>模拟召回</recall>`;
    });
    h.ctx.eventSource.on('sent', id => { recordedBeforeOtherListeners = !!h.ctx.chat[id].extra[SETTINGS_KEY]; });
    await h.install();
    await h.before();
    assert.ok(recallInput.includes('剧情命令 6\n> （投掷结果：d6 = 6）'));
    assert.ok(recallInput.includes('情绪命令\n> （投掷结果：d4 = 1）'));
    const message = await h.commit();
    assert.deepEqual(message.extra[SETTINGS_KEY].rolls.map(roll => roll.result), [6, 1]);
    assert.equal(values.length, 0);
    assert.equal(message.mes.split('剧情命令 6').length, 2);
    assert.ok(message.mes.indexOf('情绪命令') < message.mes.indexOf('</本轮用户输入>'));
    assert.ok(message.mes.indexOf('</本轮用户输入>') < message.mes.indexOf('<recall>'));
    assert.ok(!message.mes.includes('ARI:'));
    assert.equal(recordedBeforeOtherListeners, true);
    assert.equal(h.saved.length, 1);
});

test('cancelled sends and nested group generation reuse a prepared roll; duplicate events do not roll', async t => {
    const h = host();
    const random = t.mock.method(Math, 'random', () => 0);
    await h.install();
    await h.before();
    const prepared = h.input.value;
    await h.before();
    assert.equal(h.input.value, prepared);
    assert.equal(random.mock.callCount(), 2);
    assert.equal(h.saved.length, 0);
    await h.commit();
    await h.ctx.eventSource.emit('sent', 0);
    await h.before();
    assert.equal(random.mock.callCount(), 2);
    assert.equal(h.saved.length, 1);
});

test('empty outcomes remain empty after recall wraps the input and nested generation runs', async t => {
    const h = host();
    for (const rule of activeGroup(h.settings).rules) rule.commands[0] = '';
    const random = t.mock.method(Math, 'random', () => 0);
    await h.install();
    await h.before();
    h.input.value = `<本轮用户输入>${h.input.value}</本轮用户输入>\n<recall>记忆</recall>`;
    await h.before();
    const message = await h.commit();
    assert.equal(random.mock.callCount(), 2);
    assert.ok(message.extra[SETTINGS_KEY].rolls.every(roll => roll.skipped));
    assert.ok(!message.mes.includes('本轮指令'));
    assert.ok(!message.mes.includes('投掷结果'));
});

test('dry runs, automatic generation, regeneration, continuation and disabled or blank drafts are not prepared', async t => {
    const h = host();
    t.mock.method(Math, 'random', () => { throw new Error('must not roll'); });
    await h.install();
    for (const type of ['regenerate', 'continue', 'swipe', 'quiet', 'impersonate']) await h.before(type);
    await h.before('normal', {}, true);
    await h.before('normal', { automatic_trigger: true });
    h.settings.enabled = false;
    await h.before();
    assert.equal(h.input.value, '用户输入');
    h.settings.enabled = true;
    h.input.value = ' \n ';
    await h.before();
    assert.equal(h.input.value, ' \n ');
    assert.equal(h.input.notifications, 0);
    assert.equal(h.saved.length, 0);
});

test('host text transformations and settings changes do not reroll or append commands after recall', async t => {
    const h = host();
    const random = t.mock.method(Math, 'random', () => 0);
    await h.install();
    await h.before();
    const transformed = `<本轮用户输入>${h.input.value.replace('剧情命令 1', '宿主改写的命令')}</本轮用户输入><recall>记忆</recall>`;
    h.settings.enabled = false;
    const message = await h.commit(transformed);
    assert.equal(message.mes, transformed);
    assert.equal(message.extra[SETTINGS_KEY].block, '');
    assert.deepEqual(message.extra[SETTINGS_KEY].rolls.map(roll => roll.result), [1, 1]);
    assert.equal(random.mock.callCount(), 2);
});

test('switching chats discards pending results and script-created user messages still get a fresh roll', async t => {
    const h = host();
    const values = [0, 0, 0.999, 0.999];
    t.mock.method(Math, 'random', () => { assert.ok(values.length); return values.shift(); });
    await h.install();
    await h.before();
    h.ctx.chat = [];
    await h.ctx.eventSource.emit('chat');
    const message = await h.commit('另一聊天的脚本输入');
    assert.deepEqual(message.extra[SETTINGS_KEY].rolls.map(roll => roll.result), [6, 4]);
    assert.ok(message.mes.includes('剧情命令 6'));
    assert.ok(!message.mes.includes('剧情命令 1'));
});

test('history cleanup waits for an actual new message and preserves recall text', async () => {
    const h = host();
    const old = user('旧用户输入');
    h.ctx.chat.push(old);
    h.rendered.add(0);
    processMessage(h.ctx.chat, 0, h.settings, () => 0);
    old.mes += '\n<recall>旧召回</recall>';
    const before = old.mes;
    const notifications = [];
    h.ctx.eventSource.on('updated', id => {
        assert.ok(h.updated.includes(id));
        notifications.push(id);
    });
    await h.install();
    await h.before();
    assert.equal(old.mes, before);
    await h.commit();
    assert.equal(old.mes, '旧用户输入\n<recall>旧召回</recall>');
    assert.deepEqual(h.updated, [0]);
    assert.deepEqual(notifications, [0]);
});

test('unrendered history is cleaned and saved without refreshing absent DOM nodes', async t => {
    const h = host();
    const errors = t.mock.method(console, 'error', () => {});
    h.ctx.chat.push(user('较早的用户输入'));
    processMessage(h.ctx.chat, 0, h.settings, () => 0);
    await h.install();
    await h.before();
    await h.commit();
    assert.equal(errors.mock.callCount(), 0);
    assert.deepEqual(h.updated, []);
    assert.equal(h.ctx.chat[0].mes, '较早的用户输入');
    assert.equal(JSON.parse(h.saved[0])[0].mes, '较早的用户输入');
});

test('chat loading removes tracked old ARI wrappers and saves the migrated metadata once', async () => {
    const h = host();
    const display = '\n\n> **随机指令**\n> 保留命令';
    const block = `\n\n<!-- ARI:legacy -->${display}\n<!-- /ARI:legacy -->`;
    const message = user('原文' + block);
    message.extra[SETTINGS_KEY] = { block, display };
    h.ctx.chat.push(message);
    await h.install();
    assert.equal(message.mes, '原文' + display);
    assert.equal(message.extra[SETTINGS_KEY].block, display);
    assert.equal(h.saved.length, 1);
    await h.ctx.eventSource.emit('chat');
    assert.equal(h.saved.length, 1);
});
