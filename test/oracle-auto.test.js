import assert from 'node:assert/strict';
import test from 'node:test';
import { SETTINGS_KEY, activeGroup, createRollRecord, normalizeSettings } from '../core.js';
import { SKILL_GROUPS_KEY, normalizeSkillGroups } from '../skill-groups.js';
import { ORACLE_SETTINGS_KEY, normalizeOracleSettings } from '../oracle-config.js';
import { createOracleRequestGate, createOracleService } from '../oracle-service.js';
import { AUTO_ORACLE_KEY, autoOracleOwner, effectiveRandomSettings, normalizeAutoOracle, reconcileAutoOracleState, selectRandomGroup } from '../oracle-auto-state.js';
import { installAutoOracle } from '../oracle-auto.js';
import { parseConfigFile, serializeConfigFile } from '../config-transfer.js';

const reply = text => ({ is_user: false, is_system: false, mes: text, extra: {} });
const bundle = (command = '新的剧情变化') => ({ format: 'auto-random-input', formatVersion: 1,
    randomGroups: [{ name: '模型生成组', rules: [{ name: '剧情变化', diceSides: 1, commands: [command] }] }], skillGroups: [] });
function autoBundle({ diceSides = 20, commandCount = 10, ruleCount = 3, command = '新的剧情变化' } = {}) {
    const commands = Array.from({ length: commandCount }, (_, index) => index ? `指令 ${index + 1}` : command);
    const data = bundle(command);
    data.randomGroups[0].rules = Array.from({ length: ruleCount }, (_, index) => ({
        name: `骰子 ${index + 1}`, diceSides,
        commands: diceSides === 100 ? [] : commands.slice(),
        ranges: diceSides === 100 ? commands.map((text, point) => ({ range: String(point + 1), command: text })) : [],
    }));
    return data;
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture({ saved, fallbackEvent = false, afterCommands = false, hostState, run = async messages => JSON.stringify(
    messages[0].content.includes('本次每套骰子') ? autoBundle() : bundle(),
) } = {}) {
    const listeners = new Map(), notices = [], requests = [];
    let saves = 0, metadataSaves = 0;
    const store = normalizeSettings();
    const ctx = {
        characterId: 0, groupId: null, chatId: '聊天甲', name2: '测试角色',
        chat: [reply('历史开场白')], chatMetadata: saved ? { [AUTO_ORACLE_KEY]: structuredClone(saved) } : {},
        extensionSettings: { [SETTINGS_KEY]: store, [SKILL_GROUPS_KEY]: normalizeSkillGroups(), [ORACLE_SETTINGS_KEY]: normalizeOracleSettings() },
        eventTypes: { GENERATION_STARTED: 'start', GENERATION_ENDED: 'end', GENERATION_STOPPED: 'stop', MESSAGE_RECEIVED: 'received', MESSAGE_SENT: 'sent', CHAT_CHANGED: 'chat',
            ...(fallbackEvent ? {} : { CHARACTER_MESSAGE_RENDERED: 'rendered' }),
            ...(afterCommands ? { GENERATION_AFTER_COMMANDS: 'after-commands' } : {}) },
        eventSource: {
            on(name, fn) { const handlers = listeners.get(name) ?? []; handlers.push(fn); listeners.set(name, handlers); },
            async emit(name, ...args) { for (const fn of listeners.get(name) ?? []) await fn(...args); },
        },
        saveSettingsDebounced() { saves++; }, saveMetadataDebounced() { metadataSaves++; },
    };
    const api = {
        isCompatible: n => n === 1,
        context: { buildCardSection: () => '角色资料', buildTranscript: c => c.chat.map(m => m.mes).join('\n'),
            buildWorldInfo: async () => '世界书资料' },
        run: async (...args) => { requests.push(args); return run(...args); },
    };
    const gate = createOracleRequestGate(), host = { StoryOracleAPI: api };
    const skills = { view: () => ({ ready: false }) };
    const getContext = () => ({ ...ctx });
    const automatic = createOracleService(getContext, skills, host, { gate, automatic: true });
    const manual = createOracleService(getContext, skills, host, { gate });
    const controller = installAutoOracle(getContext, automatic, {
        notify: (kind, message) => notices.push({ kind, message }),
        ...(hostState ? { isMainGenerating: () => hostState.generating } : {}),
    });
    const emit = (name, ...args) => ctx.eventSource.emit(ctx.eventTypes[name] ?? name, ...args);
    return { ctx, store, api, host, gate, manual, automatic, controller, requests, notices, emit,
        setRun(next) { run = next; },
        saves: () => ({ saves, metadataSaves }),
        start: (interval = 2, prompt = '', parameters) => controller.start({ interval, prompt, ...parameters }),
        async receive(text = '新增剧情', type = 'normal', originalType = type, replace = false) {
            await emit('GENERATION_STARTED', originalType, {}, false);
            if (replace) ctx.chat.pop();
            const id = ctx.chat.push(reply(text)) - 1;
            await emit(fallbackEvent ? 'MESSAGE_RECEIVED' : 'CHARACTER_MESSAGE_RENDERED', id, type);
            await emit('GENERATION_ENDED');
            await tick();
            return id;
        },
        async send(text = '用户的下一次行动') {
            const id = ctx.chat.push({ is_user: true, mes: text }) - 1; await emit('MESSAGE_SENT', id);
        },
        async switchChat(id, chat = [reply('另一段历史')], metadata = {}) {
            Object.assign(ctx, { chatId: id, chat, chatMetadata: metadata }); await emit('CHAT_CHANGED'); await tick();
        },
    };
}

test('defaults are off; opening settings, receiving replies, and restoring a chat never call the API', async () => {
    const h = fixture();
    assert.equal(normalizeAutoOracle().enabled, false);
    assert.equal(normalizeAutoOracle().interval, 1);
    assert.equal(normalizeAutoOracle({ interval: 5 }).interval, 5);
    await h.receive(); await h.emit('CHAT_CHANGED');
    assert.equal(h.requests.length, 0);
    assert.equal(h.ctx.chatMetadata[AUTO_ORACLE_KEY], undefined);
    const restored = fixture({ saved: { enabled: true, interval: 3, progress: 2 } });
    await restored.emit('CHAT_CHANGED'); await tick();
    assert.equal(restored.requests.length, 0);
    assert.equal(restored.controller.state().progress, 2);
    assert.equal(restored.controller.state().interval, 3);
    const { commandCount, ruleCount, diceSides, mapping } = restored.controller.state();
    assert.deepEqual({ commandCount, ruleCount, diceSides, mapping }, { commandCount: 10, ruleCount: 3, diceSides: 20, mapping: 'first' });
    await restored.receive();
    assert.equal(restored.requests.length, 1);
});

test('starting makes one immediate request with the custom prompt and preserves the master switch and manual group', async () => {
    const h = fixture(), original = structuredClone(h.store.groups[0]);
    await h.start(3, '只增加日常交流中的小意外。');
    assert.equal(h.requests.length, 1);
    assert.ok(h.requests[0][0].some(m => m.content.includes('只增加日常交流中的小意外。')));
    assert.deepEqual(h.store.groups[0], original);
    assert.equal(h.store.activeGroupId, original.id);
    assert.equal(h.store.enabled, false);
    assert.equal(activeGroup(effectiveRandomSettings(h.ctx)).id, h.controller.state().groupId);
    const { rules } = activeGroup(effectiveRandomSettings(h.ctx));
    assert.equal(rules.length, 3);
    for (const rule of rules) {
        assert.equal(rule.diceSides, 20);
        assert.equal(rule.commands.filter(Boolean).length, 10);
        assert.ok(rule.commands.slice(10).every(command => command === ''));
    }
    assert.equal(h.controller.state().progress, 0);
    assert.equal(h.notices.filter(n => n.kind === 'success').length, 1);
});

test('automatic defaults use recent plot and world info while manual defaults remain reusable', async () => {
    const h = fixture(); await h.start();
    const messages = h.requests[0][0];
    assert.match(messages[0].content, /根据近期对话/);
    assert.doesNotMatch(messages.map(message => message.content).join('\n'), /长期使用|技能组字段/);
    assert.match(messages[1].content, /skillGroups 必须为 \[\]/);
    assert.ok(messages.some(m => m.content.includes('世界书资料') && m.content.includes('历史开场白')));
    const manual = await h.manual.generate('random', { randomDice: 1, ruleCount: 1 });
    assert.match(h.requests[1][0][0].content, /优先生成适合这张角色卡长期使用/);
    assert.doesNotMatch(h.requests[1][0][0].content, /本次每套骰子/);
    assert.equal(manual.error, undefined);
    assert.deepEqual(manual.value, bundle());
});

test('manual automatic regeneration uses current settings and replaces the current group while preserving the interval progress', async () => {
    const h = fixture();
    assert.throws(() => h.controller.regenerate(), /开启/);
    await h.start(3);
    await h.receive();
    const groupId = h.controller.state().groupId;
    h.controller.update({ interval: 3, prompt: '这次集中写港口情节。' });
    const pending = deferred();
    h.setRun(() => pending.promise);
    const running = h.controller.regenerate();
    await tick();
    h.controller.regenerate();
    assert.equal(h.requests.length, 2);
    assert.ok(h.requests[1][0].some(message => message.content.includes('这次集中写港口情节。')));
    pending.resolve(JSON.stringify(autoBundle({ command: '新生成的港口情节' })));
    await running;
    assert.equal(h.controller.state().groupId, groupId);
    assert.equal(h.controller.state().progress, 1);
    assert.equal(activeGroup(effectiveRandomSettings(h.ctx)).rules[0].commands[0], '新生成的港口情节');
});

for (const [diceSides, commandCount, endPoints] of [
    [6, 4, [1, 3, 4, 6]], [20, 3, [6, 13, 20]], [100, 3, [33, 66, 100]],
]) for (const mapping of ['first', 'even']) test(`d${diceSides} ${mapping} maps all faces correctly`, async () => {
    const parameters = { diceSides, commandCount, ruleCount: 1, mapping };
    const h = fixture({ run: async () => JSON.stringify(autoBundle(parameters)) });
    await h.start(2, '', parameters);
    assert.equal(h.notices.at(-1).kind, 'success');
    const effective = effectiveRandomSettings(h.ctx);
    const expected = ['新的剧情变化', ...Array.from({ length: commandCount - 1 }, (_, index) => `指令 ${index + 2}`)];
    for (let point = 1; point <= diceSides; point++) {
        const record = createRollRecord(effective, () => (point - 0.5) / diceSides);
        const index = mapping === 'first' ? point - 1 : endPoints.findIndex(end => point <= end);
        assert.equal(record.rolls[0].result, point);
        assert.equal(record.rolls[0].skipped, !expected[index]);
        if (expected[index]) assert.ok(record.block.includes(expected[index]), `d${diceSides} point ${point}`);
        else assert.equal(record.block, '');
    }
});

test('invalid automatic parameters cannot start a request or replace saved settings', async () => {
    const h = fixture();
    const baseline = { interval: 2, prompt: '' };
    const invalid = [{ ruleCount: 0 }, { ruleCount: 11 }, { ruleCount: 1.5 },
        { commandCount: 0 }, { commandCount: 1.5 }, { diceSides: 6, commandCount: 7 }, { diceSides: 12 }, { mapping: 'unknown' }];
    for (const parameters of invalid) assert.throws(() => h.controller.start({ ...baseline, ...parameters }));
    assert.equal(h.ctx.chatMetadata[AUTO_ORACLE_KEY], undefined);
    assert.equal(h.requests.length, 0);
    await h.start();
    const saved = structuredClone(h.ctx.chatMetadata[AUTO_ORACLE_KEY]);
    for (const parameters of invalid) assert.throws(() => h.controller.update({ ...baseline, ...parameters }));
    assert.deepEqual(h.ctx.chatMetadata[AUTO_ORACLE_KEY], saved);
    assert.equal(h.requests.length, 1);
});

for (const fallbackEvent of [false, true]) test(`counts new floors once with ${fallbackEvent ? 'received' : 'rendered'} events`, async () => {
    const h = fixture({ fallbackEvent }); await h.start(2);
    const id = await h.receive();
    await h.emit(fallbackEvent ? 'MESSAGE_RECEIVED' : 'CHARACTER_MESSAGE_RENDERED', id, 'normal');
    await h.emit('MESSAGE_RECEIVED', id, 'normal');
    assert.equal(h.controller.state().progress, 1);
    assert.equal(h.requests.length, 1);
    await h.receive();
    assert.equal(h.requests.length, 2);
    assert.equal(h.controller.state().progress, 0);
});

test('regenerate, swipe, continuation, system messages and empty replies do not count', async () => {
    const h = fixture(); await h.start(3); await h.receive();
    for (const type of ['regenerate', 'swipe', 'continue', 'append', 'appendFinal', 'first_message']) {
        await h.receive('替换正文', type, type, true);
    }
    await h.receive('宿主把重生成标成 normal', 'normal', 'regenerate', true);
    await h.receive('');
    const id = h.ctx.chat.push({ is_system: true, is_user: false, mes: '系统通知' }) - 1;
    await h.emit('CHARACTER_MESSAGE_RENDERED', id, 'normal');
    await h.send();
    assert.equal(h.controller.state().progress, 1);
    assert.equal(h.requests.length, 1);
});

test('both streaming event orders wait for the main reply to finish before dispatching', async () => {
    const h = fixture(); await h.start(1);
    await h.emit('GENERATION_STARTED', 'normal', {}, false);
    let id = h.ctx.chat.push(reply('非流式回复')) - 1;
    await h.emit('CHARACTER_MESSAGE_RENDERED', id, 'normal'); await tick();
    assert.equal(h.requests.length, 1); assert.equal(h.controller.pending, true);
    await h.emit('GENERATION_ENDED'); await tick();
    assert.equal(h.requests.length, 2);
    await h.emit('GENERATION_STARTED', 'normal', {}, false);
    id = h.ctx.chat.push(reply('流式回复')) - 1;
    await h.emit('GENERATION_ENDED');
    await h.emit('CHARACTER_MESSAGE_RENDERED', id, 'normal'); await tick();
    assert.equal(h.requests.length, 3);
});

test('group regeneration replacing normal floors is ignored; new user turns can count after deletion', async () => {
    const h = fixture(); h.ctx.groupId = 'group'; await h.start(10);
    await h.send(); await h.receive('成员甲'); await h.receive('成员乙');
    assert.equal(h.controller.state().progress, 2);
    h.ctx.chat.splice(-2);
    await h.receive('成员甲重新生成'); await h.receive('成员乙重新生成');
    assert.equal(h.controller.state().progress, 2);
    h.ctx.chat.splice(-2);
    await h.send(); await h.receive('新行动的回复');
    assert.equal(h.controller.state().progress, 3);
});

test('updates only the dedicated group, keeps its ID and name, and recreates a deleted group', async () => {
    const h = fixture(); await h.start(1);
    const id = h.controller.state().groupId;
    h.store.groups.find(g => g.id === id).name = '自己改的组名';
    h.api.run = async () => JSON.stringify(autoBundle({ command: '更新后的命令' }));
    await h.receive();
    assert.equal(h.store.groups.length, 2);
    assert.equal(h.controller.state().groupId, id);
    assert.equal(activeGroup(effectiveRandomSettings(h.ctx)).name, '自己改的组名');
    assert.equal(activeGroup(effectiveRandomSettings(h.ctx)).rules[0].commands[0], '更新后的命令');
    h.store.groups = h.store.groups.filter(g => g.id !== id);
    await h.receive();
    assert.notEqual(h.controller.state().groupId, id);
    assert.equal(h.store.groups.length, 2);
});

test('manual selection takes effect until the next automatic update; sending and export resolve the same group', async () => {
    const h = fixture(); await h.start(1);
    const autoId = h.controller.state().groupId;
    const group = activeGroup(effectiveRandomSettings(h.ctx));
    const record = createRollRecord(effectiveRandomSettings(h.ctx), () => 0);
    const exported = parseConfigFile(serializeConfigFile([group]));
    assert.equal(record.groupId, autoId);
    assert.equal(exported.randomGroups[0].rules[0].commands[0], '新的剧情变化');
    assert.ok(!JSON.stringify(exported).includes(AUTO_ORACLE_KEY));
    selectRandomGroup(h.ctx, h.store.groups[0].id);
    assert.equal(activeGroup(effectiveRandomSettings(h.ctx)).id, h.store.groups[0].id);
    await h.receive();
    assert.equal(activeGroup(effectiveRandomSettings(h.ctx)).id, autoId);
    h.controller.stop();
    assert.equal(activeGroup(effectiveRandomSettings(h.ctx)).id, autoId);
    await h.receive(); assert.equal(h.requests.length, 2);
});

test('chat settings, progress and automatic selection are isolated and survive returning to a chat', async () => {
    const parameters = { commandCount: 4, ruleCount: 2, diceSides: 6, mapping: 'even' };
    const h = fixture(); h.setRun(async () => JSON.stringify(autoBundle(parameters)));
    await h.start(3, '甲的要求', parameters); await h.receive();
    const first = { chat: h.ctx.chat, metadata: h.ctx.chatMetadata }, id = h.controller.state().groupId;
    await h.switchChat('聊天乙');
    assert.equal(h.controller.state().enabled, false);
    assert.equal(activeGroup(effectiveRandomSettings(h.ctx)).id, h.store.activeGroupId);
    assert.equal(h.controller.state().diceSides, 20);
    h.setRun(async () => JSON.stringify(autoBundle()));
    await h.start(1, '乙的要求');
    assert.notEqual(h.controller.state().groupId, id);
    await h.switchChat('聊天甲', first.chat, first.metadata);
    assert.equal(h.controller.state().progress, 1);
    assert.equal(h.controller.state().prompt, '甲的要求');
    const { commandCount, ruleCount, diceSides, mapping } = h.controller.state();
    assert.deepEqual({ commandCount, ruleCount, diceSides, mapping }, parameters);
    assert.equal(activeGroup(effectiveRandomSettings(h.ctx)).id, id);
    assert.equal(h.requests.length, 2);
});

test('editing the interval or prompt does not call the API; changing interval resets progress', async () => {
    const h = fixture(); await h.start(3); await h.receive();
    h.controller.update({ interval: 3, prompt: '新要求' });
    assert.equal(h.controller.state().progress, 1);
    h.controller.update({ interval: 2, prompt: '新要求' });
    assert.equal(h.controller.state().progress, 0);
    assert.equal(h.requests.length, 1);
    await h.receive(); await h.receive();
    assert.ok(h.requests[1][0].some(m => m.content.includes('新要求')));
    assert.throws(() => h.controller.update({ interval: 0, prompt: '' }), /整数/);
});

for (const name of ['bad-json', 'invalid-ranges', 'missing-api', 'wrong-rule-count', 'wrong-dice', 'blank-command', 'extra-command']) test(`${name} keeps old configuration and waits a full interval before trying again`, async () => {
    const h = fixture(); await h.start(2);
    const before = JSON.stringify(h.store.groups);
    if (name === 'bad-json') h.api.run = async () => '{broken';
    if (name === 'missing-api') h.host.StoryOracleAPI = undefined;
    if (name === 'wrong-rule-count') h.api.run = async () => JSON.stringify(autoBundle({ ruleCount: 2 }));
    if (name === 'wrong-dice') h.api.run = async () => JSON.stringify(autoBundle({ diceSides: 100 }));
    if (name === 'extra-command') h.api.run = async () => JSON.stringify(autoBundle({ commandCount: 11 }));
    if (name === 'blank-command') h.api.run = async () => JSON.stringify(autoBundle({ command: '  ' }));
    if (name === 'invalid-ranges') h.api.run = async () => {
        const data = bundle(); data.randomGroups[0].rules[0] = { name: '范围', diceSides: 100,
            ranges: [{ range: '1-50', command: '甲' }, { range: '40-60', command: '乙' }] };
        return JSON.stringify(data);
    };
    await h.receive(); await h.receive();
    assert.equal(JSON.stringify(h.store.groups), before);
    assert.equal(h.notices.filter(n => n.kind === 'error').length, 1);
    assert.equal(h.controller.state().progress, 0);
    await h.receive();
    assert.equal(h.notices.filter(n => n.kind === 'error').length, 1);
});

test('timeout reports failure without changing groups or starting a retry', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = fixture({ run: () => new Promise(() => {}) });
    h.ctx.extensionSettings[ORACLE_SETTINGS_KEY].timeoutSeconds = 30;
    const before = JSON.stringify(h.store.groups), pending = h.start();
    await tick(); t.mock.timers.tick(30001); await pending;
    assert.equal(h.requests.length, 1);
    assert.equal(h.notices[0].kind, 'error'); assert.match(h.notices[0].message, /超时/);
    assert.equal(JSON.stringify(h.store.groups), before);
    assert.equal(h.controller.busy, false);
});

