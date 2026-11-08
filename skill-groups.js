import { defaultSkillValue, newSkillId, normalizeSkillSettings, skillErrors } from './skills.js';

export const SKILL_GROUPS_KEY = 'auto_random_input_skill_groups';
// D&D 5e Basic Rules, chapter 7, Skills. This is the skill roster, not a DC rules engine.
// https://www.dndbeyond.com/sources/dnd/basic-rules-2014/using-ability-scores#Skills
export const DND5E_SKILLS = [
    '运动', '体操', '巧手', '隐匿', '奥秘', '历史', '调查', '自然', '宗教',
    '驯兽', '洞悉', '医药', '察觉', '求生', '欺瞒', '威吓', '表演', '游说',
];

export const SKILL_TEMPLATES = [
    { id: 'dnd5e', name: '5e 标准技能', description: '5e 的 18 项标准技能清单。数值为本插件的成功阈值，不是 5e 的技能加值。', skills: DND5E_SKILLS },
    { id: 'daily', name: '日常', description: '生活自理、人际沟通、工作学习与常见突发状况。', skills: [
        '烹饪', '家务整理', '生活规划', '理财预算', '购物议价', '社交沟通', '察言观色', '情绪调节', '时间管理', '记忆学习',
        '运动健身', '驾驶出行', '生活维修', '电子设备', '信息检索', '医疗急救', '照顾他人', '手工制作', '艺术表达', '环境观察',
    ] },
    { id: 'xianxia', name: '修仙', description: '修炼、斗法、丹器符阵、宗门交涉与秘境探索。', skills: [
        '吐纳调息', '灵气感知', '神识探查', '功法领悟', '境界突破', '灵力控制', '法术施展', '御剑飞行', '近身斗法', '护体防御', '身法遁术', '隐匿敛息',
        '炼丹', '炼器', '制符', '阵法', '灵植培育', '灵兽驯养', '天材辨识', '古籍研读', '心魔抵御', '天机推演', '宗门交涉', '秘境探索',
    ] },
    { id: 'detective', name: '侦探', description: '现场证据、推理还原、询问访谈、跟踪潜入与电子取证。', skills: [
        '现场勘查', '线索搜集', '痕迹辨识', '证据保全', '逻辑推理', '案件还原', '心理分析', '询问访谈', '测谎察言', '档案检索', '情报联络',
        '跟踪监视', '反跟踪', '潜入隐匿', '开锁解谜', '法医常识', '毒理识别', '电子取证', '摄影记录', '伪装扮演', '危机应对', '自卫格斗',
    ] },
    { id: 'wuxia', name: '武侠', description: '内功招式、轻功暗器、医毒机关与江湖人情。', skills: [
        '内功运转', '经脉调息', '招式领悟', '拳脚功夫', '刀法', '剑法', '枪棍', '暗器', '轻功身法', '闪避卸力', '点穴解穴',
        '听风辨位', '易容乔装', '潜行跟踪', '医术', '毒术', '机关破解', '江湖见识', '识人察言', '江湖交涉', '骑术', '野外求生',
    ] },
    { id: 'fantasy', name: '西幻冒险', description: '武艺、魔法、地下城、野外探索与冒险交涉。', skills: [
        '近战武艺', '远程射击', '施法专注', '元素法术', '治疗法术', '神圣仪式', '魔法辨识', '魔药炼制', '附魔工艺', '盾防格挡', '敏捷闪避',
        '攀爬跳跃', '潜行隐匿', '陷阱处理', '开锁', '野外追踪', '荒野求生', '驯兽骑乘', '古语解读', '遗迹探索', '交涉说服', '威慑恐吓',
    ] },
    { id: 'survival', name: '末日生存', description: '物资营地、探索避险、装备急救与团队协作。', skills: [
        '搜集物资', '资源规划', '净水处理', '食物获取', '野外烹饪', '营地建设', '环境适应', '方向辨识', '追踪侦查', '潜行避险', '陷阱布置',
        '近身搏斗', '远程射击', '装备维修', '简易制作', '载具驾驶', '急救护理', '疾病防护', '危机判断', '团队协作', '势力交涉', '意志坚守',
    ] },
    { id: 'cyberpunk', name: '赛博科幻', description: '网络电子、义体无人机、载具宇航与科技战术。', skills: [
        '编程开发', '网络渗透', '信息检索', '电子取证', '电子维修', '机械工程', '义体维护', '无人机操控', '载具驾驶', '舰船操作', '宇航作业',
        '能源管理', '枪械使用', '近身格斗', '战术分析', '潜行渗透', '安防破解', '通讯监听', '情报交易', '医疗急救', '异星勘探', '系统分析',
    ] },
    { id: 'urban', name: '都市异能', description: '能力控制与对抗、身份隐匿、现代调查和社会协作。', skills: [
        '异能控制', '能量感知', '能力解析', '能量防护', '异能对抗', '极限反应', '身体强化', '精神专注', '隐匿身份', '现场观察',
        '危机预感', '调查取证', '追踪搜索', '近身格斗', '载具驾驶', '电子技术', '社会交涉', '团队配合', '伤势处理', '意志抵抗',
    ] },
    { id: 'campus', name: '校园成长', description: '学业考试、社团文体、人际关系与自我管理。', skills: [
        '专注学习', '知识记忆', '逻辑解题', '文字写作', '语言表达', '外语交流', '科学实验', '信息技术', '体育运动', '艺术表演',
        '手工创作', '社团组织', '团队合作', '人际交往', '察言观色', '情绪调节', '时间规划', '考试应对', '生活自理', '校园观察',
    ] },
    { id: 'court', name: '宫廷权谋', description: '礼仪才艺、政治交涉、情报经营与复杂局势应对。', skills: [
        '礼仪规制', '察言观色', '口才辞令', '谈判斡旋', '政治谋略', '情报搜集', '势力经营', '人心笼络', '识破谎言', '隐瞒意图', '文书处理',
        '财政筹划', '组织调度', '历史典故', '诗书才艺', '宴会应对', '乔装潜行', '药物辨识', '危机应变', '谋局推演', '护身武艺', '意志定力',
    ] },
    { id: 'horror', name: '诡秘惊悚', description: '异常调查、神秘仪式、精神抵抗、逃脱救援与解谜。', skills: [
        '异常察觉', '线索调查', '文献考据', '符号解读', '神秘学识', '仪式执行', '灵异感知', '心理洞察', '精神定力', '恐惧抵抗', '意志维持',
        '危险直觉', '潜行隐匿', '逃脱', '追踪辨路', '机关解谜', '急救护理', '灵物辨识', '沟通安抚', '应急搏斗', '掩护同伴', '现场记录',
    ] },
];

