import { fault, idOK, nameKey } from '../project-assets/model.mjs';

const defaults = [
  ['善恶', '邪恶', '善良', '善恶未明'],
  ['权势', '弱势', '强势', '势均'],
  ['主动性', '被动', '主动', '视情况而动'],
  ['心智', '冲动', '理性', '平衡'],
  ['情绪', '压抑', '外露', '平稳'],
  ['对主角', '敌对', '支持', '中立'],
];

function defaultTiers({ negative_label, positive_label, neutral_label }) {
  return [`极${negative_label}`, `偏${negative_label}`, neutral_label, `偏${positive_label}`, `极${positive_label}`];
}

export const DEFAULT_DIMENSIONS = defaults.map(([name, negative_label, positive_label, neutral_label], index) => ({
  id: `893bf172-b62a-4c92-a606-66e12df0cf0${index}`, name, negative_label, positive_label, neutral_label, criterion: '',
}));

export const dimensionDTO = dimension => ({
  ...dimension,
  tier_labels: dimension.tier_labels ?? defaultTiers(dimension),
});

export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const isRevision = value => Number.isSafeInteger(value) && value >= 0;
export const isScore = value => Number.isInteger(value) && value >= -100 && value <= 100;

export function textField(value, max, label, optional = false) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw fault(`${label}格式无效`);
  const text = value.normalize('NFC').trim();
  if ((!optional && !text) || [...text].length > max) throw fault(`${label}最多 ${max} 字`);
  return text;
}

export function dimensionsInput(input) {
  if (!Array.isArray(input) || input.length < 3 || input.length > 8) throw fault('请配置 3–8 个属性维度');
  const ids = new Set(), names = new Set();
  return input.map(value => {
    if (!isRecord(value) || value.id !== null && !idOK(value.id)) throw fault('维度编号无效，新维度请使用 null');
    const id = value.id?.toLowerCase() ?? null;
    const name = textField(value.name, 40, '维度名称');
    const key = nameKey(name);
    if (id && ids.has(id) || names.has(key)) throw fault('维度编号或名称不能重复');
    if (id) ids.add(id);
    names.add(key);
    const negative_label = textField(value.negative_label, 24, '负向名称');
    const positive_label = textField(value.positive_label, 24, '正向名称');
    const neutral_label = textField(value.neutral_label, 24, '中间名称');
    if (nameKey(negative_label) === nameKey(positive_label)) throw fault('维度两端需要使用不同名称');
    const criterion = textField(value.criterion, 500, '评分依据', true);
    const dimension = { id, name, negative_label, positive_label, neutral_label, criterion };
    if (value.tier_labels !== undefined) {
      if (!Array.isArray(value.tier_labels) || value.tier_labels.length !== 5) throw fault('请填写从负向到正向的五档名称');
      dimension.tier_labels = value.tier_labels.map(label => textField(label, 26, '档位名称'));
    }
    return dimension;
  });
}

export function distinctIds(input, max, label) {
  if (!Array.isArray(input) || input.length < 1 || input.length > max || input.some(id => !idOK(id))) throw fault(`${label}编号或数量无效`);
  const ids = input.map(id => id.toLowerCase());
  if (new Set(ids).size !== ids.length) throw fault(`${label}不能重复`);
  return ids;
}

export function scoreChanges(input, ai = false) {
  if (!Array.isArray(input) || !input.length || input.length > (ai ? 200 : 8)) throw fault('评分数量无效');
  const seen = new Set();
  return input.map(item => {
    if (!isRecord(item) || !idOK(item.dimension_id) || ai && !idOK(item.asset_id) ||
        !isScore(item.value) && (ai || item.value !== null)) throw fault('评分需为 -100 到 100 的整数，人工可设为未评');
    const dimension_id = item.dimension_id.toLowerCase();
    const asset_id = ai ? item.asset_id.toLowerCase() : '';
    const key = asset_id + '/' + dimension_id;
    if (seen.has(key)) throw fault('同一人物的同一维度只能提交一次');
    seen.add(key);
    return { dimension_id, value: item.value, ...(ai ? { asset_id, reason: textField(item.reason, 200, '评分依据') } : {}) };
  });
}
