import { SETTINGS_KEY } from './core.js';

export const AUTO_ORACLE_KEY = 'auto_random_input_auto_oracle';

export function normalizeAutoOracle(value = {}) {
    return {
        enabled: value?.enabled === true,
        interval: Number.isSafeInteger(value?.interval) && value.interval > 0 ? value.interval : 5,
        prompt: typeof value?.prompt === 'string' ? value.prompt : '',
        progress: Number.isSafeInteger(value?.progress) && value.progress >= 0 ? value.progress : 0,
        groupId: typeof value?.groupId === 'string' ? value.groupId : null,
        useGroup: value?.useGroup === true,
        lastResult: value?.lastResult ?? null,
    };
}

export const autoOracleState = ctx => normalizeAutoOracle(ctx.chatMetadata?.[AUTO_ORACLE_KEY]);

export function saveAutoOracleState(ctx, state) {
    ctx.chatMetadata[AUTO_ORACLE_KEY] = state;
    if (ctx.saveMetadataDebounced) ctx.saveMetadataDebounced();
    else if (ctx.saveMetadata) void ctx.saveMetadata();
}

// A chat's automatic selection does not replace the shared manual selection.
// The returned settings are a read-only view; edit the original store instead.
export function effectiveRandomSettings(ctx) {
    const settings = ctx.extensionSettings[SETTINGS_KEY];
    const state = autoOracleState(ctx);
    return state.useGroup && settings.groups.some(group => group.id === state.groupId)
        ? { ...settings, activeGroupId: state.groupId } : settings;
}

export function selectRandomGroup(ctx, id) {
    const state = autoOracleState(ctx);
    if (ctx.chatMetadata?.[AUTO_ORACLE_KEY]) {
        state.useGroup = id === state.groupId;
        saveAutoOracleState(ctx, state);
    }
    if (!state.useGroup) ctx.extensionSettings[SETTINGS_KEY].activeGroupId = id;
}
