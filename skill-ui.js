import { SKILL_SETTINGS_KEY, defaultSkillModifier, minSkillModifier, newSkillId, normalizeSkillSettings, randomizeSkillModifiers,
    recommendedPointLimit, skillErrors, skillPointTotal, syncSkillBudget, skillFormula, SKILL_VERSION } from './skills.js';
import { SKILL_GROUPS_KEY, SKILL_TEMPLATES, addSkillTemplate, createSkillGroup, loadSkillGroup, saveSkillGroup,
    skillGroupMatches, uniqueSkillGroupName } from './skill-groups.js';

export function mountSkillUI(dialog, getContext, service) {
    const $ = selector => dialog.querySelector(selector);
    let metadata;
    let groupAction = '';
    const store = () => getContext().chatMetadata?.[SKILL_SETTINGS_KEY];
    const library = () => getContext().extensionSettings[SKILL_GROUPS_KEY];
    const selectedGroup = () => library().groups.find(group => group.id === store()?.groupId);
    const canEdit = () => !!getContext().chatMetadata && getContext().chat.length > 0;
    const isCurrent = () => {
        if (metadata === getContext().chatMetadata && canEdit()) return true;
        render(); return false;
    };
    const save = () => {
        const ctx = getContext();
        if (metadata !== ctx.chatMetadata) { render(); return; }
        if (store()) syncSkillBudget(store());
        if (ctx.saveMetadataDebounced) ctx.saveMetadataDebounced();
        else if (ctx.saveMetadata) void ctx.saveMetadata();
    };
    const saveLibrary = () => getContext().saveSettingsDebounced();
    function closeGroupForm() {
        groupAction = '';
        $('#ari-skill-group-form').hidden = true;
    }
    function renderGroups() {
        const group = selectedGroup();
        const config = store();
        const count = library().groups.length;
        $('#ari-skill-group').replaceChildren(new Option('当前聊天（未关联配置组）', ''), ...library().groups.map(item => new Option(item.name, item.id)));
        $('#ari-skill-group').value = group?.id ?? '';
        $('#ari-skill-group-count').textContent = `${count} 组`;
        for (const id of ['ari-rename-skill-group', 'ari-delete-skill-group', 'ari-load-skill-group']) $('#' + id).disabled = !canEdit() || !group;
        $('#ari-skill-group-status').textContent = !group ? '可将当前聊天的技能表另存为配置组。'
            : skillGroupMatches(config, group) ? `“${group.name}”已保存，可在其他聊天载入。` : `当前聊天已修改，点击「保存到组」更新“${group.name}”。`;
    }
    function applyGroup(group) {
        if (!isCurrent()) return;
        metadata[SKILL_SETTINGS_KEY] = loadSkillGroup(store(), group);
        service.resetSheet();
        save(); render();
    }
    function openGroupForm(action) {
        if (!isCurrent()) return;
        const group = selectedGroup();
        if (['rename', 'delete'].includes(action) && !group) return;
        groupAction = action;
        const labels = { new: '新建空白技能配置组', copy: '将当前技能表另存为', rename: '重命名技能配置组', delete: `删除“${group?.name}”？` };
        $('#ari-skill-group-form-label').textContent = labels[action];
        const input = $('#ari-skill-group-name');
        input.hidden = action === 'delete';
        input.value = action === 'rename' ? group.name : uniqueSkillGroupName(library(), action === 'copy' && group ? `${group.name} 副本` : '新技能配置组');
        $('#ari-skill-group-error').textContent = action === 'delete' ? '将删除保存的模板；当前聊天的技能表会保留。' : '';
        $('#ari-skill-group-confirm').textContent = action === 'delete' ? '确认删除' : '确定';
        $('#ari-skill-group-form').hidden = false;
        if (action === 'delete') $('#ari-skill-group-cancel').focus();
        else { input.focus(); input.select(); }
    }
    function submitGroup(event) {
        event.preventDefault();
        if (!isCurrent() || !groupAction) return;
        const group = selectedGroup();
        if (groupAction === 'delete') {
            if (!group) return;
            library().groups = library().groups.filter(item => item.id !== group.id);
            store().groupId = '';
        } else {
            const name = $('#ari-skill-group-name').value.trim();
            if (!name) { $('#ari-skill-group-error').textContent = '请输入配置组名称。'; return; }
            if (library().groups.some(item => item.name === name && !(groupAction === 'rename' && item.id === group?.id))) {
                $('#ari-skill-group-error').textContent = '这个名称已被使用，请换一个。'; return;
            }
            if (groupAction === 'rename') {
                if (!group) return;
                group.name = name;
            } else {
                if (groupAction === 'copy' && skillErrors(store()).length) {
                    $('#ari-skill-group-error').textContent = skillErrors(store()).join('\n'); return;
                }
                const next = createSkillGroup(name, groupAction === 'copy' ? store() : undefined);
                library().groups.push(next);
                // Saving a working sheet must not invalidate its existing pending checks.
                if (groupAction === 'copy') store().groupId = next.id;
                else {
                    metadata[SKILL_SETTINGS_KEY] = loadSkillGroup(store(), next);
                    service.resetSheet();
                }
            }
        }
        saveLibrary(); save(); closeGroupForm(); render(); $('#ari-skill-group').focus();
    }
    function renderList(container, items, empty) {
        container.replaceChildren();
        if (!items.length) { container.textContent = empty; return; }
        for (const item of items) {
            const row = document.createElement('div');
            row.className = 'ari-skill-result';
            row.dataset.passed = item.passed === undefined ? '' : String(item.passed);
            const title = document.createElement('strong');
            title.textContent = item.title;
            const detail = document.createElement('p');
            detail.textContent = item.detail;
            row.append(title, detail);
            container.append(row);
        }
    }
    function refresh() {
        if (metadata !== getContext().chatMetadata) { render(); return; }
        const state = service.view();
        const config = syncSkillBudget(store() ?? state.config);
        renderGroups();
        $('#ari-skills-enabled').checked = config.enabled;
        $('#ari-skills-enabled-label').textContent = config.enabled ? '技能检定已开启' : '技能检定已关闭';
        $('#ari-skills-status').textContent = !canEdit() ? '请先打开一个聊天，再配置主角技能。'
            : state.error || (!state.ready ? '等待 MVU 初始化当前聊天变量。' : '已连接 MVU · 技能表仅用于当前聊天');
        $('#ari-skills-errors').textContent = skillErrors(config).join('\n');
        $('#ari-skills-errors').hidden = !skillErrors(config).length;
        $('#ari-skill-range').textContent = `加值范围 ${minSkillModifier(config.diceSides)}～+${config.diceSides}；骰点＋加值 ≥ DC 为通过，相等通过。`;
        $('#ari-skill-migration-note').hidden = !config.migrationSnapshot;
        const total = skillPointTotal(config);
        const validLimit = Number.isSafeInteger(config.pointLimit) && config.pointLimit >= 0;
        $('#ari-skill-point-total').textContent = !validLimit ? `已分配 ${total} 点，请填写有效总上限。`
            : `已分配 ${total} / ${config.pointLimit} 点 · ${total > config.pointLimit ? `超出 ${total - config.pointLimit}` : `剩余 ${config.pointLimit - total}`} 点`;
        $('#ari-skill-point-total').dataset.overspent = String(validLimit && total > config.pointLimit);
        $('#ari-skill-point-suggestion').textContent = `推荐 ${recommendedPointLimit(config)} 点：${config.skills.length} 项技能 × 默认加值 ${defaultSkillModifier(config.diceSides)}。当前为${config.pointLimitMode === 'auto' ? '自动预算，随技能数量调整' : '自定义预算'}，正负加值相抵。`;
        if (config.pointLimitMode === 'auto') $('#ari-skill-point-limit').value = config.pointLimit;
        $('#ari-randomize-skills').disabled = !canEdit() || !config.skills.length || !validLimit;
        $('#ari-skill-pending-note').textContent = state.selection.issues.join('\n');
        renderList($('#ari-skill-pending'), state.selection.checks.map(check => ({ title: `${check.name} · DC ${check.dc}`,
            detail: `${check.action}\n条件：${check.conditions}` })), '暂无待检定技能');
        const chat = getContext().chat;
        const latestTurn = chat.findLast(message => message.is_user && message.extra?.auto_random_input?.skills)?.extra.auto_random_input.skills;
        const recent = service.recent();
        const legacy = recent.turn?.request.version !== SKILL_VERSION;
        renderList($('#ari-skill-results'), (recent.turn?.results ?? []).map(result => {
            const report = recent.reports.find(item => item.检定ID === result.id);
            const adopted = report?.处理 === '采用检定';
            const status = legacy ? '旧版历史结果' : adopted ? '已采用' : report ? report.处理 : '未确认';
            return {
                title: `${result.name} · 候选${result.passed ? '通过' : '失败'} · ${status}`,
                passed: adopted ? result.passed : undefined,
                detail: `${result.action}\n${legacy ? `d${result.sides} = ${result.result}，旧技能值 ${result.value}` : `${skillFormula(result)}\n条件：${result.conditions}`}\n${report?.说明 ?? ''}`,
            };
        }), '尚无检定结果');
        $('#ari-skill-last-note').textContent = [...(latestTurn?.issues ?? []), ...recent.issues].join('\n');
    }
    function renderRows() {
        const config = store() ?? normalizeSkillSettings();
        const grid = $('#ari-skills-grid');
        grid.replaceChildren();
        for (const [index, skill] of config.skills.entries()) {
            const row = document.createElement('div');
            row.className = 'ari-skill-row';
            const name = document.createElement('input');
            name.type = 'text'; name.maxLength = 60; name.value = skill.name; name.placeholder = '如：撬锁、侦查、说服';
            name.setAttribute('aria-label', `技能名称 ${index + 1}`);
            const value = document.createElement('input');
            value.type = 'number'; value.min = String(minSkillModifier(config.diceSides)); value.max = String(config.diceSides); value.step = '1'; value.value = skill.modifier ?? '';
            value.setAttribute('aria-label', `技能加值 ${index + 1}`);
            const remove = document.createElement('button');
            remove.type = 'button'; remove.textContent = '删除'; remove.setAttribute('aria-label', `删除技能 ${index + 1}`);
            for (const control of [name, value, remove]) control.disabled = !canEdit();
            name.addEventListener('input', () => { if (!isCurrent()) return; skill.name = name.value; save(); refresh(); });
            value.addEventListener('input', () => { if (!isCurrent()) return; skill.modifier = value.value === '' ? null : Number(value.value); save(); refresh(); });
            remove.addEventListener('click', () => { if (!isCurrent()) return; config.skills = config.skills.filter(item => item.id !== skill.id); save(); renderRows(); refresh(); });
            row.append(name, value, remove); grid.append(row);
        }
        $('#ari-skills-empty').hidden = config.skills.length > 0;
    }
    function render() {
        closeGroupForm();
        metadata = getContext().chatMetadata;
        if (metadata) metadata[SKILL_SETTINGS_KEY] = service.settings();
        const config = store() ?? normalizeSkillSettings();
        for (const input of $('#ari-skills-panel').querySelectorAll('input, select, button')) input.disabled = !canEdit();
        $('#ari-skills-dice').value = String(config.diceSides);
        $('#ari-skills-mode').value = config.mode;
        $('#ari-skills-max').value = String(config.maxChecks);
        $('#ari-skill-point-limit').value = config.pointLimit ?? '';
        renderRows(); refresh();
    }
    $('#ari-skill-group').addEventListener('change', event => {
        if (!isCurrent()) return;
        const group = library().groups.find(item => item.id === event.target.value);
        if (group) applyGroup(group);
        else { store().groupId = ''; save(); closeGroupForm(); refresh(); }
    });
    dialog.querySelectorAll('[data-skill-group-action]').forEach(button => button.addEventListener('click', () => openGroupForm(button.dataset.skillGroupAction)));
    $('#ari-skill-group-cancel').addEventListener('click', closeGroupForm);
    $('#ari-skill-group-form').addEventListener('submit', submitGroup);
    $('#ari-save-skill-group').addEventListener('click', () => {
        if (!isCurrent()) return;
        if (!selectedGroup()) { openGroupForm('copy'); return; }
        try { saveSkillGroup(library(), store().groupId, store()); saveLibrary(); refresh(); }
        catch (error) { $('#ari-skill-group-status').textContent = error.message; }
    });
    $('#ari-load-skill-group').addEventListener('click', () => { if (selectedGroup()) applyGroup(selectedGroup()); });
    const templateSelect = $('#ari-skill-template');
    templateSelect.replaceChildren(...SKILL_TEMPLATES.map(template => new Option(`${template.name}（${template.skills.length} 项）`, template.id)));
    const refreshTemplate = () => {
        $('#ari-skill-template-note').textContent = SKILL_TEMPLATES.find(item => item.id === templateSelect.value)?.description ?? '';
    };
    templateSelect.addEventListener('change', refreshTemplate); refreshTemplate();
    $('#ari-add-skill-template').addEventListener('click', () => {
        if (!isCurrent()) return;
        const selected = addSkillTemplate(library(), templateSelect.value);
        saveLibrary(); applyGroup(selected);
    });
    $('#ari-skills-enabled').addEventListener('change', event => { store().enabled = event.target.checked; save(); refresh(); });
    $('#ari-skills-dice').addEventListener('change', event => { store().diceSides = Number(event.target.value); save(); renderRows(); refresh(); });
    $('#ari-skills-mode').addEventListener('change', event => { store().mode = event.target.value; save(); refresh(); });
    $('#ari-skills-max').addEventListener('change', event => { store().maxChecks = Number(event.target.value); save(); refresh(); });
    $('#ari-skill-point-limit').addEventListener('input', event => {
        if (!isCurrent()) return;
        store().pointLimitMode = 'custom';
        store().pointLimit = event.target.value === '' ? null : Number(event.target.value);
        service.resetSheet(); save(); refresh();
    });
    $('#ari-use-point-suggestion').addEventListener('click', () => {
        if (!isCurrent()) return;
        store().pointLimitMode = 'auto';
        store().pointLimit = recommendedPointLimit(store());
        $('#ari-skill-point-limit').value = store().pointLimit;
        service.resetSheet(); save(); refresh();
    });
    $('#ari-randomize-skills').addEventListener('click', () => {
        if (!isCurrent()) return;
        try {
            store().skills = randomizeSkillModifiers(store());
            service.resetSheet(); save(); renderRows(); refresh();
        } catch (error) { $('#ari-skills-errors').textContent = error.message; $('#ari-skills-errors').hidden = false; }
    });
    $('#ari-add-skill').addEventListener('click', () => {
        if (!isCurrent()) return;
        const config = store();
        config.skills.push({ id: newSkillId(), name: '', modifier: defaultSkillModifier(config.diceSides) });
        save(); renderRows(); refresh();
        $('#ari-skills-grid').lastElementChild?.querySelector('input')?.focus();
    });
    render();
    return { render, refresh };
}
