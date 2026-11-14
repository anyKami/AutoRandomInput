import { DICE_SIDES, SETTINGS_KEY, THEMES, activeGroup, createGroup, createRule, createSampleGroup, displayMessage, normalizeSettings, uniqueGroupName, uniqueName, validateCommandRanges } from './core.js';
import { installSendHooks } from './send.js';
import { installSkillService, mvuApi } from './mvu-skills.js';
import { mountSkillUI } from './skill-ui.js';
import { SKILL_GROUPS_KEY, normalizeSkillGroups } from './skill-groups.js';
import { mountConfigTransferUI } from './config-transfer-ui.js';
import { ORACLE_SETTINGS_KEY, normalizeOracleSettings } from './oracle-config.js';
import { createOracleService, createOracleRequestGate } from './oracle-service.js';
import { mountOracleSettings } from './oracle-forms.js';
import { mountOracleUI } from './oracle-ui.js';
import { effectiveRandomSettings, selectRandomGroup } from './oracle-auto-state.js';
import { installAutoOracle } from './oracle-auto.js';
import { mountAutoOracleUI } from './oracle-auto-ui.js';
import { mountMetadataEditor, mountNarrativeUI } from './narrative-ui.js';
import { foldNarrative } from './narrative.js';

const context = () => SillyTavern.getContext();
const settings = () => context().extensionSettings[SETTINGS_KEY];
const currentGroup = () => activeGroup(effectiveRandomSettings(context()));
const save = () => context().saveSettingsDebounced();
let dialog;
let initialized = false;
let groupAction = '';
let selectedRuleId = '';
let skillService;
let skillUI;
let oracleSettingsUI;
let oracleUI;
let autoOracleUI;
let narrativeUI;
const $ = selector => dialog.querySelector(selector);
const selectedRule = () => {
    const group = currentGroup();
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
    if (rule.diceSides === 100) {
        renderRangeValidation();
        return;
    }
    const count = rule.commands.slice(0, rule.diceSides).filter(text => text.trim()).length;
    $('#ari-filled-count').textContent = `${rule.diceSides} 个编号 · ${count} 条已填写`;
}

function renderLastRoll() {
    if (!dialog) return;
    const chat = context().chat ?? [];
    const record = chat.findLast(message => message?.is_user && message.extra?.[SETTINGS_KEY])?.extra[SETTINGS_KEY];
    const rolls = record?.rolls ?? (record ? [{ ...record, ruleName: '骰子指令 1' }] : []);
    const invalidCount = rolls.filter(roll => roll.error).length;
    $('#ari-last-group').textContent = record ? `${record.groupName} · ${rolls.length - invalidCount} 次投掷${invalidCount ? ` · ${invalidCount} 套配置错误` : ''}` : '等待下一次发送';
    const list = $('#ari-last-rolls');
    list.replaceChildren();
    for (const roll of rolls) {
        const item = document.createElement('div');
        item.className = 'ari-roll-item';
        item.innerHTML = '<strong class="ari-roll-number"></strong><div><span></span><small></small></div>';
        item.querySelector('strong').textContent = roll.error ? '—' : String(roll.result).padStart(2, '0');
        item.querySelector('span').textContent = `${roll.ruleName} · d${roll.sides}`;
        const reasons = { blank: '空白，已跳过', invalid_ranges: '范围配置错误', conditions: '条件不满足或 MVU 未就绪', needs_binding: '等待绑定剧情线', thread_inactive: '剧情线未活跃', blocked_topic: '主题已屏蔽', cooldown: '主题冷却中', budget: '预算不足', duplicate_topic: '本轮主题重复', duplicate_thread: '本轮剧情线重复', selected: '已注入', persistent: '常驻已注入' };
        item.querySelector('small').textContent = roll.reason ? (reasons[roll.reason] ?? roll.reason) : roll.error ? `未投掷：${roll.error}`
            : roll.sides === 100 ? (roll.uncovered ? '未覆盖此骰点，已跳过' : `命中 ${roll.range}${roll.skipped ? ' · 空白，已跳过' : ''}`)
                : roll.skipped ? '空白，已跳过' : `命中第 ${roll.result} 条`;
        list.append(item);
    }
    if (record && !rolls.length) list.textContent = '本次没有启用的指令。';
    const group = currentGroup();
    const rule = selectedRule();
    const hit = rolls.find(roll => roll.ruleId === rule.id);
    dialog.querySelectorAll('.ari-command-card, .ari-range-row').forEach(card => {
        card.dataset.hit = String(!!hit && !hit.skipped && record.groupId === group.id &&
            hit.sides === rule.diceSides && (rule.diceSides === 100
                ? Number(card.dataset.index) === hit.rangeIndex && card.dataset.range === hit.range
                : Number(card.dataset.index) + 1 === hit.result));
    });
}

