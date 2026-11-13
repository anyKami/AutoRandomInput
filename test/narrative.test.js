import assert from 'node:assert/strict';
import test from 'node:test';
import { SETTINGS_KEY } from '../core.js';
import { parseConfigFile, serializeConfigFile } from '../config-transfer.js';
import {
    NARRATIVE_KEY, checkConditions, foldNarrative, normalizeNarrativeConfig, prepareNarrativeTurn,
    validateNarrativeReport,
} from '../narrative.js';

const rule = (id, commands, metadata, diceSides = 1) => ({
    id, name: id, enabled: true, diceSides, commands, commandMetadata: [metadata],
});
const state = () => ({ ...foldNarrative([]), ready: true, stat: {} });
const group = (id, rules) => ({ id, name: id, rules });
const settings = (...groups) => ({ enabled: true, stealthMode: false, groups });
const cfg = (extra = {}) => normalizeNarrativeConfig({
    enabled: true, threadsEnabled: true, longGroupId: 'long', sceneGroupId: 'scene',
    sceneRevision: 'market', sceneGroupRevision: 'market', ...extra,
});
const chosen = result => result.rolls.filter(roll => result.narrative.candidates.includes(roll.candidateId));

test('long and scene groups share one event and detail slot, with only explicitly marked d1 persistent', () => {
    const lists = settings(
        group('long', [
            rule('rumor', ['码头传来脚步声。'], { effect: 'event', topic: 'clue' }),
            rule('coat', ['衣角有雨水。'], { effect: 'detail' }),
            rule('weather', ['今晚一直下雨。'], { persistent: true }),
        ]),
        group('scene', [
            rule('arrival', ['巡逻队到场。'], { effect: 'event' }),
            rule('lamp', ['灯影昏暗。'], { effect: 'detail', persistent: true }, 2),
        ]),
    );
    const result = prepareNarrativeTurn(lists, cfg(), state(), () => 0);
    assert.equal(result.rolls.length, 5);
    assert.equal(result.rolls.find(roll => roll.ruleId === 'weather').reason, 'persistent');
    assert.notEqual(result.rolls.find(roll => roll.ruleId === 'lamp').reason, 'persistent');
    assert.equal(chosen(result).filter(roll => roll.reason === 'selected' && roll.metadata.effect === 'event').length, 1);
    assert.equal(chosen(result).filter(roll => roll.reason === 'selected' && roll.metadata.effect === 'detail').length, 1);
    assert.equal(chosen(result).length, 3);
    assert.equal(prepareNarrativeTurn(lists, cfg({ sceneRevision: 'alley' }), state(), () => 0).rolls.length, 3);
});

test('blank, blocked, cooldown and failed conditions preserve original rolls without replacement', () => {
    const lists = settings(group('long', [
        rule('blank', ['', '不应补抽'], {}, 2),
        rule('blocked', ['屏蔽的线索', '不应补抽'], { topic: 'clue' }, 2),
        rule('cooldown', ['冲突', '不应补抽'], { topic: 'conflict' }, 2),
        rule('condition', ['城门打开', '不应补抽'], { conditions: [{ type: 'label', value: '城门' }] }, 2),
    ]));
    let calls = 0;
    const result = prepareNarrativeTurn(lists, cfg({ blockedTopics: { clue: 1 } }), {
        ...state(), cooldowns: { conflict: 1 },
    }, () => {
        calls++;
        return 0;
    });
    assert.equal(calls, 4);
    assert.deepEqual(result.rolls.map(({ result, reason }) => [result, reason]), [
        [1, 'blank'], [1, 'blocked_topic'], [1, 'cooldown'], [1, 'conditions'],
    ]);
    assert.deepEqual(chosen(result), []);
});

test('conditions read only typed MVU values, scene labels and matching thread status', () => {
    const context = {
        stat: { 场景: { 回合: [2, '说明'] } },
        ready: true, labels: ['码头'], threads: [{ id: 'ferry', status: 'active' }],
    };
    const comparison = { type: 'stat', path: 'stat_data.场景.回合', op: 'gte', value: 2 };
    assert.equal(checkConditions([
        comparison, { type: 'label', value: '码头' }, { type: 'thread', threadId: 'ferry', status: 'active' },
    ], context), true);
    assert.equal(checkConditions([comparison], { ...context, ready: false }), false);
    assert.equal(checkConditions([{ ...comparison, value: '2' }], context), false);
    assert.equal(checkConditions([{ ...comparison, op: 'ne', path: 'stat_data.场景.缺失' }], context), false);
    assert.equal(checkConditions([{ ...comparison, path: 'stat_data.场景.constructor' }], context), false);
    assert.equal(checkConditions([{ type: 'thread', threadId: 'ferry', status: 'paused' }], context), false);
});

