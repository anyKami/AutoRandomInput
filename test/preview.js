import { SETTINGS_KEY, THEMES, activeGroup, createGroup, createRule, normalizeSettings } from '../core.js';
import { SKILL_GROUPS_KEY } from '../skill-groups.js';

const key = 'ari-isolated-preview-v2';
const initial = normalizeSettings(JSON.parse(localStorage.getItem(key) ?? 'null'));
if (!localStorage.getItem(key)) {
    initial.enabled = true;
    const group = activeGroup(initial);
    group.name = '冒险 · 不期而遇';
    const rule = group.rules[0];
    rule.name = '剧情变化';
    rule.diceSides = 6;
    rule.commands = [
        '让一位意料之外的访客走进当前场景，并自然地加入对话。',
        '描写一个容易被忽略的环境细节，让它成为接下来的线索。',
        '让角色流露一点与表面态度不同的真实想法。',
        '引入一个小小的意外，为当前互动增加变化，但保持情节自然。',
        '放慢叙事节奏，用动作和神态表现人物之间的微妙关系。',
        '让故事出现一个需要选择的岔路，把决定留给用户。',
        '第七条保存的命令', '第八条保存的命令', '第九条保存的命令', '第十条保存的命令',
    ];
    group.rules.push(createRule('情绪氛围', { diceSides: 4, commands: [
        '让对话的氛围更加轻松，用自然的幽默拉近人物之间的距离。',
        '增加一点含蓄的紧张感，用停顿与眼神交流来表现。',
        '让人物坦诚地表达此刻的感受，保持情绪变化自然。',
        '为场景增添温暖的细节，展现人物彼此关心的一面。',
    ] }), createRule('叙事节奏', { enabled: false, diceSides: 3, commands: [
        '加快叙事节奏，推动情节进入下一个自然的节点。',
        '放慢节奏，细致描写动作与环境之间的互动。',
        '保持当前节奏，为用户的下一次回应留下空间。',
    ] }));
    initial.includeRollResult = true;
    initial.groups.push(createGroup('日常 · 细水长流'), createGroup('战斗 · 瞬息万变'));
}

const listeners = new Map();
const hooks = [];
let saves = 0;
const skillPreview = new URLSearchParams(location.search).has('skills');
let previewChat = 1;
const loadMetadata = id => JSON.parse(localStorage.getItem(`${key}:chat-${id}`) ?? '{}');
const skillChat = () => [{ is_user: false, is_system: false, mes: `技能配置组测试聊天 ${previewChat}，不连接模型。`, extra: {} }];
const ctx = {
    extensionSettings: { [SETTINGS_KEY]: initial, [SKILL_GROUPS_KEY]: JSON.parse(localStorage.getItem(`${key}:skill-groups`) ?? 'null') },
    chat: skillPreview ? skillChat() : [], chatMetadata: loadMetadata(previewChat),
    eventTypes: { APP_READY: 'ready', MESSAGE_SENT: 'sent', CHAT_CHANGED: 'chat', GENERATION_STARTED: 'generation', GENERATION_AFTER_COMMANDS: 'before' },
    eventSource: {
        on(type, fn) { const list = listeners.get(type) ?? []; list.push(fn); listeners.set(type, list); },
        makeFirst(type, fn) { const list = listeners.get(type) ?? []; list.unshift(fn); listeners.set(type, list); },
        async emit(type, ...args) { for (const fn of listeners.get(type) ?? []) await fn(...args); },
    },
    saveSettingsDebounced() {
        localStorage.setItem(key, JSON.stringify(ctx.extensionSettings[SETTINGS_KEY]));
        localStorage.setItem(`${key}:skill-groups`, JSON.stringify(ctx.extensionSettings[SKILL_GROUPS_KEY] ?? { groups: [] }));
    },
    saveMetadataDebounced() { localStorage.setItem(`${key}:chat-${previewChat}`, JSON.stringify(ctx.chatMetadata)); },
    async saveChat() { document.getElementById('save-count').textContent = `聊天保存 ${++saves} 次`; },
    updateMessageBlock(id) {
        if (!document.querySelector(`#chat .mes[mesid="${id}"]`)) throw new Error('消息节点尚未渲染');
        renderMessage(id);
    },
    messageFormatter: { stage: { BEFORE_REGEX: 'beforeRegex' }, addHook(fn) { hooks.push(fn); } },
};
globalThis.SillyTavern = { getContext: () => ctx };
globalThis.toastr = { error: message => { document.getElementById('test-results').hidden = false; document.getElementById('test-results').textContent += `错误：${message}\n`; } };

