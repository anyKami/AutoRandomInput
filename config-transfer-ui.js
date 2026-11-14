import { activeGroup, SETTINGS_KEY } from './core.js';
import { effectiveRandomSettings } from './oracle-auto-state.js';
import { SKILL_GROUPS_KEY } from './skill-groups.js';
import { SKILL_SETTINGS_KEY } from './skills.js';
import { importConfigBundle, parseConfigFile, previewConfigImport, serializeConfigFile } from './config-transfer.js';
import { narrativeConfig } from './narrative.js';

function downloadFile(text, name) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a');
    const safeName = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 80) || '配置';
    link.href = url;
    link.download = `AutoRandomInput_${safeName}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function mountConfigTransferUI(dialog, getContext, onImport) {
    const $ = selector => dialog.querySelector(selector);
    const panel = $('#ari-transfer-panel');
    const random = () => getContext().extensionSettings[SETTINGS_KEY];
    const library = () => getContext().extensionSettings[SKILL_GROUPS_KEY];
    let sourceTab = 'random';
    let sourceIdentity;
    let pending;
    let fileRead = 0;

    function status(message = '', error = false) {
        const output = $('#ari-transfer-status');
        output.textContent = message;
        output.dataset.error = String(error);
        if (error) output.scrollIntoView({ block: 'nearest' });
    }
    function resetImport() {
        fileRead++;
        pending = null;
        $('#ari-import-file').value = '';
        $('#ari-import-preview').replaceChildren();
        $('#ari-import-actions').hidden = true;
    }
    function renderLibrary() {
        for (const [key, groups] of [['random', random().groups], ['skills', library().groups]]) {
            const list = $(`#ari-export-${key}-list`);
            list.replaceChildren();
            for (const group of groups) {
                const label = document.createElement('label');
                label.className = 'ari-transfer-choice';
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.dataset.kind = key;
                checkbox.value = group.id;
                const text = document.createElement('span');
                text.textContent = `${group.name} · ${key === 'random' ? `${group.rules.length} 套骰子` : `${group.skills.length} 项技能`}`;
                label.append(checkbox, text);
                list.append(label);
            }
            if (!groups.length) list.textContent = '尚无已保存的配置组。';
        }
    }
    function open() {
        sourceTab = $('#ari-tab-skills').getAttribute('aria-selected') === 'true' ? 'skills' : 'random';
        const ctx = getContext();
        const config = ctx.chatMetadata?.[SKILL_SETTINGS_KEY];
        const canExport = sourceTab === 'random' || !!(ctx.chat.length && config);
        const group = sourceTab === 'random' ? activeGroup(effectiveRandomSettings(ctx)) : library().groups.find(item => item.id === config?.groupId);
        sourceIdentity = sourceTab === 'random' ? group.id : ctx.chatMetadata;
        $('#ari-export-name').value = group?.name ?? '当前技能配置';
        $('#ari-export-name').disabled = !canExport;
        $('#ari-export-current').disabled = !canExport;
        $('#ari-export-current-note').textContent = !canExport ? '请先打开一个聊天，再导出当前技能配置。'
            : sourceTab === 'skills' ? '导出当前聊天正在编辑的技能表，包含尚未保存到组的修改；不会更新组库。'
                : '导出当前随机指令组，包含隐藏命令、范围表和每套骰子的开关。';
        resetImport(); renderLibrary(); status();
        $('.ari-tabs').hidden = true;
        $('#ari-random-panel').hidden = true;
        $('#ari-narrative-panel').hidden = true;
        $('#ari-skills-panel').hidden = true;
        $('#ari-settings-panel').hidden = true;
        panel.hidden = false;
        $('#ari-transfer-toggle').setAttribute('aria-expanded', 'true');
        panel.scrollTop = 0;
        $('#ari-transfer-back').focus();
    }
    function close(focus = true) {
        resetImport();
        panel.hidden = true;
        $('.ari-tabs').hidden = false;
        for (const name of ['random', 'narrative', 'skills', 'settings']) {
            $(`#ari-${name}-panel`).hidden = $(`#ari-tab-${name}`).getAttribute('aria-selected') !== 'true';
        }
        $('#ari-transfer-toggle').setAttribute('aria-expanded', 'false');
        if (focus) $('#ari-transfer-toggle').focus();
    }
    const run = action => async () => {
        try { await action(); }
        catch (error) { status(error.message, true); }
    };

    $('#ari-transfer-toggle').addEventListener('click', () => panel.hidden ? open() : close());
    $('#ari-transfer-back').addEventListener('click', () => close());
    dialog.addEventListener('close', () => close(false));
    dialog.addEventListener('cancel', event => {
        if (!panel.hidden) { event.preventDefault(); close(); }
    });
    $('#ari-export-current').addEventListener('click', run(() => {
        const ctx = getContext();
        const name = $('#ari-export-name').value.trim();
        let text;
        if (sourceTab === 'skills') {
            if (sourceIdentity !== ctx.chatMetadata || !ctx.chat.length) throw new Error('当前聊天已切换，请重新打开导入 / 导出面板。');
            text = serializeConfigFile([], [{ ...ctx.chatMetadata[SKILL_SETTINGS_KEY], name }]);
        } else {
            const group = activeGroup(effectiveRandomSettings(ctx));
            if (group.id !== sourceIdentity) throw new Error('当前配置已切换，请重新打开导入 / 导出面板。');
            const config = narrativeConfig(ctx);
            if (config.enabled) {
                const groups = [config.longGroupId, config.sceneGroupId].filter((id, i, ids) => id && ids.indexOf(id) === i)
                    .map(id => random().groups.find(item => item.id === id)).filter(Boolean);
                if (!groups.length) throw new Error('当前剧情没有可导出的绑定组。');
                text = serializeConfigFile(groups);
            } else text = serializeConfigFile([{ ...group, name }]);
        }
        downloadFile(text, name);
        status('已生成当前配置文件。');
    }));
    $('#ari-export-all').addEventListener('click', () => {
        panel.querySelectorAll('.ari-transfer-choice input').forEach(input => { input.checked = true; });
    });
    $('#ari-export-none').addEventListener('click', () => {
        panel.querySelectorAll('.ari-transfer-choice input').forEach(input => { input.checked = false; });
    });
    $('#ari-export-selected').addEventListener('click', run(() => {
        const randomGroups = [], skillGroups = [];
        for (const checkbox of panel.querySelectorAll('.ari-transfer-choice input:checked')) {
            const isRandom = checkbox.dataset.kind === 'random';
            const group = (isRandom ? random().groups : library().groups).find(item => item.id === checkbox.value);
            if (!group) throw new Error('配置组库已变化，请重新打开面板选择。');
            (isRandom ? randomGroups : skillGroups).push(group);
        }
        const text = serializeConfigFile(randomGroups, skillGroups);
        const count = randomGroups.length + skillGroups.length;
        downloadFile(text, count === 1 ? [...randomGroups, ...skillGroups][0].name : '配置组合集');
        status(`已生成包含 ${count} 个配置组的文件。`);
    }));
    $('#ari-import-file').addEventListener('change', async event => {
        const file = event.target.files[0];
        const ticket = ++fileRead;
        pending = null;
        $('#ari-import-preview').replaceChildren();
        $('#ari-import-actions').hidden = true;
        status(file ? '正在读取配置文件…' : '');
        if (!file) return;
        try {
            const text = await file.text();
            if (ticket !== fileRead || panel.hidden) return;
            const parsed = parseConfigFile(text);
            const preview = previewConfigImport(parsed, random().groups, library().groups);
            for (const [key, title] of [['randomGroups', '随机指令'], ['skillGroups', '技能配置']]) {
                preview[key].forEach((group, i) => {
                    const item = document.createElement('li');
                    const oldName = parsed[key][i].name;
                    const count = key === 'randomGroups' ? `${group.rules.length} 套骰子` : `${group.skills.length} 项技能`;
                    item.textContent = `${title} · ${oldName}${oldName === group.name ? '' : ` → ${group.name}`} · ${count}`;
                    $('#ari-import-preview').append(item);
                });
            }
            pending = parsed;
            $('#ari-import-actions').hidden = false;
            status('文件校验通过。确认后加入配置库，再由你切换或载入。');
        } catch (error) {
            if (ticket === fileRead && !panel.hidden) status(error.message, true);
        }
    });
    $('#ari-import-cancel').addEventListener('click', () => { resetImport(); status('已取消导入。'); });
    $('#ari-import-confirm').addEventListener('click', run(() => {
        if (!pending) return;
        const added = importConfigBundle(pending, random(), library());
        // Only the shared libraries change. Do not load a sheet or reset pending checks.
        getContext().saveSettingsDebounced();
        resetImport(); renderLibrary(); onImport();
        status(`已加入 ${added.randomGroups.length} 个随机指令组、${added.skillGroups.length} 个技能配置组：${[...added.randomGroups, ...added.skillGroups].map(group => group.name).join('、')}。`);
    }));
    $('#ari-download-template').addEventListener('click', run(async () => {
        const response = await fetch(new URL('./templates/config-example.json', import.meta.url));
        if (!response.ok) throw new Error(`读取示例模板失败：HTTP ${response.status}`);
        const text = await response.text();
        parseConfigFile(text);
        downloadFile(text, '示例模板');
        status('已生成示例模板，可直接导入或编辑后使用。');
    }));
}
