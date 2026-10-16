import { useEffect, useRef, useState } from "react";
import { Sparkles, Settings, X, Check } from "lucide-react";
import type { Asset } from "./main";
import { AnalysisFailure } from "./AnalysisFailure";
import type { Diagnostic } from "./OpenAIDiagnostics";
import {
  OpenAISettings,
  type AIState,
  type LocalRequest,
} from "./OpenAISettings";
type Analysis = {
  summary: string;
  mood: string;
  style: string;
  instruments: string;
  rhythm: string;
  energy: string;
  uses: string;
  limitations: string;
  tags: string[];
  note: string;
  model: string;
  start: number;
  duration: number;
  createdAt: string;
  cached: boolean;
};
export function MusicAnalysisPanel({
  asset,
  request,
  disabled,
  adopt,
}: {
  asset: Asset;
  request: LocalRequest;
  disabled: boolean;
  adopt: (tags: string[], note: string) => boolean;
}) {
  const [config, setConfig] = useState<AIState | null>(null);
  const [result, setResult] = useState<Analysis | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [useNote, setUseNote] = useState(false);
  const [start, setStart] = useState(0);
  const [duration, setDuration] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [failure, setFailure] = useState<Diagnostic | null>(null);
  const [settings, setSettings] = useState(false);
  const [notice, setNotice] = useState("");
  const seq = useRef(0);
  const available = asset.online && asset.ext !== "ncm";
  function accept(r: Analysis | null) {
    setResult(r);
    setPicked(r?.tags || []);
    setUseNote(false);
  }
  async function configuration() {
    setConfig(await request<AIState>("/openai"));
  }
  useEffect(() => {
    void configuration().catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    setStart(0);
    setNotice("");
  }, [asset.id]);
  useEffect(() => {
    const s = ++seq.current;
    accept(null);
    setFailure(null);
    setError("");
    setBusy(false);
    request<{ diagnostic: Diagnostic | null }>(
      `/assets/${asset.id}/analysis-failure`,
    )
      .then((d) => {
        if (s === seq.current) setFailure(d.diagnostic);
      })
      .catch(() => {});
    if (available)
      request<{ result: Analysis | null }>(
        `/assets/${asset.id}/analysis?start=${start}&duration=${duration}`,
      )
        .then((d) => {
          if (s === seq.current) accept(d.result);
        })
        .catch((e) => {
          if (s === seq.current) setError(e.message);
        });
    return () => {
      seq.current++;
    };
  }, [asset.id, available, start, duration]);
  async function analyze(force = false) {
    if (!available || disabled || busy) return;
    if (
      force &&
      !window.confirm("重新上传此片段进行分析？会产生新的 API 调用费用。")
    )
      return;
    const s = ++seq.current;
    setBusy(true);
    setFailure(null);
    setError("");
    setNotice("");
    try {
      const r = await request<Analysis>("/assets/" + asset.id + "/analysis", {
        start,
        duration,
        consent: true,
        force,
      });
      if (s === seq.current) accept(r);
    } catch (e) {
      if (s === seq.current) {
        setError(e instanceof Error ? e.message : "分析失败");
        const diagnostic = (e as { diagnostic?: Diagnostic })?.diagnostic;
        if (diagnostic) setFailure(diagnostic);
      }
    } finally {
      if (s === seq.current) setBusy(false);
    }
  }
  const fields: [string, keyof Analysis][] = [
    ["情绪", "mood"],
    ["风格", "style"],
    ["音色 / 乐器", "instruments"],
    ["节奏", "rhythm"],
    ["强度", "energy"],
    ["剪辑用途", "uses"],
  ];
  return (
    <section className="music-analysis-panel" aria-label="GPT 音乐分析">
      <div className="analysis-heading">
        <h3>
          <Sparkles size={17} />
          GPT 音乐分析
        </h3>
        <button
          className="icon-button"
          aria-label="音乐分析设置"
          title="音乐分析设置"
          disabled={busy}
          onClick={() => setSettings(true)}
        >
          <Settings size={17} />
        </button>
      </div>
      <div className="analysis-controls">
        <label>
          起点（秒）
          <input
            aria-label="分析片段起点"
            type="number"
            min={0}
            max={
              asset.duration == null ? 86400 : Math.max(0, asset.duration - 0.1)
            }
            step={1}
            value={start}
            disabled={busy}
            onChange={(e) => setStart(Number(e.target.value))}
          />
        </label>
        <label>
          片段长度
          <select
            aria-label="分析片段长度"
            value={duration}
            disabled={busy}
            onChange={(e) => setDuration(Number(e.target.value))}
          >
            <option value={15}>15 秒</option>
            <option value={30}>30 秒</option>
            <option value={60}>60 秒</option>
          </select>
        </label>
        <button
          className="primary"
          disabled={disabled || busy || !available || !config?.hasKey}
          onClick={() => void analyze(!!result)}
        >
          <Sparkles size={16} />
          {busy ? "分析中…" : result ? "重新分析" : "分析当前音乐"}
        </button>
      </div>
      <p className="analysis-disclosure">
        仅点击分析时上传选定音频片段至 OpenAI，按 API
        计费；不会发送本机路径，结果仅供参考。
      </p>
      {!config?.hasKey && (
        <button disabled={busy} onClick={() => setSettings(true)}>
          配置 API Key
        </button>
      )}
      {!available && (
        <p className="muted">
          {!asset.online ? "离线音乐暂不能分析" : "NCM 暂不支持音频分析"}
        </p>
      )}
      {error && (
        <p className="database-error" role="alert">
          {error}
        </p>
      )}
      {failure && !result && (
        <section className="last-analysis-failure">
          <h4>上次失败详情</h4>
          <AnalysisFailure diagnostic={failure} />
        </section>
      )}
      {result && (
        <div className="analysis-result">
          <p className="analysis-meta">
            待确认 · {result.cached ? "本机缓存" : "新分析"} · {result.model} ·{" "}
            {result.start.toFixed(0)}–
            {(result.start + result.duration).toFixed(1)} 秒
          </p>
          <p>{result.summary}</p>
          <dl>
            {fields.map(([label, field]) => (
              <div key={field}>
                <dt>{label}</dt>
                <dd>{String(result[field])}</dd>
              </div>
            ))}
          </dl>
          <p className="muted">{result.limitations}</p>
          <div className="queue-tag-options">
            {result.tags.map((t) => (
              <label key={t} className={picked.includes(t) ? "selected" : ""}>
                <input
                  type="checkbox"
                  aria-label={"AI 建议标签：" + t}
                  checked={picked.includes(t)}
                  onChange={() =>
                    setPicked((p) =>
                      p.includes(t) ? p.filter((x) => x !== t) : [...p, t],
                    )
                  }
                />
                <span>{t}</span>
              </label>
            ))}
          </div>
          <label className="analysis-note-choice">
            <input
              type="checkbox"
              checked={useNote}
              onChange={(e) => setUseNote(e.target.checked)}
            />
            同时采用建议备注
          </label>
          {result.note && <p className="analysis-note">{result.note}</p>}
          <button
            disabled={disabled || (!picked.length && !useNote)}
            onClick={() => {
              if (adopt(picked, useNote ? result.note : ""))
                setNotice("建议已放入编辑区，尚未保存");
            }}
          >
            <Check size={16} />
            采用勾选建议
          </button>
        </div>
      )}
      {notice && (
        <p role="status" className="category-notice">
          {notice}
        </p>
      )}
      {settings && (
        <div className="modal-backdrop">
          <div
            className="modal category-editor"
            role="dialog"
            aria-modal="true"
            aria-label="OpenAI 音乐分析设置"
          >
            <div className="modal-head">
              <h2>音乐分析设置</h2>
              <button
                className="icon-button"
                aria-label="关闭音乐分析设置"
                onClick={() => setSettings(false)}
              >
                <X size={17} />
              </button>
            </div>
            <div className="modal-body">
              <OpenAISettings
                request={request}
                changed={() =>
                  void configuration().catch((e) => setError(e.message))
                }
              />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
