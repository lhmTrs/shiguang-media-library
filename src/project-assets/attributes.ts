import type { PromptRequest } from '../PromptTemplateWorkspace';

/*
 * 人物属性：每个维度是一条双向轴，整数 -100 ~ +100，0 不偏向任何一端。
 * 五档（与后端一致）：-100～-60、-59～-20、-19～19、20～59、60～100。
 * 「未评」与 0 分开：分数里没有这一维 = 从未评；value 为 null = 人工清空，都显示为「未评」。
 * 合同见 ai_work_place ATTRS-开工-精确合同 / 字段确认 / 合同修订-删除预览。
 */

export type AttrDimension = { id: string; name: string; negative_label: string; positive_label: string; neutral_label: string; tier_labels?: string[]; criterion?: string };
export type AttrConfig = { project_id: string; revision: number; source: 'default' | 'user' | 'agent'; updated_at: number | null; dimensions: AttrDimension[] } & EffectiveFields;
/**
 * 维度剧内统一（合同 v1 · A1）：生效配置的附加字段。旧后端不返回，前端按「独立项目」处理。
 * config_scope 'series' 表示这一集已统一，维度只在全剧改。config_token 是编辑所依据的那次读取的凭证：
 * 项目 / 全剧的维度保存、删除影响预览、项目与全剧评分写入都原样带回；过期由服务端以 ATTRIBUTE_CONTEXT_STALE 拒绝。
 */
export type EffectiveFields = { series_id?: string | null; config_scope?: 'project' | 'series'; alignment_status?: 'standalone' | 'pending' | 'aligned'; config_editable?: boolean; config_token?: string };
export type AttrScore = { value: number | null; source: 'manual' | 'ai'; reason: string | null; updated_at: number };
export type AssetAttributes = { asset_id: string; project_id: string; config_revision: number; attribute_revision: number; scores: Record<string, AttrScore> };
export type RemovalPreview = { token: string; config_revision: number; affected: { dimension_id: string; name: string; scored_assets: number; archived_scored_assets: number }[] };
export type DimensionDraft = { id: string | null; name: string; negative_label: string; positive_label: string; neutral_label: string; tier_labels?: string[]; criterion: string };

export const ATTR_MIN = -100, ATTR_MAX = 100;
/** Fixed categorical order, validated for light/dark surfaces and colour-vision deficiency (green, blue, orange). */
export const SERIES_COLORS = ['#2e8b57', '#2f6fb3', '#c8642a'];
export const SINGLE_COLOR = '#2f6fb3';

export const tierIndex = (v: number) => v <= -60 ? 0 : v <= -20 ? 1 : v <= 19 ? 2 : v <= 59 ? 3 : 4;
export const defaultTiers = (d: Pick<AttrDimension, 'negative_label' | 'positive_label' | 'neutral_label'>) =>
  ['极' + d.negative_label, '偏' + d.negative_label, d.neutral_label || '中立', '偏' + d.positive_label, '极' + d.positive_label];
export const tiersOf = (d: AttrDimension) => d.tier_labels?.length === 5 ? d.tier_labels : defaultTiers(d);
export const scoreValue = (s?: AttrScore | null) => s && typeof s.value === 'number' ? s.value : null;
export const tierText = (d: AttrDimension, v: number | null) => v === null ? '未评' : tiersOf(d)[tierIndex(v)];
export const signed = (v: number) => (v > 0 ? '+' : '') + v;
export const clampScore = (v: number) => Math.max(ATTR_MIN, Math.min(ATTR_MAX, Math.round(v)));

/** Where the shown scores came from: all AI, all manual, mixed, or nothing scored yet. */
export function sourceSummary(a: AssetAttributes | null, dims: AttrDimension[]) {
  const rows = dims.map(d => a?.scores[d.id]).filter((s): s is AttrScore => !!s);
  if (!rows.length) return null;
  const ai = rows.filter(s => s.source === 'ai').length, latest = Math.max(...rows.map(s => s.updated_at || 0));
  return { label: ai === rows.length ? 'AI 打分' : ai ? 'AI + 手动' : '手动', at: latest };
}

const base = (projectId: string) => '/project-assets/projects/' + encodeURIComponent(projectId);
export const attrApi = {
  config: (request: PromptRequest, projectId: string) => request<AttrConfig>(base(projectId) + '/attribute-config'),
  saveConfig: (request: PromptRequest, projectId: string, body: { expected_revision: number; dimensions: DimensionDraft[]; removal_confirmation?: { token: string }; preserve_scored_axes?: string[]; config_token?: string }) =>
    request<AttrConfig>(base(projectId) + '/attribute-config', body, 'PUT'),
  removalPreview: (request: PromptRequest, projectId: string, body: { expected_revision: number; remove: string[]; config_token?: string }) =>
    request<RemovalPreview>(base(projectId) + '/attribute-config/removal-preview', body, 'POST'),
  get: (request: PromptRequest, assetId: string) => request<AssetAttributes>('/project-assets/assets/' + encodeURIComponent(assetId) + '/attributes'),
  patch: (request: PromptRequest, assetId: string, body: { project_id: string; expected_config_revision: number; expected_attribute_revision: number; changes: { dimension_id: string; value: number | null }[]; config_token?: string }) =>
    request<AssetAttributes>('/project-assets/assets/' + encodeURIComponent(assetId) + '/attributes', body, 'PATCH'),
  compare: (request: PromptRequest, projectId: string, ids: string[]) =>
    request<{ config_revision: number; items: { asset_id: string; attribute_revision: number; scores: Record<string, AttrScore> }[] }>(base(projectId) + '/attributes?' + new URLSearchParams({ asset_ids: ids.join(',') })),
};
export const errCode = (e: unknown) => String((e as { code?: string })?.code || '');

/** Config and scores must describe the same config revision before they are shown or edited; re-read a few times if not. */
export async function readConsistent<T extends { config_revision: number }>(read: () => Promise<[AttrConfig, T]>, tries = 3): Promise<[AttrConfig, T]> {
  for (let i = 0; i < tries; i++) { const [c, a] = await read(); if (c.revision === a.config_revision) return [c, a]; }
  throw Object.assign(Error('维度配置正在更新，属性暂时没读到一致的版本，请稍后重试'), { code: 'CONFIG_REVISION_MISMATCH' });
}