test('new same-chat replies and edits during a request do not invalidate its result or lose progress', async () => {
    const result = deferred(), h = fixture({ run: () => result.promise });
    const pending = h.start(5); await tick();
    h.ctx.chat[0].mes = '编辑过的历史'; await h.receive();
    result.resolve(JSON.stringify(autoBundle())); await pending;
    assert.equal(h.notices[0].kind, 'success');
    assert.equal(h.controller.state().progress, 1);
    assert.ok(!h.requests[0][0].some(m => m.content.includes('编辑过的历史')));
});

test('editing automatic generation parameters during a request takes effect on the next request', async () => {
    const result = deferred(), h = fixture({ run: () => result.promise });
    const pending = h.start(2); await tick();
    await h.receive();
    const next = { interval: 2, prompt: '下一轮要求', diceSides: 100, commandCount: 2, ruleCount: 1, mapping: 'even' };
    h.controller.update(next);
    assert.equal(h.requests.length, 1);
    assert.equal(h.controller.state().progress, 1);
    result.resolve(JSON.stringify(autoBundle())); await pending;
    assert.equal(h.notices.at(-1).kind, 'success');
    const original = activeGroup(effectiveRandomSettings(h.ctx));
    assert.equal(original.rules.length, 3);
    assert.equal(original.rules[0].diceSides, 20);
    assert.equal(original.rules[0].commands[10], '');
    assert.equal(h.controller.state().mapping, 'even');
    h.setRun(async () => JSON.stringify(autoBundle(next)));
    await h.receive();
    assert.equal(h.notices.at(-1).kind, 'success');
    const updated = activeGroup(effectiveRandomSettings(h.ctx));
    assert.equal(updated.rules.length, 1);
    assert.equal(updated.rules[0].diceSides, 100);
    assert.deepEqual(updated.rules[0].ranges.map(row => row.range), ['1-50', '51-100']);
    assert.ok(h.requests[1][0].some(message => message.content.includes(next.prompt)));
});

