import { SETTINGS_KEY, NARRATIVE_TOPICS } from './core.js';
import { foldNarrative, narrativeConfig, narrativeId, NARRATIVE_KEY, readStatPath, saveNarrativeConfig, validateNarrativeReport } from './narrative.js';
import { autoOracleState } from './oracle-auto-state.js';

const TOPICS = { daily:'日常', relationship:'关系', clue:'线索', opportunity:'机会', obstacle:'阻碍', conflict:'冲突', callback:'旧事回访', atmosphere:'氛围', general:'未分类' };
const REASONS = { blank:'空白', invalid_ranges:'范围错误', conditions:'条件不满足或 MVU 未就绪', needs_binding:'需要绑定', thread_inactive:'剧情线未活跃', blocked_topic:'主题屏蔽', cooldown:'主题冷却', budget:'达到上限', duplicate_topic:'主题重复', duplicate_thread:'故事线重复', selected:'已选中', persistent:'固定要求' };
const el = (tag, text, className) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; };
const button = (text, click, cls) => { const node = el('button', text, cls); node.type = 'button'; node.addEventListener('click', click); return node; };
const card = (title, text) => { const node = el('section', null, 'ari-story-card'); node.append(el('h4', title)); if (text) node.append(el('p', text, 'ari-story-help')); return node; };
const details = (title, key, open) => { const node = el('details', null, 'ari-story-details'); node.dataset.storyDetails = key; node.open = !!open; node.append(el('summary', title)); return node; };
const named = (name, control, help) => { const wrapper = el('label', null, 'ari-story-field'); wrapper.append(el('span', name)); if (help) wrapper.append(el('small', help)); control.setAttribute('aria-label', name); wrapper.append(control); return wrapper; };

// Read only: the same branch gate and report validation used by the ledger.
export function visibleTurnReports(chat, turnIndex) {
    const turn = chat[turnIndex]?.extra?.[SETTINGS_KEY]?.narrative;
    if (!turn || foldNarrative(chat, turnIndex).revision !== turn.baseRevision) return [];
    const reports = [];
    for (let i = turnIndex + 1; i < chat.length && !chat[i].is_user; i++) {
        const message = chat[i]; if (message.is_system) continue;
        const report = message.extra?.[NARRATIVE_KEY]?.swipes?.[String(message.swipe_id ?? 0)]?.report;
        if (!report) continue;
        const checked = validateNarrativeReport(report, turn, message.mes);
        if (checked.valid) reports.push(checked);
    }
    return reports;
}