function renderRangeValidation() {
    const rule = selectedRule();
    const validation = validateCommandRanges(rule.ranges);
    $('#ari-filled-count').textContent = validation.valid
        ? `${validation.entries.length} 条范围 · 覆盖 ${validation.coveredCount}/100 点`
        : `${rule.ranges.length} 行 · 范围待修正`;
    const status = $('#ari-range-status');
    status.dataset.invalid = String(!validation.valid);
    status.textContent = validation.valid
        ? `未覆盖 ${100 - validation.coveredCount} 个骰点，投中不追加指令、不重投。`
        : `${validation.errors[0].message}${validation.errors.length > 1 ? ` 共 ${validation.errors.length} 处错误。` : ''} 本套 d100 暂停投掷，修正后自动恢复。`;
    $('#ari-range-list').querySelectorAll('.ari-range-row').forEach(row => {
        const index = Number(row.dataset.index);
        const error = validation.errors.find(item => item.indexes.includes(index));
        const entry = validation.entries.find(item => item.index === index);
        row.dataset.invalid = String(!!error);
        row.dataset.range = entry?.range ?? '';
        row.querySelector('input').setAttribute('aria-invalid', String(!!error));
        row.querySelector('.ari-range-info').textContent = error ? '范围待修正' : entry
            ? `${entry.end - entry.start + 1}%${entry.command.trim() ? '' : ' · 空白跳过'}` : '空白行不参与';
        const message = row.querySelector('.ari-range-error');
        message.hidden = !error;
        message.textContent = error?.message ?? '';
    });
}

function renderRanges() {
    const rule = selectedRule();
    const list = $('#ari-range-list');
    list.replaceChildren();
    rule.ranges.forEach((entry, index) => {
        const row = document.createElement('div');
        row.className = 'ari-range-row';
        row.dataset.index = String(index);
        row.innerHTML = `<div class="ari-range-field"><label for="ari-command-range-${index}">骰点范围</label><input id="ari-command-range-${index}" type="text" placeholder="如 1-14" autocomplete="off" aria-describedby="ari-range-error-${index}"><small class="ari-range-info"></small></div><div class="ari-range-content"><label for="ari-range-command-${index}">指令内容</label><textarea id="ari-range-command-${index}" rows="3" placeholder="命中此范围时追加的指令…" spellcheck="false"></textarea></div><button type="button" class="ari-remove-range" aria-label="删除第 ${index + 1} 行范围" title="删除此行">×</button><p id="ari-range-error-${index}" class="ari-range-error" hidden></p>`;
        const input = row.querySelector('input');
        const command = row.querySelector('textarea');
        input.value = entry.range;
        command.value = entry.command;
        const update = () => {
            entry.range = input.value;
            entry.command = command.value;
            renderRangeValidation(); renderLastRoll(); save();
        };
        input.addEventListener('input', update);
        command.addEventListener('input', update);
        row.querySelector('button').addEventListener('click', () => {
            rule.ranges.splice(index, 1);
            save(); renderRanges(); renderCounter(); renderLastRoll();
            const next = list.querySelectorAll('input')[Math.min(index, rule.ranges.length - 1)];
            (next ?? $('#ari-add-range')).focus();
        });
        mountMetadataEditor(row, () => entry.metadata, value => { entry.metadata = value; save(); },
            { getThreads: () => foldNarrative(context().chat).threads });
        list.append(row);
    });
}

function renderRules() {
    const group = currentGroup();
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
    $('#ari-delete-rule').disabled = currentGroup().rules.length <= 1;
    $('#ari-delete-rule').title = currentGroup().rules.length <= 1 ? '至少保留一套骰子指令' : '删除当前骰子指令';
    $('#ari-disabled-hint').hidden = rule.enabled;
    $('#ari-sides').value = String(rule.diceSides);
    $('#ari-dice-label').textContent = `D${rule.diceSides}`;
    $('#ari-range').textContent = rule.diceSides === 1 ? '1' : `1–${rule.diceSides}`;
    $('#ari-probability').textContent = `${Number((100 / rule.diceSides).toFixed(2))}%`;
    $('#ari-probability-label').textContent = rule.diceSides === 100 ? '每点概率' : '每条概率';
    $('#ari-range-editor').hidden = rule.diceSides !== 100;
    const grid = $('#ari-command-grid');
    grid.hidden = rule.diceSides === 100;
    grid.replaceChildren();
    $('#ari-range-list').replaceChildren();
    // Only render active slots; keep hidden commands when switching die sizes.
    rule.commands.slice(0, rule.diceSides === 100 ? 0 : rule.diceSides).forEach((text, index) => {
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
        mountMetadataEditor(card, () => rule.commandMetadata[index], value => { rule.commandMetadata[index] = value; save(); },
            { persistentAllowed: rule.diceSides === 1, getThreads: () => foldNarrative(context().chat).threads });
        grid.append(card);
    });
    if (rule.diceSides === 100) renderRanges();
    const hint = $('#ari-hidden-hint');
    hint.hidden = rule.diceSides === 100 || rule.diceSides === rule.commands.length;
    hint.textContent = hint.hidden ? '' : `第 ${rule.diceSides + 1}–${rule.commands.length} 条已收起，内容仍保留。调大骰子面数即可恢复。`;
    renderCounter();
    renderLastRoll();
}