test('changing the speaking character in the same group does not invalidate an automatic request', async () => {
    const result = deferred(), h = fixture({ run: () => result.promise });
    h.ctx.groupId = 'group';
    const pending = h.start(); await tick(); h.ctx.characterId = 9;
    result.resolve(JSON.stringify(autoBundle())); await pending;
    assert.equal(h.notices[0].kind, 'success');
});

for (const action of ['stop', 'switch']) test(`${action} cancels and ignores a late API result`, async () => {
    const result = deferred(), h = fixture({ run: () => result.promise });
    const pending = h.start(); await tick();
    if (action === 'stop') h.controller.stop(); else await h.switchChat('聊天乙');
    await pending;
    result.resolve(JSON.stringify(autoBundle())); await tick();
    assert.equal(h.store.groups.length, 1);
    assert.equal(h.notices.length, 1); assert.equal(h.notices[0].kind, 'info');
    assert.equal(h.controller.state().enabled, false);
});

test('automatic generation waits for manual generation and does not replace its draft', async () => {
    const result = deferred(), h = fixture({ run: () => result.promise });
    const manual = h.manual.generate('random', {}); await tick();
    await h.start(2); assert.equal(h.controller.pending, true); assert.equal(h.requests.length, 1);
    h.api.run = async () => JSON.stringify(autoBundle({ command: '自动结果' }));
    result.resolve(JSON.stringify(bundle('手动结果')));
    const draft = await manual; await tick();
    assert.equal(h.controller.pending, false);
    assert.equal(h.manual.draft, draft);
    assert.equal(h.manual.valid(), true);
    assert.equal(activeGroup(effectiveRandomSettings(h.ctx)).rules[0].commands[0], '自动结果');
    h.manual.apply(draft.value);
    assert.equal(activeGroup(effectiveRandomSettings(h.ctx)).rules[0].commands[0], '手动结果');
});

