/**
 * T-LOCAL-011 父级重渲染隔离夹具。
 *
 * 真实 CloudWorkspace + useCloudAuth + 真实本地后端/管理 mock；唯一额外动作是
 * 父组件每 200ms setState 一次，模拟素材轮询/提示等无关状态更新。
 *
 * legacy 模式（Vite 插件只改 CloudWorkspace 的 loadProfile 依赖回旧写法）用于对比：
 * 修复前父级每次渲染都会生成新的 loadProfile，从而反复请求 profile。
 */
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CloudWorkspace } from "../../../../src/CloudWorkspace";
import { useCloudAuth } from "../../../../src/cloud-auth";
import type { LocalRequest } from "../../../../src/OpenAISettings";

declare const __LEGACY__: boolean;
const LEGACY = __LEGACY__;

let token = "";
async function request<T = unknown>(url: string, body?: unknown, method?: string): Promise<T> {
  const verb = method || (body ? "POST" : "GET");
  const headers: Record<string, string> = {};
  if (body) headers["Content-Type"] = "application/json";
  if (verb.toUpperCase() !== "GET") headers["X-Local-Token"] = token;
  const response = await fetch("/api" + url, {
    method: verb,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(Error(result.error || "请求失败"), {
      code: result.code,
      kind: result.kind,
      status: response.status,
      retryAfterMs: result.retryAfterMs,
      requestId: result.requestId,
    });
  return result;
}

async function bootToken() {
  const response = await fetch("/api/session");
  const session = await response.json();
  token = session.token;
}

function Harness() {
  const real = useCloudAuth(request);
  const [, setTick] = useState(0);
  useEffect(() => {
    // 模拟真实 App 在账户工作台打开期间仍会发生的无关状态更新。
    const timer = setInterval(() => setTick((n) => n + 1), 200);
    return () => clearInterval(timer);
  }, []);
  // legacy 模式还原本轮修复前 useCloudAuth 每次渲染返回新对象字面量的行为。
  const auth = LEGACY ? { ...real } : real;
  return (
    <CloudWorkspace
      auth={auth}
      request={request as LocalRequest}
      onBack={() => undefined}
      onLogin={() => undefined}
      onNotice={() => undefined}
    />
  );
}

await bootToken();
createRoot(document.getElementById("root")!).render(<Harness />);
