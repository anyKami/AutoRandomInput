import assert from 'node:assert/strict';
import test from 'node:test';
import { SETTINGS_KEY, createGroup, normalizeSettings } from '../core.js';
import { SKILL_GROUPS_KEY } from '../skill-groups.js';
import { NARRATIVE_KEY, normalizeNarrativeConfig } from '../narrative.js';
import { mountConfigTransferUI } from '../config-transfer-ui.js';

function fixture(t) {
    class Element {
        constructor(tag = 'div') {
            this.tag = tag; this.children = []; this.dataset = {}; this.attrs = {};
            this.handlers = new Map(); this.value = ''; this.hidden = false;
        }
        append(...children) { this.children.push(...children); }
        replaceChildren(...children) { this.children = children; }
        setAttribute(name, value) { this.attrs[name] = value; }
        getAttribute(name) { return this.attrs[name]; }
        addEventListener(name, callback) {
            const listeners = this.handlers.get(name) ?? [];
            listeners.push(callback); this.handlers.set(name, listeners);
        }
        async fire(name) { for (const callback of this.handlers.get(name) ?? []) await callback({ target: this }); }
        querySelectorAll() { return []; }
        focus() {}
        scrollIntoView() {}
        click() {}
        remove() {}
    }
    const nodes = new Map();
    const node = selector => {
        if (!nodes.has(selector)) nodes.set(selector, new Element());
        return nodes.get(selector);
    };
    const dialog = new Element(); dialog.querySelector = node;
    node('#ari-transfer-panel').hidden = true;
    const downloads = [];
    globalThis.document = { body: new Element('body'), createElement: tag => new Element(tag) };
    t.after(() => { delete globalThis.document; });
    t.mock.method(URL, 'createObjectURL', blob => { downloads.push(blob); return 'blob:config-test'; });
    t.mock.method(URL, 'revokeObjectURL', () => {});
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const store = normalizeSettings();
    const manual = createGroup('共享手动组'), long = createGroup('A 长期组'), scene = createGroup('A 场景组');
    const otherLong = createGroup('B 长期组'), otherScene = createGroup('B 场景组');
    store.groups = [manual, long, scene, otherLong, otherScene]; store.activeGroupId = manual.id;
    const ctx = { chat: [{ is_user: true, mes: '当前聊天' }], chatId: 'A', characterId: 0,
        chatMetadata: { integrity: 'chat-A', [NARRATIVE_KEY]: normalizeNarrativeConfig({ enabled: true, longGroupId: long.id, sceneGroupId: scene.id }) },
        extensionSettings: { [SETTINGS_KEY]: store, [SKILL_GROUPS_KEY]: { groups: [] } } };
    mountConfigTransferUI(dialog, () => ctx, () => {});
    return { ctx, store, manual, long, scene, otherLong, otherScene, node, downloads,
        open: () => node('#ari-transfer-toggle').fire('click'),
        exportCurrent: () => node('#ari-export-current').fire('click'),
        status: () => node('#ari-transfer-status').textContent,
        downloaded: async () => JSON.parse(await downloads.at(-1).text()),
    };
}

test('current narrative export contains its bound layers and explains the export scope', async t => {
    const h = fixture(t); await h.open();
    assert.match(h.node('#ari-export-current-note').textContent, /绑定/);
    await h.exportCurrent();
    assert.deepEqual((await h.downloaded()).randomGroups.map(group => group.name), ['A 长期组', 'A 场景组']);
});

test('switching chats cannot export the new narrative bindings under an old open panel', async t => {
    const h = fixture(t); await h.open();
    h.ctx.chatId = 'B';
    h.ctx.chatMetadata = { integrity: 'chat-B', [NARRATIVE_KEY]: normalizeNarrativeConfig({ enabled: true,
        longGroupId: h.otherLong.id, sceneGroupId: h.otherScene.id }) };
    await h.exportCurrent();
    assert.equal(h.downloads.length, 0);
    assert.match(h.status(), /重新打开/);
    await h.open(); await h.open(); await h.exportCurrent();
    assert.deepEqual((await h.downloaded()).randomGroups.map(group => group.name), ['B 长期组', 'B 场景组']);
});

test('an in-place chat identity change invalidates narrative export even when binding IDs match', async t => {
    const h = fixture(t); await h.open();
    h.ctx.chatId = 'B'; h.ctx.chatMetadata.integrity = 'chat-B';
    await h.exportCurrent();
    assert.equal(h.downloads.length, 0);
    assert.match(h.status(), /重新打开/);
});

test('changing a narrative layer while export is open requires reopening the panel', async t => {
    const h = fixture(t); await h.open();
    h.ctx.chatMetadata[NARRATIVE_KEY].sceneGroupId = h.otherScene.id;
    await h.exportCurrent();
    assert.equal(h.downloads.length, 0);
    assert.match(h.status(), /重新打开/);
});

test('toggling narrative mode cannot silently change what current configuration exports', async t => {
    const h = fixture(t); await h.open();
    h.ctx.chatMetadata[NARRATIVE_KEY].enabled = false;
    await h.exportCurrent();
    assert.equal(h.downloads.length, 0);
    assert.match(h.status(), /重新打开/);
});

test('ordinary current-group export keeps its naming and selection-change guard', async t => {
    const h = fixture(t); h.ctx.chatMetadata[NARRATIVE_KEY].enabled = false;
    await h.open(); h.node('#ari-export-name').value = '导出的组名';
    await h.exportCurrent();
    assert.equal((await h.downloaded()).randomGroups[0].name, '导出的组名');
    h.store.activeGroupId = h.scene.id;
    await h.exportCurrent();
    assert.equal(h.downloads.length, 1);
    assert.match(h.status(), /重新打开/);
});