test('automatic requests serialize and coalesce multiple elapsed intervals into one pending call', async () => {
    const first = deferred(), second = deferred(); let calls = 0;
    const h = fixture({ run: () => (++calls === 1 ? first.promise : second.promise) });
    const pending = h.start(1); await tick();
    for (let i = 0; i < 4; i++) await h.receive(`楼层 ${i}`);
    assert.equal(calls, 1); assert.equal(h.controller.pending, true);
    await assert.rejects(h.manual.generate('random', {}), /正在生成/);
    first.resolve(JSON.stringify(autoBundle({ command: '首次' }))); await pending; await tick();
    assert.equal(calls, 2);
    second.resolve(JSON.stringify(autoBundle({ command: '合并更新' }))); await tick();
    assert.equal(calls, 2); assert.equal(h.controller.pending, false);
    assert.equal(h.store.groups.length, 2);
});

for (const groupId of [null, 'group']) test(`a ${groupId ? 'group' : 'character'} chat branch owns a copy before its first edit or automatic update`, async () => {
    const h = fixture();
    h.ctx.groupId = groupId;
    h.ctx.chatMetadata.integrity = 'parent-integrity';
    await h.start(1);
    const parent = { chat: h.ctx.chat, metadata: h.ctx.chatMetadata };
    const parentId = h.controller.state().groupId;
    const original = structuredClone(h.store.groups.find(group => group.id === parentId));
    const branchMetadata = { ...structuredClone(parent.metadata), main_chat: h.ctx.chatId, integrity: 'branch-integrity' };
    const branch = { ...h.ctx, chatId: '聊天甲 - Branch #1', chatMetadata: branchMetadata };
    const before = JSON.stringify({ store: h.store, metadata: branchMetadata });
    assert.equal(effectiveRandomSettings(branch), h.store, 'a copied owner cannot select its source group before reconciliation');
    assert.equal(JSON.stringify({ store: h.store, metadata: branchMetadata }), before, 'reading/exporting settings is side-effect free');

    await h.switchChat(branch.chatId, structuredClone(parent.chat), branchMetadata);
    const branchId = h.controller.state().groupId;
    const copied = activeGroup(effectiveRandomSettings(h.ctx));
    assert.notEqual(branchId, parentId);
    assert.equal(h.controller.state().ownerKey, autoOracleOwner(h.ctx));
    assert.equal(h.requests.length, 1, 'entering the branch makes no model request');
    assert.deepEqual(copied.rules.map(({ id, ...rule }) => rule), original.rules.map(({ id, ...rule }) => rule));
    copied.rules[0].commands[0] = '分支中的手工修改';
    assert.deepEqual(h.store.groups.find(group => group.id === parentId), original, 'editing the selected branch group preserves its parent');
    h.setRun(async () => JSON.stringify(autoBundle({ command: '分支剧情的新指令' })));
    await h.send(); await h.receive();
    assert.equal(h.requests.length, 2);
    assert.equal(h.controller.state().groupId, branchId);
    assert.equal(activeGroup(effectiveRandomSettings(h.ctx)).rules[0].commands[0], '分支剧情的新指令');
    assert.deepEqual(h.store.groups.find(group => group.id === parentId), original);

    await h.switchChat('聊天甲', parent.chat, parent.metadata);
    assert.equal(activeGroup(effectiveRandomSettings(h.ctx)).id, parentId);
    assert.equal(h.store.groups.length, 3);
});

test('legacy ownerless groups are copied once, preserving options and leaving the original intact even when a branch migrates first', async () => {
    const h = fixture();
    h.ctx.chatMetadata.integrity = 'legacy-parent';
    await h.start(5, '保留提示词'); await h.receive();
    const parent = { chat: h.ctx.chat, metadata: h.ctx.chatMetadata };
    delete parent.metadata[AUTO_ORACLE_KEY].ownerKey;
    const originalId = h.controller.state().groupId;
    const original = structuredClone(h.store.groups.find(group => group.id === originalId));
    const branchMetadata = { ...structuredClone(parent.metadata), integrity: 'legacy-branch' };
    await h.switchChat('旧聊天的分支', structuredClone(parent.chat), branchMetadata);
    const branchId = h.controller.state().groupId;
    assert.notEqual(branchId, originalId);
    assert.equal(h.controller.state().progress, 1);
    assert.equal(h.controller.state().prompt, '保留提示词');
    assert.equal(h.controller.state().enabled, true);
    assert.equal(h.requests.length, 1);
    const migrated = structuredClone(h.ctx.chatMetadata);
    await h.switchChat('旧聊天的分支', structuredClone(h.ctx.chat), migrated);
    assert.equal(h.controller.state().groupId, branchId, 'reloading does not migrate again');
    assert.equal(h.store.groups.length, 3);

    await h.switchChat('聊天甲', parent.chat, parent.metadata);
    const parentId = h.controller.state().groupId;
    assert.notEqual(parentId, originalId);
    assert.notEqual(parentId, branchId);
    assert.equal(h.store.groups.length, 4);
    assert.deepEqual(h.store.groups.find(group => group.id === originalId), original);
});

test('chat renames and group speaker changes preserve an integrity-owned group', async () => {
    const h = fixture();
    h.ctx.groupId = 'group'; h.ctx.chatMetadata.integrity = 'stable-integrity';
    await h.start();
    const id = h.controller.state().groupId, count = h.store.groups.length;
    h.ctx.characterId = 99;
    await h.switchChat('重命名的聊天', structuredClone(h.ctx.chat), structuredClone(h.ctx.chatMetadata));
    assert.equal(h.controller.state().groupId, id);
    assert.equal(h.store.groups.length, count);
    assert.equal(activeGroup(effectiveRandomSettings(h.ctx)).id, id);
});

test('hosts without integrity use the chat identity to separate branches, and a missing source group is detached safely', async () => {
    const h = fixture(); await h.start();
    const sourceId = h.controller.state().groupId;
    const copiedMetadata = structuredClone(h.ctx.chatMetadata);
    await h.switchChat('另一分支', structuredClone(h.ctx.chat), copiedMetadata);
    assert.notEqual(h.controller.state().groupId, sourceId);
    const orphan = { ...h.ctx, chatId: '缺失组的分支', chatMetadata: {
        [AUTO_ORACLE_KEY]: { ...h.controller.state(), groupId: 'deleted-group', useGroup: true },
    } };
    const before = h.store.groups.length;
    const state = reconcileAutoOracleState(orphan);
    assert.equal(state.groupId, null); assert.equal(state.useGroup, false);
    assert.equal(state.ownerKey, autoOracleOwner(orphan));
    assert.equal(h.store.groups.length, before);
});

for (const hostState of [undefined, { generating: false }]) test(`a pure slash command cannot block enabling auto generation ${hostState ? 'with a live host state' : 'with the after-commands event fallback'}`, async () => {
    const h = fixture({ afterCommands: true, hostState });
    await h.emit('GENERATION_STARTED', 'normal', {}, false);
    // ST returns after executing the slash command: no AFTER_COMMANDS or ENDED.
    await h.start();
    assert.equal(h.requests.length, 1);
    assert.equal(h.controller.pending, false);
    h.controller.stop();
    await h.emit('GENERATION_STARTED', 'normal', {}, false);
    await h.start();
    assert.equal(h.requests.length, 2);
});

test('a pre-model early return after commands does not leave a stale busy flag', async () => {
    const hostState = { generating: false }, h = fixture({ afterCommands: true, hostState });
    await h.emit('GENERATION_STARTED', 'normal', {}, false);
    await h.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
    // A disconnected backend can return without showing the stop button/ENDED.
    await h.start();
    assert.equal(h.requests.length, 1);
    assert.equal(h.controller.pending, false);
});

test('an already queued update resumes when the host becomes idle without emitting ENDED', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const hostState = { generating: true }, h = fixture({ afterCommands: true, hostState });
    await h.emit('GENERATION_STARTED', 'normal', {}, false);
    await h.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
    await h.start();
    assert.equal(h.requests.length, 0); assert.equal(h.controller.pending, true);
    t.mock.timers.tick(250); await tick();
    assert.equal(h.requests.length, 0, 'a running main generation still holds the queue');
    hostState.generating = false;
    t.mock.timers.tick(250); await tick();
    assert.equal(h.requests.length, 1); assert.equal(h.controller.pending, false);
    t.mock.timers.tick(1000); await tick();
    assert.equal(h.requests.length, 1, 'dispatch clears the waiting timer');
});

