// Explicit opt-in browser fixture: no model request or real user chat is accessed.
export function installOracleFixture(ctx) {
    let calls = 0;
    const sample = () => ({ format: 'auto-random-input', formatVersion: 1,
        randomGroups: [{ name: '测试生成组', rules: [{ name: '环境细节', diceSides: 100,
            ranges: [{ range: '1-40', command: '补充与当前环境相符的细节。' }, { range: '61-80', command: '出现一个可选择的调查机会，不逆转检定结果。' }] }] }],
        skillGroups: [{ name: '测试技能组', diceSides: 20, mode: 'challenge', maxChecks: 2, pointLimitMode: 'auto',
            skills: [{ name: '调查', modifier: 7 }, { name: '体力', modifier: -1 }] }] });
    globalThis.Mvu = { getMvuData: () => document.querySelector('#oracle-test-mode')?.value === 'no-mvu' ? null : ({ stat_data: { 场景: { 位置: '测试档案馆' } }, schema: {} }) };
    globalThis.StoryOracleAPI = {
        isCompatible: n => n === 1,
        context: { buildCardSection: () => '主角是档案调查员，擅长检索，不擅长体力活动。',
            buildTranscript: c => c.chat.map(m => m.mes).join('\n'), buildWorldInfo: async () => '蓝签索引规则。',
            getSettings: () => ({ mode: 'direct', model: '界面测试桩（不联网）' }) },
        run: async messages => {
            calls++; document.querySelector('#oracle-test-calls').textContent = `模型请求次数：${calls}`;
            const mode = document.querySelector('#oracle-test-mode').value;
            const data = sample();
            if (mode === 'broken') return '{invalid JSON';
            if (mode === 'overlap') data.randomGroups[0].rules[0].ranges[1].range = '30-70';
            if (mode === 'budget') data.skillGroups[0].skills[0].modifier = 15;
            if (mode === 'late') await new Promise(resolve => setTimeout(resolve, 7000)); // intentionally ignores signal
            const target = messages[1].content.match(/生成目标：(\w+)/)?.[1];
            if (target === 'skills') data.randomGroups = [];
            if (target === 'random') data.skillGroups = [];
            return JSON.stringify(data);
        },
    };
    return () => {
        const label = document.createElement('label'); label.textContent = '界面测试返回：';
        const select = document.createElement('select'); select.id = 'oracle-test-mode';
        for (const [key, name] of [['valid','有效配置'], ['broken','非法 JSON'], ['overlap','范围重叠'], ['budget','技能超预算'], ['late','迟到结果'], ['no-mvu','MVU未就绪']]) select.append(new Option(name,key));
        const counter = document.createElement('p'); counter.id = 'oracle-test-calls'; counter.textContent = '模型请求次数：0';
        label.append(select); document.querySelector('#ari-oracle-panel').prepend(label,counter);
    };
}
