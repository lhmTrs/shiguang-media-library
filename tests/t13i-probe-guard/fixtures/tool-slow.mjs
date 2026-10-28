/**
 * 合成慢 probe 工具：400ms 后输出合法 WAV JSON。
 * 用于并发/重入场景让第一个调用确实持锁，但最终仍可成功。
 */
const payload = {
  format: { format_name: "wav", duration: "1.0" },
  streams: [{ codec_type: "audio", codec_name: "pcm_s16le", channels: 2, sample_rate: "44100" }],
};
setTimeout(() => {
  process.stdout.write(JSON.stringify(payload));
}, 400);