test('a group member ENDED event cannot release the queue while the host group is still generating', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const hostState = { generating: true }, h = fixture({ hostState }); h.ctx.groupId = 'group';
    await h.emit('GENERATION_STARTED', 'normal', {}, false);
    await h.start();
    await h.emit('GENERATION_ENDED'); await tick();
    assert.equal(h.requests.length, 0); assert.equal(h.controller.pending, true);
    hostState.generating = false;
    t.mock.timers.tick(250); await tick();
    assert.equal(h.requests.length, 1);
});

for (const action of ['stop', 'switch', 'interval']) test(`${action} clears a queued host-state recheck`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const hostState = { generating: true }, h = fixture({ hostState });
    await h.start(); assert.equal(h.controller.pending, true);
    if (action === 'stop') h.controller.stop();
    else if (action === 'switch') await h.switchChat('另一聊天');
    else h.controller.update({ interval: 3, prompt: '' });
    hostState.generating = false;
    t.mock.timers.tick(1000); await tick();
    assert.equal(h.controller.pending, false);
    assert.equal(h.requests.length, 0);
});

test('a delayed oracle response cannot replace candidates when the selected scene changes', async () => {
    const response = deferred();
    const h = fixture({ run: () => response.promise });
    const { NARRATIVE_KEY, foldNarrative } = await import('../narrative.js');
    h.ctx.chatMetadata[NARRATIVE_KEY] = { enabled: true, threadsEnabled: true };
    const initialRevision = foldNarrative(h.ctx.chat).revision;
    h.ctx.chat.push({ is_user: true, mes: '查看桌上的物件', extra: { [SETTINGS_KEY]: { narrative: {
        turnId: 'turn', newThreadId: 'thread', baseRevision: initialRevision, candidates: [],
    } } } });
    h.ctx.chat.push({ ...reply('他发现一枚蓝签。'), swipe_id: 0, extra: { [NARRATIVE_KEY]: {
        uid: 'reply', swipes: { 0: { report: {
            version: 1, turnId: 'turn', baseRevision: initialRevision, uses: [], updates: [],
            newThread: { title: '蓝签来历', cause: '发现一枚蓝签', question: '谁留下的？', evidence: '他发现一枚蓝签。' },
        } }, 1: {} },
    } } });
    const start = h.start(2);
    await tick();
    assert.equal(h.requests.length, 1);
    assert.match(h.requests[0][0].map(message => message.content).join('\n'), /蓝签来历/);
    const groupCount = h.store.groups.length;
    h.ctx.chatMetadata[NARRATIVE_KEY].sceneRevision = 'new-scene';
    response.resolve(JSON.stringify(autoBundle()));
    await start;
    await tick();
    assert.equal(h.requests.length, 1);
    assert.equal(h.store.groups.length, groupCount);
    assert.equal(h.ctx.chatMetadata[NARRATIVE_KEY].sceneGroupId, undefined);
});

test('oracle initializes the MVU scene on first request and drops a response after the MVU location changes', async t => {
    const { NARRATIVE_KEY } = await import('../narrative.js');
    let position = '阅览区';
    globalThis.Mvu = { getMvuData: () => ({ stat_data: { 场景: { 位置: position } } }) };
    t.after(() => { delete globalThis.Mvu; });
    for (const changesDuringRequest of [false, true]) {
        position = '阅览区';
        const response = deferred();
        const h = fixture({ run: () => response.promise });
        h.ctx.chatMetadata[NARRATIVE_KEY] = { enabled: true, scenePath: 'stat_data.场景.位置' };
        const oldGroups = h.store.groups.length;
        const started = h.start(2);
        await tick();
        assert.equal(h.requests.length, 1);
        assert.equal(h.ctx.chatMetadata[NARRATIVE_KEY].sceneValue, '阅览区');
        if (changesDuringRequest) position = '门厅';
        response.resolve(JSON.stringify(autoBundle()));
        await started;
        await tick();
        const scene = h.ctx.chatMetadata[NARRATIVE_KEY];
        assert.equal(scene.sceneValue, position);
        assert.equal(h.store.groups.length, oldGroups + Number(!changesDuringRequest));
        if (changesDuringRequest) assert.equal(scene.sceneGroupId, null);
        else assert.equal(scene.sceneGroupRevision, scene.sceneRevision);
        assert.equal(h.requests.length, 1);
    }
});

test('branch ownership also isolates the narrative automatic scene layer without changing its long layer or preferences', async () => {
    const { NARRATIVE_KEY } = await import('../narrative.js');
    const h = fixture(); h.ctx.chatMetadata.integrity = 'narrative-parent';
    const longGroupId = h.store.groups[0].id;
    h.ctx.chatMetadata[NARRATIVE_KEY] = { enabled: true, longGroupId,
        preferences: '多一点日常', topicPreferences: { daily: 'prefer' }, blockedTopics: { conflict: 3 } };
    h.setRun(async () => {
        const value = autoBundle(); value.formatVersion = 2;
        value.randomGroups[0].rules[0].commandMetadata = [{ effect: 'detail', topic: 'daily', conditions: [{ type: 'label', value: '室内' }] }];
        return JSON.stringify(value);
    });
    await h.start(1);
    const parent = { chat: h.ctx.chat, metadata: h.ctx.chatMetadata };
    const original = structuredClone(h.store.groups.find(group => group.id === h.controller.state().groupId));
    const metadata = { ...structuredClone(parent.metadata), integrity: 'narrative-branch' };
    await h.switchChat('剧情分支', structuredClone(parent.chat), metadata);
    const config = h.ctx.chatMetadata[NARRATIVE_KEY], id = config.sceneGroupId;
    assert.notEqual(id, original.id);
    assert.equal(h.controller.state().groupId, id);
    assert.equal(config.longGroupId, longGroupId);
    assert.equal(config.preferences, '多一点日常');
    assert.deepEqual(config.topicPreferences, { daily: 'prefer' });
    assert.deepEqual(config.blockedTopics, { conflict: 3 });
    assert.equal(config.sceneGroupRevision, config.sceneRevision);
    assert.equal(h.store.groups.length, 3, 'the auto group and scene binding share one copy');
    const branchGroup = h.store.groups.find(group => group.id === id);
    branchGroup.rules[0].commandMetadata[0].conditions[0].value = '室外';
    assert.deepEqual(h.store.groups.find(group => group.id === original.id), original);
    h.setRun(async () => JSON.stringify(autoBundle({ command: '只适合分支的新指令' })));
    await h.send(); await h.receive();
    assert.equal(h.ctx.chatMetadata[NARRATIVE_KEY].sceneGroupId, id);
    assert.equal(h.store.groups.find(group => group.id === id).rules[0].commands[0], '只适合分支的新指令');
    assert.deepEqual(h.store.groups.find(group => group.id === original.id), original);
    assert.equal(parent.metadata[NARRATIVE_KEY].sceneGroupId, original.id);
});

for (const legacy of [false, true]) test(`${legacy ? 'an ownerless legacy' : 'a copied'} automatic state isolates a scene group rebound after its previous automatic update`, async () => {
    const { NARRATIVE_KEY } = await import('../narrative.js');
    const { createGroup } = await import('../core.js');
    const h = fixture(); h.ctx.chatMetadata.integrity = 'parent';
    await h.start();
    const automaticId = h.controller.state().groupId;
    const scene = createGroup('用户重新绑定的场景'); h.store.groups.push(scene);
    h.ctx.chatMetadata[NARRATIVE_KEY] = { enabled: true, longGroupId: h.store.groups[0].id,
        sceneGroupId: scene.id, sceneRevision: 'scene', sceneGroupRevision: 'scene', preferences: '保留新偏好' };
    if (legacy) delete h.ctx.chatMetadata[AUTO_ORACLE_KEY].ownerKey;
    const original = structuredClone(scene);
    const branch = { ...structuredClone(h.ctx.chatMetadata), integrity: 'branch' };
    await h.switchChat('已重新绑定场景的分支', structuredClone(h.ctx.chat), branch);
    const branchSceneId = h.ctx.chatMetadata[NARRATIVE_KEY].sceneGroupId;
    assert.notEqual(h.controller.state().groupId, automaticId);
    assert.notEqual(branchSceneId, scene.id);
    assert.equal(h.ctx.chatMetadata[NARRATIVE_KEY].preferences, '保留新偏好');
    await h.start();
    assert.equal(h.controller.state().groupId, branchSceneId);
    assert.deepEqual(h.store.groups.find(group => group.id === scene.id), original);
});

