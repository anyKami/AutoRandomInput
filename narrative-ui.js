import { SETTINGS_KEY, NARRATIVE_TOPICS, normalizeCommandMetadata } from './core.js';
import { foldNarrative, narrativeConfig, narrativeId, NARRATIVE_KEY, saveNarrativeConfig } from './narrative.js';

const TOPIC_LABELS = { daily: '日常', relationship: '关系', clue: '线索', opportunity: '机会', obstacle: '阻碍', conflict: '冲突', callback: '旧事回访', atmosphere: '氛围', general: '未分类' };
export function mountMetadataEditor(container, getMeta, setMeta, { persistentAllowed = false, getThreads = () => [] } = {}) {
    const details = document.createElement('details');
    const summary = document.createElement('summary'); summary.textContent = '剧情增强设置'; details.append(summary);
    const meta = normalizeCommandMetadata(getMeta());
    const row = document.createElement('div'); row.className = 'ari-group-actions'; details.append(row);
    const select = (label, values, current, changed) => {
        const wrapper = document.createElement('label'); wrapper.textContent = label;
        const input = document.createElement('select'); input.setAttribute('aria-label', label); values.forEach(([value, text]) => input.append(new Option(text, value)));
        input.value = current; input.addEventListener('change', () => changed(input.value)); wrapper.append(input); row.append(wrapper);
    };
    const save = () => setMeta(structuredClone(meta));
    select('效果', [['event','实质变化'],['detail','氛围细节']], meta.effect, value => { meta.effect = value; save(); });
    select('主题', NARRATIVE_TOPICS.map(topic => [topic, TOPIC_LABELS[topic]]), meta.topic, value => { meta.topic = value; save(); });
    const threads = getThreads();
    select('剧情线', [['','无关联'], ...threads.map(thread => [thread.id, thread.title])], meta.threadId ?? '', value => {
        if (value) { meta.threadId = value; meta.conditions = meta.conditions.map(condition => condition?.type === 'thread' && !condition.threadId ? { ...condition, threadId: value } : condition); delete meta.needsBinding; } else delete meta.threadId; save();
    });
    if (meta.needsBinding) { const warning = document.createElement('p'); warning.textContent = '此指令需要重新绑定剧情线后才能触发。'; details.append(warning); }
    if (persistentAllowed) {
        const label = document.createElement('label'), checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = meta.persistent === true;
        checkbox.addEventListener('change', () => { meta.persistent = checkbox.checked; save(); }); label.append(checkbox, ' 显式常驻（不占预算）'); details.append(label);
    }
    const heading = document.createElement('p'); heading.textContent = '条件：全部满足才触发'; details.append(heading);
    const conditions = document.createElement('div'); details.append(conditions);
    const draw = () => {
        conditions.replaceChildren();
        meta.conditions.forEach((condition, index) => {
            const item = document.createElement('div'), kind = document.createElement('select'); kind.setAttribute('aria-label', `条件 ${index + 1} 类型`);
            [['stat','MVU 变量'],['label','场景标签'],['thread','剧情线状态']].forEach(([value,text]) => kind.append(new Option(text,value))); kind.value = condition.type;
            kind.addEventListener('change', () => { meta.conditions[index] = kind.value === 'stat' ? { type:'stat', path:'stat_data.', op:'eq', value:'' } : kind.value === 'thread' ? { type:'thread', threadId:'', status:'active' } : { type:'label', value:'' }; save(); draw(); }); item.append(kind);
            const field = (placeholder, value, change) => { const input = document.createElement('input'); input.placeholder = placeholder; input.setAttribute('aria-label', `条件 ${index + 1} ${placeholder}`); input.value = value ?? ''; input.addEventListener('input', () => { change(input.value); save(); }); item.append(input); };
            if (condition.type === 'stat') {
                field('stat_data.路径', condition.path, value => { condition.path = value; });
                const op = document.createElement('select'); op.setAttribute('aria-label', `条件 ${index + 1} 运算符`); ['eq','ne','gt','gte','lt','lte','contains'].forEach(value => op.append(new Option(value,value))); op.value = condition.op; op.addEventListener('change', () => { condition.op = op.value; save(); }); item.append(op);
                const type = document.createElement('select'); type.setAttribute('aria-label', `条件 ${index + 1} 值类型`); [['string','文字'],['number','数字'],['boolean','布尔']].forEach(([value,text]) => type.append(new Option(text,value))); type.value = typeof condition.value; item.append(type);
                const value = document.createElement('input'); value.placeholder = '比较值'; value.setAttribute('aria-label', `条件 ${index + 1} 比较值`); value.value = String(condition.value ?? ''); const update = () => { const raw = value.value; const valid = type.value === 'number' ? raw.trim() !== '' && Number.isFinite(Number(raw)) : type.value === 'boolean' ? ['true','false'].includes(raw) : true; condition.value = !valid ? '' : type.value === 'number' ? Number(raw) : type.value === 'boolean' ? raw === 'true' : raw; value.setCustomValidity(valid ? '' : '请输入有效的比较值'); save(); }; type.addEventListener('change', update); value.addEventListener('input', update); item.append(value);
            } else if (condition.type === 'label') field('场景标签', condition.value, value => { condition.value = value; });
            else if (condition.type === 'thread') {
                const thread = document.createElement('select'); thread.setAttribute('aria-label', `条件 ${index + 1} 剧情线`); thread.append(new Option('选择剧情线','')); getThreads().forEach(t => thread.append(new Option(t.title,t.id))); thread.value = condition.threadId ?? ''; thread.addEventListener('change', () => { condition.threadId = thread.value; save(); }); item.append(thread);
                const status = document.createElement('select'); status.setAttribute('aria-label', `条件 ${index + 1} 剧情线状态`); [['active','活跃'],['paused','暂停'],['completed','已结束']].forEach(([value,text]) => status.append(new Option(text,value))); status.value = condition.status; status.addEventListener('change', () => { condition.status = status.value; save(); }); item.append(status);
            }
            const remove = document.createElement('button'); remove.type='button'; remove.textContent='删除条件'; remove.addEventListener('click', () => { meta.conditions.splice(index,1); save(); draw(); }); item.append(remove); conditions.append(item);
        });
    }; draw();
    const add = document.createElement('button'); add.type='button'; add.textContent='＋ 添加条件'; add.addEventListener('click', () => { meta.conditions.push({ type:'stat', path:'stat_data.', op:'eq', value:'' }); save(); draw(); }); details.append(add);
    container.append(details);
}