function snapshot(source) {
    const config = normalizeSkillSettings(source);
    return { diceSides: config.diceSides, mode: config.mode, maxChecks: config.maxChecks, pointLimit: config.pointLimit,
        skills: config.skills.map(skill => ({ ...skill })) };
}

export function normalizeSkillGroups(value) {
    const groups = [];
    const ids = new Set();
    for (const group of Array.isArray(value?.groups) ? value.groups : []) {
        if (!group || typeof group.id !== 'string' || !group.id || typeof group.name !== 'string' || !group.name.trim() || ids.has(group.id)) continue;
        ids.add(group.id);
        groups.push({ id: group.id, name: group.name.trim(), ...snapshot(group) });
    }
    return { version: 1, groups };
}

export function uniqueSkillGroupName(library, base) {
    let name = base;
    for (let suffix = 2; library.groups.some(group => group.name === name); suffix++) name = `${base} ${suffix}`;
    return name;
}

export function createSkillGroup(name, source) {
    const config = snapshot(source);
    return { id: newSkillId(), name, ...config, skills: config.skills.map(skill => ({ ...skill, id: newSkillId() })) };
}

export function create5eSkillGroup() {
    return createSkillTemplateGroup('dnd5e');
}

export function createSkillTemplateGroup(templateId) {
    const template = SKILL_TEMPLATES.find(item => item.id === templateId);
    if (!template) throw new RangeError('未知的技能样板。');
    return createSkillGroup(template.name, { diceSides: 20, mode: 'challenge', maxChecks: 1,
        skills: template.skills.map(name => ({ name, value: defaultSkillValue(20) })) });
}

export function addSkillTemplate(library, templateId) {
    const group = createSkillTemplateGroup(templateId);
    group.name = uniqueSkillGroupName(library, group.name);
    library.groups.push(group);
    return group;
}

export function loadSkillGroup(current, group) {
    return normalizeSkillSettings({ ...current, ...snapshot(group), groupId: group.id,
        // Loading is an explicit change of sheet. Never consume the old sheet's pending checks.
        skills: group.skills.map(skill => ({ ...skill, id: newSkillId() })) });
}

export function saveSkillGroup(library, groupId, current) {
    const group = library.groups.find(item => item.id === groupId);
    if (!group) throw new Error('请先选择一个技能配置组。');
    const errors = skillErrors(current);
    if (errors.length) throw new Error(errors.join('\n'));
    Object.assign(group, snapshot(current));
    return group;
}

export function skillGroupMatches(current, group) {
    if (!group) return false;
    const fields = config => ({ diceSides: config.diceSides, mode: config.mode, maxChecks: config.maxChecks, pointLimit: config.pointLimit,
        skills: config.skills.map(({ name, value }) => ({ name, value })) });
    return JSON.stringify(fields(current)) === JSON.stringify(fields(group));
}