test('owner migration does not create duplicate groups when the automatic and scene references are missing', async () => {
    const { NARRATIVE_KEY } = await import('../narrative.js');
    const h = fixture(); await h.start();
    const metadata = structuredClone(h.ctx.chatMetadata);
    delete metadata[AUTO_ORACLE_KEY].ownerKey;
    metadata[AUTO_ORACLE_KEY].groupId = 'missing-auto';
    metadata[NARRATIVE_KEY] = { enabled: true, longGroupId: h.store.groups[0].id, sceneGroupId: 'missing-scene', preferences: '保留' };
    const before = JSON.stringify(h.store.groups);
    await h.switchChat('缺失组的旧分支', structuredClone(h.ctx.chat), metadata);
    assert.equal(JSON.stringify(h.store.groups), before);
    assert.equal(h.controller.state().groupId, null);
    assert.equal(h.ctx.chatMetadata[NARRATIVE_KEY].sceneGroupId, 'missing-scene');
    assert.equal(h.ctx.chatMetadata[NARRATIVE_KEY].preferences, '保留');
    const groupCount = h.store.groups.length;
    await h.start();
    assert.equal(h.store.groups.length, groupCount + 1);
    assert.equal(h.ctx.chatMetadata[NARRATIVE_KEY].sceneGroupId, h.controller.state().groupId);
});

test('an automatic narrative result preserves preferences and automatic parameters edited while it was running', async () => {
    const { NARRATIVE_KEY } = await import('../narrative.js');
    const response = deferred(), h = fixture({ run: () => response.promise });
    h.ctx.chatMetadata[NARRATIVE_KEY] = { enabled: true, preferences: '旧偏好' };
    const pending = h.start(5); await tick();
    h.ctx.chatMetadata[NARRATIVE_KEY].preferences = '新的用户偏好';
    h.ctx.chatMetadata[NARRATIVE_KEY].topicPreferences = { conflict: 'reduce' };
    h.ctx.chatMetadata[NARRATIVE_KEY].eventBudget = 0;
    h.controller.update({ interval: 5, prompt: '下一次自动要求', diceSides: 100, commandCount: 2, ruleCount: 1, mapping: 'even' });
    response.resolve(JSON.stringify(autoBundle())); await pending;
    const narrative = h.ctx.chatMetadata[NARRATIVE_KEY], automatic = h.controller.state();
    assert.ok(narrative.sceneGroupId);
    assert.equal(narrative.preferences, '新的用户偏好');
    assert.deepEqual(narrative.topicPreferences, { conflict: 'reduce' });
    assert.equal(narrative.eventBudget, 0);
    assert.equal(automatic.prompt, '下一次自动要求');
    assert.equal(automatic.diceSides, 100); assert.equal(automatic.mapping, 'even');
    assert.equal(automatic.commandCount, 2); assert.equal(automatic.ruleCount, 1);
    assert.equal(h.store.groups.find(group => group.id === narrative.sceneGroupId).rules[0].diceSides, 20, 'the in-flight response still uses its original parameter snapshot');
});

for (const key of ['sceneGroupId', 'longGroupId']) test(`rebinding ${key} while a narrative request is pending retains the user's new choice`, async () => {
    const { NARRATIVE_KEY } = await import('../narrative.js');
    const { createGroup } = await import('../core.js');
    const response = deferred(), h = fixture({ run: () => response.promise });
    const scene = createGroup('原场景'), selected = createGroup('用户新选组'); h.store.groups.push(scene, selected);
    h.ctx.chatMetadata[NARRATIVE_KEY] = { enabled: true, longGroupId: h.store.groups[0].id, sceneGroupId: scene.id };
    const before = JSON.stringify(h.store.groups);
    const pending = h.start(); await tick();
    h.ctx.chatMetadata[NARRATIVE_KEY][key] = selected.id;
    response.resolve(JSON.stringify(autoBundle())); await pending;
    assert.equal(h.ctx.chatMetadata[NARRATIVE_KEY][key], selected.id);
    assert.equal(JSON.stringify(h.store.groups), before);
});

test('append mode adds chat-local dice after manual dice and replaces only that tail on every cycle', async () => {
    const h = fixture(), before = structuredClone(h.store.groups[0]);
    h.setRun(async () => JSON.stringify(autoBundle({ diceSides: 6, commandCount: 3, ruleCount: 2 })));
    await h.start(1, '', { appendMode: true, diceSides: 6, commandCount: 3, ruleCount: 2 });
    assert.equal(h.requests.length, 1);
    assert.equal(h.store.groups.length, 1, 'append must not create a group');
    assert.deepEqual(h.store.groups[0], before, 'original library stays byte-for-byte unchanged');
    const id = before.id;
    let visible = activeGroup(effectiveRandomSettings(h.ctx));
    assert.equal(visible.id, id);
    assert.equal(visible.rules.length, before.rules.length + 2);
    assert.deepEqual(visible.rules.slice(0, before.rules.length), before.rules);
    const firstIds = visible.rules.slice(-2).map(rule => rule.id);
    const record = createRollRecord({ ...effectiveRandomSettings(h.ctx), enabled: true }, () => 0);
    assert.equal(record.rolls.length, before.rules.length + 2);
    h.setRun(async () => JSON.stringify(autoBundle({ command: '第二批生成的指令', diceSides: 6, commandCount: 3, ruleCount: 2 })));
    await h.send(); await h.receive();
    visible = activeGroup(effectiveRandomSettings(h.ctx));
    assert.equal(h.store.groups.length, 1);
    assert.equal(visible.rules.length, before.rules.length + 2, 'repeated updates must not accumulate dice');
    assert.ok(visible.rules.slice(-2).every(rule => !firstIds.includes(rule.id)));
    assert.equal(visible.rules.at(-1).commands[0], '第二批生成的指令');
    assert.deepEqual(h.store.groups[0], before);
    assert.equal(h.controller.state().appendRules.length, 2);
    assert.equal(h.controller.state().useGroup, false);
    assert.equal(h.controller.state().appendGroupId, id);
    h.controller.stop();
    assert.equal(activeGroup(effectiveRandomSettings(h.ctx)).rules.length, before.rules.length + 2,
        'turning off scheduling retains the last generated tail');
});

test('append mode preserves selected manual group and supports moving the tail without extra calls', async () => {
    const { createGroup } = await import('../core.js');
    const h = fixture();
    const alternative = createGroup('第二组'); h.store.groups.push(alternative);
    h.setRun(async () => JSON.stringify(autoBundle({ ruleCount: 1 })));
    await h.start(5, '', { appendMode: true, ruleCount: 1 });
    const old = h.store.groups[0];
    assert.equal(activeGroup(effectiveRandomSettings(h.ctx)).rules.length, old.rules.length + 1);
    const calls = h.requests.length;
    selectRandomGroup(h.ctx, alternative.id);
    assert.equal(h.requests.length, calls);
    assert.equal(h.controller.state().appendGroupId, alternative.id);
    assert.equal(activeGroup(effectiveRandomSettings(h.ctx)).id, alternative.id);
    assert.equal(activeGroup(effectiveRandomSettings(h.ctx)).rules.length, alternative.rules.length + 1);
    assert.equal(effectiveRandomSettings(h.ctx).groups.find(group => group.id === old.id).rules.length, old.rules.length);
    assert.equal(alternative.rules.length, 1, 'shared target should never gain a permanent auto rule');
});

