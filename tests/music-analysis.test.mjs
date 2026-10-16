import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Library, run } from "../server/library.mjs";
import {
  redactDetails,
  readResponseText,
} from "../server/diagnostic-details.mjs";
import {
  MusicAnalysis,
  parseAnalysis,
  AUDIO_MODEL,
  providerError,
} from "../server/music-analysis.mjs";

const result = {
  summary: "低沉的电子片段",
  mood: "紧张",
  style: "电子",
  instruments: "合成器",
  rhythm: "规律脉冲",
  energy: "中等",
  uses: "悬疑铺垫",
  limitations: "只分析当前片段，无法确定整首结构",
  tags: ["紧张", "电子", "紧张"],
  note: "适合悬疑铺垫，使用前试听确认。",
};
const testKey = "sk-local-test-key-not-real";
test("失败正文脱敏与长度限制：保留原因和参数，隐藏凭据、请求音频和路径", async () => {
  const source = {
    error: {
      message: "Unsupported parameter: max_completion_tokens " + testKey,
      type: "invalid_request_error",
      param: "max_completion_tokens",
    },
    apiKey: "not-a-public-secret",
    token: "private-token",
    messages: [{ content: "private prompt" }],
    audio: { data: "private audio" },
    path: "/Users/private/file.wav",
  };
  const cleaned = redactDetails(JSON.stringify(source));
  for (const secret of [
    testKey,
    "not-a-public-secret",
    "private-token",
    "private prompt",
    "private audio",
    "/Users/private",
  ])
    assert.ok(!cleaned.includes(secret));
  assert.ok(cleaned.includes("Unsupported parameter"));
  assert.ok(cleaned.includes("max_completion_tokens"));
  assert.equal(redactDetails("z".repeat(20000)).length < 16001, true);
  assert.ok(
    !redactDetails('{"password":"other-password", invalid').includes(
      "other-password",
    ),
  );
  await assert.rejects(
    readResponseText(new Response("x".repeat(100)), 20),
    (e) => e.responseTruncated && e.responseBody.length === 20,
  );
});
async function fixture(t, fetchFn) {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "sg-analysis-")),
  );
  const source = path.join(base, "音乐");
  await fs.mkdir(source);
  const file = path.join(source, "私密 中文 音乐.wav");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
    file,
  ]);
  const lib = await new Library(path.join(base, "data")).init();
  lib.enqueue = () => {};
  t.after(async () => {
    lib.db.close();
    await fs.rm(base, { recursive: true, force: true });
  });
  const root = await lib.addRoot(source, "music"),
    job = lib.scan(root.id);
  while (job.status === "running") await new Promise((r) => setTimeout(r, 10));
  const a = lib.list({ kind: "music" }).items[0];
  const service = await new MusicAnalysis(lib, { fetchFn }).init();
  return { lib, a, service, file, base, source };
}
test("音乐分析：显式上传、片段编码、密钥隔离、缓存与不改原始素材", async (t) => {
  let calls = 0;
  const f = await fixture(t, async (url, options) => {
    calls++;
    assert.equal(url, "https://api.openai.com/v1/chat/completions");
    assert.equal(options.redirect, "error");
    const request = JSON.parse(options.body);
    assert.equal(request.model, AUDIO_MODEL);
    assert.deepEqual(request.modalities, ["text"]);
    assert.equal(request.store, false);
    assert.ok(
      !options.body.includes("私密") && !options.body.includes(f.source),
    );
    const audio = request.messages[1].content[1].input_audio;
    assert.equal(audio.format, "wav");
    assert.equal(
      Buffer.from(audio.data, "base64").subarray(0, 4).toString(),
      "RIFF",
    );
    return Response.json({
      choices: [{ message: { content: JSON.stringify(result) } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    });
  });
  f.lib.patch(f.a.id, {
    tags: ["原有标签"],
    note: "原有备注",
    confirmed: true,
  });
  const before = f.lib.asset(f.a.id),
    bytes = await fs.readFile(f.file);
  await assert.rejects(f.service.analyze(f.a.id, {}), /确认/);
  await assert.rejects(f.service.analyze(f.a.id, { consent: true }), /API Key/);
  assert.equal(calls, 0);
  const config = await f.service.configure({ apiKey: testKey });
  assert.equal(config.hasKey, true);
  assert.ok(!JSON.stringify(config).includes(testKey));
  assert.equal(
    (await fs.stat(f.service.secrets.masterPath)).mode & 0o777,
    0o600,
  );
  const savedSecret = f.lib.db
    .prepare("SELECT encrypted FROM app_secrets WHERE id=?")
    .get("openai-api-key");
  assert.ok(savedSecret && !savedSecret.encrypted.includes(testKey));
  await assert.rejects(fs.access(f.service.configPath), { code: "ENOENT" });
  assert.equal((await f.service.readCache(f.a.id)).result, null);
  assert.equal(calls, 0);
  const r = await f.service.analyze(f.a.id, {
    consent: true,
    start: 0,
    duration: 30,
  });
  assert.deepEqual(r.tags, ["紧张", "电子"]);
  assert.equal(r.duration, 2);
  assert.equal(r.cached, false);
  assert.equal(calls, 1);
  assert.deepEqual(f.lib.asset(f.a.id), before);
  assert.deepEqual(await fs.readFile(f.file), bytes);
  assert.ok(
    !(await fs.readdir(f.lib.dataDir)).some((n) =>
      n.startsWith("analysis-temp-"),
    ),
  );
  const restored = await new MusicAnalysis(f.lib, {
    fetchFn: () => {
      throw Error("缓存不应联网");
    },
  }).init();
  assert.equal((await restored.readCache(f.a.id)).result.cached, true);
  assert.equal(
    (await restored.analyze(f.a.id, { consent: true })).cached,
    true,
  );
  await restored.removeKey();
  assert.equal(restored.state().hasKey, false);
  assert.equal(
    f.lib.db.prepare("SELECT COUNT(*) n FROM app_secrets").get().n,
    0,
  );
  assert.equal((await restored.readCache(f.a.id)).result.cached, true);
  await fs.utimes(f.file, new Date(), new Date(Date.now() + 5000));
  assert.equal((await restored.readCache(f.a.id)).result, null);
});

test("OpenAI 429：余额、组织/项目额度和暂时限流分开提示，不回传原始错误", async () => {
  for (const code of [
    "insufficient_quota",
    "credit_balance_exhausted",
    "organization_spend_limit_exceeded",
    "project_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
  ]) {
    const error = await providerError(
      Response.json({ error: { code, message: testKey } }, { status: 429 }),
    );
    assert.ok(error.message.includes(code));
    assert.ok(error.message.includes("反复重试不会恢复额度"));
    assert.ok(!error.message.includes(testKey));
  }
  const limited = await providerError(
    Response.json(
      { error: { code: "rate_limit_exceeded" } },
      { status: 429, headers: { "Retry-After": "12" } },
    ),
  );
  assert.match(limited.message, /不等于余额不足/);
  assert.match(limited.message, /至少等待 12 秒/);
  const typed = await providerError(
    Response.json({ error: { type: "insufficient_quota" } }, { status: 429 }),
  );
  assert.match(typed.message, /可用额度不足/);
  const unknown = await providerError(
    Response.json(
      { error: { code: testKey, message: testKey } },
      { status: 429 },
    ),
  );
  assert.match(unknown.message, /暂时无法区分/);
  assert.ok(!unknown.message.includes(testKey));
  const invalid = await providerError(
    new Response("not json", { status: 429 }),
  );
  assert.match(invalid.message, /暂时无法区分/);
});
test("音乐分析：范围与格式校验、越界链接拒绝和结果约束", async (t) => {
  const f = await fixture(t, () => {
    throw Error("不应联网");
  });
  await f.service.configure({ apiKey: testKey });
  for (const input of [
    { start: -1 },
    { start: Infinity },
    { duration: 90 },
    { start: 90000 },
  ])
    await assert.rejects(
      f.service.analyze(f.a.id, { ...input, consent: true }),
      /片段/,
    );
  f.lib.db.prepare("UPDATE assets SET duration=? WHERE id=?").run(2, f.a.id);
  await assert.rejects(
    f.service.analyze(f.a.id, { consent: true, start: 3 }),
    /超出/,
  );
  f.lib.patch(f.a.id, { kind: "sfx" });
  await assert.rejects(
    f.service.analyze(f.a.id, { consent: true }),
    /仅分析音乐/,
  );
  f.lib.patch(f.a.id, { kind: "music" });
  await fs.rename(f.file, path.join(f.base, "outside.wav"));
  await fs.symlink(path.join(f.base, "outside.wav"), f.file);
  await assert.rejects(
    f.service.analyze(f.a.id, { consent: true }),
    /超出登记/,
  );
  assert.throws(() => parseAnalysis("not json"));
  assert.throws(() =>
    parseAnalysis(JSON.stringify({ ...result, tags: ["未标记"] })),
  );
  assert.deepEqual(
    parseAnalysis("```json\n" + JSON.stringify(result) + "\n```").tags,
    ["紧张", "电子"],
  );
});

test("音乐分析失败返回详细诊断：原始错误正文、错误参数与底层网络链", async (t) => {
  const f = await fixture(t, async () =>
    Response.json(
      {
        error: {
          message: "Unsupported parameter: max_completion_tokens " + testKey,
          param: "max_completion_tokens",
          code: "unsupported_parameter",
          type: "invalid_request_error",
        },
      },
      { status: 400 },
    ),
  );
  await f.service.configure({ apiKey: testKey });
  await assert.rejects(f.service.analyze(f.a.id, { consent: true }), (e) => {
    assert.ok(
      e.diagnostic.details.responseBody.includes("Unsupported parameter"),
    );
    assert.equal(e.diagnostic.details.providerParam, "max_completion_tokens");
    assert.ok(!JSON.stringify(e.diagnostic).includes(testKey));
    return true;
  });
  const last = f.service.diagnostics.lastFailure(f.a.id);
  assert.equal(last.httpStatus, 400);
  assert.equal(f.service.diagnostics.lastFailure("unknown-id"), null);
  f.service.fetchFn = async () => {
    throw Object.assign(new TypeError("fetch failed " + testKey), {
      cause: Object.assign(new Error("connection timed out"), {
        code: "UND_ERR_CONNECT_TIMEOUT",
      }),
    });
  };
  await assert.rejects(f.service.analyze(f.a.id, { consent: true }), (e) => {
    assert.equal(e.diagnostic.httpStatus, null);
    assert.equal(e.diagnostic.details.responseBody, null);
    assert.equal(
      e.diagnostic.details.network.cause.code,
      "UND_ERR_CONNECT_TIMEOUT",
    );
    assert.ok(!JSON.stringify(e.diagnostic).includes(testKey));
    return true;
  });
  f.service.fetchFn = async () =>
    new Response("model did not return JSON", { status: 200 });
  await assert.rejects(
    f.service.analyze(f.a.id, { consent: true }),
    (e) =>
      e.diagnostic.httpStatus === 200 &&
      e.diagnostic.details.responseBody === "model did not return JSON",
  );
});
test("音乐分析：失败脱敏、无自动重试、清理临时片段", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    throw Error(testKey + " 原始远端错误");
  });
  await f.service.configure({ apiKey: testKey });
  await assert.rejects(
    f.service.analyze(f.a.id, { consent: true }),
    (e) => !e.message.includes(testKey) && e.message.includes("未自动重试"),
  );
  assert.equal(calls, 1);
  assert.equal(f.service.state().active, false);
  assert.equal((await f.service.readCache(f.a.id)).result, null);
  assert.ok(
    !(await fs.readdir(f.lib.dataDir)).some((n) =>
      n.startsWith("analysis-temp-"),
    ),
  );
  f.service.fetchFn = async () => new Response("远端敏感详情", { status: 401 });
  await assert.rejects(
    f.service.analyze(f.a.id, { consent: true }),
    /Key 无效/,
  );
});
test("音乐分析：禁止并行重复调用，配置变更受保护", async (t) => {
  let release, started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const f = await fixture(t, async () => {
    started();
    return new Promise((resolve) => {
      release = () =>
        resolve(
          Response.json({
            choices: [{ message: { content: JSON.stringify(result) } }],
          }),
        );
    });
  });
  await f.service.configure({ apiKey: testKey });
  const pending = f.service.analyze(f.a.id, { consent: true });
  await ready;
  await assert.rejects(
    f.service.analyze(f.a.id, { consent: true }),
    /已有音乐/,
  );
  await assert.rejects(f.service.removeKey(), /进行中/);
  release();
  await pending;
  assert.equal(f.service.state().active, false);
});

