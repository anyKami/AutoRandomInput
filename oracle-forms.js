import { ORACLE_FIELDS, ORACLE_SETTINGS_KEY, normalizeOracleSettings } from './oracle-config.js';

export function mountOracleFields(container, prefix, fields = ORACLE_FIELDS) {
    for (const field of fields) {
        const label = document.createElement('label'); label.className = 'ari-oracle-field';
        const span = document.createElement('span'); span.textContent = field.label;
        const input = document.createElement(field.options ? 'select' : 'input');
        input.id = `${prefix}-${field.key}`; input.dataset.field = field.key;
        if (field.options) input.replaceChildren(...field.options.map(([value, name]) => new Option(name, value)));
        else {
            input.type = field.type;
            if (field.type === 'number') { input.min = field.min; input.max = field.max; input.step = '1'; input.required = true; }
        }
        label.append(span, input); container.append(label);
    }
    return {
        fill(value) {
            const values = normalizeOracleSettings(value);
            for (const f of fields) {
                const node = container.querySelector(`[data-field="${f.key}"]`);
                if (f.type === 'checkbox') node.checked = values[f.key]; else node.value = values[f.key];
            }
        },
        read() {
            const values = {};
            for (const f of fields) {
                const node = container.querySelector(`[data-field="${f.key}"]`);
                if (!node.checkValidity()) throw new Error(`请修正“${f.label}”。`);
                values[f.key] = f.type === 'checkbox' ? node.checked : f.options
                    ? f.options.find(([key]) => String(key) === node.value)?.[0] : Number(node.value);
                if (values[f.key] === undefined) throw new Error(`请选择“${f.label}”。`);
            }
            return values;
        },
    };
}

export function mountOracleSettings(dialog, getContext, service) {
    const $ = selector => dialog.querySelector(selector);
    const fields = mountOracleFields($('#ari-oracle-settings'), 'ari-default');
    const status = $('#ari-oracle-settings-status');
    const refresh = () => {
        const caps = service.capabilities();
        $('#ari-oracle-connection').textContent = caps.ready ? `神谕接口可用 · ${caps.connection || '模型连接由神谕管理'}`
            : `神谕尚未就绪或缺少接口：${caps.missing.join('、')}。手工配置仍可使用。`;
    };
    const load = () => fields.fill(getContext().extensionSettings[ORACLE_SETTINGS_KEY]);
    const saveFields = () => {
        try {
            getContext().extensionSettings[ORACLE_SETTINGS_KEY] = normalizeOracleSettings(fields.read());
            getContext().saveSettingsDebounced(); status.textContent = '生成默认设置已保存。'; status.dataset.error = 'false';
        } catch (error) { status.textContent = error.message; status.dataset.error = 'true'; }
    };
    $('#ari-oracle-settings').addEventListener('input', saveFields);
    $('#ari-oracle-settings').addEventListener('change', saveFields);
    $('#ari-oracle-reset').addEventListener('click', () => {
        getContext().extensionSettings[ORACLE_SETTINGS_KEY] = normalizeOracleSettings();
        getContext().saveSettingsDebounced(); load(); status.dataset.error = 'false'; status.textContent = '已恢复神谕生成默认设置，配置组和聊天技能表保留。';
    });
    $('#ari-oracle-probe').addEventListener('click', refresh);
    document.addEventListener('story-oracle-ready', refresh);
    load(); refresh();
    return { refresh };
}