test('append mode isolates chat branches and other chats without creating copied groups', async () => {
    const h = fixture();
    h.ctx.chatMetadata.integrity = 'append-parent';
    h.setRun(async () => JSON.stringify(autoBundle({ ruleCount: 2 })));
    await h.start(2, '', { appendMode: true, ruleCount: 2 });
    const parentMetadata = structuredClone(h.ctx.chatMetadata), parentChat = structuredClone(h.ctx.chat);
    const originalGroups = structuredClone(h.store.groups);
    const groupCount = h.store.groups.length;
    const branchMetadata = { ...structuredClone(parentMetadata), integrity: 'append-branch' };
    await h.switchChat('分支', structuredClone(parentChat), branchMetadata);
    assert.equal(h.store.groups.length, groupCount, 'branch must not clone any group for a chat-local overlay');
    assert.equal(activeGroup(effectiveRandomSettings(h.ctx)).rules.length, h.store.groups[0].rules.length + 2);
    h.setRun(async () => JSON.stringify(autoBundle({ command: '分支中新的指令', ruleCount: 2 })));
    await h.controller.regenerate();
    assert.equal(h.store.groups.length, groupCount);
    assert.equal(activeGroup(effectiveRandomSettings(h.ctx)).rules.at(-1).commands[0], '分支中新的指令');
    assert.deepEqual(h.store.groups, originalGroups);
    await h.switchChat('聊天甲', parentChat, parentMetadata);
    assert.equal(h.store.groups.length, groupCount);
    assert.equal(activeGroup(effectiveRandomSettings(h.ctx)).rules.at(-1).commands[0], '新的剧情变化',
        'switching back restores parent-specific generated content');
    await h.switchChat('无自动设置的新聊天', [reply('开场')], {});
    assert.equal(activeGroup(effectiveRandomSettings(h.ctx)).rules.length, h.store.groups[0].rules.length);
});

test('narrative append mode overlays an existing configured layer without allocating a scene group', async () => {
    const { NARRATIVE_KEY } = await import('../narrative.js');
    const h = fixture();
    const manualId = h.store.groups[0].id;
    h.ctx.chatMetadata[NARRATIVE_KEY] = { enabled: true, longGroupId: manualId };
    h.setRun(async () => JSON.stringify({ ...autoBundle({ command: '叠加剧情' }), formatVersion: 2 }));
    await h.start(3, '', { appendMode: true, ruleCount: 3 });
    assert.equal(h.requests.length, 1);
    assert.equal(h.store.groups.length, 1);
    assert.equal(h.controller.state().appendGroupId, manualId);
    assert.equal(h.ctx.chatMetadata[NARRATIVE_KEY].sceneGroupId, undefined);
    assert.equal(effectiveRandomSettings(h.ctx).groups.find(group => group.id === manualId).rules.length, 4);
});

test('narrative append mode lacking a bound layer fails before spending a model request', async () => {
    const { NARRATIVE_KEY } = await import('../narrative.js');
    const h = fixture();
    h.ctx.chatMetadata[NARRATIVE_KEY] = { enabled: true };
    await h.start(1, '', { appendMode: true });
    assert.equal(h.requests.length, 0);
    assert.equal(h.store.groups.length, 1);
    assert.match(h.controller.state().lastResult.message, /先绑定/);
});

test('switching between append mode and dedicated mode does not create redundant groups', async () => {
    const h = fixture();
    await h.start(4);
    const dedicated = h.controller.state().groupId;
    assert.equal(h.store.groups.length, 2);
    h.controller.update({ interval: 4, prompt: '', appendMode: true });
    await h.controller.regenerate();
    assert.equal(h.store.groups.length, 2);
    assert.equal(h.controller.state().appendMode, true);
    assert.equal(h.controller.state().useGroup, false);
    assert.equal(activeGroup(effectiveRandomSettings(h.ctx)).id, h.store.groups[0].id);
    h.controller.update({ interval: 4, prompt: '', appendMode: false });
    await h.controller.regenerate();
    assert.equal(h.store.groups.length, 2);
    assert.equal(h.controller.state().groupId, dedicated, 'existing dedicated group is reused');
});

test('copying or exporting the visible appended group can freeze it as ordinary rules', async () => {
    const { createGroup } = await import('../core.js');
    const h = fixture();
    await h.start(5, '', { appendMode: true });
    const current = activeGroup(effectiveRandomSettings(h.ctx));
    const snapshot = createGroup('保存组合', current);
    assert.equal(snapshot.rules.length, h.store.groups[0].rules.length + 3);
    assert.ok(snapshot.rules.every(rule => !current.rules.some(original => original.id === rule.id)));
    const serialized = serializeConfigFile([{ ...current, name: '组合导出' }]);
    const restored = parseConfigFile(serialized);
    assert.equal(restored.randomGroups[0].rules.length, snapshot.rules.length);
    assert.equal(h.store.groups.length, 1, 'copying a snapshot in memory does not allocate a group automatically');
});

test('changing placement while a request is in flight uses the current checkbox setting', async () => {
    const response = deferred(), h = fixture({ run: () => response.promise });
    const request = h.start(3);
    await tick();
    assert.equal(h.requests.length, 1);
    h.controller.update({ interval: 3, prompt: '', appendMode: true });
    response.resolve(JSON.stringify(autoBundle()));
    await request;
    assert.equal(h.requests.length, 1);
    assert.equal(h.store.groups.length, 1, 'late default-mode response must not create a group after append is selected');
    assert.equal(activeGroup(effectiveRandomSettings(h.ctx)).rules.length, h.store.groups[0].rules.length + 3);
});

test('narrative append selects an active scene group ahead of the long group', async () => {
    const { NARRATIVE_KEY } = await import('../narrative.js');
    const { createGroup } = await import('../core.js');
    const h = fixture();
    const long = h.store.groups[0], scene = createGroup('场景');
    h.store.groups.push(scene);
    h.ctx.chatMetadata[NARRATIVE_KEY] = { enabled: true, longGroupId: long.id,
        sceneGroupId: scene.id, sceneRevision: 'active', sceneGroupRevision: 'active' };
    h.setRun(async () => JSON.stringify({ ...autoBundle(), formatVersion: 2 }));
    await h.start(5, '', { appendMode: true });
    assert.equal(h.store.groups.length, 2);
    assert.equal(h.controller.state().appendGroupId, scene.id);
    const effective = effectiveRandomSettings(h.ctx);
    assert.equal(effective.groups.find(group => group.id === long.id).rules.length, long.rules.length);
    assert.equal(effective.groups.find(group => group.id === scene.id).rules.length, scene.rules.length + 3);
});

for (const legacyMode of [null, true, false]) for (const trigger of ['manual regeneration', 'interval-1 reply']) test(`a narrative append branch isolates its scene on ${trigger} (saved placement: ${legacyMode ?? 'new'})`, async () => {
    const { NARRATIVE_KEY } = await import('../narrative.js');
    const { createGroup } = await import('../core.js');
    const h = fixture(), interval = trigger === 'interval-1 reply' ? 1 : 5;
    h.ctx.chatMetadata.integrity = 'append-scene-parent';
    const long = h.store.groups[0], scene = createGroup('原聊天场景');
    long.rules[0].commands[0] = '保留平时指令';
    scene.rules[0].commands[0] = '保留原聊天场景指令';
    h.store.groups.push(scene);
    h.ctx.chatMetadata[NARRATIVE_KEY] = { enabled: true, longGroupId: long.id,
        sceneGroupId: scene.id, sceneRevision: 'active', sceneGroupRevision: 'active', preferences: '保留剧情偏好' };
    const originalGroups = structuredClone(h.store.groups);
    await h.start(interval, '保留自动提示词', { appendMode: true });
    const parent = { chat: h.ctx.chat, metadata: h.ctx.chatMetadata };
    const parentSnapshot = structuredClone(parent.metadata);
    await h.switchChat('剧情追加分支', structuredClone(parent.chat), {
        ...structuredClone(parent.metadata), integrity: 'append-scene-branch',
    });
    if (legacyMode !== null) {
        h.controller.update({ interval, prompt: '保留自动提示词', appendMode: legacyMode });
        const metadata = structuredClone(h.ctx.chatMetadata);
        delete metadata[AUTO_ORACLE_KEY].inheritedSceneGroupId;
        await h.switchChat('剧情追加分支', structuredClone(h.ctx.chat), metadata);
    }
    assert.deepEqual(h.store.groups, originalGroups, 'entering an append branch must not copy any group');
    assert.equal(h.controller.state().appendGroupId, scene.id);
    assert.equal(h.requests.length, 1, 'entering the branch must not generate');
    if (trigger === 'manual regeneration') await h.receive('尚未达到保存的间隔');
    const progress = h.controller.state().progress;
    h.controller.update({ interval, prompt: '保留自动提示词', appendMode: false });
    assert.equal(h.requests.length, 1, 'changing placement must not generate');
    h.setRun(async () => JSON.stringify(autoBundle({ command: '仅供分支的新场景指令' })));
    if (trigger === 'manual regeneration') await h.controller.regenerate();
    else { await h.send(); await h.receive(); }
    assert.equal(h.requests.length, 2);
    assert.equal(h.controller.state().lastResult.kind, 'success');
    assert.deepEqual(h.store.groups.find(group => group.id === long.id), originalGroups[0], 'the usual group must remain unchanged');
    assert.deepEqual(h.store.groups.find(group => group.id === scene.id), originalGroups[1], 'the parent scene group must remain unchanged');
    const branchId = h.ctx.chatMetadata[NARRATIVE_KEY].sceneGroupId;
    assert.notEqual(branchId, scene.id);
    assert.equal(h.controller.state().groupId, branchId);
    assert.equal(h.store.groups.length, originalGroups.length + 1, 'allocate only one independent scene group');
    assert.equal(h.store.groups.find(group => group.id === branchId).rules[0].commands[0], '仅供分支的新场景指令');
    assert.equal(h.ctx.chatMetadata[NARRATIVE_KEY].longGroupId, long.id);
    assert.equal(h.ctx.chatMetadata[NARRATIVE_KEY].sceneGroupRevision, 'active');
    assert.equal(h.ctx.chatMetadata[NARRATIVE_KEY].preferences, '保留剧情偏好');
    assert.equal(h.controller.state().interval, interval);
    assert.equal(h.controller.state().progress, trigger === 'manual regeneration' ? progress : 0);
    assert.equal(h.controller.state().prompt, '保留自动提示词');
    assert.deepEqual(parent.metadata, parentSnapshot);

    h.controller.update({ interval, prompt: '保留自动提示词', appendMode: true });
    await h.controller.regenerate();
    h.controller.update({ interval, prompt: '保留自动提示词', appendMode: false });
    await h.controller.regenerate();
    await h.emit('CHAT_CHANGED');
    assert.equal(h.controller.state().groupId, branchId, 'mode changes and reconciliation must reuse the independent group');
    assert.equal(h.store.groups.length, originalGroups.length + 1);
    assert.deepEqual(h.store.groups.slice(0, originalGroups.length), originalGroups);
    await h.switchChat('聊天甲', parent.chat, parent.metadata);
    assert.equal(h.ctx.chatMetadata[NARRATIVE_KEY].sceneGroupId, scene.id);
    assert.equal(h.controller.state().appendMode, true);
    assert.equal(effectiveRandomSettings(h.ctx).groups.find(group => group.id === scene.id).rules.at(-1).commands[0], '新的剧情变化');
});

