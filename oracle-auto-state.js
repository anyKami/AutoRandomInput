import { SETTINGS_KEY, createGroup, uniqueGroupName } from './core.js';
import { narrativeConfig, saveNarrativeConfig } from './narrative.js';

export const AUTO_ORACLE_KEY = 'auto_random_input_auto_oracle';

export function normalizeAutoOracle(value = {}) {
    return {
        enabled: value?.enabled === true,
        interval: Number.isSafeInteger(value?.interval) && value.interval > 0 ? value.interval : 5,
        commandCount: Number.isSafeInteger(value?.commandCount) && value.commandCount >= 1 && value.commandCount <= 100 ? value.commandCount : 10,
        diceSides: [1,2,3,4,5,6,7,8,9,10,20,100].includes(value?.diceSides) ? value.diceSides : 20,
        mapping: value?.mapping === 'even' ? 'even' : 'first',
        ruleCount: Number.isSafeInteger(value?.ruleCount) && value.ruleCount >= 1 && value.ruleCount <= 10 ? value.ruleCount : 3,
        prompt: typeof value?.prompt === 'string' ? value.prompt : '',
        progress: Number.isSafeInteger(value?.progress) && value.progress >= 0 ? value.progress : 0,
        groupId: typeof value?.groupId === 'string' ? value.groupId : null,
        ownerKey: typeof value?.ownerKey === 'string' ? value.ownerKey : null,
        useGroup: value?.useGroup === true,
        lastResult: value?.lastResult ?? null,
    };
}

export const autoOracleState = ctx => normalizeAutoOracle(ctx.chatMetadata?.[AUTO_ORACLE_KEY]);

// SillyTavern keeps integrity across renames and gives branches a new value.
// Older hosts without it fall back to the chat identity, ignoring the current
// speaking character in group chats.
export function autoOracleOwner(ctx) {
    const integrity = ctx.chatMetadata?.integrity;
    if (typeof integrity === 'string' && integrity) return JSON.stringify(['integrity', integrity]);
    const owner = ctx.groupId != null ? ['group', ctx.groupId]
        : ['character', ctx.characters?.[ctx.characterId]?.avatar ?? ctx.characterId];
    return JSON.stringify(['chat', owner, ctx.chatId]);
}

export function saveAutoOracleState(ctx, state) {
    ctx.chatMetadata[AUTO_ORACLE_KEY] = state;
    if (ctx.saveMetadataDebounced) ctx.saveMetadataDebounced();
    else if (ctx.saveMetadata) void ctx.saveMetadata();
}

// Branch metadata copies the group's ID, but the group library is global. Make
// an independent copy before the branch can edit, send or update that group.
// Legacy state has no reliable owner: copy once rather than claim a possibly
// shared group. Keep the original group and all saved options/progress intact.
export function reconcileAutoOracleState(ctx) {
    const state = autoOracleState(ctx), ownerKey = autoOracleOwner(ctx);
    if (!ctx.chatMetadata?.[AUTO_ORACLE_KEY]) return { ...state, ownerKey };
    if (state.ownerKey === ownerKey) return state;
    const settings = ctx.extensionSettings[SETTINGS_KEY];
    const copies = new Map();
    const copyGroup = id => {
        if (copies.has(id)) return copies.get(id);
        const previous = settings.groups.find(group => group.id === id);
        if (!previous) return null;
        const copy = createGroup(uniqueGroupName(settings, previous.name), previous);
        settings.groups.push(copy); copies.set(id, copy.id);
        return copy.id;
    };
    state.groupId = copyGroup(state.groupId);
    if (!state.groupId) state.useGroup = false;
    // In narrative mode automatic updates write the selected scene layer. A
    // branch must not retain that writable reference, even if the user rebound
    // it since the last auto update. The explicitly maintained long layer stays
    // shared; all current preferences and scene-version fields are preserved.
    const narrative = narrativeConfig(ctx);
    if (narrative.sceneGroupId && narrative.sceneGroupId !== narrative.longGroupId) {
        const sceneGroupId = copyGroup(narrative.sceneGroupId);
        if (sceneGroupId) {
            narrative.sceneGroupId = sceneGroupId;
            saveNarrativeConfig(ctx, narrative);
        }
    }
    state.ownerKey = ownerKey;
    saveAutoOracleState(ctx, state);
    if (copies.size) ctx.saveSettingsDebounced();
    return state;
}

// A chat's automatic selection does not replace the shared manual selection.
// The returned settings are a read-only view; edit the original store instead.
export function effectiveRandomSettings(ctx) {
    const settings = ctx.extensionSettings[SETTINGS_KEY];
    const state = autoOracleState(ctx);
    return state.useGroup && state.ownerKey === autoOracleOwner(ctx) && settings.groups.some(group => group.id === state.groupId)
        ? { ...settings, activeGroupId: state.groupId } : settings;
}

export function selectRandomGroup(ctx, id) {
    const state = reconcileAutoOracleState(ctx);
    if (ctx.chatMetadata?.[AUTO_ORACLE_KEY]) {
        state.useGroup = id === state.groupId;
        saveAutoOracleState(ctx, state);
    }
    if (!state.useGroup) ctx.extensionSettings[SETTINGS_KEY].activeGroupId = id;
}