const turnAt = (chat, id) => ({
    turnId: id, newThreadId: 'thread-' + id, baseRevision: foldNarrative(chat).revision, candidates: [],
});
const user = narrative => ({ is_user: true, extra: { [SETTINGS_KEY]: { narrative, rolls: [] } } });
const report = (turn, extra = {}) => ({
    version: 1, turnId: turn.turnId, baseRevision: turn.baseRevision, uses: [], updates: [], ...extra,
});
const newThread = title => ({ title, cause: '发现异常', question: '谁留下的？', evidence: '他捡起蓝签。' });
const reply = (uid, swipes, swipe_id = 0, mes = '他捡起蓝签。') => ({
    mes, swipe_id, extra: { [NARRATIVE_KEY]: { uid, swipes } },
});

test('group speakers share the new-thread cap, swipes and reload rebuild the visible branch', () => {
    const chat = [];
    const first = turnAt(chat, 'first');
    chat.push(user(first));
    const a = reply('speaker-a', { 0: { report: report(first, { newThread: newThread('蓝签') }) }, 1: {} });
    const b = reply('speaker-b', { 0: { report: report(first, { newThread: newThread('密函') }) } });
    chat.push(a, b);
    const original = foldNarrative(chat);
    assert.deepEqual(original.threads.map(thread => thread.title), ['蓝签']);
    a.swipe_id = 1;
    assert.deepEqual(foldNarrative(chat).threads.map(thread => thread.title), ['密函']);
    a.swipe_id = 0;
    assert.deepEqual(foldNarrative(JSON.parse(JSON.stringify(chat))), original);
    assert.deepEqual(foldNarrative([chat[0], reply('replacement', {}, 0)]).threads, []);
});

test('three active threads is a cap, and stale later turns cannot recreate a removed branch', () => {
    const chat = [];
    for (const name of ['a', 'b', 'c', 'd']) {
        const turn = turnAt(chat, name);
        chat.push(user(turn), reply('reply-' + name, { 0: { report: report(turn, { newThread: newThread(name) }) }, 1: {} }));
    }
    assert.deepEqual(foldNarrative(chat).threads.map(thread => thread.title), ['a', 'b', 'c']);
    chat[1].swipe_id = 1;
    assert.deepEqual(foldNarrative(chat).threads, []);
});

test('wrong revisions reject reports and evidence must be in narrative text outside the MVU packet', () => {
    const turn = turnAt([], 'first');
    const claim = report(turn, { newThread: newThread('蓝签') });
    assert.equal(validateNarrativeReport({ ...claim, baseRevision: 'stale' }, turn, '他捡起蓝签。').valid, false);
    assert.equal(validateNarrativeReport(claim, turn, '他直接离开了。').newThread, null);
    const raw = '他直接离开了。\n<UpdateVariable>\n<JSONPatch>' +
        JSON.stringify([{ op: 'replace', path: '/随机指令工作台/剧情回报', value: claim }]) +
        '</JSONPatch>\n</UpdateVariable>';
    const chat = [user(turn), reply('unsupported-claim', { 0: { report: claim } }, 0, raw)];
    assert.deepEqual(foldNarrative(chat).threads, []);
});

test('portable v2 preserves slot and d100 metadata without carrying either form of thread reference', () => {
    const id = 'isolated-old-thread';
    const long = group('long', [
        rule('weather', ['小雨'], { effect: 'detail', topic: 'clue', threadId: id }),
        { ...rule('range', [], null, 100), ranges: [{
            range: '1-20', command: '送来电报',
            metadata: { conditions: [{ type: 'thread', threadId: id, status: 'active' }] },
        }] },
    ]);
    const portable = serializeConfigFile([long]);
    assert.ok(!portable.includes(id));
    const { randomGroups: [saved], formatVersion } = parseConfigFile(portable);
    assert.equal(formatVersion, 2);
    assert.equal(saved.rules[0].commandMetadata[0].effect, 'detail');
    assert.equal(saved.rules[0].commandMetadata[0].needsBinding, true);
    assert.equal(saved.rules[1].ranges[0].metadata.needsBinding, true);
    assert.equal(saved.rules[1].ranges[0].metadata.conditions[0].status, 'active');
});

test('an old scene candidate linked to a paused thread is filtered while its unrelated detail still applies', () => {
    const chat = [];
    const turn = turnAt(chat, 'first');
    chat.push(user(turn), reply('speaker', { 0: {
        report: report(turn, { newThread: newThread('蓝签') }),

    } }));
    chat[1].extra[NARRATIVE_KEY].swipes[0].actions = [{ type: 'pause', threadId: turn.newThreadId, baseRevision: foldNarrative(chat).revision }];
    const paused = { ...state(), ...foldNarrative(chat) };
    assert.equal(paused.threads[0].status, 'paused');
    const lists = settings(group('scene', [
        rule('thread-event', ['追查蓝签'], { threadId: turn.newThreadId, topic: 'clue' }),
        rule('detail', ['湿透的伞面'], { effect: 'detail' }),
    ]));
    const result = prepareNarrativeTurn(lists, cfg(), paused, () => 0);
    assert.equal(result.rolls[0].reason, 'thread_inactive');
    assert.deepEqual(chosen(result).map(item => item.command), ['湿透的伞面']);
});

