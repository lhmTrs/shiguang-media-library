const HIDDEN = "[已隐藏]";
const sensitiveField =
  /^(authorization|api[_-]?key|password|secret|token|cookie|set-cookie|access[_-]?token|refresh[_-]?token|input_audio|audio|data|messages|prompt|path|filename)$/i;

function cleanText(value, secrets = []) {
  let text = String(value);
  for (const secret of secrets)
    if (typeof secret === "string" && secret.length >= 8)
      text = text.split(secret).join(HIDDEN);
  return text
    .replace(
      /("(?:api[_-]?key|authorization|password|secret|token|cookie|input_audio|data|prompt)"\s*:\s*)"[^"\n]*"/gi,
      '$1"[已隐藏]"',
    )
    .replace(/sk-[A-Za-z0-9_-]+/g, HIDDEN)
    .replace(/Bearer\s+[^\s"',;]+/gi, "Bearer " + HIDDEN)
    .replace(
      /\/(?:Users|Volumes|private\/var|var\/folders|tmp)\/[^\n\r"'<>]*/g,
      "[本机路径已隐藏]",
    )
    .replace(/[A-Za-z0-9+/=_-]{256,}/g, "[长编码内容已隐藏]");
}

export function redactDetails(value, secrets = [], limit = 16000) {
  if (value == null) return null;
  let source = typeof value === "string" ? value : JSON.stringify(value);
  try {
    const parsed = JSON.parse(source);
    function scrub(item, depth = 0) {
      if (depth > 8) return "[内容层级已截断]";
      if (typeof item === "string") return cleanText(item, secrets);
      if (Array.isArray(item))
        return item.slice(0, 50).map((v) => scrub(v, depth + 1));
      if (item && typeof item === "object") {
        const out = Object.create(null);
        for (const [key, val] of Object.entries(item).slice(0, 100))
          out[cleanText(key, secrets)] = sensitiveField.test(key)
            ? HIDDEN
            : scrub(val, depth + 1);
        return out;
      }
      return item;
    }
    source = JSON.stringify(scrub(parsed), null, 2);
  } catch {
    source = cleanText(source, secrets);
  }
  return source.slice(0, limit);
}

export function networkDetails(
  error,
  secrets = [],
  depth = 0,
  seen = new Set(),
) {
  if (!error || depth > 4 || seen.has(error) || seen.size >= 12) return null;
  seen.add(error);
  return {
    name: redactDetails(error.name || "Error", secrets, 80),
    message: redactDetails(error.message || "网络调用失败", secrets, 512),
    code:
      typeof error.code === "string"
        ? redactDetails(error.code, secrets, 100)
        : null,
    cause: networkDetails(error.cause, secrets, depth + 1, seen),
    errors: Array.isArray(error.errors)
      ? error.errors
          .slice(0, 4)
          .map((e) => networkDetails(e, secrets, depth + 1, seen))
          .filter(Boolean)
      : [],
  };
}

export async function readResponseText(response, limit = 65536) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const available = limit - size;
      parts.push(value.subarray(0, available));
      size += Math.min(available, value.length);
      if (size >= limit) {
        await reader.cancel();
        const error = Error("服务端响应过大，内容已截断");
        error.responseBody = Buffer.concat(parts).toString("utf8");
        error.responseTruncated = true;
        throw error;
      }
    }
    return Buffer.concat(parts).toString("utf8");
  } catch (error) {
    error.responseBody ??= Buffer.concat(parts).toString("utf8");
    error.responseTruncated = true;
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function failureDetails(input, secrets = []) {
  if (!input || typeof input !== "object") return null;
  let network = null;
  if (input.network) {
    const text = redactDetails(input.network, secrets, 16000);
    try {
      network = JSON.parse(text);
    } catch {
      network = { message: text.slice(0, 3000), truncated: true };
    }
  }
  return {
    reason: redactDetails(input.reason, secrets, 1500),
    providerMessage: redactDetails(input.providerMessage, secrets, 2000),
    providerParam: redactDetails(input.providerParam, secrets, 256),
    responseBody: redactDetails(input.responseBody, secrets, 16000),
    responseTruncated:
      input.responseTruncated === true ||
      (typeof input.responseBody === "string" &&
        input.responseBody.length > 16000),
    network,
  };
}