function renderGroups() {
    const store = settings();
    $('#ari-group').replaceChildren(...store.groups.map(group => new Option(group.name, group.id)));
    $('#ari-group').value = currentGroup().id;
    $('#ari-group-count').textContent = `${store.groups.length} 组`;
    $('#ari-delete-group').disabled = store.groups.length <= 1;
    $('#ari-delete-group').title = store.groups.length <= 1 ? '至少保留一个配置组' : '删除当前配置组';
}

function render() {
    renderGroups();
    renderStatus();
    renderRules();
    renderCommands();
    skillUI?.render();
    oracleSettingsUI?.refresh();
    oracleUI?.refreshCaps();
    autoOracleUI?.refresh();
    narrativeUI?.refresh();
}

function closeGroupForm() {
    $('#ari-group-form').hidden = true;
    groupAction = '';
}

function openGroupForm(action) {
    groupAction = action;
    const group = currentGroup();
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
    const group = currentGroup();
    if (groupAction === 'delete-rule') {
        if (group.rules.length <= 1) return;
        group.rules = group.rules.filter(rule => rule.id !== selectedRule().id);
        selectedRuleId = group.rules[0].id;
    } else if (groupAction === 'delete') {
        if (store.groups.length <= 1) return;
        store.groups = store.groups.filter(item => item.id !== group.id);
        selectRandomGroup(context(), store.groups[0].id);
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
            selectRandomGroup(context(), next.id);
        }
    }
    save();
    closeGroupForm();
    render();
    $('#ari-group').focus();
}

function bindUI() {
    const tabs = ['random', 'narrative', 'skills', 'settings'];
    const selectTab = name => {
        for (const tab of tabs) {
            const selected = tab === name;
            $(`#ari-tab-${tab}`).setAttribute('aria-selected', String(selected));
            $(`#ari-tab-${tab}`).tabIndex = selected ? 0 : -1;
            $(`#ari-${tab}-panel`).hidden = !selected;
        }
        $(`#ari-tab-${name}`).scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        $('.ari-master').hidden = name !== 'random';
        if (name === 'skills') skillUI?.render();
        if (name === 'narrative') narrativeUI?.refresh();
        if (name === 'settings') { oracleSettingsUI?.refresh(); autoOracleUI?.refresh(); }
    };
    for (const name of tabs) {
        $(`#ari-tab-${name}`).addEventListener('click', () => selectTab(name));
        $(`#ari-tab-${name}`).addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1)
                : tabs[(tabs.indexOf(name) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
            selectTab(next); $(`#ari-tab-${next}`).focus();
        });
    }
    for (const sides of DICE_SIDES) $('#ari-sides').append(new Option(`d${sides}`, String(sides)));
    for (const [id, name] of Object.entries(THEMES)) $('#ari-theme').append(new Option(name, id));
    $('#ari-close').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
    $('#ari-enabled').addEventListener('change', event => { settings().enabled = event.target.checked; save(); renderStatus(); autoOracleUI?.refresh(); });
    $('#ari-stealth').addEventListener('change', event => { settings().stealthMode = event.target.checked; save(); renderStatus(); });
    $('#ari-include-result').addEventListener('change', event => { settings().includeRollResult = event.target.checked; save(); });
    $('#ari-theme').addEventListener('change', event => { settings().theme = event.target.value; save(); renderStatus(); });
    $('#ari-sides').addEventListener('change', event => {
        const rule = selectedRule();
        rule.diceSides = Number(event.target.value);
        if (rule.diceSides === 100 && !rule.ranges.length) rule.ranges.push({ range: '', command: '' });
        save(); renderRules(); renderCommands();
    });
    $('#ari-add-range').addEventListener('click', () => {
        const rule = selectedRule();
        rule.ranges.push({ range: '', command: '' });
        save(); renderRanges(); renderCounter(); renderLastRoll();
        $(`#ari-command-range-${rule.ranges.length - 1}`).focus();
    });
    $('#ari-group').addEventListener('change', event => { selectRandomGroup(context(), event.target.value); selectedRuleId = ''; closeGroupForm(); save(); renderRules(); renderCommands(); });
    $('#ari-rule-name').addEventListener('input', event => { selectedRule().name = event.target.value; save(); renderRules(); });
    $('#ari-rule-name').addEventListener('change', event => {
        selectedRule().name = event.target.value.trim() || '未命名指令';
        event.target.value = selectedRule().name;
        save(); renderRules();
    });
    const addRule = copy => {
        const group = currentGroup();
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
        selectRandomGroup(context(), group.id);
        selectedRuleId = group.rules[0].id;
        closeGroupForm(); save(); render();
    });
    $('#ari-copy-rule').addEventListener('click', () => addRule(true));
    $('#ari-delete-rule').addEventListener('click', () => openGroupForm('delete-rule'));
    dialog.querySelectorAll('[data-group-action]').forEach(button => button.addEventListener('click', () => openGroupForm(button.dataset.groupAction)));
    $('#ari-group-cancel').addEventListener('click', closeGroupForm);
    $('#ari-group-form').addEventListener('submit', submitGroup);
}

