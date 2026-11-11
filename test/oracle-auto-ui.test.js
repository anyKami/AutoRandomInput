import assert from 'node:assert/strict';
import test from 'node:test';
import { SETTINGS_KEY } from '../core.js';
import { AUTO_ORACLE_KEY, autoOracleState } from '../oracle-auto-state.js';
import { mountAutoOracleUI } from '../oracle-auto-ui.js';

function fixture({ chat = [{}] } = {}) {
    class Element extends EventTarget {
        _value = ''; checked = false; hidden = false; disabled = false; dataset = {};
        get value() { return this._value; }
        set value(value) { this._value = String(value); }
        textContent = ''; open = false;
        focus() {}
        showModal() { this.open = true; }
        close() { this.open = false; }
        reportValidity() { return this.value.trim() !== '' && Number(this.value) >= 1; }
    }
    const nodes = new Map();
    const node = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
    const dialog = new Element(); dialog.querySelector = id => node(id.replace('#ari-auto-oracle-', ''));
    const ctx = { chat, chatMetadata: {}, extensionSettings: { [SETTINGS_KEY]: { enabled: false } } };
    const calls = [];
    let ui;
    const controller = {
        state: () => autoOracleState(ctx), busy: false, pending: false,
        start(values) {
            calls.push(['start', values]);
            ctx.chatMetadata[AUTO_ORACLE_KEY] = { ...controller.state(), ...values, enabled: true };
            ui.refresh();
        },
        stop() {
            calls.push(['stop']); ctx.chatMetadata[AUTO_ORACLE_KEY].enabled = false; ui.refresh();
        },
        update(values) {
            calls.push(['update', values]); Object.assign(ctx.chatMetadata[AUTO_ORACLE_KEY], values); ui.refresh();
        },
    };
    ui = mountAutoOracleUI(dialog, () => ctx, controller);
    const fire = (id, type) => node(id).dispatchEvent(new Event(type, { cancelable: true }));
    const enable = () => { node('enabled').checked = true; fire('enabled', 'change'); };
    const accept = () => fire('confirm-ok', 'click');
    return { node, fire, enable, accept, ctx, calls, dialog, ui };
}

test('no chat disables the switch without enabling or calling anything', () => {
    const h = fixture({ chat: [] });
    assert.equal(h.node('enabled').disabled, true);
    assert.equal(h.node('form').hidden, true);
    assert.deepEqual(h.calls, []);
});

test('declining the API notice leaves the feature off and never starts a request', () => {
    const h = fixture(); h.enable();
    assert.equal(h.node('confirm').open, true);
    h.fire('confirm-cancel', 'click');
    assert.equal(h.node('confirm').open, false);
    assert.equal(h.node('enabled').checked, false);
    assert.equal(h.node('form').hidden, true);
    assert.equal(h.ctx.chatMetadata[AUTO_ORACLE_KEY], undefined);
    assert.deepEqual(h.calls, []);
});

test('accepting the notice waits for the prompt and start button before making the first request', () => {
    const h = fixture(); h.enable();
    assert.equal(h.node('form').hidden, true);
    assert.deepEqual(h.calls, []);
    h.accept();
    assert.equal(h.node('form').hidden, false);
    assert.equal(h.node('enabled').checked, false);
    h.node('interval').value = '3'; h.node('prompt').value = '围绕刚才的争执生成指令。';
    h.fire('prompt', 'input');
    assert.deepEqual(h.calls, []);
    h.fire('form', 'submit');
    assert.deepEqual(h.calls, [['start', { interval: 3, prompt: '围绕刚才的争执生成指令。' }]]);
    assert.equal(h.node('enabled').checked, true);
    assert.equal(h.node('start-actions').hidden, true);
    h.fire('form', 'submit');
    assert.equal(h.calls.length, 1);
});

for (const action of ['cancel', 'close', 'switch']) test(`${action} abandons unfinished setup without calling the API`, () => {
    const h = fixture(); h.enable(); h.accept(); h.node('prompt').value = '未保存的要求';
    if (action === 'cancel') h.fire('setup-cancel', 'click');
    if (action === 'close') h.dialog.dispatchEvent(new Event('close'));
    if (action === 'switch') { h.ctx.chatMetadata = {}; h.ui.refresh(); }
    assert.deepEqual(h.calls, []);
    assert.equal(h.node('form').hidden, true);
    assert.equal(h.node('prompt').value, '');
});

test('invalid interval cannot enable the feature; active edits do not start another request', () => {
    const h = fixture(); h.enable(); h.accept(); h.node('interval').value = '0'; h.fire('form', 'submit');
    assert.deepEqual(h.calls, []);
    assert.match(h.node('result').textContent, /整数/);
    h.node('interval').value = '2'; h.fire('form', 'submit');
    h.node('prompt').value = '之后的要求'; h.fire('prompt', 'input');
    h.node('interval').value = '4'; h.fire('interval', 'change');
    assert.equal(h.calls.filter(([name]) => name === 'start').length, 1);
    assert.deepEqual(h.calls.at(-1), ['update', { interval: 4, prompt: '之后的要求' }]);
    h.dialog.dispatchEvent(new Event('close'));
    assert.equal(h.calls.filter(([name]) => name === 'stop').length, 0);
});

test('turning off stops automatic generation and re-enabling asks again', () => {
    const h = fixture(); h.enable(); h.accept(); h.fire('form', 'submit');
    h.node('enabled').checked = false; h.fire('enabled', 'change');
    assert.equal(h.calls.at(-1)[0], 'stop');
    h.enable();
    assert.equal(h.node('confirm').open, true);
    assert.equal(h.calls.filter(([name]) => name === 'start').length, 1);
});