function renderMessage(id) {
    const message = ctx.chat[id];
    let element = document.getElementById(`preview-message-${id}`);
    if (!element) {
        element = document.createElement('article');
        element.id = `preview-message-${id}`;
        element.className = 'preview-message mes';
        element.setAttribute('mesid', String(id));
        element.innerHTML = '<div class="preview-rendered"></div><details><summary>实际发送内容（原始消息）</summary><pre></pre></details>';
        document.getElementById('preview-chat').append(element);
    }
    let text = message.mes;
    for (const hook of hooks) text = hook(text, { isUser: message.is_user, messageId: id });
    element.querySelector('.preview-rendered').textContent = text;
    element.querySelector('pre').textContent = message.mes;
}

async function send(text = document.getElementById('send_textarea').value) {
    if (!text.trim()) return;
    const input = document.getElementById('send_textarea');
    input.value = text;
    await ctx.eventSource.emit('before', 'normal', {}, false);
    ctx.chat.push({ is_user: true, is_system: false, mes: input.value, extra: {} });
    const id = ctx.chat.length - 1;
    await ctx.eventSource.emit('sent', id);
    renderMessage(id);
    document.getElementById('send_textarea').value = '';
}
// Register before the extension to verify its priority over an already loaded recall handler.
ctx.eventSource.on('before', () => {
    if (!document.getElementById('preview-recall').checked) return;
    const input = document.getElementById('send_textarea');
    const query = document.getElementById('preview-recall-input');
    query.hidden = false;
    query.textContent = `召回读取的本轮输入：\n${input.value}`;
    input.value = `<本轮用户输入>\n${input.value}\n</本轮用户输入>\n\n<recall>这是模拟召回结果。</recall>`;
});
document.getElementById('send_but').addEventListener('click', () => send());
document.getElementById('send_textarea').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
});
document.getElementById('preview-regenerate').addEventListener('click', () => ctx.eventSource.emit('generation', 'regenerate'));
document.getElementById('preview-switch-chat').hidden = !skillPreview;
document.getElementById('preview-switch-chat').addEventListener('click', async () => {
    ctx.saveMetadataDebounced(); previewChat = previewChat === 1 ? 2 : 1;
    ctx.chatMetadata = loadMetadata(previewChat); ctx.chat = skillChat();
    document.getElementById('preview-chat').replaceChildren();
    ctx.chat.forEach((_, id) => renderMessage(id));
    await ctx.eventSource.emit('chat');
});

await import('../index.js');
await ctx.eventSource.emit('ready');
ctx.chat.forEach((_, id) => renderMessage(id));
document.getElementById('ari-menu-button')?.click();

