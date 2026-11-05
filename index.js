import { SETTINGS_KEY, THEMES, activeGroup, createGroup, createRule, createSampleGroup, displayMessage, normalizeSettings, processMessage, uniqueGroupName, uniqueName } from './core.js';

const context = () => SillyTavern.getContext();
const settings = () => context().extensionSettings[SETTINGS_KEY];
const save = () => context().saveSettingsDebounced();
let dialog;
let initialized = false;
let groupAction = '';
let selectedRuleId = '';
const $ = selector => dialog.querySelector(selector);
const selectedRule = () => {
    const group = activeGroup(settings());
    return group.rules.find(rule => rule.id === selectedRuleId) ?? group.rules[0];
};

function renderStatus() {
    const store = settings();
    $('#ari-enabled').checked = store.enabled;
    $('#ari-enabled-label').textContent = store.enabled ? '自动投掷已开启' : '自动投掷已关闭';
    $('#ari-stealth').checked = store.stealthMode;
    $('#ari-include-result').checked = store.includeRollResult;
    $('#ari-theme').value = store.theme;
    dialog.dataset.theme = store.theme;
    $('#ari-mode-hint').textContent = store.stealthMode ? '模型会收到命令，聊天正文中隐藏。' : '命令会显示在聊天正文末尾。';
}

function renderCounter() {
    const rule = selectedRule();
    const count = rule.commands.slice(0, rule.diceSides).filter(text => text.trim()).length;
    $('#ari-filled-count').textContent = `${rule.diceSides} 个编号 · ${count} 条已填写`;
}

function renderLastRoll() {
    if (!dialog) return;
    const chat = context().chat ?? [];
    const record = chat.findLast(message => message?.is_user && message.extra?.[SETTINGS_KEY])?.extra[SETTINGS_KEY];
    const rolls = record?.rolls ?? (record ? [{ ...record, ruleName: '骰子指令 1' }] : []);
    $('#ari-last-group').textContent = record ? `${record.groupName} · ${rolls.length} 次投掷` : '等待下一次发送';
    const list = $('#ari-last-rolls');
    list.replaceChildren();
    for (const roll of rolls) {
        const item = document.createElement('div');
        item.className = 'ari-roll-item';
        item.innerHTML = '<strong class="ari-roll-number"></strong><div><span></span><small></small></div>';
        item.querySelector('strong').textContent = String(roll.result).padStart(2, '0');
        item.querySelector('span').textContent = `${roll.ruleName} · d${roll.sides}`;
        item.querySelector('small').textContent = roll.skipped ? '空白，已跳过' : `命中第 ${roll.result} 条`;
        list.append(item);
    }
    if (record && !rolls.length) list.textContent = '本次没有启用的指令。';
    const group = activeGroup(settings());
    const rule = selectedRule();
    const hit = rolls.find(roll => roll.ruleId === rule.id);
    dialog.querySelectorAll('.ari-command-card').forEach(card => {
        card.dataset.hit = String(!!hit && !hit.skipped && record.groupId === group.id &&
            hit.sides === rule.diceSides && Number(card.dataset.index) + 1 === hit.result);
    });
}

function renderRules() {
    const group = activeGroup(settings());
    $('#ari-rule-count').textContent = `${group.rules.filter(rule => rule.enabled).length}/${group.rules.length} 启用`;
    const list = $('#ari-rule-list');
    list.replaceChildren();
    group.rules.forEach((rule, index) => {
        const row = document.createElement('div');
        row.className = 'ari-rule-row';
        row.dataset.active = String(rule.id === selectedRule().id);
        row.dataset.enabled = String(rule.enabled);
        row.innerHTML = '<button type="button" class="ari-rule-select"><span class="ari-small-die"></span><span class="ari-rule-label"></span></button><label class="ari-toggle"><input type="checkbox"><span class="ari-switch"></span></label>';
        row.querySelector('.ari-small-die').textContent = `D${rule.diceSides}`;
        row.querySelector('.ari-rule-label').textContent = rule.name || `骰子指令 ${index + 1}`;
        const button = row.querySelector('button');
        button.title = rule.name;
        button.setAttribute('aria-pressed', String(rule.id === selectedRule().id));
        button.addEventListener('click', () => { selectedRuleId = rule.id; closeGroupForm(); renderRules(); renderCommands(); });
        const checkbox = row.querySelector('input');
        checkbox.checked = rule.enabled;
        checkbox.setAttribute('aria-label', `启用骰子指令 ${index + 1}：${rule.name}`);
        checkbox.addEventListener('change', () => {
            rule.enabled = checkbox.checked;
            row.dataset.enabled = String(rule.enabled);
            $('#ari-rule-count').textContent = `${group.rules.filter(item => item.enabled).length}/${group.rules.length} 启用`;
            $('#ari-disabled-hint').hidden = selectedRule().enabled;
            save();
        });
        list.append(row);
    });
}

