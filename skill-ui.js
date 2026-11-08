import { SKILL_SETTINGS_KEY, newSkillId, normalizeSkillSettings, skillErrors } from './skills.js';

export function mountSkillUI(dialog, getContext, service) {
    const $ = selector => dialog.querySelector(selector);
    let metadata;
    const store = () => getContext().chatMetadata?.[SKILL_SETTINGS_KEY];
    const canEdit = () => !!getContext().chatMetadata && getContext().chat.length > 0;
    const save = () => {
        const ctx = getContext();
        if (metadata !== ctx.chatMetadata) { render(); return; }
        if (ctx.saveMetadataDebounced) ctx.saveMetadataDebounced();
        else if (ctx.saveMetadata) void ctx.saveMetadata();
    };
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
        const config = store() ?? state.config;
        $('#ari-skills-enabled').checked = config.enabled;
        $('#ari-skills-enabled-label').textContent = config.enabled ? '技能检定已开启' : '技能检定已关闭';
        $('#ari-skills-status').textContent = !canEdit() ? '请先打开一个聊天，再配置主角技能。'
            : state.error || (!state.ready ? '等待 MVU 初始化当前聊天变量。' : '已连接 MVU · 技能表仅用于当前聊天');
        $('#ari-skills-errors').textContent = skillErrors(config).join('\n');
        $('#ari-skills-errors').hidden = !skillErrors(config).length;
        $('#ari-skill-range').textContent = `技能值范围 0～${config.diceSides}；骰点 ≤ 技能值为通过。`;
        $('#ari-skill-pending-note').textContent = state.selection.issues.join('\n');
        renderList($('#ari-skill-pending'), state.selection.checks.map(check => ({ title: check.name, detail: check.action })), '暂无待检定技能');
        const last = getContext().chat.findLast(message => message.is_user && message.extra?.auto_random_input?.skills)?.extra.auto_random_input.skills;
        renderList($('#ari-skill-results'), (last?.results ?? []).map(result => ({
            title: `${result.name} · ${result.passed ? '通过' : '失败'}`, passed: result.passed,
            detail: `${result.action}\nd${result.sides} = ${result.result}，技能值 ${result.value}`,
        })), '尚无检定结果');
        $('#ari-skill-last-note').textContent = last?.issues?.join('\n') ?? '';
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
            value.type = 'number'; value.min = '0'; value.max = String(config.diceSides); value.step = '1'; value.value = skill.value ?? '';
            value.setAttribute('aria-label', `技能值 ${index + 1}`);
            const remove = document.createElement('button');
            remove.type = 'button'; remove.textContent = '删除'; remove.setAttribute('aria-label', `删除技能 ${index + 1}`);
            for (const control of [name, value, remove]) control.disabled = !canEdit();
            name.addEventListener('input', () => { skill.name = name.value; save(); refresh(); });
            value.addEventListener('input', () => { skill.value = value.value === '' ? null : Number(value.value); save(); refresh(); });
            remove.addEventListener('click', () => { config.skills = config.skills.filter(item => item.id !== skill.id); save(); renderRows(); refresh(); });
            row.append(name, value, remove); grid.append(row);
        }
        $('#ari-skills-empty').hidden = config.skills.length > 0;
    }
    function render() {
        metadata = getContext().chatMetadata;
        if (metadata) metadata[SKILL_SETTINGS_KEY] = normalizeSkillSettings(metadata[SKILL_SETTINGS_KEY]);
        const config = store() ?? normalizeSkillSettings();
        for (const input of $('#ari-skills-panel').querySelectorAll('input, select, button')) input.disabled = !canEdit();
        $('#ari-skills-dice').value = String(config.diceSides);
        $('#ari-skills-mode').value = config.mode;
        $('#ari-skills-max').value = String(config.maxChecks);
        renderRows(); refresh();
    }
    $('#ari-skills-enabled').addEventListener('change', event => { store().enabled = event.target.checked; save(); refresh(); });
    $('#ari-skills-dice').addEventListener('change', event => { store().diceSides = Number(event.target.value); save(); renderRows(); refresh(); });
    $('#ari-skills-mode').addEventListener('change', event => { store().mode = event.target.value; save(); refresh(); });
    $('#ari-skills-max').addEventListener('change', event => { store().maxChecks = Number(event.target.value); save(); refresh(); });
    $('#ari-add-skill').addEventListener('click', () => {
        const config = store();
        config.skills.push({ id: newSkillId(), name: '', value: Math.floor(config.diceSides / 2) });
        save(); renderRows(); refresh();
        $('#ari-skills-grid').lastElementChild?.querySelector('input')?.focus();
    });
    render();
    return { render, refresh };
}
