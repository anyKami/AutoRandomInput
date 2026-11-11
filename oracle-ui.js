import { DICE_SIDES, SETTINGS_KEY, validateCommandRanges } from './core.js';
import { SKILL_GROUPS_KEY } from './skill-groups.js';
import { ORACLE_FIELDS, ORACLE_SETTINGS_KEY, validateGeneratedConfig } from './oracle-config.js';
import { previewConfigImport } from './config-transfer.js';
import { mountOracleFields } from './oracle-forms.js';

export function mountOracleUI(dialog, getContext, service, skillService, onApply) {
    const $ = s => dialog.querySelector(s);
    const panel = $('#ari-oracle-panel'), editor = $('#ari-oracle-preview');
    const fields = mountOracleFields($('#ari-oracle-constraints'), 'ari-once', ORACLE_FIELDS.filter(f => f.constraint));
    let options, value, ticket = 0, returnTab = 'random', summaries = [];
    const status = (text, error = false) => { $('#ari-oracle-status').textContent = text; $('#ari-oracle-status').dataset.error = String(error); };
    const node = (tag, text, className) => {
        const el = document.createElement(tag); if (text !== undefined) el.textContent = text;
        if (className) el.className = className; return el;
    };
    function input(parent, labelText, object, key, { choices, number = false, area = false, rerender = false } = {}) {
        const label = node('label', undefined, 'ari-oracle-field'); label.append(node('span', labelText));
        const el = node(choices ? 'select' : area ? 'textarea' : 'input');
        if (choices) el.append(...choices.map(([id, title]) => new Option(title, id)));
        else if (number) { el.type = 'number'; el.step = '1'; }
        else if (area) el.rows = 3;
        el.value = typeof object[key] === 'object' ? '' : object[key] ?? '';
        el.addEventListener(choices ? 'change' : 'input', () => {
            object[key] = choices ? choices.find(([id]) => String(id) === el.value)?.[0] : number
                ? (el.value.trim() ? Number(el.value) : null) : el.value;
            if (rerender) renderPreview(); else validate();
        });
        label.append(el); parent.append(label); return el;
    }
    function action(parent, label, fn) {
        const btn = node('button', label); btn.type = 'button';
        btn.addEventListener('click', () => { fn(); renderPreview(); }); parent.append(btn);
    }
    function validate() {
        for (const update of summaries) update();
        let ok = false;
        const hasSkills = $('#ari-oracle-target').value !== 'random';
        const ready = skillService.view().ready;
        $('#ari-oracle-enable-random-label').hidden = $('#ari-oracle-target').value === 'skills';
        $('#ari-oracle-enable-skills-label').hidden = !hasSkills;
        $('#ari-oracle-enable-skills').disabled = !ready;
        $('#ari-oracle-apply-note').textContent = hasSkills ? ready
            ? '保存并应用将载入新的聊天技能表，旧表待检定项失效，历史骰点保留。'
            : 'MVU 尚未就绪：本次可保存到组库，待 MVU 初始化后再载入并启用。' : '保存并应用将切换当前随机指令组。';
        try {
            if (!value || !service.valid()) throw new Error('');
            const bundle = validateGeneratedConfig(value, service.draft.target, service.draft.options);
            const ctx = getContext();
            const preview = previewConfigImport(bundle, ctx.extensionSettings[SETTINGS_KEY].groups, ctx.extensionSettings[SKILL_GROUPS_KEY].groups);
            $('#ari-oracle-validation').textContent = '校验通过，将保存为：' + [...preview.randomGroups, ...preview.skillGroups].map(g => g.name).join('、');
            $('#ari-oracle-validation').dataset.error = 'false'; ok = true;
        } catch (error) { $('#ari-oracle-validation').textContent = error.message; $('#ari-oracle-validation').dataset.error = 'true'; }
        $('#ari-oracle-apply').disabled = !ok || (hasSkills && !ready);
        $('#ari-oracle-save-only').disabled = !ok;
    }
    function renderPreview() {
        editor.replaceChildren(); summaries = [];
        if (!value || typeof value !== 'object' || Array.isArray(value)) { validate(); return; }
        try {
            for (const group of (value.randomGroups ?? [])) {
                if (!group || !Array.isArray(group.rules) || group.rules.length > 10) throw new Error('无法预览随机指令结构，请重新生成。');
                const card = node('section', undefined, 'ari-transfer-card'); editor.append(card);
                card.append(node('h4', '随机指令组')); input(card, '随机组名称', group, 'name');
                for (const [ri, rule] of group.rules.entries()) {
                    if (!rule || (rule.commands && !Array.isArray(rule.commands)) || (rule.ranges && !Array.isArray(rule.ranges))) throw new Error('骰子指令结构无效。');
                    if (rule.commands === undefined) rule.commands = [];
                    if (rule.ranges === undefined) rule.ranges = [];
                    if (!Array.isArray(rule.commands) || !Array.isArray(rule.ranges)) throw new Error('命令与范围须为数组。');
                    if (rule.ranges.length > 100 || rule.commands.length > 20) throw new Error('指令行数过多，请重新生成。');
                    const box = node('fieldset'); box.append(node('legend', `骰子指令 ${ri + 1}`)); card.append(box);
                    input(box, '指令名称', rule, 'name');
                    input(box, '骰型', rule, 'diceSides', { choices: DICE_SIDES.map(n => [n, `d${n}`]), rerender: true });
                    if (rule.enabled === undefined) rule.enabled = true;
                    input(box, '状态', rule, 'enabled', { choices: [[true, '启用'], [false, '暂停']] });
                    if (rule.diceSides === 100) {
                        const summary = node('p', '', 'ari-skill-note'); box.append(summary);
                        summaries.push(() => { summary.textContent = `覆盖 ${validateCommandRanges(rule.ranges).coveredCount}/100 点；空档投中无指令。`; });
                        for (const [i, row] of rule.ranges.entries()) {
                            if (!row || typeof row !== 'object') throw new Error('范围行结构无效。');
                            const line = node('div', undefined, 'ari-oracle-range'); box.append(line);
                            input(line, `范围 ${i + 1}`, row, 'range'); input(line, '指令内容', row, 'command', { area: true });
                            action(line, '删除范围', () => rule.ranges.splice(i, 1));
                        }
                        action(box, '＋ 添加范围', () => rule.ranges.push({ range: '', command: '' }));
                    } else {
                        for (let i = 0; i < (DICE_SIDES.includes(rule.diceSides) ? rule.diceSides : 0); i++) input(box, `骰点 ${i + 1}`, rule.commands, i, { area: true });
                    }
                    action(box, '删除这套指令', () => group.rules.splice(ri, 1));
                }
                action(card, '＋ 添加骰子指令', () => group.rules.push({ name: '新指令', enabled: true, diceSides: 6, commands: [], ranges: [] }));
            }
            for (const group of (value.skillGroups ?? [])) {
                if (!group || !Array.isArray(group.skills) || group.skills.length > 50) throw new Error('无法预览技能结构，请重新生成。');
                const card = node('section', undefined, 'ari-transfer-card'); editor.append(card); card.append(node('h4', '技能配置组'));
                input(card, '技能组名称', group, 'name');
                input(card, '统一骰型', group, 'diceSides', { choices: [10, 20, 100].map(n => [n, `d${n}`]), rerender: true });
                if (group.mode === undefined) group.mode = 'challenge';
                if (group.maxChecks === undefined) group.maxChecks = 1;
                if (group.pointLimitMode === undefined) group.pointLimitMode = 'auto';
                input(card, '判定频率', group, 'mode', { choices: [['challenge', '有明确挑战时'], ['every', '每轮判定']] });
                input(card, '每轮检定上限', group, 'maxChecks', { choices: [1, 2, 3].map(n => [n, String(n)]) });
                input(card, '预算模式', group, 'pointLimitMode', { choices: [['auto', '自动推荐'], ['custom', '自定义']], rerender: true });
                if (group.pointLimitMode === 'custom') input(card, '净预算', group, 'pointLimit', { number: true });
                const summary = node('p', '', 'ari-oracle-budget ari-skill-note'); card.append(summary);
                summaries.push(() => { summary.textContent = `单项范围 ${-group.diceSides / 5}～+${group.diceSides}；加值净和 ${group.skills.reduce((sum, s) => sum + (Number(s?.modifier) || 0), 0)}。${group.pointLimitMode === 'auto' ? `推荐预算 ${group.skills.length * Math.round(group.diceSides * 3 / 20)}` : ''}`; });
                for (const [i, skill] of group.skills.entries()) {
                    if (!skill || typeof skill !== 'object') throw new Error('技能行结构无效。');
                    const row = node('div', undefined, 'ari-oracle-range'); card.append(row);
                    input(row, `技能 ${i + 1}`, skill, 'name'); input(row, '技能加值', skill, 'modifier', { number: true });
                    action(row, '删除技能', () => group.skills.splice(i, 1));
                }
                action(card, '＋ 添加技能', () => group.skills.push({ name: '', modifier: Math.round(group.diceSides * 3 / 20) }));
            }
        } catch (error) { editor.replaceChildren(node('p', error.message)); }
        validate();
    }
    function refreshCaps() {
        const caps = service.capabilities();
        $('#ari-oracle-generate').disabled = service.busy || !caps.ready || !getContext().chat?.length;
        $('#ari-oracle-capability').textContent = service.busy ? '神谕请求进行中，请等待完成后再生成。'
            : caps.ready ? `使用故事神谕 · ${caps.connection}` : '请先启用故事神谕并配置模型连接，可在设置页重新检测。';
    }
    function clearDraft() {
        value = undefined; summaries = []; editor.replaceChildren(); $('#ari-oracle-raw').textContent = '';
        $('#ari-oracle-request').textContent = '';
        $('#ari-oracle-notes').textContent = ''; $('#ari-oracle-validation').textContent = ''; validate();
    }
    function close(focus = true) {
        ticket++; service.cancel(); panel.hidden = true; clearDraft();
        $('.ari-tabs').hidden = false; $('#ari-transfer-toggle').disabled = false;
        for (const name of ['random', 'skills', 'settings']) $(`#ari-${name}-panel`).hidden = $(`#ari-tab-${name}`).getAttribute('aria-selected') !== 'true';
        if (focus) $(`#ari-generate-${returnTab}`)?.focus();
    }
    for (const name of ['random', 'skills']) $(`#ari-generate-${name}`).addEventListener('click', () => {
        returnTab = name; options = { ...getContext().extensionSettings[ORACLE_SETTINGS_KEY] }; fields.fill(options);
        $('#ari-oracle-target').value = name; $('#ari-oracle-requirements').value = '';
        $('#ari-oracle-enable-random').checked = false; $('#ari-oracle-enable-skills').checked = false;
        service.cancel(); clearDraft(); status();
        $('.ari-tabs').hidden = true; $('#ari-transfer-toggle').disabled = true;
        for (const tab of ['random', 'skills', 'settings']) $(`#ari-${tab}-panel`).hidden = true;
        panel.hidden = false; refreshCaps(); $('#ari-oracle-target').disabled = false;
        $('#ari-oracle-target').focus();
    });
    $('#ari-oracle-back').addEventListener('click', () => close());
    dialog.addEventListener('close', () => { if (!panel.hidden) close(false); });
    dialog.addEventListener('cancel', event => { if (!panel.hidden) { event.preventDefault(); close(); } });
    $('#ari-oracle-target').addEventListener('change', () => { ticket++; service.cancel(); clearDraft(); status(); refreshCaps(); });
    $('#ari-oracle-cancel').addEventListener('click', () => {
        ticket++; service.cancel(); clearDraft(); status('已取消，现有配置未修改。');
        $('#ari-oracle-target').disabled = false; refreshCaps();
    });
    $('#ari-oracle-generate').addEventListener('click', async () => {
        const own = ++ticket;
        try {
            const request = { ...options, ...fields.read() };
            clearDraft(); status('正在读取剧情资料并生成…'); $('#ari-oracle-target').disabled = true;
            const pending = service.generate($('#ari-oracle-target').value, request, $('#ari-oracle-requirements').value,
                count => status(`神谕正在生成，已接收 ${count} 字符…`));
            refreshCaps();
            const result = await pending;
            if (own !== ticket || panel.hidden) return;
            value = result.value; $('#ari-oracle-raw').textContent = result.raw;
            $('#ari-oracle-request').textContent = result.messages.map(m => `${m.role}\n${m.content}`).join('\n\n');
            $('#ari-oracle-notes').textContent = result.notes.join('\n'); renderPreview();
            status(result.error || '生成完成。可修改预览，再保存并应用；本次固定参数仍参与校验。', !!result.error);
        } catch (error) { if (own === ticket && !panel.hidden) status(error.message, true); }
        finally { if (own === ticket) { $('#ari-oracle-target').disabled = false; refreshCaps(); } }
    });
    for (const [id, saveOnly] of [['ari-oracle-apply', false], ['ari-oracle-save-only', true]]) $('#' + id).addEventListener('click', () => {
        try {
            const result = service.apply(value, { saveOnly, enableRandom: $('#ari-oracle-enable-random').checked, enableSkills: $('#ari-oracle-enable-skills').checked });
            onApply(); status(`已${saveOnly ? '保存到组库' : '保存并应用'}：${[...result.randomGroups, ...result.skillGroups].map(g => g.name).join('、')}。`); validate();
        } catch (error) { status(error.message, true); validate(); }
    });
    const ctx = getContext();
    for (const event of ['CHAT_CHANGED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MESSAGE_EDITED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED']) {
        if (ctx.eventTypes[event]) ctx.eventSource.on(ctx.eventTypes[event], () => {
            if (panel.hidden) return;
            ticket++; service.cancel(); clearDraft(); status('聊天或来源消息已变化，请重新生成。', true);
            $('#ari-oracle-target').disabled = false; refreshCaps();
        });
    }
    document.addEventListener('story-oracle-ready', refreshCaps);
    return { refreshCaps };
}