function renderCommands() {
    const rule = selectedRule();
    $('#ari-rule-name').value = rule.name;
    $('#ari-delete-rule').disabled = activeGroup(settings()).rules.length <= 1;
    $('#ari-delete-rule').title = activeGroup(settings()).rules.length <= 1 ? '至少保留一套骰子指令' : '删除当前骰子指令';
    $('#ari-disabled-hint').hidden = rule.enabled;
    $('#ari-sides').value = String(rule.diceSides);
    $('#ari-dice-label').textContent = `D${rule.diceSides}`;
    $('#ari-range').textContent = rule.diceSides === 1 ? '1' : `1–${rule.diceSides}`;
    $('#ari-probability').textContent = `${Number((100 / rule.diceSides).toFixed(2))}%`;
    const grid = $('#ari-command-grid');
    grid.replaceChildren();
    // Only render active slots. Every rule retains its own full ten-slot array.
    rule.commands.slice(0, rule.diceSides).forEach((text, index) => {
        const card = document.createElement('article');
        card.className = 'ari-command-card';
        card.dataset.index = String(index);
        card.innerHTML = `<div class="ari-card-heading"><span class="ari-card-number">${String(index + 1).padStart(2, '0')}</span><label for="ari-command-${index}">命令 ${index + 1}</label><span class="ari-card-state"></span></div><textarea id="ari-command-${index}" rows="3" placeholder="填写命中这个编号时要追加的命令…" spellcheck="false"></textarea>`;
        const input = card.querySelector('textarea');
        input.value = text;
        const update = () => {
            card.dataset.filled = String(!!input.value.trim());
            card.querySelector('.ari-card-state').textContent = input.value.trim() ? '已填写' : '空白跳过';
        };
        input.addEventListener('input', () => {
            rule.commands[index] = input.value;
            update();
            renderCounter();
            save();
        });
        update();
        grid.append(card);
    });
    const hint = $('#ari-hidden-hint');
    hint.hidden = rule.diceSides === 10;
    hint.textContent = `第 ${rule.diceSides === 9 ? '10' : `${rule.diceSides + 1}–10`} 条已收起，内容仍保留。调大骰子面数即可恢复。`;
    renderCounter();
    renderLastRoll();
}

function render() {
    const store = settings();
    $('#ari-group').replaceChildren(...store.groups.map(group => new Option(group.name, group.id)));
    $('#ari-group').value = store.activeGroupId;
    $('#ari-group-count').textContent = `${store.groups.length} 组`;
    $('#ari-delete-group').disabled = store.groups.length <= 1;
    $('#ari-delete-group').title = store.groups.length <= 1 ? '至少保留一个配置组' : '删除当前配置组';
    renderStatus();
    renderRules();
    renderCommands();
}

function closeGroupForm() {
    $('#ari-group-form').hidden = true;
    groupAction = '';
}

function openGroupForm(action) {
    groupAction = action;
    const group = activeGroup(settings());
    const labels = { new: '新建配置组', copy: '复制为新配置组', rename: '重命名配置组', delete: `删除“${group.name}”？`, 'delete-rule': `删除骰子指令“${selectedRule().name}”？` };
    $('#ari-group-form-label').textContent = labels[action];
    const input = $('#ari-group-name');
    const deleting = action === 'delete' || action === 'delete-rule';
    input.hidden = deleting;
    input.value = action === 'new' ? uniqueGroupName(settings(), '新配置组')
        : action === 'copy' ? uniqueGroupName(settings(), `${group.name} 副本`) : group.name;
    $('#ari-group-error').textContent = deleting ? (action === 'delete' ? '该组保存的全部骰子指令将被删除。' : '这套骰子指令及其全部命令将被删除。') : '';
    $('#ari-group-confirm').textContent = deleting ? '确认删除' : '确定';
    $('#ari-group-form').hidden = false;
    if (!deleting) { input.focus(); input.select(); }
    else $('#ari-group-cancel').focus();
}

function submitGroup(event) {
    event.preventDefault();
    const store = settings();
    const group = activeGroup(store);
    if (groupAction === 'delete-rule') {
        if (group.rules.length <= 1) return;
        group.rules = group.rules.filter(rule => rule.id !== selectedRule().id);
        selectedRuleId = group.rules[0].id;
    } else if (groupAction === 'delete') {
        if (store.groups.length <= 1) return;
        store.groups = store.groups.filter(item => item.id !== group.id);
        store.activeGroupId = store.groups[0].id;
    } else {
        const name = $('#ari-group-name').value.trim();
        if (!name) { $('#ari-group-error').textContent = '请输入配置组名称。'; return; }
        if (store.groups.some(item => item.name === name && (groupAction !== 'rename' || item.id !== group.id))) {
            $('#ari-group-error').textContent = '这个名称已被使用，请换一个。';
            return;
        }
        if (groupAction === 'rename') group.name = name;
        else {
            const next = createGroup(name, groupAction === 'copy' ? group : undefined);
            store.groups.push(next);
            store.activeGroupId = next.id;
        }
    }
    save();
    closeGroupForm();
    render();
    $('#ari-group').focus();
}

