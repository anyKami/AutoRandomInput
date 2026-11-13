import assert from 'node:assert/strict';
import test from 'node:test';
import { mountMetadataEditor, mountNarrativeUI } from '../narrative-ui.js';
import { SETTINGS_KEY } from '../core.js';
import { NARRATIVE_KEY } from '../narrative.js';

test('editing an MVU comparison saves the current path and typed value without blur', t => {
    class Element extends EventTarget {
        constructor(tag) {
            super();
            this.tag = tag;
            this.children = [];
            this.attrs = {};
        }
        append(...children) { this.children.push(...children); }
        replaceChildren(...children) { this.children = children; }
        setAttribute(name, value) { this.attrs[name] = value; }
        setCustomValidity(value) { this.validationMessage = value; }
    }
    globalThis.document = { createElement: tag => new Element(tag) };
    globalThis.Option = class { constructor(text, value) { Object.assign(this, { text, value }); } };
    t.after(() => { delete globalThis.document; delete globalThis.Option; });
    const root = new Element('div');
    let saved;
    mountMetadataEditor(root, () => ({ conditions: [{ type: 'stat', path: 'stat_data.', op: 'eq', value: '' }] }),
        metadata => { saved = metadata; });
    function find(node, label) {
        if (node.attrs?.['aria-label'] === label) return node;
        for (const child of node.children ?? []) {
            const item = find(child, label);
            if (item) return item;
        }
    }
    function edit(label, value, event) {
        const field = find(root, '条件 1 ' + label);
        assert.ok(field, label);
        field.value = value;
        field.dispatchEvent(new Event(event));
        return field;
    }
    edit('stat_data.路径', 'stat_data.场景.回合', 'input');
    edit('运算符', 'gte', 'change');
    edit('值类型', 'number', 'change');
    const value = edit('比较值', '0', 'input');
    assert.deepEqual(saved.conditions[0], { type: 'stat', path: 'stat_data.场景.回合', op: 'gte', value: 0 });
    assert.equal(value.validationMessage, '');
    edit('比较值', '', 'input');
    assert.equal(saved.conditions[0].value, '');
    assert.ok(value.validationMessage);
});

test('the last-turn display counts group reports without revealing candidate IDs or repeating adoption labels', t => {
    class Element extends EventTarget {
        children = [];
        append(...children) { this.children.push(...children); }
        replaceChildren(...children) { this.children = children; }
        setAttribute() {}
    }
    globalThis.document = { createElement: () => new Element() };
    globalThis.Option = class { constructor(text, value) { Object.assign(this, { text, value }); } };
    t.after(() => { delete globalThis.document; delete globalThis.Option; });
    const candidateId = 'c0000000-0000-0000-0000-000000000001';
    const unconfirmedId = 'c0000000-0000-0000-0000-000000000002';
    const ctx = { chatMetadata: {}, extensionSettings: { [SETTINGS_KEY]: { groups: [] } }, chat: [{
        is_user: true, extra: { [SETTINGS_KEY]: {
            narrative: { injected: true },
            rolls: [{ candidateId, ruleName: '回访', sides: 1, result: 1, reason: 'selected' },
                { candidateId: unconfirmedId, ruleName: '纸张', sides: 1, result: 1, reason: 'selected' }],
        } },
    }, ...[1, 2].map(uid => ({ mes: '一段正文', extra: { [NARRATIVE_KEY]: {
        uid, swipes: { 0: { report: { uses: [{ candidateId, status: 'adopted' }] } } },
    } } }))] };
    const panel = new Element();
    mountNarrativeUI({ querySelector: () => panel }, () => ctx);
    const lines = panel.children.map(element => element.textContent).filter(Boolean);
    assert.ok(lines.some(line => line.includes('已收到 2 条 AI 回报')));
    assert.equal(lines.filter(line => line.includes('回访 ·')).join('').match(/AI 报告采用/g).length, 1);
    assert.ok(lines.some(line => line.includes('纸张 ·') && line.includes('未确认')));
    assert.ok(!lines.some(line => line.includes(candidateId) || line.includes(unconfirmedId) || line.includes('adopted')));
});