test("连接测试只读取模型信息，日志持久化且不包含密钥或音频", async (t) => {
  let calls = 0;
  const f = await fixture(t, async (url, options) => {
    calls++;
    assert.equal(url, "https://api.openai.com/v1/models/" + AUDIO_MODEL);
    assert.equal(options.method, "GET");
    assert.equal(options.body, undefined);
    assert.equal(options.headers.Authorization, "Bearer " + testKey);
    assert.ok(options.headers["X-Client-Request-Id"]);
    return Response.json(
      { id: AUDIO_MODEL, object: "model" },
      { headers: { "x-request-id": "req_connection_fixture" } },
    );
  });
  const missing = await f.service.testConnection();
  assert.equal(missing.ok, false);
  assert.equal(missing.diagnostic.code, "not_configured");
  assert.equal(calls, 0);
  await f.service.configure({ apiKey: testKey });
  const result = await f.service.testConnection();
  assert.equal(result.ok, true);
  assert.match(result.message, /未验证/);
  assert.equal(result.diagnostic.httpStatus, 200);
  assert.equal(result.diagnostic.requestId, "req_connection_fixture");
  assert.equal(calls, 1);
  const restarted = await new MusicAnalysis(f.lib).init();
  const logs = restarted.diagnostics.list();
  assert.equal(logs.length, 2);
  const exportText = JSON.stringify(logs);
  assert.ok(!exportText.includes(testKey));
  assert.ok(!exportText.includes(f.file));
  assert.ok(!exportText.includes("Bearer"));
  f.service.fetchFn = async () =>
    Response.json(
      {
        error: {
          code: "insufficient_quota",
          type: "insufficient_quota",
          message: testKey,
        },
      },
      { status: 429, headers: { "x-request-id": "req_quota_fixture" } },
    );
  const failed = await f.service.testConnection();
  assert.equal(failed.ok, false);
  assert.equal(failed.diagnostic.code, "insufficient_quota");
  assert.equal(failed.diagnostic.httpStatus, 429);
  assert.ok(!JSON.stringify(failed).includes(testKey));
  f.service.fetchFn = async () => {
    throw Error(testKey);
  };
  assert.equal(
    (await f.service.testConnection()).diagnostic.code,
    "network_error",
  );
  restarted.diagnostics.clear();
  assert.equal(restarted.diagnostics.list().length, 0);
});