document.getElementById('run-ui-tests').addEventListener('click', async () => {
    const output = document.getElementById('test-results');
    output.hidden = false;
    output.textContent = '';
    const backup = JSON.stringify(ctx.extensionSettings[SETTINGS_KEY]);
    const originalChat = ctx.chat;
    const originalRandom = Math.random;
    const originalRecall = document.getElementById('preview-recall').checked;
    const query = selector => document.querySelector(selector);
    const set = (selector, value, event = 'change') => {
        const element = query(selector);
        if (typeof value === 'boolean') element.checked = value; else element.value = value;
        element.dispatchEvent(new Event(event, { bubbles: true }));
    };
    const check = (name, condition) => { if (!condition) throw new Error(name); output.textContent += `PASS ${name}\n`; };
    try {
        ctx.chat = [];
        set('#preview-recall', false);
        ctx.extensionSettings[SETTINGS_KEY] = normalizeSettings();
        document.getElementById('preview-chat').replaceChildren();
        query('#ari-menu-button').click();
        set('#ari-sides', '10');
        set('#ari-command-9', '隐藏槽位保留验证', 'input');
        set('#ari-sides', '6');
        check('d6 只渲染六个输入框', document.querySelectorAll('.ari-command-card').length === 6 && !query('#ari-command-6'));
        set('#ari-sides', '10');
        check('恢复 d10 时隐藏内容未丢失', query('#ari-command-9').value === '隐藏槽位保留验证');
        set('#ari-sides', '6');
        query('[data-group-action="copy"]').click();
        set('#ari-group-name', '界面检查副本', 'input');
        query('#ari-group-confirm').click();
        const copiedGroup = activeGroup(ctx.extensionSettings[SETTINGS_KEY]);
        check('复制包含骰子面数和隐藏槽位', copiedGroup.rules[0].diceSides === 6 && copiedGroup.rules[0].commands[9] === '隐藏槽位保留验证');
        query('[data-group-action="rename"]').click();
        set('#ari-group-name', ctx.extensionSettings[SETTINGS_KEY].groups[0].name, 'input');
        query('#ari-group-confirm').click();
        check('重复名称被拒绝', query('#ari-group-error').textContent.includes('已被使用'));
        query('#ari-group-cancel').click();
        set('#ari-enabled', true);
        set('#ari-stealth', false);
        set('#ari-rule-name', '剧情', 'input');
        set('#ari-command-5', '剧情命令 $&', 'input');
        query('#ari-add-rule').click();
        set('#ari-rule-name', '情绪', 'input');
        set('#ari-sides', '4');
        set('#ari-command-0', '情绪命令', 'input');
        check('同组多套骰子有独立面数与命令', copiedGroup.rules.length === 2 && copiedGroup.rules[0].diceSides === 6 && copiedGroup.rules[1].diceSides === 4 && copiedGroup.rules[0].commands[5] === '剧情命令 $&');
        set('#ari-include-result', true);
        const values = [0.999, 0];
        Math.random = () => values.shift();
        await send('第一条测试消息');
        const first = ctx.chat[0];
        check('每套骰子独立投掷且按顺序追加', first.extra[SETTINGS_KEY].rolls.map(roll => roll.result).join(',') === '6,1' && first.mes.indexOf('剧情命令') < first.mes.indexOf('情绪命令'));
        check('投掷结果紧跟各自命令', first.mes.includes('剧情命令 $&\n> （投掷结果：d6 = 6）') && first.mes.includes('情绪命令\n> （投掷结果：d4 = 1）'));
        check('可见模式显示选中的命令', query('#preview-message-0 .preview-rendered').textContent.includes('剧情命令 $&'));
        check('结果面板列出每套骰子的结果', query('#ari-last-rolls').children.length === 2);
        Math.random = () => 0;
        set('#ari-stealth', true);
        set('#ari-include-result', false);
        await send('第二条测试消息');
        check('隐身模式只隐藏显示，关闭结果附加生效', query('#preview-message-1 .preview-rendered').textContent === '第二条测试消息' && ctx.chat[1].mes.includes('情绪命令') && !ctx.chat[1].mes.includes('投掷结果'));
        check('历史清理同时更新消息和界面', ctx.chat[0].mes === '第一条测试消息' && query('#preview-message-0 .preview-rendered').textContent === '第一条测试消息');
        const saved = JSON.stringify(ctx.chat);
        await ctx.eventSource.emit('sent', 1);
        await ctx.eventSource.emit('generation', 'regenerate');
        await ctx.eventSource.emit('generation', 'continue');
        check('重复事件、重新生成与续写不重投', JSON.stringify(ctx.chat) === saved);
        set('#ari-rule-list .ari-rule-row:first-child input', false);
        set('#ari-command-0', ' ', 'input');
        await send('空白命令测试');
        check('空白命令跳过且清理旧命令', ctx.chat[2].mes === '空白命令测试' && ctx.chat[1].mes === '第二条测试消息');
        check('暂停的骰子不参与投掷', ctx.chat[2].extra[SETTINGS_KEY].rolls.length === 1 && ctx.chat[2].extra[SETTINGS_KEY].rolls[0].ruleName === '情绪');
        const backgrounds = new Set();
        for (const theme of Object.keys(THEMES)) {
            set('#ari-theme', theme);
            backgrounds.add(getComputedStyle(query('#ari-workbench')).backgroundColor);
        }
        check('五种主题分别改变背景并保存选择', backgrounds.size === 5 && JSON.parse(localStorage.getItem(key)).theme === 'paper');
        query('#ari-rule-list .ari-rule-select').click();
        query('#ari-copy-rule').click();
        check('复制骰子指令保留隐藏内容且身份独立', copiedGroup.rules[2].commands[9] === '隐藏槽位保留验证' && copiedGroup.rules[2].id !== copiedGroup.rules[0].id);
        query('#ari-delete-rule').click();
        query('#ari-group-confirm').click();
        check('删除单套骰子不影响其他指令', copiedGroup.rules.length === 2 && copiedGroup.rules[1].commands[0] === ' ');
        query('#ari-delete-rule').click();
        query('#ari-group-confirm').click();
        check('每组至少保留一套骰子指令', copiedGroup.rules.length === 1 && query('#ari-delete-rule').disabled);
        check('设置已自动持久化', JSON.parse(localStorage.getItem(key)).activeGroupId === ctx.extensionSettings[SETTINGS_KEY].activeGroupId);
        query('[data-group-action="delete"]').click();
        query('#ari-group-confirm').click();
        check('删除当前组后选择有效，最后一组受到保护', ctx.extensionSettings[SETTINGS_KEY].groups.some(group => group.id === ctx.extensionSettings[SETTINGS_KEY].activeGroupId) && query('#ari-delete-group').disabled);
        query('#ari-add-sample').click();
        const sample = activeGroup(ctx.extensionSettings[SETTINGS_KEY]);
        check('样板组依次包含自动肘击 d1、进展 d6、情绪 d4、节奏 d3', sample.rules.map(rule => rule.diceSides).join(',') === '1,6,4,3' && sample.rules.reduce((count, rule) => count + rule.commands.filter(text => text.trim()).length, 0) === 14);
        query('#ari-add-sample').click();
        const secondSample = activeGroup(ctx.extensionSettings[SETTINGS_KEY]);
        check('重复添加样板生成独立组，不覆盖原有组', secondSample.id !== sample.id && secondSample.name !== sample.name && ctx.extensionSettings[SETTINGS_KEY].groups.length === 3);
        set('#ari-stealth', false);
        set('#preview-recall', true);
        await send('召回顺序测试');
        const recalled = ctx.chat.at(-1);
        check('召回读取前已追加完整的自动肘击内容', secondSample.rules[0].commands[0].split('\n').every(line => query('#preview-recall-input').textContent.includes(line)));
        check('最终消息先放本轮指令，再放召回结果，正文不含 ARI 标记', recalled.mes.indexOf('本轮指令') >= 0 && recalled.mes.indexOf('本轮指令') < recalled.mes.indexOf('</本轮用户输入>') && recalled.mes.indexOf('</本轮用户输入>') < recalled.mes.indexOf('<recall>') && !recalled.mes.includes('<!--'));
        output.textContent += '\n全部界面检查通过。';
    } catch (error) { output.textContent += `FAIL ${error.message}\n${error.stack}`; }
    finally {
        Math.random = originalRandom;
        query('#preview-recall').checked = originalRecall;
        query('#preview-recall-input').hidden = true;
        ctx.extensionSettings[SETTINGS_KEY] = JSON.parse(backup);
        ctx.chat = originalChat;
        ctx.saveSettingsDebounced();
        document.getElementById('preview-chat').replaceChildren();
        ctx.chat.forEach((_, id) => renderMessage(id));
        query('#ari-workbench').close();
    }
});
