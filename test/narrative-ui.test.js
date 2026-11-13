import assert from 'node:assert/strict';
import test from 'node:test';
import { mountMetadataEditor } from '../narrative-ui.js';
import { SETTINGS_KEY } from '../core.js';
import { NARRATIVE_KEY, foldNarrative } from '../narrative.js';
import { mountNarrativePanel, visibleTurnReports } from '../narrative-panel.js';

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

function panelFixture(t) {
    const document = Object.assign(new EventTarget(), { activeElement: null, createTextNode: textContent => ({ textContent }) });
    class Element extends EventTarget {
        constructor(tag) {
            super();
            this.tagName = tag.toUpperCase();
            this.children = [];
            this.attrs = {};
            this.dataset = {};
            this.scrollTop = 0;
            this.classList = { add() {} };
        }
        append(...children) { this.children.push(...children); }
        replaceChildren(...children) { this.children = children; }
        setAttribute(name, value) { this.attrs[name] = value; }
        querySelectorAll() { return this.all(node => node.dataset?.storyDetails); }
        all(filter) { return this.children.flatMap(node => [ ...(filter(node) ? [node] : []), ...(node.all?.(filter) ?? []) ]); }
        contains(node) { return node === this || this.all(child => child === node).length > 0; }
        focus() { document.activeElement = this; }
    }
    document.createElement = tag => new Element(tag);
    globalThis.document = document;
    globalThis.Option = class { constructor(text, value) { Object.assign(this, { text, value }); } };
    t.after(() => { delete globalThis.document; delete globalThis.Option; });
    const panel = new Element('div');
    const groups = ['A','B'].map(id => ({ id, name: id === 'B' ? '完整场景配置组名称·隔离验证' : id, rules: [
        { name: '线索', diceSides: 1, commands: ['蓝签 ' + id], enabled: true },
    ] }));
    const store = { groups, activeGroupId: 'A', enabled: true };
    const chat = [];
    const turn = { turnId:'turn', baseRevision:foldNarrative(chat).revision, newThreadId:'thread', candidates:['candidate'], injected:true };
    const report = { version:1, turnId:turn.turnId, baseRevision:turn.baseRevision, uses:[{candidateId:'candidate',status:'adopted'}],
        updates:[], newThread:{ title:'蓝签', cause:'发现蓝签', question:'谁留下的？', evidence:'他捡起蓝签。' } };
    chat.push({is_user:true, extra:{[SETTINGS_KEY]:{narrative:turn,rolls:[
        {candidateId:'candidate',ruleName:'回访',result:1,sides:1,reason:'selected',command:'追查蓝签'},
        {candidateId:'unconfirmed',ruleName:'纸张',result:1,sides:1,reason:'selected',command:'追查蓝签'},
    ]}}}, ...[1,2].map(uid => ({mes:'他捡起蓝签。',swipe_id:0,extra:{[NARRATIVE_KEY]:{uid,swipes:{0:{report},1:{report:{...report,turnId:'stale'}}}}}})));
    let ctx = { chatId:'chat-a', groupId:'group', characterId:1, chat, chatMetadata:{}, extensionSettings:{[SETTINGS_KEY]:store}, saveChat() { saved++; } };
    let saved = 0, opened = 0;
    const api = mountNarrativePanel({ querySelector: () => panel }, () => ctx, () => {}, {openAutoSettings: () => { opened++; }});
    const button = text => panel.all(node => node.tagName === 'BUTTON' && node.textContent === text)[0];
    const field = name => panel.all(node => node.attrs?.['aria-label'] === name)[0];
    const action = text => { const item = button(text); assert.ok(item, text); item.dispatchEvent(new Event('click')); };
    const set = (name, value, event = 'change') => {
        const item = field(name); assert.ok(item, name); item.value = value; item.dispatchEvent(new Event(event)); return item;
    };
    return { panel, api, chat, report, store, field, set, action, button, document, saved: () => saved, opened: () => opened,
        cfg: () => ctx.chatMetadata[NARRATIVE_KEY], setConfig: values => { ctx.chatMetadata[NARRATIVE_KEY] = values; api.refresh(); }, changeSpeaker: () => { ctx.characterId++; api.refresh(); }, swap: () => { ctx = {...ctx,chatId:'chat-b',chatMetadata:{}}; api.refresh(); }};
}

