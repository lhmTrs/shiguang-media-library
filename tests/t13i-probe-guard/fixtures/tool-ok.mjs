/**
 * 合成 probe 工具（非真实 ffprobe）：立即输出一份合法 WAV JSON。
 * 只用于 probe guard 定向测试；不读真实素材、不联网。
 */
const payload = {
  format: { format_name: "wav", duration: "1.0" },
  streams: [{ codec_type: "audio", codec_name: "pcm_s16le", channels: 2, sample_rate: "44100" }],
};
process.stdout.write(JSON.stringify(payload));
