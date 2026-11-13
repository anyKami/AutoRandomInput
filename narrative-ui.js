import { NARRATIVE_TOPICS, normalizeCommandMetadata } from './core.js';
import { mountNarrativePanel } from './narrative-panel.js';

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
    select('效果', [['event','剧情推动'],['detail','氛围描写']], meta.effect, value => { meta.effect = value; save(); });
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

export function mountNarrativeUI(dialog, getContext, onChange = () => {}, options = {}) {
    return mountNarrativePanel(dialog, getContext, onChange, options);
}