test('settings bind distinct groups and limits without editing the library or starting generation', t => {
    const h = panelFixture(t), original = structuredClone(h.store);
    h.action('剧情设置');
    h.set('平时使用的随机指令','A');
    h.set('当前场景追加的随机指令（可选）','A');
    assert.equal(h.cfg().sceneGroupId, null);
    h.set('当前场景追加的随机指令（可选）','B');
    assert.equal(h.cfg().sceneGroupId, 'B');
    assert.ok(h.panel.all(node => node.textContent === '当前选择：完整场景配置组名称·隔离验证').length);
    assert.equal(h.cfg().sceneGroupRevision, h.cfg().sceneRevision);
    h.action('停用当前场景指令');
    assert.equal(h.cfg().sceneGroupId,'B');
    assert.notEqual(h.cfg().sceneGroupRevision,h.cfg().sceneRevision);
    h.action('重新启用本场景指令');
    assert.equal(h.cfg().sceneGroupId,'B');
    assert.equal(h.cfg().sceneGroupRevision,h.cfg().sceneRevision);
    assert.equal(h.panel.all(node => node.dataset?.storyDetails === 'group:longGroupId')[0].all(node => node.textContent === '蓝签 A').length,1);
    assert.deepEqual(h.store, original);
    for (const value of ['0','1','2','3']) {
        h.set('剧情推动指令上限',value);
        h.set('氛围描写指令上限',value);
        assert.equal(h.cfg().eventBudget,Number(value));
        assert.equal(h.cfg().detailBudget,Number(value));
    }
    h.set('关系','prefer');
    h.action('前往自动生成设置');
    assert.equal(h.opened(),1);
    h.action('返回剧情');
    h.action('下一次暂停随机剧情推动');
    assert.equal(h.cfg().quietNext,true);
    h.action('取消下一次暂停');
    assert.equal(h.cfg().quietNext,false);
    h.action('屏蔽关系');
    assert.deepEqual(h.cfg().blockedTopics,{relationship:5});
    assert.deepEqual(h.cfg().topicPreferences,{relationship:'prefer'});
    h.action('关系 · 剩余 5 次 · 撤销');
    assert.deepEqual(h.cfg().blockedTopics,{});
    assert.deepEqual(h.cfg().topicPreferences,{relationship:'prefer'});
    assert.equal(h.saved(),0);
});

test('correction keeps focus, draft and expansion across refresh and resets them on chat switch', async t => {
    const h = panelFixture(t);
    const expanded = () => h.panel.all(node => node.dataset?.storyDetails === 'correct:thread')[0];
    expanded().open = true;
    h.set('纠正对象','question');
    const input = h.set('纠正后的内容','新问题？','input');
    input.focus();
    h.api.refresh();
    assert.equal(h.document.activeElement,input);
    assert.equal(h.field('纠正后的内容'),input);
    h.document.activeElement = null;
    h.panel.dispatchEvent(new Event('focusout'));
    await new Promise(queueMicrotask);
    assert.equal(expanded().open,true);
    assert.equal(h.field('纠正后的内容').value,'新问题？');
    h.action('保存纠正');
    assert.equal(foldNarrative(h.chat).threads[0].question,'新问题？');
    assert.equal(h.saved(),1);
    h.set('纠正后的内容','未提交','input');
    h.action('剧情设置');
    h.swap();
    assert.equal(expanded().open,false);
    assert.equal(h.field('纠正后的内容').value,'');
    assert.equal(h.cfg(),undefined);
});

