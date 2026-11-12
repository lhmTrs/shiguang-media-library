import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { FileText, Link, Share2 } from "lucide-react";
import "./agent-share.css";

type Guide = { state: "loading" | "error" } | { state: "ready"; markdown: string };
type CopyResult = { label: string; manualText?: string };

export function AgentShare({ projectId, projectName, disabled = false }: {
  projectId: string;
  projectName: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [guide, setGuide] = useState<Guide>({ state: "loading" });
  const [copying, setCopying] = useState(false);
  const [result, setResult] = useState<CopyResult | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const firstAction = useRef<HTMLButtonElement>(null);
  const manualField = useRef<HTMLTextAreaElement>(null);
  const session = useRef<AbortController | null>(null);
  const panelId = useId();
  const guideUrl = `${window.location.origin}/api/projects/${encodeURIComponent(projectId)}/agent-guide`;

  const close = useCallback(() => {
    session.current?.abort();
    session.current = null;
    setOpen(false);
  }, []);

  useLayoutEffect(() => () => session.current?.abort(), []);
  useLayoutEffect(() => {
    if (!open) return;
    if (disabled) { close(); return; }
    const container = root.current;
    const button = trigger.current;
    const popup = panel.current;
    if (!container || !button || !popup) return;

    const position = (rect: DOMRect) => {
      const { clientWidth, clientHeight } = document.documentElement;
      const margin = 12, gap = 6;
      const above = rect.top - margin - gap;
      const below = clientHeight - rect.bottom - margin - gap;
      const opensAbove = below < 230 && above > below;
      const left = Math.min(rect.right - popup.offsetWidth, clientWidth - popup.offsetWidth - margin);
      popup.style.left = `${Math.max(margin, left)}px`;
      popup.style.top = opensAbove ? "auto" : `${rect.bottom + gap}px`;
      popup.style.bottom = opensAbove ? `${clientHeight - rect.top + gap}px` : "auto";
      popup.style.maxHeight = `${Math.max(0, opensAbove ? above : below)}px`;
    };
    const outside = (event: Event) => {
      if (!(event.target instanceof Node) || !container.contains(event.target)) close();
    };
    const onScroll = (event: Event) => {
      // Follow the trigger's scroller, including a scroll queued before opening.
      const target = event.target;
      if (target instanceof Node && !target.contains(button)) return;

      const rect = button.getBoundingClientRect();
      let top = 0, bottom = document.documentElement.clientHeight;
      if (target instanceof Element && target !== document.scrollingElement) {
        const scrollportTop = target.getBoundingClientRect().top + target.clientTop;
        top = Math.max(top, scrollportTop);
        bottom = Math.min(bottom, scrollportTop + target.clientHeight);
      }
      if (rect.bottom <= top || rect.top >= bottom) {
        close();
        return;
      }
      position(rect);
    };
    const onResize = () => position(button.getBoundingClientRect());
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
      button.focus({ preventScroll: true });
    };
    onResize();
    firstAction.current?.focus({ preventScroll: true });
    // Handle Escape before the enclosing storyboard modal's native listener.
    container.addEventListener("keydown", onEscape);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      container.removeEventListener("keydown", onEscape);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [close, disabled, open]);

  useLayoutEffect(() => {
    const field = manualField.current;
    if (!field) return;
    field.focus({ preventScroll: true });
    field.select();
    if (panel.current) panel.current.scrollTop = panel.current.scrollHeight;
  }, [result]);

  async function preload(signal: AbortSignal) {
    setGuide({ state: "loading" });
    try {
      const response = await fetch(guideUrl, { signal, cache: "no-store" });
      const mimeType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      if (!response.ok || mimeType !== "text/markdown") throw new Error("Markdown unavailable");
      const markdown = await response.text();
      if (!signal.aborted) setGuide({ state: "ready", markdown });
    } catch {
      if (!signal.aborted) setGuide({ state: "error" });
    }
  }

  function toggle() {
    if (open) {
      close();
      trigger.current?.focus({ preventScroll: true });
      return;
    }
    const next = new AbortController();
    session.current = next;
    setCopying(false);
    setResult(null);
    setOpen(true);
    void preload(next.signal);
  }

  async function copy(label: string, text: string) {
    const signal = session.current?.signal;
    if (!signal || signal.aborted || copying) return;
    setResult(null);
    setCopying(true);
    try {
      await navigator.clipboard.writeText(text);
      if (!signal.aborted) setResult({ label });
    } catch {
      if (!signal.aborted) setResult({ label, manualText: text });
    } finally {
      if (!signal.aborted) setCopying(false);
    }
  }

  function copyGuide() {
    const signal = session.current?.signal;
    if (!signal || signal.aborted || copying || guide.state === "loading") return;
    if (guide.state === "ready") {
      void copy("Markdown 说明", guide.markdown);
    } else {
      setResult(null);
      void preload(signal);
    }
  }

  const manualText = result?.manualText;
  const guideStatus = guide.state === "loading" ? "正在读取 Markdown 说明…" :
    guide.state === "error" ? "读取 Markdown 说明失败，请重试。" : "";
  const status = copying ? "正在复制…" : result
    ? manualText === undefined ? `已复制${result.label}` : "复制失败，请手动复制已选中的内容。"
    : guideStatus;

  return <div className="agent-share" ref={root}>
    <button type="button" className="agent-share-trigger" ref={trigger} disabled={disabled}
      aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={toggle}>
      <Share2 size={14} aria-hidden="true"/>分享给 Agent
    </button>
    {open && <div id={panelId} className="agent-share-panel" ref={panel} role="group" aria-labelledby={`${panelId}-name`}>
      <strong className="agent-share-name" id={`${panelId}-name`}>{projectName}</strong>
      <button type="button" className="agent-share-action" ref={firstAction} aria-disabled={copying}
        onClick={event => { event.currentTarget.focus({ preventScroll: true }); void copy("接入链接", guideUrl); }}>
        <Link size={14} aria-hidden="true"/>复制接入链接
      </button>
      <button type="button" className="agent-share-action" aria-disabled={copying || guide.state === "loading"}
        onClick={event => { event.currentTarget.focus({ preventScroll: true }); copyGuide(); }}>
        <FileText size={14} aria-hidden="true"/>{guide.state === "error" ? "重新加载 Markdown 说明" : "复制 Markdown 说明"}
      </button>
      <div className="agent-share-status" role="status">{status}</div>
      {manualText !== undefined && <textarea className="agent-share-manual" ref={manualField} readOnly
        aria-label={result?.label} rows={3} value={manualText}/>}
    </div>}
  </div>;
}
