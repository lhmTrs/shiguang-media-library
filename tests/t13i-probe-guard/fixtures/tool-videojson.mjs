/**
 * 合成“执行成功但结果不可接受”的 probe 工具：输出合法 JSON，但流不是音频。
 * 用于解析拒绝用例（executor 成功、adapter 必须 PROBE_REJECTED）。
 */
const payload = {
  format: { format_name: "mov", duration: "1.0" },
  streams: [{ codec_type: "video", codec_name: "h264", channels: 0, sample_rate: "0" }],
};
process.stdout.write(JSON.stringify(payload));
