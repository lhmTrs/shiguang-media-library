import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { LoaderCircle, RefreshCw, Save } from "lucide-react";
import type { LocalRequest } from "./OpenAISettings";

type Settings = { thresholdMb: number; thresholdBytes: number; version: number; configured: boolean };

export function CloudUploadApprovalSettings({ request, guard, onAuthFailure }: {
  request: LocalRequest;
  guard: <T>(task: () => Promise<T>) => Promise<T>;
  onAuthFailure: (failure: unknown) => string;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [conflict, setConflict] = useState(false);
  const sequence = useRef(0);
  const active = useRef(false);
  const load = useCallback(async () => {
    const seq = ++sequence.current;
    setBusy(true); setError(""); setSuccess("");
    try {
      const next = await guard(() => request<Settings>("/cloud-management/upload-approval-settings"));
      if (!active.current || seq !== sequence.current) return;
      setSettings(next); setValue(String(next.thresholdMb)); setConflict(false);
    } catch (failure) {
      if (active.current && seq === sequence.current) setError(onAuthFailure(failure));
    } finally {
      if (active.current && seq === sequence.current) setBusy(false);
    }
  }, [request, guard, onAuthFailure]);
  useEffect(() => {
    active.current = true; void load();
    return () => { active.current = false; sequence.current += 1; };
  }, [load]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!settings || busy || conflict) return;
    const thresholdMb = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(thresholdMb) || thresholdMb < 1 || thresholdMb > 2048) {
      setError("请输入 1 至 2048 之间的整数 MB。"); return;
    }
    const seq = ++sequence.current;
    setBusy(true); setError(""); setSuccess("");
    try {
      const next = await guard(() => request<Settings>("/cloud-management/upload-approval-settings", {
        thresholdMb, expectedVersion: settings.version,
      }, "PUT"));
      if (!active.current || seq !== sequence.current) return;
      setSettings(next); setValue(String(next.thresholdMb));
      setSuccess(`已保存为 ${next.thresholdMb} MB，仅对新上传申请生效。`);
    } catch (failure) {
      if (!active.current || seq !== sequence.current) return;
      if ((failure as { code?: string })?.code === "VERSION_CONFLICT") setConflict(true);
      setError(onAuthFailure(failure));
    } finally {
      if (active.current && seq === sequence.current) setBusy(false);
    }
  }
  return <section className="cw-panel">
    <div className="cw-pagebar"><div className="cw-pagebar-title"><h2>上传人工审批阈值</h2></div>
      <button className="plain" type="button" onClick={() => void load()} disabled={busy}><RefreshCw size={14} /> 重新读取</button>
    </div>
    <p className="cw-hint">仅超级管理员可修改。新申请的文件大小超过此值时需要人工审批，等于此值时免审。1 MB = 1,000,000 字节。</p>
    <p className="cw-hint">修改仅影响新申请；已有申请及其重试保留原阈值和审批状态。实际上传大小上限保持不变。</p>
    {error && <p role="alert" className="cw-error">{error}</p>}
    {success && <p role="status" className="cw-success">{success}</p>}
    {!settings && busy && <p role="status"><LoaderCircle size={14} /> 正在读取…</p>}
    {settings && <form className="cw-surface cw-detail-pane cw-form" style={{ maxWidth: 640 }} onSubmit={event => void save(event)}>
      <label className="field">免审阈值（MB） <input type="number" min="1" max="2048" step="1" required value={value}
        disabled={busy || conflict} onChange={event => { setValue(event.target.value); setSuccess(""); }} /></label>
      <p className="cw-hint">当前：{settings.thresholdMb} MB{settings.configured ? "（已保存）" : "（沿用服务器配置，默认 100 MB）"}</p>
      <button className="primary" type="submit" disabled={busy || conflict}><Save size={14} /> {busy ? "处理中…" : "保存"}</button>
      {conflict && <p className="cw-hint">设置已变化，请先点击“重新读取”，再修改保存。</p>}
    </form>}
  </section>;
}
