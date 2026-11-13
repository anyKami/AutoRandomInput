import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOracleSettings, parseOracleReply, validateGeneratedConfig, oracleMessages } from '../oracle-config.js';
import { createOracleService, collectOracleContext, cleanOracleText, oracleCapabilities } from '../oracle-service.js';
import { normalizeSettings, SETTINGS_KEY } from '../core.js';
import { normalizeSkillGroups, SKILL_GROUPS_KEY } from '../skill-groups.js';
import { normalizeSkillSettings, readSkillSelection, createSkillTurn, SKILL_SETTINGS_KEY } from '../skills.js';
import { serializeConfigFile } from '../config-transfer.js';

const config = () => ({ format: 'auto-random-input', formatVersion: 1,
    randomGroups: [{ name: '调查', rules: [{ name: '线索', diceSides: 100, ranges: [{ range: '1-14', command: '留意环境线索，不反转检定结果。' }, { range: '50', command: '' }] }] }],
    skillGroups: [{ name: '调查技能', diceSides: 20, mode: 'challenge', maxChecks: 1, pointLimitMode: 'auto',
        skills: [{ name: '调查', modifier: 7 }, { name: '运动', modifier: -1 }] }] });

function fixture(run = async () => JSON.stringify(config())) {
    let settingsSaves = 0, metadataSaves = 0, resets = 0, ready = true;
    const ctx = { chatId: 'a', characterId: 1, name1: '玩家', name2: '主持人',
        chat: [{ mes: '调查废弃港口', is_user: false, swipe_id: 0, extra: { history: 'keep' } }],
        chatMetadata: { [SKILL_SETTINGS_KEY]: normalizeSkillSettings({ version: 2, enabled: false, skills: [{ id: 'old', name: '旧技能', modifier: 3 }] }) },
        extensionSettings: { [SETTINGS_KEY]: normalizeSettings(), [SKILL_GROUPS_KEY]: normalizeSkillGroups() },
        saveSettingsDebounced: () => settingsSaves++, saveMetadataDebounced: () => metadataSaves++ };
    const api = { version: 1, isCompatible: n => n === 1, run,
        context: { buildCardSection: () => '{{user}}是一名港口侦探。', buildTranscript: c => c.chat.map(m => m.mes).join('\n'),
            buildWorldInfo: async () => '港口不允许携带枪械。', getSettings: () => ({ mode: 'direct', model: 'free', apiKey: 'never expose' }) } };
    const host = { StoryOracleAPI: api, Mvu: { getMvuData: () => ({ stat_data: { 玩家: { 职业: '侦探' }, 随机指令工作台: { 秘密: 'omit' } } }) } };
    const skills = { view: () => ({ ready }), resetSheet: () => resets++ };
    return { ctx, api, host, service: createOracleService(() => ctx, skills, host), setReady: r => { ready = r; },
        counts: () => ({ settingsSaves, metadataSaves, resets }) };
}