for (const legacyMode of [null, true, false]) for (const deleteScene of [false, true]) test(`a narrative branch reuses its dedicated group after restoring narrative (saved placement: ${legacyMode ?? 'new'}, deleted scene: ${deleteScene})`, async () => {
    const { NARRATIVE_KEY } = await import('../narrative.js');
    const { createGroup } = await import('../core.js');
    const h = fixture(), scene = createGroup('继承场景');
    h.ctx.chatMetadata.integrity = 'dedicated-parent';
    h.store.groups.push(scene);
    h.ctx.chatMetadata[NARRATIVE_KEY] = { enabled: true, longGroupId: h.store.groups[0].id,
        sceneGroupId: scene.id, sceneRevision: 'active', sceneGroupRevision: 'active' };
    const originalGroups = structuredClone(h.store.groups);
    await h.start(1, '', { appendMode: true });
    await h.switchChat('已有独立组的分支', structuredClone(h.ctx.chat), {
        ...structuredClone(h.ctx.chatMetadata), integrity: 'dedicated-branch',
    });
    h.ctx.chatMetadata[NARRATIVE_KEY].enabled = false;
    h.controller.update({ interval: 1, prompt: '', appendMode: false });
    await h.controller.regenerate();
    const dedicated = h.controller.state().groupId;
    assert.notEqual(dedicated, scene.id);
    if (legacyMode !== null) {
        h.controller.update({ interval: 1, prompt: '', appendMode: legacyMode });
        const metadata = structuredClone(h.ctx.chatMetadata);
        delete metadata[AUTO_ORACLE_KEY].inheritedSceneGroupId;
        await h.switchChat('已有独立组的分支', structuredClone(h.ctx.chat), metadata);
    }
    if (deleteScene) h.store.groups.splice(h.store.groups.findIndex(group => group.id === scene.id), 1);
    const groupCount = h.store.groups.length;
    h.ctx.chatMetadata[NARRATIVE_KEY].enabled = true;
    h.controller.update({ interval: 1, prompt: '', appendMode: false });
    h.setRun(async () => JSON.stringify(autoBundle({ command: '复用分支独立组' })));
    await h.controller.regenerate();
    assert.equal(h.controller.state().lastResult.kind, 'success');
    assert.deepEqual(h.store.groups[0], originalGroups[0]);
    if (!deleteScene) assert.deepEqual(h.store.groups.find(group => group.id === scene.id), originalGroups[1]);
    assert.equal(h.store.groups.length, groupCount, 'an existing independent group must be reused even if the inherited scene was deleted');
    assert.equal(h.controller.state().groupId, dedicated);
    assert.equal(h.ctx.chatMetadata[NARRATIVE_KEY].sceneGroupId, dedicated);
    assert.equal(h.store.groups.find(group => group.id === dedicated).rules[0].commands[0], '复用分支独立组');
});

for (const appendMode of [false, true]) test(`a narrative branch applies an in-flight result using its latest append setting (${appendMode})`, async () => {
    const { NARRATIVE_KEY } = await import('../narrative.js');
    const { createGroup } = await import('../core.js');
    const h = fixture(), scene = createGroup('继承场景');
    h.ctx.chatMetadata.integrity = 'pending-parent';
    h.store.groups.push(scene);
    h.ctx.chatMetadata[NARRATIVE_KEY] = { enabled: true, longGroupId: h.store.groups[0].id,
        sceneGroupId: scene.id, sceneRevision: 'active', sceneGroupRevision: 'active' };
    await h.start(1, '', { appendMode: true });
    await h.switchChat('请求中的分支', structuredClone(h.ctx.chat), {
        ...structuredClone(h.ctx.chatMetadata), integrity: 'pending-branch',
    });
    const before = structuredClone(h.store.groups), response = deferred();
    h.setRun(() => response.promise);
    const pending = h.controller.regenerate(); await tick();
    h.controller.update({ interval: 1, prompt: '', appendMode: false });
    if (appendMode) h.controller.update({ interval: 1, prompt: '', appendMode: true });
    assert.deepEqual(h.store.groups, before, 'mode changes must not allocate or mutate a group');
    response.resolve(JSON.stringify(autoBundle({ command: '请求期间切换模式后的结果' })));
    await pending;
    assert.equal(h.requests.length, 2);
    assert.equal(h.controller.state().lastResult.kind, 'success');
    assert.deepEqual(h.store.groups.slice(0, before.length), before);
    assert.equal(h.store.groups.length, before.length + Number(!appendMode));
    const id = h.ctx.chatMetadata[NARRATIVE_KEY].sceneGroupId;
    if (appendMode) assert.equal(id, scene.id);
    else assert.notEqual(id, scene.id);
    assert.equal(effectiveRandomSettings(h.ctx).groups.find(group => group.id === id).rules.at(-1).commands[0], '请求期间切换模式后的结果');
});

test('a frozen copy does not steal the future append target when next interval generates', async () => {
    const { createGroup } = await import('../core.js');
    const h = fixture();
    await h.start(5, '', { appendMode: true });
    const originalId = h.controller.state().appendGroupId;
    const frozen = createGroup('固化版本', activeGroup(effectiveRandomSettings(h.ctx)));
    h.store.groups.push(frozen);
    selectRandomGroup(h.ctx, frozen.id, { keepAppendTarget: true });
    assert.equal(h.controller.state().appendGroupId, originalId);
    const frozenCount = frozen.rules.length;
    h.setRun(async () => JSON.stringify(autoBundle({ command: '第三批自动结果' })));
    await h.controller.regenerate();
    assert.equal(h.store.groups.length, 2);
    assert.equal(h.controller.state().appendGroupId, originalId);
    assert.equal(activeGroup(effectiveRandomSettings(h.ctx)).rules.length, frozenCount);
    assert.equal(effectiveRandomSettings(h.ctx).groups.find(group => group.id === originalId).rules.at(-1).commands[0], '第三批自动结果');
    assert.equal(frozen.rules.at(-1).commands[0], '新的剧情变化', 'the snapshot must remain permanent and unchanged');
});