function bindUI() {
    for (let sides = 1; sides <= 10; sides++) $('#ari-sides').append(new Option(`d${sides}`, String(sides)));
    for (const [id, name] of Object.entries(THEMES)) $('#ari-theme').append(new Option(name, id));
    $('#ari-close').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
    $('#ari-enabled').addEventListener('change', event => { settings().enabled = event.target.checked; save(); renderStatus(); });
    $('#ari-stealth').addEventListener('change', event => { settings().stealthMode = event.target.checked; save(); renderStatus(); });
    $('#ari-include-result').addEventListener('change', event => { settings().includeRollResult = event.target.checked; save(); });
    $('#ari-theme').addEventListener('change', event => { settings().theme = event.target.value; save(); renderStatus(); });
    $('#ari-sides').addEventListener('change', event => { selectedRule().diceSides = Number(event.target.value); save(); renderRules(); renderCommands(); });
    $('#ari-group').addEventListener('change', event => { settings().activeGroupId = event.target.value; selectedRuleId = ''; closeGroupForm(); save(); renderRules(); renderCommands(); });
    $('#ari-rule-name').addEventListener('input', event => { selectedRule().name = event.target.value; save(); renderRules(); });
    $('#ari-rule-name').addEventListener('change', event => {
        selectedRule().name = event.target.value.trim() || '未命名指令';
        event.target.value = selectedRule().name;
        save(); renderRules();
    });
    const addRule = copy => {
        const group = activeGroup(settings());
        const rule = createRule(uniqueName(group.rules, copy ? `${selectedRule().name} 副本` : '新骰子指令'), copy ? selectedRule() : undefined);
        group.rules.push(rule);
        selectedRuleId = rule.id;
        closeGroupForm(); save(); renderRules(); renderCommands();
        $('#ari-rule-name').focus(); $('#ari-rule-name').select();
    };
    $('#ari-add-rule').addEventListener('click', () => addRule(false));
    $('#ari-add-sample').addEventListener('click', () => {
        const store = settings();
        const group = createSampleGroup();
        group.name = uniqueGroupName(store, group.name);
        store.groups.push(group);
        store.activeGroupId = group.id;
        selectedRuleId = group.rules[0].id;
        closeGroupForm(); save(); render();
    });
    $('#ari-copy-rule').addEventListener('click', () => addRule(true));
    $('#ari-delete-rule').addEventListener('click', () => openGroupForm('delete-rule'));
    dialog.querySelectorAll('[data-group-action]').forEach(button => button.addEventListener('click', () => openGroupForm(button.dataset.groupAction)));
    $('#ari-group-cancel').addEventListener('click', closeGroupForm);
    $('#ari-group-form').addEventListener('submit', submitGroup);
}

async function onMessageSent(messageId) {
    try {
        const ctx = context();
        const outcome = processMessage(ctx.chat, messageId, settings());
        if (!outcome) return;
        for (const id of outcome.changedIds) ctx.updateMessageBlock(id, ctx.chat[id]);
        renderLastRoll();
        // MESSAGE_SENT is emitted after the host's initial save, so persist our changes explicitly.
        await ctx.saveChat();
    } catch (error) {
        console.error('[AutoRandomInput] 消息处理失败', error);
        globalThis.toastr?.error('随机指令处理或保存失败，请检查当前消息。', 'AutoRandomInput');
    }
}

async function init() {
    if (initialized) return;
    initialized = true;
    const ctx = context();
    ctx.extensionSettings[SETTINGS_KEY] = normalizeSettings(ctx.extensionSettings[SETTINGS_KEY]);
    save();
    ctx.eventSource.on(ctx.eventTypes.MESSAGE_SENT, onMessageSent);
    ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, renderLastRoll);
    // On hosts with display hooks, hide before Markdown/HTML encoding; never modify the prompt here.
    if (ctx.messageFormatter?.addHook) {
        ctx.messageFormatter.addHook((text, meta) => meta.isUser
            ? displayMessage(text, context().chat[meta.messageId]?.extra?.[SETTINGS_KEY]) : text,
        { stage: ctx.messageFormatter.stage.BEFORE_REGEX });
    }

    const response = await fetch(new URL('./index.html', import.meta.url));
    if (!response.ok) throw new Error(`界面加载失败：HTTP ${response.status}`);
    const template = document.createElement('template');
    template.innerHTML = await response.text();
    document.body.append(template.content);
    dialog = document.getElementById('ari-workbench');
    bindUI();
    render();
    const button = document.createElement('button');
    button.id = 'ari-menu-button';
    button.type = 'button';
    button.className = 'list-group-item flex-container flexGap5 interactable';
    button.innerHTML = '<i class="fa-solid fa-dice-d6" aria-hidden="true"></i><span>随机指令</span>';
    button.addEventListener('click', () => { closeGroupForm(); render(); if (!dialog.open) dialog.showModal(); });
    const menu = document.getElementById('extensionsMenu') ?? document.getElementById('extensions_settings2');
    if (menu) menu.append(button);
    else console.error('[AutoRandomInput] 未找到扩展菜单入口');
}

context().eventSource.on(context().eventTypes.APP_READY, () =>
    init().catch(error => {
        console.error('[AutoRandomInput] 初始化失败', error);
        globalThis.toastr?.error('随机指令界面加载失败，请刷新页面。', 'AutoRandomInput');
    }));
