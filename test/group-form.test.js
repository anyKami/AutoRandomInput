import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { activeGroup, createGroup, createRule, normalizeSettings, SETTINGS_KEY, uniqueGroupName } from '../core.js';
import { effectiveRandomSettings, selectRandomGroup } from '../oracle-auto-state.js';

// Run the real entry-point handlers without booting SillyTavern. The fixture only
// supplies host state and DOM fields; selection changes remain real store changes.
const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const handlers = source.slice(source.indexOf('function closeGroupForm('), source.indexOf('\nfunction bindUI('));

function fixture() {
    const store = normalizeSettings();
    const first = createGroup('配置 A');
    const second = createGroup('配置 B');
    first.rules.push(createRule('A 的第二套'));
    second.rules.push(createRule('B 的第二套'));
    store.groups = [first, second]; store.activeGroupId = first.id;
    const ctx = { extensionSettings: { [SETTINGS_KEY]: store }, chatMetadata: {} };
    const nodes = new Map();
    const node = selector => {
        if (!nodes.has(selector)) nodes.set(selector, { value: '', hidden: false, disabled: false, focus() {}, select() {} });
        return nodes.get(selector);
    };
    let saves = 0;
    const scope = {
        groupAction: null, selectedRuleId: first.rules[0].id,
        settings: () => store, context: () => ctx,
        currentGroup: () => activeGroup(effectiveRandomSettings(ctx)),
        selectedRule: () => {
            const group = scope.currentGroup();
            return group.rules.find(rule => rule.id === scope.selectedRuleId) ?? group.rules[0];
        },
        $: node, save() { saves++; }, render() {},
        createGroup, uniqueGroupName, selectRandomGroup,
    };
    vm.createContext(scope);
    vm.runInContext(handlers, scope, { filename: 'index.js:group-form' });
    return { store, first, second, node, scope, saves: () => saves,
        open: action => scope.openGroupForm(action),
        submit: () => scope.submitGroup({ preventDefault() {} }),
        switchTo: group => { selectRandomGroup(ctx, group.id); scope.selectedRuleId = group.rules[0].id; },
    };
}

test('group deletion keeps the confirmed target when selection changes before submit', () => {
    const h = fixture(); h.open('delete');
    assert.equal(h.node('#ari-group-form-label').textContent, '删除“配置 A”？');
    h.switchTo(h.second); h.submit();
    assert.deepEqual(h.store.groups.map(group => group.id), [h.second.id]);
    assert.equal(h.scope.currentGroup().id, h.second.id);
    assert.equal(h.saves(), 1);
});

test('rule deletion keeps both the original group and rule across a selection change', () => {
    const h = fixture(), removed = h.first.rules[0].id;
    const secondRules = h.second.rules.map(rule => rule.id);
    h.open('delete-rule'); h.switchTo(h.second); h.submit();
    assert.ok(!h.first.rules.some(rule => rule.id === removed));
    assert.deepEqual(h.second.rules.map(rule => rule.id), secondRules);
    assert.equal(h.scope.selectedRuleId, secondRules[0]);
});

test('rename and copy use the group selected when the form opened', () => {
    for (const action of ['rename', 'copy']) {
        const h = fixture();
        h.first.rules[0].commands[0] = 'A 的指令';
        h.second.rules[0].commands[0] = 'B 的指令';
        h.open(action); h.node('#ari-group-name').value = '已确认的名称';
        h.switchTo(h.second); h.submit();
        assert.equal(h.second.name, '配置 B');
        const changed = h.store.groups.find(group => group.name === '已确认的名称');
        assert.ok(changed);
        assert.equal(changed.rules[0].commands[0], 'A 的指令');
        if (action === 'copy') assert.notEqual(changed.id, h.first.id);
        else assert.equal(changed.id, h.first.id);
    }
});

test('a replaced rule invalidates confirmation without deleting a replacement', () => {
    const h = fixture(); h.open('delete-rule');
    h.first.rules = [createRule('后台更新 1'), createRule('后台更新 2')];
    const replacementIds = h.first.rules.map(rule => rule.id);
    h.submit();
    assert.deepEqual(h.first.rules.map(rule => rule.id), replacementIds);
    assert.equal(h.saves(), 0);
    assert.match(h.node('#ari-group-error').textContent, /重新/);
    assert.equal(h.node('#ari-group-confirm').disabled, true);
    h.open('delete-rule');
    assert.equal(h.node('#ari-group-confirm').disabled, false);
});

test('closing or invalidating a form prevents a delayed submit from mutating any group', () => {
    const h = fixture(); h.open('rename');
    h.node('#ari-group-name').value = '取消后不应创建的组';
    h.scope.closeGroupForm();
    h.switchTo(h.second); h.submit();
    assert.deepEqual(h.store.groups.map(group => group.id), [h.first.id, h.second.id]);
    assert.equal(h.saves(), 0);
});

test('a deleted group invalidates its open confirmation without falling back to the current group', () => {
    const h = fixture(); h.open('delete');
    const third = createGroup('配置 C');
    h.store.groups = [h.second, third]; h.switchTo(h.second);
    h.submit();
    assert.deepEqual(h.store.groups.map(group => group.id), [h.second.id, third.id]);
    assert.equal(h.saves(), 0);
    assert.equal(h.node('#ari-group-confirm').disabled, true);
    assert.match(h.node('#ari-group-error').textContent, /重新/);
});

test('confirmation cannot delete the last remaining group or rule', () => {
    const h = fixture(); h.store.groups = [h.first]; h.first.rules.length = 1;
    h.open('delete'); h.submit();
    h.open('delete-rule'); h.submit();
    assert.equal(h.store.groups.length, 1);
    assert.equal(h.first.rules.length, 1);
    assert.equal(h.saves(), 0);
});
