import { SETTINGS_KEY } from './core.js';

export function mountAutoOracleUI(dialog, getContext, controller) {
    const $ = selector => dialog.querySelector(selector);
    const toggle = $('#ari-auto-oracle-enabled'), form = $('#ari-auto-oracle-form');
    const confirmation = $('#ari-auto-oracle-confirm');
    const interval = $('#ari-auto-oracle-interval'), prompt = $('#ari-auto-oracle-prompt');
    let metadata, settingUp = false;
    function fill() {
        const state = controller.state();
        interval.value = state.interval; prompt.value = state.prompt;
    }
    function refresh() {
        const ctx = getContext(), state = controller.state();
        if (metadata !== ctx.chatMetadata) {
            metadata = ctx.chatMetadata; settingUp = false; confirmation.close(); fill();
        }
        const ready = !!ctx.chat?.length;
        toggle.disabled = !ready;
        toggle.checked = state.enabled;
        $('#ari-auto-oracle-label').textContent = state.enabled ? '当前聊天：自动生成已开启' : '当前聊天：自动生成已关闭';
        form.hidden = !ready || (!settingUp && !state.enabled);
        $('#ari-auto-oracle-start-actions').hidden = !settingUp;
        $('#ari-auto-oracle-hint').textContent = !ready ? '请先打开一个聊天，每个聊天分别开启。'
            : settingUp ? '确认间隔和提示词后，点击“开始自动生成”将立即调用一次。取消则不调用 API。'
                : '只计新增 AI 楼层，重生成、滑动重抽和续写不计数。修改间隔会重新计数；修改提示词从下次生成生效。';
        const progress = `本轮已累计 ${state.progress}/${state.interval} 层 AI 回复。`;
        $('#ari-auto-oracle-progress').textContent = controller.busy ? `正在自动生成… ${progress}`
            : controller.pending ? `已达到生成条件，等待当前回复或神谕请求完成。${progress}`
                : state.enabled ? progress : '关闭后不会自动调用神谕，已有配置仍保留可用。';
        const last = $('#ari-auto-oracle-result');
        last.textContent = state.lastResult ? `最近结果：${state.lastResult.message}` : '';
        last.dataset.error = String(state.lastResult?.kind === 'error');
        $('#ari-auto-oracle-master-note').hidden = ctx.extensionSettings[SETTINGS_KEY].enabled;
    }
    const cancelSetup = () => { settingUp = false; confirmation.close(); fill(); refresh(); };
    const read = () => {
        const count = Number(interval.value);
        if (!interval.reportValidity() || !Number.isSafeInteger(count) || count < 1) {
            throw new Error('生成间隔须为大于等于 1 的整数。');
        }
        return { interval: count, prompt: prompt.value };
    };
    const showError = error => {
        $('#ari-auto-oracle-result').textContent = error.message;
        $('#ari-auto-oracle-result').dataset.error = 'true';
    };
    toggle.addEventListener('change', () => {
        if (!toggle.checked) { settingUp = false; controller.stop(); refresh(); return; }
        toggle.checked = false;
        confirmation.showModal();
    });
    $('#ari-auto-oracle-confirm-cancel').addEventListener('click', () => confirmation.close());
    $('#ari-auto-oracle-confirm-ok').addEventListener('click', () => {
        confirmation.close();
        settingUp = true; fill(); refresh(); interval.focus();
    });
    form.addEventListener('submit', event => {
        event.preventDefault();
        if (!settingUp) return;
        try {
            const values = read();
            settingUp = false;
            void controller.start(values);
            refresh();
        } catch (error) { settingUp = true; refresh(); showError(error); }
    });
    const update = () => {
        if (settingUp || !controller.state().enabled) return;
        try { controller.update(read()); } catch (error) { showError(error); }
    };
    interval.addEventListener('change', update);
    prompt.addEventListener('input', update);
    $('#ari-auto-oracle-setup-cancel').addEventListener('click', cancelSetup);
    dialog.addEventListener('close', cancelSetup);
    refresh();
    return { refresh };
}
