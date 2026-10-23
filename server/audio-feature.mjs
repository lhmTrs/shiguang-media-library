/**
 * 音频分析功能的默认关闭开关。
 *
 * 只认运维显式配置的环境变量，浏览器/HTTP 请求无法修改；默认（未设置或非 "1"）
 * 一律视为关闭，启动时不创建音频实例、不建表、不联网、不下载、不 spawn。
 */
export const AUDIO_FEATURE_FLAG = "SHIGUANG_AUDIO_ANALYSIS";
export const AUDIO_FEATURE_DISABLED = "AUDIO_FEATURE_DISABLED";

export function audioFeatureEnabled(env = process.env) {
  return env[AUDIO_FEATURE_FLAG] === "1";
}

/** 关闭态的固定拒绝：只回固定错误码与提示，不带引擎路径/下载地址。 */
export function rejectAudioFeature(res) {
  return res.status(503).json({
    error: "音频分析功能未启用",
    code: AUDIO_FEATURE_DISABLED,
  });
}