test("诊断日志字段白名单、保留期限和调用失败日志", async (t) => {
  const f = await fixture(t, async () =>
    Response.json(
      {
        error: {
          code: "rate_limit_exceeded",
          type: "rate_limit_error",
          message: testKey,
        },
      },
      {
        status: 429,
        headers: { "x-request-id": "req_rate_fixture", "retry-after": "10" },
      },
    ),
  );
  await f.service.configure({ apiKey: testKey });
  await assert.rejects(
    f.service.analyze(f.a.id, { consent: true }),
    /暂时限流/,
  );
  const log = f.service.diagnostics.list()[0];
  assert.equal(log.operation, "analysis");
  assert.equal(log.code, "rate_limit_exceeded");
  assert.equal(log.requestId, "req_rate_fixture");
  assert.equal(log.retryAfter, "10");
  assert.equal(log.httpStatus, 429);
  assert.equal(log.assetId, f.a.id);
  assert.equal(log.duration, 2);
  const sanitized = f.service.diagnostics.record({
    operation: "analysis",
    outcome: "error",
    code: testKey,
    requestId: testKey,
    retryAfter: testKey,
    providerType: testKey,
    model: testKey,
    assetId: f.file,
    start: Infinity,
    message: testKey,
    body: testKey,
    headers: { Authorization: testKey },
  });
  assert.ok(!JSON.stringify(sanitized).includes(testKey));
  assert.equal(sanitized.assetId, null);
  f.lib.db
    .prepare("UPDATE openai_diagnostics SET created_ms=?")
    .run(Date.now() - 31 * 86400000);
  assert.equal(f.service.diagnostics.list().length, 0);
  f.service.diagnostics.record({ operation: "connection", outcome: "success" });
  assert.equal(
    f.lib.db.prepare("SELECT COUNT(*) n FROM openai_diagnostics").get().n,
    1,
  );
  const insert = f.lib.db.prepare(
    "INSERT INTO openai_diagnostics(id,created_ms,payload) VALUES(?,?,?)",
  );
  f.lib.db.transaction(() => {
    for (let i = 0; i < 1005; i++)
      insert.run("fixture-" + i, Date.now(), JSON.stringify(sanitized));
  })();
  f.service.diagnostics.record({ operation: "connection", outcome: "success" });
  assert.equal(
    f.lib.db.prepare("SELECT COUNT(*) n FROM openai_diagnostics").get().n,
    1000,
  );
});

