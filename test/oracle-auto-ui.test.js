import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DICE_SIDES, SETTINGS_KEY } from '../core.js';
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
        reportValidity() {
            const value = Number(this.value);
            return Number.isSafeInteger(value) && value >= 1 && value <= this.max;
        }
        max = Infinity;
    }
    const nodes = new Map();
    const node = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
    node('rule-count').max = 10;
    node('command-count').max = 100;
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

test('automatic form exposes the supported dice, mapping choices and numeric bounds', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const dice = html.match(/id="ari-auto-oracle-dice-sides">([^<]*(?:<option[^>]*>[^<]*<\/option>)*)<\/select>/)[1];
    assert.deepEqual([...dice.matchAll(/<option value="(\d+)"/g)].map(match => Number(match[1])), DICE_SIDES);
    assert.match(dice, /value="20" selected/);
    assert.match(html, /id="ari-auto-oracle-command-count"[^>]*min="1"[^>]*max="100"[^>]*value="10"/);
    assert.match(html, /id="ari-auto-oracle-rule-count"[^>]*min="1"[^>]*max="10"[^>]*value="3"/);
    assert.match(html, /id="ari-auto-oracle-mapping">\s*<option value="first"[^>]*>[^<]*<\/option>\s*<option value="even"/);
});

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
    h.node('command-count').value = '4'; h.node('rule-count').value = '2';
    h.node('dice-sides').value = '6'; h.node('mapping').value = 'even';
    h.fire('prompt', 'input');
    assert.deepEqual(h.calls, []);
    h.fire('form', 'submit');
    assert.deepEqual(h.calls, [['start', { interval: 3, prompt: '围绕刚才的争执生成指令。', commandCount: 4, ruleCount: 2, diceSides: 6, mapping: 'even' }]]);
    assert.equal(h.node('enabled').checked, true);
    assert.equal(h.node('start-actions').hidden, true);
    h.fire('form', 'submit');
    assert.equal(h.calls.length, 1);
});

for (const action of ['cancel', 'close', 'switch']) test(`${action} abandons unfinished setup without calling the API`, () => {
    const h = fixture(); h.enable(); h.accept(); h.node('prompt').value = '未保存的要求';
    h.node('command-count').value = '4'; h.node('rule-count').value = '2';
    h.node('dice-sides').value = '6'; h.node('mapping').value = 'even';
    if (action === 'cancel') h.fire('setup-cancel', 'click');
    if (action === 'close') h.dialog.dispatchEvent(new Event('close'));
    if (action === 'switch') { h.ctx.chatMetadata = {}; h.ui.refresh(); }
    assert.deepEqual(h.calls, []);
    assert.equal(h.node('form').hidden, true);
    assert.equal(h.node('prompt').value, '');
    assert.equal(h.node('command-count').value, '10');
    assert.equal(h.node('rule-count').value, '3');
    assert.equal(h.node('dice-sides').value, '20');
    assert.equal(h.node('mapping').value, 'first');
});

test('invalid interval cannot enable the feature; active edits do not start another request', () => {
    const h = fixture(); h.enable(); h.accept(); h.node('interval').value = '0'; h.fire('form', 'submit');
    assert.deepEqual(h.calls, []);
    assert.match(h.node('result').textContent, /整数/);
    h.node('interval').value = '2'; h.fire('form', 'submit');
    h.node('prompt').value = '之后的要求'; h.fire('prompt', 'input');
    h.node('interval').value = '4'; h.fire('interval', 'change');
    assert.equal(h.calls.filter(([name]) => name === 'start').length, 1);
    assert.deepEqual(h.calls.at(-1), ['update', { interval: 4, prompt: '之后的要求', commandCount: 10, ruleCount: 3, diceSides: 20, mapping: 'first' }]);
    h.dialog.dispatchEvent(new Event('close'));
    assert.equal(h.calls.filter(([name]) => name === 'stop').length, 0);
});

test('active dice controls validate and forward changes without starting again', () => {
    const h = fixture(); h.enable(); h.accept(); h.fire('form', 'submit');
    h.node('dice-sides').value = '6'; h.fire('dice-sides', 'change');
    assert.equal(h.calls.length, 1);
    assert.match(h.node('result').textContent, /骰子面数/);
    h.node('command-count').value = '4'; h.fire('command-count', 'change');
    h.node('rule-count').value = '11'; h.fire('rule-count', 'change');
    assert.equal(h.calls.length, 2);
    assert.match(h.node('result').textContent, /骰子数量/);
    h.node('rule-count').value = '2'; h.fire('rule-count', 'change');
    h.node('mapping').value = 'even'; h.fire('mapping', 'change');
    h.node('dice-sides').value = '100'; h.fire('dice-sides', 'change');
    assert.equal(h.calls.filter(([name]) => name === 'start').length, 1);
    assert.deepEqual(h.calls.at(-1), ['update', { interval: 5, prompt: '', commandCount: 4, ruleCount: 2, diceSides: 100, mapping: 'even' }]);
});

test('turning off stops automatic generation and re-enabling asks again', () => {
    const h = fixture(); h.enable(); h.accept(); h.fire('form', 'submit');
    h.node('enabled').checked = false; h.fire('enabled', 'change');
    assert.equal(h.calls.at(-1)[0], 'stop');
    h.enable();
    assert.equal(h.node('confirm').open, true);
    assert.equal(h.calls.filter(([name]) => name === 'start').length, 1);
});