export function mountNarrativePanel(dialog, getContext, onChange = () => {}, options = {}) {
    const panel = dialog.querySelector('#ari-narrative-panel');
    let view = 'home', chatIdentity, chatKey, expanded = {}, pending = false, pointerInteraction = false, correctionDrafts = new Map(), scrollByView = { home: 0, settings: 0 };
    const snapshotOpen = () => { panel.querySelectorAll('[data-story-details]').forEach(node => { expanded[node.dataset.storyDetails] = node.open; }); };
    const changeView = next => { scrollByView[view] = panel.scrollTop; snapshotOpen(); view = next; refresh({ force:true, restoreView:true }); };
    const refresh = ({ force = false, restoreView = false } = {}) => {
        const ctx = getContext();
        const key = JSON.stringify([ctx.groupId != null ? null : ctx.characterId, ctx.groupId, ctx.chatId]);
        const changedChat = ctx.chatMetadata !== chatIdentity || key !== chatKey;
        if (changedChat) { chatIdentity = ctx.chatMetadata; chatKey = key; view = 'home'; expanded = {}; correctionDrafts = new Map(); scrollByView = { home:0, settings:0 }; force = true; }
        if (!force && panel.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '')) { pending = true; return; }
        pending = false; if (!changedChat && !restoreView) snapshotOpen(); const scroll = changedChat ? 0 : restoreView ? scrollByView[view] : panel.scrollTop;
        const config = narrativeConfig(ctx), state = foldNarrative(ctx.chat), store = ctx.extensionSettings[SETTINGS_KEY], auto = autoOracleState(ctx);
        let baseline = structuredClone(config);
        const active = state.threads.filter(t => t.status === 'active'), other = state.threads.filter(t => t.status !== 'active');
        const save = () => {
            const latest = narrativeConfig(ctx);
            for (const key of Object.keys(config)) {
                if (key === 'configVersion' || JSON.stringify(config[key]) === JSON.stringify(baseline[key])) continue;
                if (['blockedTopics', 'topicPreferences'].includes(key)) {
                    for (const name of new Set([...Object.keys(baseline[key]), ...Object.keys(config[key])])) {
                        if (baseline[key][name] === config[key][name]) continue;
                        if (Object.hasOwn(config[key], name)) latest[key][name] = config[key][name]; else delete latest[key][name];
                    }
                } else latest[key] = structuredClone(config[key]);
            }
            latest.configVersion++; saveNarrativeConfig(ctx, latest); Object.assign(config, latest); baseline = structuredClone(latest); onChange();
        };
        const section = (title, description) => card(title, description);
        const data = id => store.groups.find(group => group.id === id);
        const mvu = options.mvuState?.() ?? { ready: false }, mvuReady = !!mvu.ready;
        const sceneValue = mvuReady && config.scenePath ? readStatPath(mvu.data?.stat_data, config.scenePath) : undefined;
        const sceneChanged = !!config.scenePath && sceneValue !== undefined && JSON.stringify(sceneValue) !== JSON.stringify(config.sceneValue);
        panel.replaceChildren(); panel.classList.add('ari-story-panel');
        const header = el('div', null, 'ari-story-header'); header.append(el('h3', view === 'home' ? '剧情增强' : '剧情设置'));
        header.append(button(view === 'home' ? '剧情设置' : '返回剧情', () => changeView(view === 'home' ? 'settings' : 'home'))); panel.append(header);
        if (view === 'home') {
            const status = section('运行状态');
            const scene = !config.sceneGroupId ? '未绑定' : !data(config.sceneGroupId) ? '配置组已删除，暂停' : config.sceneGroupRevision !== config.sceneRevision ? '已过期，暂停' : config.scenePath && sceneValue === undefined ? '场景变量未就绪，状态待确认' : sceneChanged ? '场景已变化，发送时暂停' : '当前场景有效';
            const toggles = el('div', null, 'ari-story-toggles');
            for (const [key, label] of [['enabled','启用剧情增强'],['threadsEnabled','记录故事后续']]) { const input = el('input'); input.type = 'checkbox'; input.checked = config[key]; input.addEventListener('change', () => { config[key] = input.checked; save(); refresh({force:true}); }); const field = el('label'); field.append(input, document.createTextNode(label)); toggles.append(field); }
            status.append(toggles);
            const statuses = el('div', null, 'ari-story-status');
            const recording = !config.enabled ? '剧情增强关闭，记录不运行' : !config.threadsEnabled ? '故事记录已关闭' : mvuReady ? '剧情记录可用' : '剧情记录等待 MVU';
            for (const text of [`随机指令：${store.enabled ? '已开启' : '已关闭'}`, `场景：${scene}`, recording]) statuses.append(el('span', text, 'ari-story-badge'));
            status.append(statuses); panel.append(status);
            const limits = `剧情推动 ${config.quietNext ? 0 : config.eventBudget} 条、氛围描写 ${config.detailBudget} 条`;
            const nextText = !config.enabled ? `剧情增强已关闭，当前不使用剧情增强调度；开启后的上限为${limits}。`
                : !store.enabled ? `随机指令总开关已关闭，本次不发送随机指令；开启后的上限为${limits}。`
                    : `最多向 AI 发送${limits}指令。骰点和条件可能减少实际数量；是否采用由 AI 判断，固定要求另计。`;
            const next = section('下一次发送', nextText);
            next.append(el('p', config.quietNext ? '下一次暂停已开启，仅下一次成功发送生效；氛围描写和固定要求仍按原规则处理。' : '可仅在下一次成功发送时暂停随机剧情推动，氛围描写和固定要求仍按原规则处理。', 'ari-story-help'));
            next.append(button(config.quietNext ? '取消下一次暂停' : '下一次暂停随机剧情推动', () => { config.quietNext = !config.quietNext; save(); refresh({force:true}); })); panel.append(next);
            const blocks = details('暂时屏蔽主题', 'blocks', expanded.blocks);
            blocks.append(el('p', '屏蔽后的 5 次成功发送内不会选择该主题，可随时撤销。', 'ari-story-help'));
            const blockGrid = el('div', null, 'ari-story-topic-grid');
            for (const topic of NARRATIVE_TOPICS.filter(t => t !== 'general')) { const n = config.blockedTopics[topic] ?? 0; blockGrid.append(button(n ? `${TOPICS[topic]} · 剩余 ${n} 次 · 撤销` : `屏蔽${TOPICS[topic]}`, () => { if (n) delete config.blockedTopics[topic]; else config.blockedTopics[topic] = 5; save(); refresh({force:true}); })); } blocks.append(blockGrid); panel.append(blocks);
            const stories = section(`活跃故事（${active.length}/3）`, 'AI 根据正文记录，不代表自动语义核验。');
            const renderThread = thread => {
                const box = el('article', null, 'ari-story-thread'); box.append(el('h4', thread.title)); box.append(el('span', {active:'活跃',paused:'已暂停',completed:'已结束'}[thread.status], 'ari-story-badge')); box.append(el('p', `未解决：${thread.question}`));
                if (thread.facts.length) box.append(el('p', `最近进展：${thread.facts.at(-1).fact}`));
                const history = details('记录与证据', `history:${thread.id}`, expanded[`history:${thread.id}`]);
                history.append(el('p', `起因：${thread.cause}${thread.causeUserCorrected ? '（用户纠正）' : thread.evidence ? `（证据：${thread.evidence}）` : ''}`));
                thread.facts.forEach(f => history.append(el('p', `${f.user ? '用户纠正' : 'AI 根据正文记录'}：${f.fact}${f.evidence ? `（证据：${f.evidence}）` : ''}`))); box.append(history);
                const action = (type, fact, target) => {
                    if (type === 'resume' && foldNarrative(ctx.chat).threads.filter(t => t.status === 'active').length >= 3) { globalThis.toastr?.warning('最多同时活跃 3 条故事线。'); return; }
                    const index = ctx.chat.findLastIndex(m => !m.is_user && !m.is_system), reply = ctx.chat[index]; if (!reply) { globalThis.toastr?.warning('请先等待一条 AI 回复。'); return; }
                    reply.extra ??= {}; const saved = reply.extra[NARRATIVE_KEY] ??= { uid:narrativeId(), swipes:{} }, swipe = String(reply.swipe_id ?? 0), entry = saved.swipes[swipe] ??= {};
                    const baseRevision = foldNarrative(ctx.chat, index + 1).revision;
                    (entry.actions ??= []).push({ type, threadId:thread.id, baseRevision, ...(fact ? { fact, ...(['cause','question'].includes(target) ? {target} : {factIndex:Number(target)}) } : {}) });
                    if (type === 'correct') correctionDrafts.delete(thread.id); void ctx.saveChat(); refresh({force:true});
                };
                const controls = el('div', null, 'ari-story-actions');
                if (thread.status === 'active') controls.append(button('暂停', () => action('pause')), button('结束', () => action('complete')));
                if (thread.status === 'paused') controls.append(button('恢复', () => action('resume')), button('结束', () => action('complete')));
                box.append(controls);
                const correction = details('纠正记录', `correct:${thread.id}`, expanded[`correct:${thread.id}`]);
                const target = el('select'); target.append(new Option('起因','cause'), new Option('未解决问题','question')); thread.facts.forEach((fact, i) => target.append(new Option(`进展 ${i + 1}：${fact.fact}`, String(i))));
                const draft = correctionDrafts.get(thread.id) ?? { target:thread.facts.length ? String(thread.facts.length - 1) : 'cause', text:'' }; target.value = draft.target;
                const input = el('textarea'); input.rows = 3; input.value = draft.text; target.addEventListener('change', () => { draft.target = target.value; correctionDrafts.set(thread.id, draft); }); input.addEventListener('input', () => { draft.text = input.value; correctionDrafts.set(thread.id, draft); });
                correction.append(named('纠正对象', target), named('纠正后的内容', input), button('保存纠正', () => { if (!input.value.trim()) { input.focus(); return; } action('correct', input.value.trim(), target.value); })); box.append(correction); return box;
            };
            if (!active.length) stories.append(el('p', '暂无活跃故事。')); else active.forEach(t => stories.append(renderThread(t)));
            if (other.length) { const archived = details(`暂停或已结束（${other.length}）`, 'archived', expanded.archived); other.forEach(t => archived.append(renderThread(t))); stories.append(archived); } panel.append(stories);
            const last = section('上次发送'); const turnIndex = ctx.chat.findLastIndex(m => m.is_user && m.extra?.[SETTINGS_KEY]?.narrative);
            if (turnIndex < 0) last.append(el('p', '还没有剧情增强发送记录。'));
            else { const record = ctx.chat[turnIndex].extra[SETTINGS_KEY], reports = visibleTurnReports(ctx.chat, turnIndex), uses = reports.flatMap(r => r.uses);
                last.append(el('p', `${record.narrative.injected ? '已注入' : '未注入'}；${reports.length ? `已收到 ${reports.length} 条有效 AI 回报` : '尚未确认采用情况'}`));
                const sent = (record.rolls ?? []).filter(roll => record.narrative.injected && ['selected','persistent'].includes(roll.reason));
                if (!sent.length) last.append(el('p', '本次没有发送随机指令。', 'ari-story-help'));
                for (const roll of sent) { const usesFor = uses.filter(use => use.candidateId === roll.candidateId), labels = [...new Set(usesFor.map(use => use.status === 'adopted' ? 'AI 报告采用' : 'AI 报告未采用'))]; const item = el('article', null, 'ari-story-sent'); item.append(el('strong', roll.ruleName || '随机指令'), el('p', roll.command || ''), el('small', labels.length ? labels.join('、') : '尚未确认')); last.append(item); }
                const list = details('骰点与筛选详情', 'rolls', expanded.rolls);
                for (const roll of record.rolls ?? []) { const result = uses.filter(use => use.candidateId === roll.candidateId), labels = [...new Set(result.map(use => use.status === 'adopted' ? 'AI 报告采用' : 'AI 报告未采用'))]; list.append(el('p', `${roll.ruleName || '未命名指令'} · d${roll.sides ?? '?'} = ${roll.result ?? '未投'} · ${REASONS[roll.reason] ?? '未记录筛选原因'} · ${roll.command || '无指令'}${labels.length ? ` · ${labels.join('、')}` : ['selected','persistent'].includes(roll.reason) ? ' · 尚未确认' : ''}`)); } last.append(list);
            } panel.append(last);
        } else {
            const groups = section('随机指令来源', '两组共享指令库。场景过期后暂停场景组，平时使用的指令继续生效。');
            for (const [key, title, help] of [['longGroupId','平时使用的随机指令','适合这张角色卡长期使用，切换场景后仍参与抽取；自动生成不会覆盖此组。绑定不会改变随机指令页的选择。'],['sceneGroupId','当前场景追加的随机指令（可选）','补充当前剧情，与平时使用的组一起抽取并共享数量上限；自动生成会更新此组。不能与平时使用的组相同。']]) {
                const groupCard = el('div', null, 'ari-story-group'); groupCard.append(el('h4', title), el('p', help, 'ari-story-help'));
                const select = el('select'); select.append(new Option(key === 'sceneGroupId' ? '不绑定' : '请选择','')); store.groups.forEach(group => select.append(new Option(group.name, group.id)));
                if (config[key] && !data(config[key])) select.append(new Option('已删除的配置组（暂停）',config[key])); select.value = config[key] ?? '';
                const message = el('p', '', 'ari-story-error'); select.addEventListener('change', () => { const otherId = key === 'longGroupId' ? config.sceneGroupId : config.longGroupId; if (select.value && select.value === otherId) { select.value = config[key] ?? ''; message.textContent = '两组不能相同，请选择其他组。'; return; } config[key] = select.value || null; if (key === 'sceneGroupId') config.sceneGroupRevision = select.value ? config.sceneRevision : null; save(); refresh({force:true}); });
                const available = config[key] && data(config[key]);
                const groupStatus = !config[key] ? '未绑定' : !available ? '配置组已删除，已停用' : key === 'sceneGroupId' && (config.sceneGroupRevision !== config.sceneRevision || sceneChanged) ? '已停用，当前场景不会抽取' : key === 'sceneGroupId' && config.scenePath && sceneValue === undefined ? '场景变量未就绪，状态待确认' : '可用';
                const groupPicker = named('选择配置', select); select.setAttribute('aria-label', title);
                groupCard.append(groupPicker, el('p', `当前选择：${available ? available.name : config[key] ? '配置组已删除' : '未绑定'}`, 'ari-story-group-name'), el('p', `状态：${groupStatus}`, 'ari-story-help'), message);
                if (key === 'sceneGroupId' && available && (config.sceneGroupRevision !== config.sceneRevision || sceneChanged)) groupCard.append(button('重新启用本场景指令', () => { if (sceneChanged) { config.sceneValue = structuredClone(sceneValue); config.sceneRevision = narrativeId(); } config.sceneGroupRevision = config.sceneRevision; save(); refresh({force:true}); }));
                const group = data(config[key]); if (group) { const inspect = details('查看组内容（只读）', `group:${key}`, expanded[`group:${key}`]); group.rules.forEach(rule => { const part = el('div'); part.append(el('strong', `${rule.name} · d${rule.diceSides}${rule.enabled ? '' : ' · 已暂停'}`)); const commands = rule.diceSides === 100 ? rule.ranges.map(row => `${row.range}：${row.command}`) : rule.commands.slice(0, rule.diceSides).filter(Boolean); commands.forEach(command => part.append(el('p', command))); inspect.append(part); }); groupCard.append(inspect); }
                groups.append(groupCard);
            }
            groups.append(button('停用当前场景指令', () => { config.sceneRevision = narrativeId(); config.sceneValue = null; save(); refresh({force:true}); }), button('前往自动生成设置', () => options.openAutoSettings?.())); panel.append(groups);
            const limits = section('每次发送的数量上限', '这是最多发送给 AI 的指令数量，不代表一定发生，也不是 AI 采用数量；固定要求另计。');
            for (const [key, title, help] of [['eventBudget','剧情推动指令','例如出现线索、关系变化、遇到阻碍；上限为 2 时最多发送两条。'],['detailBudget','氛围描写指令','例如环境声音、天气、人物神态；上限为 1 时最多发送一条。']]) { const select = el('select'); for (let n = 0; n <= 3; n++) select.append(new Option(String(n), String(n))); select.value = String(config[key]); select.addEventListener('change', () => { config[key] = Number(select.value); save(); }); limits.append(named(`${title}上限`, select, help)); } panel.append(limits);
            const prefs = section('生成指令时的内容要求', '例如：多一些日常互动，少一些冲突。下次手动或自动生成时生效，不会立即改变现有指令或概率。');
            const input = el('textarea'); input.rows = 4; input.placeholder = '例如：多一些日常互动，少一些冲突'; input.value = config.preferences; input.addEventListener('input', () => { config.preferences = input.value; save(); }); prefs.append(named('内容要求', input));
            const prefGrid = el('div', null, 'ari-story-topic-grid');
            for (const topic of NARRATIVE_TOPICS.filter(t => t !== 'general')) { const select = el('select'); [['','默认'],['prefer','多一些'],['reduce','少一些']].forEach(([v,t]) => select.append(new Option(t,v))); select.value = config.topicPreferences[topic] ?? ''; select.addEventListener('change', () => { if (select.value) config.topicPreferences[topic] = select.value; else delete config.topicPreferences[topic]; save(); }); prefGrid.append(named(TOPICS[topic], select)); } prefs.append(prefGrid, el('p', `自动生成：${auto.enabled ? `已开启，每 ${auto.interval} 条 AI 回复一次` : '已关闭'}`, 'ari-story-help'), button('前往自动生成设置', () => options.openAutoSettings?.())); panel.append(prefs);
            const advanced = details('高级设置', 'advanced', expanded.advanced);
            const path = el('input'); path.value = config.scenePath; path.placeholder = '例如 stat_data.场景.位置'; path.addEventListener('input', () => { config.scenePath = path.value; save(); }); advanced.append(named('MVU 场景路径（可留空）', path, '根据角色卡变量变化自动停用旧场景指令；不了解可留空。'));
            const labels = el('input'); labels.value = config.labels.join(', '); labels.placeholder = '例如 港口, 雨天'; labels.addEventListener('input', () => { config.labels = labels.value.split(/[,，]/).map(x => x.trim()).filter(Boolean); save(); }); advanced.append(named('人工场景标签', labels, '用于判断指令的场景标签条件，多个标签用逗号分隔；不会自动识别。')); panel.append(advanced);
        }
        panel.scrollTop = scroll;
    };
    const flushPending = () => {
        if (pending && !pointerInteraction && (!panel.contains(document.activeElement) || !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? ''))) refresh();
    };
    // A pointer click blurs an input before click fires. Do not replace the
    // target until its action has run, including non-focusable summaries.
    panel.addEventListener('pointerdown', () => { pointerInteraction = true; }, true);
    panel.addEventListener('click', () => { pointerInteraction = false; queueMicrotask(flushPending); });
    panel.addEventListener('pointercancel', () => { pointerInteraction = false; queueMicrotask(flushPending); });
    document.addEventListener('pointerup', event => {
        if (pointerInteraction && !panel.contains(event.target)) { pointerInteraction = false; queueMicrotask(flushPending); }
    }, true);
    panel.addEventListener('focusout', event => {
        if (!pending || pointerInteraction || (event.relatedTarget && panel.contains(event.relatedTarget))) return;
        queueMicrotask(flushPending);
    });
    refresh(); return { refresh, openSettings: () => changeView('settings') };
}