async function init() {
    if (initialized) return;
    initialized = true;
    const ctx = context();
    ctx.extensionSettings[SETTINGS_KEY] = normalizeSettings(ctx.extensionSettings[SETTINGS_KEY]);
    ctx.extensionSettings[SKILL_GROUPS_KEY] = normalizeSkillGroups(ctx.extensionSettings[SKILL_GROUPS_KEY]);
    ctx.extensionSettings[ORACLE_SETTINGS_KEY] = normalizeOracleSettings(ctx.extensionSettings[ORACLE_SETTINGS_KEY]);
    save();
    skillService = installSkillService(context, () => skillUI?.refresh());
    await installSendHooks(context, () => { renderLastRoll(); skillUI?.refresh(); narrativeUI?.refresh(); }, undefined, undefined, skillService);
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
    skillUI = mountSkillUI(dialog, context, skillService);
    narrativeUI = mountNarrativeUI(dialog, context, () => {}, {
        mvuState: () => {
            const ctx = context(); let index = ctx.chat.length - 1;
            while (index >= 0 && ctx.chat[index]?.is_system) index--;
            try { const data = index >= 0 ? mvuApi()?.getMvuData({ type: 'message', message_id: index }) : null; return { ready: !!data?.stat_data, data }; }
            catch { return { ready: false, data: null }; }
        },
        openAutoSettings: () => { $('#ari-tab-settings').click(); $('#ari-auto-oracle-title').scrollIntoView({ block: 'start' }); },
    });
    const oracleGate = createOracleRequestGate();
    const oracleService = createOracleService(context, skillService, globalThis, { gate: oracleGate });
    oracleSettingsUI = mountOracleSettings(dialog, context, oracleService);
    oracleUI = mountOracleUI(dialog, context, oracleService, skillService, () => { selectedRuleId = ''; render(); });
    const autoOracle = installAutoOracle(context,
        createOracleService(context, skillService, globalThis, { gate: oracleGate, automatic: true }), {
            onChange: () => { autoOracleUI?.refresh(); oracleUI?.refreshCaps(); narrativeUI?.refresh(); },
            onApply: () => { selectedRuleId = ''; render(); },
            onChatChange: () => { selectedRuleId = ''; closeGroupForm(); render(); },
        });
    autoOracleUI = mountAutoOracleUI(dialog, context, autoOracle);
    mountConfigTransferUI(dialog, context, () => { renderGroups(); skillUI.renderGroups(); });
    render();
    const button = document.createElement('div');
    button.id = 'ari-menu-button';
    button.setAttribute('role', 'button');
    button.tabIndex = 0;
    button.className = 'list-group-item flex-container flexGap5 interactable';
    button.innerHTML = '<i class="fa-solid fa-dice-d6" aria-hidden="true"></i><span>随机指令</span>';
    button.addEventListener('click', () => { closeGroupForm(); render(); if (!dialog.open) dialog.showModal(); });
    button.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        button.click();
    });
    const menu = document.getElementById('extensionsMenu') ?? document.getElementById('extensions_settings2');
    if (menu) menu.append(button);
    else console.error('[AutoRandomInput] 未找到扩展菜单入口');
}

context().eventSource.on(context().eventTypes.APP_READY, () =>
    init().catch(error => {
        console.error('[AutoRandomInput] 初始化失败', error);
        globalThis.toastr?.error('随机指令界面加载失败，请刷新页面。', 'AutoRandomInput');
    }));