test('the last-turn display uses only current valid reports, keeps candidate IDs private and deduplicates statuses', t => {
    const h = panelFixture(t);
    const lines = () => h.panel.all(node => typeof node.textContent === 'string').map(node => node.textContent);
    assert.equal(visibleTurnReports(h.chat,0).length,2);
    assert.ok(lines().some(line => line.includes('已收到 2 条有效 AI 回报')));
    assert.ok(lines().some(line => line.includes('追查蓝签')));
    assert.equal(lines().find(line => line.includes('回访 ·')).match(/AI 报告采用/g).length,1);
    assert.ok(lines().some(line => line.includes('纸张 ·') && line.includes('未确认')));
    assert.ok(!lines().some(line => /candidate|adopted/.test(line)));
    h.chat[2].swipe_id = 1;
    h.api.refresh();
    assert.equal(visibleTurnReports(h.chat,0).length,1);
    assert.ok(lines().some(line => line.includes('已收到 1 条有效 AI 回报')));
    h.chat.unshift({mes:'不同分支的前序回复'});
    h.api.refresh();
    assert.equal(visibleTurnReports(h.chat,1).length,0);
    assert.ok(lines().some(line => line.includes('未确认采用情况')));
});

test('same group speaker changes preserve in-progress correction and current view', t => {
    const h = panelFixture(t);
    const correction = () => h.panel.all(node => node.dataset?.storyDetails === 'correct:thread')[0];
    correction().open = true;
    h.set('纠正后的内容','保存前草稿','input');
    h.panel.scrollTop = 81;
    h.changeSpeaker();
    assert.equal(h.panel.scrollTop,81);
    assert.equal(correction().open,true);
    assert.equal(h.field('纠正后的内容').value,'保存前草稿');
    h.swap();
    assert.equal(h.panel.scrollTop,0);
    assert.equal(correction().open,false);
    assert.equal(h.field('纠正后的内容').value,'');
});

test('the next-send status distinguishes disabled scheduling, disabled random and disabled recording', t => {
    const h = panelFixture(t);
    const shows = text => h.panel.all(node => typeof node.textContent === 'string' && node.textContent.includes(text)).length > 0;
    assert.ok(shows('剧情增强已关闭，当前不使用剧情增强调度'));
    assert.ok(shows('剧情增强关闭，记录不运行'));
    h.setConfig({ enabled:true, threadsEnabled:false, eventBudget:2, detailBudget:0 });
    assert.ok(shows('故事记录已关闭'));
    assert.ok(!shows('当前不使用剧情增强调度'));
    h.store.enabled = false;
    h.api.refresh();
    assert.ok(shows('随机指令总开关已关闭，本次不发送随机指令'));
    assert.ok(shows('开启后的上限'));
    h.setConfig({ enabled:true, threadsEnabled:true });
    assert.ok(shows('剧情记录等待 MVU'));
});

test('pending refresh leaves the original click target attached through blur and pointerup', async t => {
    const h = panelFixture(t);
    const transition = async (input, target, click) => {
        input.focus();
        h.api.refresh();
        h.panel.dispatchEvent(new Event('pointerdown'));
        h.document.activeElement = target;
        h.panel.dispatchEvent(new Event('focusout'));
        await new Promise(queueMicrotask);
        const up = new Event('pointerup');
        Object.defineProperty(up,'target',{value:target});
        h.document.dispatchEvent(up);
        await new Promise(queueMicrotask);
        assert.ok(h.panel.contains(target));
        click();
        h.panel.dispatchEvent(new Event('click'));
        await new Promise(queueMicrotask);
    };
    const draft = h.set('纠正后的内容','点一次就保存','input');
    const save = h.button('保存纠正');
    await transition(draft, save, () => save.dispatchEvent(new Event('click')));
    assert.equal(h.saved(),1);
    assert.equal(foldNarrative(h.chat).threads[0].cause,'点一次就保存');
    const correction = h.panel.all(node => node.dataset?.storyDetails === 'correct:thread')[0];
    const summary = correction.children[0];
    await transition(h.field('纠正后的内容'),summary,() => { correction.open = true; });
    assert.equal(h.panel.all(node => node.dataset?.storyDetails === 'correct:thread')[0].open,true);
    h.action('剧情设置');
    const back = h.button('返回剧情');
    await transition(h.field('内容要求'),back,() => back.dispatchEvent(new Event('click')));
    assert.ok(h.button('剧情设置'));
    assert.equal(h.saved(),1);
});