export function mountNarrativeUI(dialog, getContext, onChange = () => {}) {
    const panel = dialog.querySelector('#ari-narrative-panel');
    const refresh = () => {
        const ctx = getContext(), config = narrativeConfig(ctx), state = foldNarrative(ctx.chat), store = ctx.extensionSettings[SETTINGS_KEY];
        panel.replaceChildren();
        const title = document.createElement('h3'); title.textContent = '剧情增强'; panel.append(title);
        const note = document.createElement('p'); note.textContent = '按当前聊天保存。剧情线由 AI 根据正文记录，需启用 MVU；记录并非自动语义核验。'; panel.append(note);
        const save = () => { config.configVersion++; saveNarrativeConfig(ctx, config); onChange(); };
        const check = (text, key) => { const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.checked = config[key]; input.addEventListener('change', () => { config[key] = input.checked; save(); refresh(); }); label.append(input, ` ${text}`); panel.append(label, document.createElement('br')); };
        check('启用剧情增强模式', 'enabled'); check('启用持续剧情线（需要 MVU）', 'threadsEnabled');
        const groupHint = document.createElement('p'); groupHint.textContent = config.longGroupId ? '' : '请绑定长期组；未绑定时长期指令暂停。'; panel.append(groupHint);
        const groupSelect = (labelText, key, optional) => { const label = document.createElement('label'); label.textContent = labelText; const select = document.createElement('select'); select.setAttribute('aria-label', labelText.trim());
            select.append(new Option(optional ? '不绑定' : '请选择', '')); store.groups.forEach(group => select.append(new Option(group.name, group.id)));
            if (config[key] && !store.groups.some(group => group.id === config[key])) select.append(new Option('已删除的配置组（暂停）', config[key]));
            select.value = config[key] ?? ''; select.addEventListener('change', () => { const other = key === 'longGroupId' ? config.sceneGroupId : config.longGroupId; if (select.value && select.value === other) { select.value = config[key] ?? ''; groupHint.textContent = '长期组与场景组不能相同，请选择其他配置组。'; return; }
                config[key] = select.value || null; if (key === 'sceneGroupId') config.sceneGroupRevision = select.value ? config.sceneRevision : null; save(); refresh(); }); label.append(select); panel.append(label, document.createElement('br')); };
        groupSelect('长期组 ', 'longGroupId', false); groupSelect('场景组 ', 'sceneGroupId', true);
        for (const [key, labelText] of [['eventBudget','实质变化预算'],['detailBudget','氛围细节预算']]) { const label = document.createElement('label'); label.textContent = labelText; const select = document.createElement('select'); select.setAttribute('aria-label', labelText); for (let n=0;n<=3;n++) select.append(new Option(String(n), String(n))); select.value = String(config[key]); select.addEventListener('change', () => { config[key] = Number(select.value); save(); }); label.append(select); panel.append(label); }
        const field = (labelText, key) => { const label = document.createElement('label'); label.textContent = labelText; const input = document.createElement('input'); input.setAttribute('aria-label', labelText.trim()); input.value = config[key]; input.addEventListener('input', () => { config[key] = input.value; save(); }); label.append(input); panel.append(label, document.createElement('br')); };
        field('MVU 场景路径（stat_data.开头，可留空） ', 'scenePath'); field('神谕偏好 ', 'preferences');
        const scene = document.createElement('button'); scene.type = 'button'; scene.textContent = '结束 / 切换场景'; scene.addEventListener('click', () => { config.sceneRevision = narrativeId(); config.sceneValue = null; save(); refresh(); }); panel.append(scene);
        const quiet = document.createElement('button'); quiet.type = 'button'; quiet.textContent = config.quietNext ? '取消下轮安静' : '下轮安静（实质变化预算为 0）'; quiet.addEventListener('click', () => { config.quietNext = !config.quietNext; save(); refresh(); }); panel.append(quiet);
        const labels = document.createElement('input'); labels.value = config.labels.join(', '); labels.placeholder = '场景标签，逗号分隔'; labels.setAttribute('aria-label', '场景标签'); labels.addEventListener('input', () => { config.labels = labels.value.split(/[,，]/).map(x => x.trim()).filter(Boolean); save(); }); panel.append(labels);
        const block = document.createElement('div'); block.textContent = '近期屏蔽主题（后续 5 个成功发送）：';
        for (const topic of NARRATIVE_TOPICS.filter(t => t !== 'general')) { const button = document.createElement('button'); button.type = 'button'; button.textContent = config.blockedTopics[topic] ? `${TOPIC_LABELS[topic]} ${config.blockedTopics[topic]} · 撤销` : TOPIC_LABELS[topic]; button.addEventListener('click', () => { if (config.blockedTopics[topic]) delete config.blockedTopics[topic]; else config.blockedTopics[topic] = 5; save(); refresh(); }); block.append(button); } panel.append(block);
        const preferences = document.createElement('div'); preferences.textContent = '主题反馈（神谕软要求，依次点击切换）：';
        for (const topic of NARRATIVE_TOPICS.filter(t => t !== 'general')) { const button = document.createElement('button'); button.type='button'; const preference = config.topicPreferences[topic]; button.textContent = `${TOPIC_LABELS[topic]}：${preference === 'prefer' ? '偏好' : preference === 'reduce' ? '减少' : '无'}`; button.addEventListener('click', () => { if (!preference) config.topicPreferences[topic] = 'prefer'; else if (preference === 'prefer') config.topicPreferences[topic] = 'reduce'; else delete config.topicPreferences[topic]; save(); refresh(); }); preferences.append(button); } panel.append(preferences);
        const heading = document.createElement('h4'); heading.textContent = `剧情线（活跃 ${state.threads.filter(t => t.status === 'active').length}/3）`; panel.append(heading);
        const turnIndex = ctx.chat.findLastIndex(message => message.is_user && message.extra?.[SETTINGS_KEY]?.narrative);
        if (turnIndex >= 0) {
            const record = ctx.chat[turnIndex].extra[SETTINGS_KEY], reportList = []; let reportCount = 0;
            for (let index = turnIndex + 1; index < ctx.chat.length && !ctx.chat[index].is_user; index++) {
                const reply = ctx.chat[index], report = reply.extra?.[NARRATIVE_KEY]?.swipes?.[String(reply.swipe_id ?? 0)]?.report;
                if (report) { reportCount++; reportList.push(...(report.uses ?? [])); }
            }
            const status = document.createElement('p'); status.textContent = `最近一轮：${record.narrative.injected ? '已注入' : '未注入'}；${reportCount ? `已收到 ${reportCount} 条 AI 回报` : '未确认采用情况'}`; panel.append(status);
            const reasons = { blank:'空白', invalid_ranges:'范围错误', conditions:'条件不满足或 MVU 未就绪', needs_binding:'需要绑定', thread_inactive:'剧情线未活跃', blocked_topic:'主题屏蔽', cooldown:'主题冷却', budget:'预算不足', duplicate_topic:'主题重复', duplicate_thread:'剧情线重复', selected:'选中', persistent:'常驻' };
            for (const roll of record.rolls ?? []) { const item = document.createElement('p'); const uses = reportList.filter(entry => entry.candidateId === roll.candidateId); const labels = [...new Set(uses.map(use => use.status === 'adopted' ? 'AI 报告采用' : 'AI 报告未采用'))]; item.textContent = `${roll.ruleName || '未命名指令'} · d${roll.sides ?? '?'} = ${roll.result ?? '未投'} · ${reasons[roll.reason] ?? '未记录筛选原因'} · ${roll.command || '无指令'}${labels.length ? ` · ${labels.join('、')}` : ['selected','persistent'].includes(roll.reason) ? ' · 未确认' : ''}`; panel.append(item); }
        }
        for (const thread of state.threads) { const section = document.createElement('section'), text = document.createElement('p'); text.textContent = `${thread.title} · ${{active:'活跃',paused:'暂停',completed:'已结束'}[thread.status]}：${thread.question}`; section.append(text);
            const origin = document.createElement('p'); origin.textContent = `起因：${thread.cause}；${thread.causeUserCorrected ? '用户纠正' : `正文证据：${thread.evidence}`}`; section.append(origin);
            for (const fact of thread.facts) { const line = document.createElement('p'); line.textContent = `${fact.user ? '用户纠正' : 'AI 根据正文记录'}：${fact.fact}${fact.evidence ? `（证据：${fact.evidence}）` : ''}`; section.append(line); }
            const correctionTarget = document.createElement('select'); correctionTarget.setAttribute('aria-label', `${thread.title} 纠正对象`); correctionTarget.append(new Option('起因','cause'), new Option('未解决问题','question'));
            thread.facts.forEach((fact, index) => correctionTarget.append(new Option(`进展 ${index + 1}：${fact.fact}`, String(index))));
            if (thread.facts.length) correctionTarget.value = String(thread.facts.length - 1);
            const correction = document.createElement('input'); correction.placeholder = '输入纠正后的内容'; correction.setAttribute('aria-label', `${thread.title} 纠正内容`); section.append(correctionTarget, correction);
            for (const type of thread.status === 'active' ? ['pause','complete','correct'] : thread.status === 'paused' ? ['resume','complete','correct'] : ['correct']) { const button = document.createElement('button'); button.type='button'; button.textContent = {pause:'暂停',resume:'恢复',complete:'结束',correct:'保存纠正'}[type]; button.addEventListener('click', () => {
                if (type === 'resume' && state.threads.filter(t => t.status === 'active').length >= 3) { globalThis.toastr?.warning('最多同时活跃 3 条剧情线。'); return; }
                const replyIndex = ctx.chat.findLastIndex(message => !message.is_user && !message.is_system), reply = ctx.chat[replyIndex]; if (!reply) return;
                const fact = type === 'correct' ? correction.value.trim() : undefined; if (type === 'correct' && !fact) { correction.focus(); return; }
                const target = correctionTarget.value;
                reply.extra ??= {}; const data = reply.extra[NARRATIVE_KEY] ??= { uid: narrativeId(), swipes: {} }, swipe = String(reply.swipe_id ?? 0); const entry = data.swipes[swipe] ??= {};
                const baseRevision = foldNarrative(ctx.chat, replyIndex + 1).revision;
                (entry.actions ??= []).push({ type, threadId: thread.id, baseRevision, ...(fact ? { fact, ...(['cause','question'].includes(target) ? { target } : { factIndex: Number(target) }) } : {}) }); void ctx.saveChat(); refresh();
            }); section.append(button); } panel.append(section); }
    };
    refresh(); return { refresh };
}