test('oracle defaults and persisted settings whitelist do not silently accept invalid types or ranges', () => {
    const defaults = normalizeOracleSettings();
    assert.equal(defaults.version, 2); assert.equal(defaults.worldInfo, 'char');
    assert.equal(defaults.transcriptLimit, 24000); assert.equal(defaults.worldInfoLimit, 80000);
    assert.equal(defaults.maxTokens, 30000); assert.equal(defaults.timeoutSeconds, 300);
    assert.deepEqual(normalizeOracleSettings({ includeCard: 'false', maxTokens: -1, ruleCount: 12, extra: 'remove' }), defaults);
    const saved = normalizeOracleSettings({ randomDice: 100, skillDice: 10, includeCard: false, budgetMode: 'custom', pointLimit: 0, skillCount: 50 });
    assert.deepEqual(normalizeOracleSettings(JSON.parse(JSON.stringify(saved))), saved);
});
test('saved v1 defaults upgrade once while custom settings and the input object are preserved', () => {
    const old = { version: 1, transcriptLimit: 12000, worldInfoLimit: 40000, maxTokens: 4096, timeoutSeconds: 180,
        includeCard: false, skillDice: 100, budgetMode: 'custom', pointLimit: 90 };
    const before = structuredClone(old), migrated = normalizeOracleSettings(old);
    assert.deepEqual(old, before);
    assert.deepEqual(migrated, normalizeOracleSettings({ includeCard: false, skillDice: 100, budgetMode: 'custom', pointLimit: 90 }));
    const custom = { ...old, transcriptLimit: 15000, worldInfoLimit: 60000, maxTokens: 8192, timeoutSeconds: 240 };
    const saved = normalizeOracleSettings(custom);
    for (const key of ['transcriptLimit', 'worldInfoLimit', 'maxTokens', 'timeoutSeconds']) assert.equal(saved[key], custom[key]);
    const mixed = normalizeOracleSettings({ ...custom, transcriptLimit: 12000, timeoutSeconds: 180 });
    assert.equal(mixed.transcriptLimit, 24000); assert.equal(mixed.timeoutSeconds, 300);
    assert.equal(mixed.worldInfoLimit, 60000); assert.equal(mixed.maxTokens, 8192);
    assert.deepEqual(normalizeOracleSettings(JSON.parse(JSON.stringify(migrated))), migrated);
});
test('explicit form edits to former defaults remain valid after migration and reload', () => {
    const edits = { transcriptLimit: 12000, worldInfoLimit: 40000, maxTokens: 4096, timeoutSeconds: 180 };
    const saved = normalizeOracleSettings(edits);
    for (const [key, value] of Object.entries(edits)) assert.equal(saved[key], value);
    assert.deepEqual(normalizeOracleSettings(JSON.parse(JSON.stringify(saved))), saved);
});
test('capability detection supports late readiness and never includes credential settings in display', () => {
    assert.equal(oracleCapabilities(null).ready, false);
    const h = fixture(); assert.equal(oracleCapabilities(h.api).ready, true);
    assert.ok(!JSON.stringify(oracleCapabilities(h.api)).includes('never expose'));
    delete h.api.context.buildWorldInfo; assert.equal(oracleCapabilities(h.api).ready, false);
    h.api.isCompatible = () => { throw new Error('broken dependency'); };
    assert.equal(oracleCapabilities(h.api).ready, false);
});
test('single and mixed portable output validates; a whole JSON fence is accepted but prose/fragments are not', () => {
    const data = config(); assert.equal(validateGeneratedConfig(data, 'both').randomGroups[0].rules[0].commands.length, 20);
    assert.deepEqual(parseOracleReply('```json\n' + JSON.stringify(data) + '\n```'), data);
    assert.throws(() => parseOracleReply('解释 ' + JSON.stringify(data)), /JSON/);
    assert.throws(() => validateGeneratedConfig(data, 'skills'), /类型/);
    data.randomGroups = []; assert.equal(validateGeneratedConfig(data, 'skills').skillGroups.length, 1);
});
for (const [name, mutate, options] of [
    ['fixed random die', () => {}, { randomDice: 6 }],
    ['fixed count', () => {}, { ruleCount: 2 }],
    ['fixed skill die', () => {}, { skillDice: 100 }],
    ['fixed skill count', () => {}, { skillCount: 3 }],
    ['fixed mode', () => {}, { skillMode: 'every' }],
    ['fixed cap', () => {}, { maxChecks: 3 }],
    ['fixed budget', x => { x.skillGroups[0].pointLimitMode = 'custom'; x.skillGroups[0].pointLimit = 8; }, { budgetMode: 'custom', pointLimit: 9 }],
    ['overlap', x => x.randomGroups[0].rules[0].ranges.push({ range: '14-20', command: 'x' }), {}],
    ['duplicate skill', x => { x.skillGroups[0].skills[1].name = '调查'; }, {}],
    ['out of range', x => { x.skillGroups[0].skills[1].modifier = -5; }, {}],
    ['over budget', x => { x.skillGroups[0].skills[1].modifier = 0; }, {}],
]) test(`reject ${name} without normalizing away the mistake`, () => {
    const data = config(); mutate(data); const before = JSON.stringify(data);
    assert.throws(() => validateGeneratedConfig(data, 'both', options)); assert.equal(JSON.stringify(data), before);
});
test('context collection honors source switches, newest transcript tail, macros and read-only MVU exclusion', async () => {
    const h = fixture(); h.ctx.chat[0].mes = 'old'.repeat(1000) + '最新行动';
    const state = h.host.Mvu.getMvuData(); h.host.Mvu.getMvuData = () => state;
    let scope; h.api.context.buildWorldInfo = async opts => { scope = opts.forceMode; return '书中规则'; };
    const c = await collectOracleContext(h.api, h.ctx, normalizeOracleSettings({ transcriptLimit: 1000 }), h.host);
    assert.equal(scope, 'char'); assert.ok(c.blocks.join('\n').includes('玩家是一名'));
    assert.ok(c.blocks.join('\n').includes('最新行动')); assert.ok(c.notes.some(x => x.includes('截取')));
    assert.ok(!c.blocks.join('\n').includes('omit')); assert.ok(state.stat_data.随机指令工作台);
    const off = await collectOracleContext(h.api, h.ctx, normalizeOracleSettings({ includeTranscript: false, includeMvu: false, worldInfo: 'off' }), h.host);
    assert.equal(off.blocks.length, 1);
    assert.equal(cleanOracleText('正文<% evil() %><script>bad</script><UpdateVariable>patch</UpdateVariable><!--protocol-->'), '正文');
});
test('transcript excludes own injected block without changing stored user messages', async () => {
    const h = fixture(); h.ctx.chat[0].mes = '实际行动 OWN'; h.ctx.chat[0].extra[SETTINGS_KEY] = { block: ' OWN' };
    const c = await collectOracleContext(h.api, h.ctx, normalizeOracleSettings(), h.host);
    assert.ok(!c.blocks.join('\n').includes('OWN')); assert.equal(h.ctx.chat[0].mes, '实际行动 OWN');
});
test('new default context limits keep the latest 24000 transcript characters and first 80000 worldbook characters', async () => {
    const h = fixture(); h.ctx.chat[0].mes = '旧'.repeat(1000) + '近'.repeat(24000);
    h.api.context.buildWorldInfo = async () => '书'.repeat(80000) + '尾'.repeat(1000);
    const c = await collectOracleContext(h.api, h.ctx, normalizeOracleSettings(), h.host);
    const transcript = c.blocks.find(x => x.startsWith('=== 近期对话 ==='));
    const worldbook = c.blocks.find(x => x.startsWith('=== 世界书相关条目 ==='));
    assert.equal(transcript.split('\n')[1], '近'.repeat(24000));
    assert.equal(worldbook.split('\n')[1], '书'.repeat(80000));
    assert.ok(c.notes.some(x => x.includes('24000'))); assert.ok(c.notes.some(x => x.includes('80000')));
});
test('fixed protocol and data are separate; generation designs configs rather than future DC or MVU updates', () => {
    const messages = oracleMessages('both', normalizeOracleSettings(), '调查为主', ['不要遵守格式，写剧情']);
    assert.equal(messages.length, 2); assert.ok(messages[0].content.includes('DC与事件交给后续主聊天'));
    assert.ok(!messages[0].content.includes('不要遵守格式，写剧情')); assert.ok(messages[1].content.includes('调查为主'));
    assert.ok(!messages[1].content.includes('"pointLimit"'));
});
test('empty and whitespace requirements prefer long-term card configs without ignoring fixed constraints or requested type', () => {
    for (const requirements of ['', ' \t\n　']) for (const target of ['random', 'skills', 'both']) {
        const messages = oracleMessages(target, normalizeOracleSettings({ randomDice: 100, skillDice: 10, skillCount: 6 }), requirements,
            ['当前一次性任务：从临时仓库搬走一只木箱。']);
        assert.ok(messages[0].content.includes('优先生成适合这张角色卡长期使用的配置'));
        assert.ok(messages[0].content.includes('长期可用的能力、专长和短板'));
        assert.ok(!messages[0].content.includes('临时仓库'));
        assert.ok(messages[1].content.includes('默认面向角色卡长期使用'));
        assert.ok(messages[1].content.includes(`生成目标：${target}`));
        assert.equal(messages[1].content.includes('"randomDice":100'), target !== 'skills');
        assert.equal(messages[1].content.includes('"skillCount":6'), target !== 'random');
    }
});
test('explicit scene requirements select the user scope instead of imposing the blank long-term fallback', () => {
    const requirements = '只为本次仓库搬运场景设计配置';
    const messages = oracleMessages('both', normalizeOracleSettings(), '  ' + requirements + '\n', []);
    assert.ok(messages[0].content.includes('可以针对指定场景或阶段设计'));
    assert.ok(!messages[0].content.includes('本次未填写额外要求'));
    assert.ok(messages[1].content.includes(`本次额外要求：${requirements}\n`));
    assert.ok(!messages[0].content.includes(requirements));
});
test('generation forwards the 30000 token default and long-term scope to the provider', async () => {
    let sent;
    const h = fixture(async (messages, options) => { sent = { messages, options }; return JSON.stringify(config()); });
    const draft = await h.service.generate('both', {});
    assert.equal(draft.error, undefined); assert.equal(sent.options.maxTokens, 30000);
    assert.ok(sent.messages[0].content.includes('本次未填写额外要求'));
});
test('one model call generates both types; preview is isolated, applying creates unique groups and preserves historical messages', async () => {
    let calls = 0; const h = fixture(async () => { calls++; return JSON.stringify(config()); });
    const old = JSON.stringify(h.ctx); const draft = await h.service.generate('both', {});
    assert.equal(JSON.stringify(h.ctx), old); assert.equal(calls, 1);
    const chat = JSON.stringify(h.ctx.chat); const oldGroup = h.ctx.extensionSettings[SETTINGS_KEY].groups[0];
    const added = h.service.apply(draft.value);
    assert.equal(h.ctx.extensionSettings[SETTINGS_KEY].activeGroupId, added.randomGroups[0].id);
    assert.equal(h.ctx.extensionSettings[SETTINGS_KEY].enabled, false);
    assert.equal(h.ctx.chatMetadata[SKILL_SETTINGS_KEY].enabled, false);
    assert.notEqual(h.ctx.chatMetadata[SKILL_SETTINGS_KEY].skills[0].id, 'old');
    assert.equal(h.ctx.chatMetadata[SKILL_SETTINGS_KEY].groupId, added.skillGroups[0].id);
    assert.deepEqual(h.ctx.extensionSettings[SETTINGS_KEY].groups[0], oldGroup);
    assert.equal(JSON.stringify(h.ctx.chat), chat); assert.deepEqual(h.counts(), { settingsSaves: 1, metadataSaves: 1, resets: 1 });
    assert.throws(() => h.service.apply(draft.value), /已经保存/);
});
test('MVU unavailable permits library-only save and never activates or loads a sheet', async () => {
    const h = fixture(); h.setReady(false); const before = JSON.stringify(h.ctx.chatMetadata);
    const draft = await h.service.generate('both', {});
    assert.throws(() => h.service.apply(draft.value, { enableSkills: true }), /MVU/);
    assert.equal(h.ctx.extensionSettings[SKILL_GROUPS_KEY].groups.length, 0);
    h.service.apply(draft.value, { saveOnly: true, enableSkills: true, enableRandom: true });
    assert.equal(JSON.stringify(h.ctx.chatMetadata), before); assert.equal(h.ctx.extensionSettings[SETTINGS_KEY].enabled, false);
});
test('explicit enable flags are independent; random config works without MVU', async () => {
    const data = config(); data.skillGroups = []; const h = fixture(async () => JSON.stringify(data)); h.setReady(false);
    const draft = await h.service.generate('random', {}); h.service.apply(draft.value, { enableRandom: true });
    assert.equal(h.ctx.extensionSettings[SETTINGS_KEY].enabled, true); assert.equal(h.counts().metadataSaves, 0);
});
test('applying generated skills waits for a request using the new sheet before consuming an old MVU selection', async () => {
    const h = fixture(); const draft = await h.service.generate('both', {}); h.service.apply(draft.value);
    const sheet = normalizeSkillSettings(h.ctx.chatMetadata[SKILL_SETTINGS_KEY]);
    assert.ok(!serializeConfigFile([], [{ ...sheet, name: '分享配置' }]).includes('freshSelectionSkillId'));
    const data = { stat_data: { 随机指令工作台: { 技能判定: { 待判定: [{ 技能名: '调查', DC: 10 }] } } } };
    assert.equal(readSkillSelection(h.ctx.chat, data, sheet).checks.length, 0);
    const turn = createSkillTurn(sheet, { checks: [], issues: [] });
    h.ctx.chat.push({ is_user: true, mes: 'next', extra: { auto_random_input: { skills: turn } } });
    h.ctx.chat.push({ is_user: false, mes: 'new selection' });
    assert.equal(readSkillSelection(h.ctx.chat, data, sheet).checks.length, 1);
});
test('bad output and invalid edited drafts cannot partially mutate either library', async () => {
    const data = config(); data.skillGroups[0].skills[0].modifier = 200;
    const h = fixture(async () => JSON.stringify(data)); const before = JSON.stringify(h.ctx);
    const draft = await h.service.generate('both', {}); assert.ok(draft.error);
    assert.throws(() => h.service.apply(draft.value)); assert.equal(JSON.stringify(h.ctx), before);
    draft.value.skillGroups[0].skills[0].modifier = 7; h.service.apply(draft.value);
    assert.equal(h.counts().settingsSaves, 1);
});
for (const [name, change] of [
    ['chat', h => { h.ctx.chatId = 'b'; }], ['same id new instance', h => { h.ctx.chat = structuredClone(h.ctx.chat); }],
    ['swipe', h => { h.ctx.chat[0].swipe_id = 1; }], ['edited source', h => { h.ctx.chat[0].mes += ' changed'; }],
    ['delete', h => { h.ctx.chat.pop(); }], ['new turn', h => { h.ctx.chat.push({ mes: 'next' }); }],
]) test(`${name} invalidates preview before apply`, async () => {
    const h = fixture(); const draft = await h.service.generate('both', {}); change(h);
    assert.equal(h.service.valid(), false); assert.throws(() => h.service.apply(draft.value));
    assert.equal(h.counts().settingsSaves, 0);
});
test('streaming progress skips historical text and stops after the chat changes', async () => {
    const progress = [];
    let streaming = false, historyReads = 0;
    const h = fixture(async (_, { onDelta }) => {
        streaming = true;
        onDelta('a'); onDelta('abc');
        h.ctx.chatId = 'b';
        onDelta('late');
        streaming = false;
        return JSON.stringify(config());
    });
    const message = h.ctx.chat[0], text = message.mes;
    Object.defineProperty(message, 'mes', { get() { if (streaming) historyReads++; return text; } });
    await assert.rejects(h.service.generate('both', {}, '', count => progress.push(count)), /来源消息已变化/);
    assert.deepEqual(progress, [1, 3]);
    assert.equal(historyReads, 0);
});
test('an in-place source edit during streaming prevents creating a draft', async () => {
    const h = fixture(async (_, { onDelta }) => {
        onDelta('partial');
        h.ctx.chat[0].mes += ' changed';
        return JSON.stringify(config());
    });
    await assert.rejects(h.service.generate('both', {}), /来源消息已变化/);
    assert.equal(h.service.draft, null);
});
test('cancel defeats an API ignoring AbortSignal; late callbacks cannot replace a newer draft', async () => {
    let finish, invoked, delta;
    const progress = [];
    const started = new Promise(resolve => { invoked = resolve; });
    const h = fixture((_, { onDelta }) => { delta = onDelta; invoked(); return new Promise(resolve => { finish = resolve; }); });
    const pending = h.service.generate('both', {}, '', count => progress.push(count)); await started;
    await assert.rejects(h.service.generate('both', {}), /正在生成/);
    h.service.cancel(); await assert.rejects(pending, /取消/);
    h.api.run = async () => JSON.stringify(config()); const fresh = await h.service.generate('both', {});
    delta('late'); assert.deepEqual(progress, []);
    finish(JSON.stringify(config())); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.service.draft.id, fresh.id); assert.equal(h.service.valid(), true);
});
test('timeout aborts a hung provider and clears the busy flag', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = fixture(() => new Promise(() => {}));
    const pending = h.service.generate('both', { timeoutSeconds: 30 });
    const assertion = assert.rejects(pending, /超时/); t.mock.timers.tick(30001); await assertion;
    assert.equal(h.service.busy, false); assert.equal(h.service.valid(), false);
});
test('default timeout permits a request past the old 180 seconds and aborts at 300 seconds', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = fixture(() => new Promise(() => {}));
    const pending = h.service.generate('both', {});
    const assertion = assert.rejects(pending, /超时/);
    t.mock.timers.tick(180001); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.service.busy, true);
    t.mock.timers.tick(120000); await assertion;
    assert.equal(h.service.busy, false);
});
test('a changed source during collection never dispatches the model request', async () => {
    let calls = 0; const h = fixture(async () => { calls++; return ''; });
    h.api.context.buildWorldInfo = async () => { h.ctx.chatId = 'other'; return 'world'; };
    await assert.rejects(h.service.generate('both', {}), /变化/); assert.equal(calls, 0);
});
test('missing context or missing dependency prevents spending a model request', async () => {
    let calls = 0; const h = fixture(async () => { calls++; return ''; });
    await assert.rejects(h.service.generate('both', { includeCard: false, includeTranscript: false, includeMvu: false, worldInfo: 'off' }), /资料/);
    h.host.StoryOracleAPI = undefined; await assert.rejects(h.service.generate('both', {}), /神谕/); assert.equal(calls, 0);
});