test('manual corrections and pauses remain attached to their original reply and branch prefix', () => {
    const chat = [];
    const origin = turnAt(chat, 'origin');
    chat.push(user(origin), reply('origin-reply', { 0: {
        report: report(origin, { newThread: newThread('蓝签') }),
    } }));
    const followup = turnAt(chat, 'followup');
    const anchored = reply('followup-reply', { 0: {}, 1: {} });
    chat.push(user(followup), anchored);
    const actions = anchored.extra[NARRATIVE_KEY].swipes[0].actions = [];
    actions.push({ type: 'correct', target: 'question', fact: '蓝签应交给谁？',
        threadId: origin.newThreadId, baseRevision: foldNarrative(chat).revision });
    actions.push({ type: 'pause', threadId: origin.newThreadId, baseRevision: foldNarrative(chat).revision });
    const original = foldNarrative(chat);
    assert.equal(original.threads[0].question, '蓝签应交给谁？');
    assert.equal(original.threads[0].status, 'paused');
    assert.deepEqual(foldNarrative(JSON.parse(JSON.stringify(chat))), original);
    anchored.swipe_id = 1;
    assert.equal(foldNarrative(chat).threads[0].status, 'active');
    anchored.swipe_id = 0;
    assert.deepEqual(foldNarrative(chat), original);
    chat[1].mes += ' 门外下着雨。';
    const edited = foldNarrative(chat).threads[0];
    assert.equal(edited.status, 'active');
    assert.equal(edited.question, '谁留下的？');
});

test('the prepared narrative prompt gives a valid JSON Patch for the actual turn and candidates', () => {
    const lists = settings(group('long', [rule('clue', ['观察蓝签'], { topic: 'clue' })]));
    const result = prepareNarrativeTurn(lists, cfg(), state(), () => 0);
    const encoded = /数组示例[^：]*：(\[.*?\])。本插件的剧情回报操作/.exec(result.narrative.prompt)?.[1];
    assert.ok(encoded);
    const [operation] = JSON.parse(encoded);
    assert.equal(operation.op, 'add');
    assert.equal(operation.path, '/随机指令工作台/剧情回报');
    assert.equal(operation.value.turnId, result.narrative.turnId);
    assert.equal(operation.value.baseRevision, result.narrative.baseRevision);
    assert.deepEqual(operation.value.uses, result.narrative.candidates.map(candidateId => ({ candidateId, status: 'ignored' })));
    assert.match(result.narrative.prompt, /继续沿用卡的 _\.set 原语法/);
    assert.match(result.narrative.prompt, /本插件的剧情回报操作必须有 op、path、value 三个键，op 的值使用 add 或 replace[^。]*角色卡其他变量操作沿用原协议/);
    assert.match(result.narrative.prompt, /群聊中后续角色也必须单独回报/);
    assert.match(result.narrative.prompt, /不能引用其他角色的回复；前面角色已记录的新线不要重复提议/);
    assert.match(result.narrative.prompt, /不输出协议解释、自检、修正草稿或重复正文/);
    assert.match(result.narrative.prompt, /没有剧情变化时，uses 仍逐项填写，updates 为 \[\]，newThread 为 null/);
    assert.match(result.narrative.prompt, /<UpdateVariable><JSONPatch>合法 JSON 数组<\/JSONPatch><\/UpdateVariable>/);
});

test('deleting an earlier reply and reusing its index cannot resurrect dependent facts', () => {
    const chat = [];
    const origin = turnAt(chat, 'origin');
    chat.push(user(origin), reply('old-origin', { 0: {
        report: report(origin, { newThread: newThread('蓝签') }),
    } }));
    const followup = turnAt(chat, 'followup');
    chat.push(user(followup), reply('dependent', { 0: {
        report: report(followup, { updates: [{
            threadId: origin.newThreadId, action: 'advance', fact: '蓝签已经登记。', evidence: '他捡起蓝签。',
        }] }),
    } }));
    assert.equal(foldNarrative(chat).threads[0].facts.length, 1);
    chat.splice(1, 1);
    assert.deepEqual(foldNarrative(chat).threads, []);
    chat.splice(1, 0, reply('new-occupant', {}, 0, '他捡起蓝签。'));
    assert.deepEqual(foldNarrative(chat).threads, []);
    assert.deepEqual(foldNarrative(JSON.parse(JSON.stringify(chat))), foldNarrative(chat));
});
