import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * legacy 模式只把 CloudWorkspace 的 loadProfile 依赖改回修复前的 `[auth, ...]`，
 * 其它源码完全不变；配合 main.tsx 在 legacy 模式下每次渲染传入新的 auth 对象，
 * 即可复现“父级无关重渲染 → 反复读取 profile”。
 */
function legacyDependencyPlugin() {
  return {
    name: "t11-legacy-auth-dependency",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith("/src/CloudWorkspace.tsx")) return null;
      const needle = "    [accountKey, guard, request, viewState],\n  );";
      if (!code.includes(needle)) throw new Error("T-LOCAL-011 legacy 注入口未找到");
      return code.replace(needle, "    [auth, guard, request],\n  );");
    },
  };
}

export default defineConfig(({ mode }) => {
  const legacy = mode === "legacy";
  return {
    root: HERE,
    base: "/",
    appType: "spa",
    define: { __LEGACY__: JSON.stringify(legacy) },
    plugins: legacy ? [legacyDependencyPlugin()] : [],
    build: {
      outDir: path.join(HERE, legacy ? "dist-legacy" : "dist"),
      emptyOutDir: true,
      target: "es2022",
    },
  };
});
