import React, { useEffect, useRef } from "react";
import { X, RotateCcw, Check } from "lucide-react";
import { THEME_LIST, type ThemeId } from "./theme-list";

/**
 * 界面设置：界面风格（主题）+ 导航栏目显隐。
 * 风格切换只写 <html data-theme>，配色由 themes.css 的 token 覆盖完成，因此即时生效、无需刷新。
 */
export function NavigationSettings({ items, hidden, toggle, reset, theme, setTheme, close }: {
  items: [string, string][];
  hidden: string[];
  toggle: (id: string) => void;
  reset: () => void;
  theme: ThemeId;
  setTheme: (id: ThemeId) => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    element.querySelector<HTMLButtonElement>("button")?.focus();
    function keydown(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      if (e.key !== "Tab") return;
      const controls = [...element.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')];
      const first = controls[0], last = controls[controls.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, [close]);
  return <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) close(); }}>
    <div ref={dialog} className="modal navigation-settings" role="dialog" aria-modal="true" aria-labelledby="navigation-settings-title">
      <div className="modal-head"><h2 id="navigation-settings-title">界面设置</h2><button className="icon-button" title="关闭界面设置" aria-label="关闭界面设置" onClick={close}><X size={18}/></button></div>
      <div className="modal-body interface-settings-body">
        <section className="settings-section">
          <div className="settings-section-head">
            <h3>界面风格</h3>
            <small>点选即时生效，选择会记住</small>
          </div>
          <div className="theme-grid" role="radiogroup" aria-label="界面风格">
            {THEME_LIST.map(item => {
              const active = theme === item.id;
              return <button key={item.id} type="button" role="radio" aria-checked={active} data-theme-option={item.id}
                className={"theme-card" + (active ? " is-active" : "")} title={item.desc} onClick={() => setTheme(item.id)}>
                <span className="theme-swatch" aria-hidden="true">
                  {item.swatch.map((color, index) => <i key={index} style={{ background: color }}/>)}
                </span>
                <span className="theme-card-text"><strong>{item.name}</strong><small>{item.desc}</small></span>
                {active && <Check className="theme-card-check" size={15} aria-hidden="true"/>}
              </button>;
            })}
          </div>
        </section>
        <section className="settings-section">
          <div className="settings-section-head">
            <h3>导航栏目</h3>
            <small>取消勾选即可隐藏左侧对应入口</small>
          </div>
          <div className="navigation-options">{items.map(([id, label]) => <label key={id}>
            <input type="checkbox" checked={!hidden.includes(id)} disabled={id === "all"} onChange={() => toggle(id)}/>
            <span>{label}</span>{id === "all" && <small>始终显示</small>}
          </label>)}</div>
        </section>
      </div>
      <div className="navigation-settings-footer"><button className="plain" onClick={reset}><RotateCcw size={15}/>恢复全部</button><button className="primary" onClick={close}>完成</button></div>
    </div>
  </div>;
}
