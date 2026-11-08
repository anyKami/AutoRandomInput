// Only reload after a confirmed update and completed saves. No update is downloaded here.
export function createUpdateReloader({ version, readVersion, isBusy, flush, reload, notify = () => {}, onError = () => {},
    storage, setTimer = setTimeout, clearTimer = clearTimeout }) {
    const storageKey = 'auto-random-input-reloaded-version';
    let pending = false, stopped = false, observed = null, timer = null, task = null;
    let lastReload;
    try { lastReload = storage?.getItem(storageKey); } catch { /* Storage is optional. */ }
    const remember = value => {
        lastReload = value;
        try {
            if (value) storage?.setItem(storageKey, value);
            else storage?.removeItem(storageKey);
        } catch { /* A blocked storage area must not prevent a successful update. */ }
    };
    const schedule = delay => {
        if (timer !== null) clearTimer(timer);
        if (!stopped) timer = setTimer(() => { void check(); }, delay);
    };
    function request() {
        if (stopped || pending) return;
        pending = true;
        notify();
        schedule(1000);
    }
    function dispose() {
        stopped = true;
        if (timer !== null) clearTimer(timer);
    }
    function check() {
        if (stopped) return Promise.resolve(false);
        if (task) return task;
        let retryDelay = 0;
        task = (async () => {
            const latest = await readVersion();
            if (typeof latest !== 'string' || !latest.trim()) throw new Error('无法读取随机指令版本');
            if (latest !== version) {
                // Confirm external git/file updates twice; suppress a stale cached entry point loop.
                if (lastReload === latest && !pending) { observed = null; return false; }
                if (observed === latest) request();
                observed = latest;
            } else {
                observed = null;
                remember(null);
            }
            if (!pending || stopped || await isBusy()) return false;
            await flush();
            if (stopped || await isBusy()) return false;
            remember(latest);
            dispose();
            reload();
            return true;
        })().catch(error => {
            retryDelay = 10000;
            onError(error);
            return false;
        }).finally(() => {
            task = null;
            if (!stopped) schedule(retryDelay || (pending || observed ? 1000 : 30000));
        });
        return task;
    }
    schedule(30000);
    return { request, check, dispose };
}

const stableJSON = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

export async function flushBeforeReload(getContext, host, fetcher = fetch) {
    const ctx = getContext();
    let saved = false;
    const onSaved = () => { saved = true; };
    ctx.eventSource.on(ctx.eventTypes.SETTINGS_UPDATED, onSaved);
    try {
        await host.saveSettings();
        if (!saved) throw new Error('设置尚未保存，稍后刷新');
    } finally {
        ctx.eventSource.removeListener(ctx.eventTypes.SETTINGS_UPDATED, onSaved);
    }
    const chatId = ctx.getCurrentChatId?.() ?? ctx.chatId;
    if (!chatId) return;
    const currentId = () => getContext().getCurrentChatId?.() ?? getContext().chatId;
    const snapshot = () => stableJSON({ metadata: ctx.chatMetadata ?? {}, messages: ctx.chat ?? [] });
    const expected = snapshot();
    const unchanged = () => currentId() === chatId && getContext().chat === ctx.chat &&
        getContext().chatMetadata === ctx.chatMetadata && snapshot() === expected;
    const character = ctx.characters?.[ctx.characterId];
    const body = ctx.groupId ? { id: chatId } : { file_name: chatId, ch_name: character?.name, avatar_url: character?.avatar };
    await ctx.saveChat();
    if (!unchanged()) throw new Error('聊天已变化，稍后刷新');
    const response = await fetcher(ctx.groupId ? '/api/chats/group/get' : '/api/chats/get', {
        method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify(body), cache: 'no-store',
    });
    if (!response.ok) throw new Error(`无法核对聊天保存：HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data) || stableJSON({ metadata: data[0]?.chat_metadata ?? {}, messages: data.slice(1) }) !== expected ||
        !unchanged()) throw new Error('聊天尚未完整保存，稍后刷新');
}
