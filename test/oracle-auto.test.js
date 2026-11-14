import assert from 'node:assert/strict';
import test from 'node:test';
import { SETTINGS_KEY, activeGroup, createRollRecord, normalizeSettings } from '../core.js';
import { SKILL_GROUPS_KEY, normalizeSkillGroups } from '../skill-groups.js';
import { ORACLE_SETTINGS_KEY, normalizeOracleSettings } from '../oracle-config.js';
import { createOracleRequestGate, createOracleService } from '../oracle-service.js';
import { AUTO_ORACLE_KEY, effectiveRandomSettings, normalizeAutoOracle, selectRandomGroup } from '../oracle-auto-state.js';
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

function fixture({ saved, fallbackEvent = false, run = async messages => JSON.stringify(
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
            ...(fallbackEvent ? {} : { CHARACTER_MESSAGE_RENDERED: 'rendered' }) },
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
    const controller = installAutoOracle(getContext, automatic, { notify: (kind, message) => notices.push({ kind, message }) });
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
    assert.equal(normalizeAutoOracle().interval, 5);
    await h.receive(); await h.emit('CHAT_CHANGED');
    assert.equal(h.requests.length, 0);
    assert.equal(h.ctx.chatMetadata[AUTO_ORACLE_KEY], undefined);
    const restored = fixture({ saved: { enabled: true, interval: 3, progress: 2 } });
    await restored.emit('CHAT_CHANGED'); await tick();
    assert.equal(restored.requests.length, 0);
    assert.equal(restored.controller.state().progress, 2);
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
