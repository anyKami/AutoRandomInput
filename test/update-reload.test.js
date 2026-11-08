import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateReloader, flushBeforeReload } from '../update-reload.js';

function fixture(t, overrides = {}) {
    let latest = '2.1.2', busy = false, next = 0;
    const calls = [], errors = [], timers = new Map();
    const monitor = createUpdateReloader({ version: '2.1.2', readVersion: async () => latest, isBusy: async () => busy,
        flush: async () => { calls.push('saved'); }, reload: () => calls.push('reload'), notify: () => calls.push('notice'),
        onError: error => errors.push(error), setTimer: (fn, delay) => { timers.set(++next, { fn, delay }); return next; },
        clearTimer: id => timers.delete(id), ...overrides });
    t.after(monitor.dispose);
    return { monitor, calls, errors, timers, version: value => { latest = value; }, busy: value => { busy = value; } };
}

test('an unchanged installation never saves or reloads; update hook reloads once even with the same version', async t => {
    const h = fixture(t);
    await h.monitor.check(); await h.monitor.check();
    assert.deepEqual(h.calls, []);
    assert.equal([...h.timers.values()][0].delay, 30000);
    h.monitor.request(); h.monitor.request();
    await h.monitor.check(); await h.monitor.check(); h.monitor.request();
    assert.deepEqual(h.calls, ['notice', 'saved', 'reload']);
    assert.equal(h.timers.size, 0);
});

test('external updates require a stable new version and stale cached code cannot loop across page reloads', async t => {
    const data = new Map();
    const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
    const h = fixture(t, { storage });
    for (const version of ['2.1.3','2.1.2','2.1.3','2.1.4']) { h.version(version); await h.monitor.check(); }
    assert.deepEqual(h.calls, []);
    await h.monitor.check();
    assert.deepEqual(h.calls, ['notice', 'saved', 'reload']);
    const stale = fixture(t, { storage }); stale.version('2.1.4');
    await stale.monitor.check(); await stale.monitor.check();
    assert.deepEqual(stale.calls, []);
    const current = fixture(t, { storage, version: '2.1.4', readVersion: async () => '2.1.4' });
    await current.monitor.check();
    assert.equal(data.size, 0);
});

test('busy state defers refresh, and typing during a save cancels the imminent reload', async t => {
    const h = fixture(t); h.busy(true); h.monitor.request();
    await h.monitor.check(); await h.monitor.check();
    assert.deepEqual(h.calls, ['notice']);
    h.busy(false); await h.monitor.check();
    assert.deepEqual(h.calls, ['notice', 'saved', 'reload']);
    let release, entered;
    const saving = new Promise(resolve => { entered = resolve; });
    const race = fixture(t, { flush: async () => { entered(); await new Promise(resolve => { release = resolve; }); } });
    race.monitor.request(); const check = race.monitor.check(); await saving;
    race.busy(true); release();
    assert.equal(await check, false);
    assert.deepEqual(race.calls, ['notice']);
});

test('failed manifests and failed saves remain retryable without repeated notices', async t => {
    let latest = null, failSave = true;
    const h = fixture(t, { readVersion: async () => latest, flush: async () => { if (failSave) throw Error('offline'); } });
    await h.monitor.check(); assert.equal(h.errors.length, 1);
    assert.deepEqual(h.calls, []);
    latest = '2.1.3'; await h.monitor.check(); await h.monitor.check();
    assert.deepEqual(h.calls, ['notice']);
    assert.equal([...h.timers.values()][0].delay, 10000);
    failSave = false; await h.monitor.check();
    assert.deepEqual(h.calls, ['notice', 'reload']);
});

test('concurrent checks share one save and page disposal cancels in-flight reload', async t => {
    let entered, release, saves = 0;
    const saving = new Promise(resolve => { entered = resolve; });
    const h = fixture(t, { flush: async () => { saves++; entered(); await new Promise(resolve => { release = resolve; }); } });
    h.monitor.request(); const first = h.monitor.check(), second = h.monitor.check();
    assert.strictEqual(first, second); await saving;
    h.monitor.dispose(); release(); await first;
    assert.equal(saves, 1); assert.deepEqual(h.calls, ['notice']); assert.equal(h.timers.size, 0);
});

function saveFixture() {
    const listeners = new Map(), requests = [];
    const ctx = { chatId: 'fixture-chat', characterId: 0, characters: [{ name: 'Test', avatar: 'test.png' }],
        chatMetadata: { auto_random_input_skills: { skills: [{ name: '侦查', value: 13 }] } },
        chat: [{ is_user: true, mes: 'test', extra: { auto_random_input: { skills: { results: [6] } } } }],
        eventTypes: { SETTINGS_UPDATED: 'saved' }, eventSource: {
            on: (event, fn) => listeners.set(event, fn), removeListener: event => listeners.delete(event),
        }, getRequestHeaders: () => ({ 'Content-Type': 'application/json' }), saveChat: async () => {},
    };
    const host = { saveSettings: async () => listeners.get('saved')?.() };
    const fetcher = async (url, options) => {
        requests.push({ url, body: JSON.parse(options.body) });
        return { ok: true, json: async () => [{ chat_metadata: structuredClone(ctx.chatMetadata) }, ...structuredClone(ctx.chat)] };
    };
    return { ctx, host, fetcher, listeners, requests };
}

test('refresh verifies saved single and group chats including skill snapshots and metadata', async () => {
    const h = saveFixture();
    await flushBeforeReload(() => h.ctx, h.host, h.fetcher);
    assert.deepEqual(h.requests[0], { url: '/api/chats/get', body: { file_name: 'fixture-chat', ch_name: 'Test', avatar_url: 'test.png' } });
    h.ctx.groupId = 'group';
    await flushBeforeReload(() => h.ctx, h.host, h.fetcher);
    assert.deepEqual(h.requests[1], { url: '/api/chats/group/get', body: { id: 'fixture-chat' } });
    assert.equal(h.listeners.size, 0);
});

test('missing settings confirmation or a swallowed chat-save failure prevents refresh', async () => {
    const h = saveFixture();
    await assert.rejects(flushBeforeReload(() => h.ctx, { saveSettings: async () => {} }, h.fetcher), /设置尚未保存/);
    assert.equal(h.requests.length, 0); assert.equal(h.listeners.size, 0);
    const stale = async () => ({ ok: true, json: async () => [{ chat_metadata: h.ctx.chatMetadata }] });
    await assert.rejects(flushBeforeReload(() => h.ctx, h.host, stale), /聊天尚未完整保存/);
    await assert.rejects(flushBeforeReload(() => h.ctx, h.host, async () => ({ ok: false, status: 500 })), /HTTP 500/);
});

test('switching or replacing a chat during saving defers reload and does not fetch the wrong chat', async () => {
    const h = saveFixture(); let current = h.ctx;
    h.ctx.saveChat = async () => { current = { ...h.ctx, chat: structuredClone(h.ctx.chat) }; };
    await assert.rejects(flushBeforeReload(() => current, h.host, h.fetcher), /聊天已变化/);
    assert.equal(h.requests.length, 0);
    const welcome = saveFixture(); welcome.ctx.chatId = undefined;
    await flushBeforeReload(() => welcome.ctx, welcome.host, welcome.fetcher);
    assert.equal(welcome.requests.length, 0);
});