test("API Key 旧明文配置迁移：验证密文后删除旧文件，重启可恢复", async (t) => {
  const f = await fixture(t, () => {
    throw Error("不应联网");
  });
  await fs.writeFile(
    f.service.configPath,
    JSON.stringify({ apiKey: testKey }),
    { mode: 0o600 },
  );
  const migrated = await new MusicAnalysis(f.lib).init();
  assert.equal(migrated.state().hasKey, true);
  assert.equal(migrated.state().error, "");
  assert.equal(migrated.key, testKey);
  await assert.rejects(fs.access(migrated.configPath), { code: "ENOENT" });
  const envelope = f.lib.db
    .prepare("SELECT encrypted FROM app_secrets WHERE id=?")
    .get("openai-api-key").encrypted;
  assert.equal(envelope.includes(testKey), false);
  assert.equal((await new MusicAnalysis(f.lib).init()).key, testKey);
  await migrated.configure({ apiKey: "" });
  assert.equal(migrated.key, testKey);
  await migrated.configure({ apiKey: "sk-replacement-local-test-key" });
  assert.equal(migrated.key, "sk-replacement-local-test-key");
});

test("API Key 解密失败不覆盖密文，旧配置迁移失败保留原文件", async (t) => {
  const f = await fixture(t, () => {
    throw Error("不应联网");
  });
  await f.service.configure({ apiKey: testKey });
  const before = f.lib.db
    .prepare("SELECT encrypted FROM app_secrets WHERE id=?")
    .get("openai-api-key").encrypted;
  await fs.unlink(f.service.secrets.masterPath);
  await fs.writeFile(
    f.service.configPath,
    JSON.stringify({ apiKey: testKey }),
    { mode: 0o600 },
  );
  const lost = await new MusicAnalysis(f.lib).init();
  assert.equal(lost.state().hasKey, false);
  assert.ok(lost.state().error);
  assert.ok(!JSON.stringify(lost.state()).includes(testKey));
  await assert.rejects(
    lost.configure({ apiKey: "sk-another-local-placeholder-key" }),
    /未覆盖/,
  );
  assert.equal(
    f.lib.db
      .prepare("SELECT encrypted FROM app_secrets WHERE id=?")
      .get("openai-api-key").encrypted,
    before,
  );
  assert.equal(
    JSON.parse(await fs.readFile(lost.configPath, "utf8")).apiKey,
    testKey,
  );
  await lost.removeKey();
  await lost.configure({ apiKey: testKey });
  assert.equal(lost.state().hasKey, true);
  const row = f.lib.db
    .prepare("SELECT encrypted FROM app_secrets WHERE id=?")
    .get("openai-api-key");
  const corrupted = JSON.parse(row.encrypted);
  corrupted.tag = Buffer.alloc(16).toString("base64");
  f.lib.db
    .prepare("UPDATE app_secrets SET encrypted=? WHERE id=?")
    .run(JSON.stringify(corrupted), "openai-api-key");
  assert.throws(() => lost.key, /无法解密/);
  assert.equal(lost.state().hasKey, false);
});
