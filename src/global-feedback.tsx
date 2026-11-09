import React, {useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {createPortal} from 'react-dom';
import {AlertCircle, AlertTriangle, CheckCircle2, Info, X} from 'lucide-react';
import {createFeedbackStore, type FeedbackInput, type FeedbackItem} from './feedback-store';
import './global-feedback.css';

export const feedback = createFeedbackStore();
export const notifyFeedback = (input: FeedbackInput) => feedback.publish(input);
type Options = {source?: string; active?: boolean; kind?: FeedbackInput['kind']};

export class GlobalErrorBoundary extends React.Component<{children: React.ReactNode}, {failed: boolean}> {
  state = {failed: false};
  static getDerivedStateFromError() { return {failed: true}; }
  componentDidCatch() { notifyFeedback({kind: 'error', key: 'render-failure', title: '页面暂时无法显示', message: '页面遇到了异常，已保存的数据不受影响。请保留当前工作后刷新重试。'}); }
  render() { return this.state.failed ? <section className="global-feedback-fallback" role="alert"><h1>页面暂时无法显示</h1><p>页面遇到了异常，请刷新重试。未提交的操作不会自动重新执行。</p><button type="button" onClick={() => location.reload()}>刷新页面</button></section> : this.props.children; }
}

/** Bridge an existing visible error state without changing its guards or retry semantics. */
export function useFeedbackToast(message: string | null | undefined, {source = '', active = true, kind = 'error'}: Options = {}) {
  const previous = useRef('');
  useEffect(() => {
    if (!message) { previous.current = ''; return; }
    if (!active || previous.current === message) return;
    const send = () => { previous.current = message; notifyFeedback({message, source, kind}); };
    if (/\b(?:HOST_BUSY|DATABASE_BUSY|SQLITE_BUSY|FILE_MAINTENANCE_BUSY)\b/.test(message)) { const timer = setTimeout(send, 1200); return () => clearTimeout(timer); }
    send();
  }, [message, source, active, kind]);
}

/** Announce a live task failure, not failures merely loaded from historical records. */
export function useTaskFailureToast(id: string | undefined, running: boolean, failure: string, {source = '', active = true}: Options = {}) {
  const observed = useRef<{id: string; running: boolean} | null>(null);
  useEffect(() => {
    if (!active || !id) { observed.current = null; return; }
    if (observed.current?.id === id && observed.current.running && !running && failure)
      notifyFeedback({kind: 'error', source, message: failure, key: 'task-failure:' + id});
    observed.current = {id, running};
  }, [id, running, failure, source, active]);
}

function FeedbackCard({item}: {item: FeedbackItem}) {
  const Icon = {error: AlertCircle, warning: AlertTriangle, success: CheckCircle2, info: Info}[item.kind];
  return <article className={'global-feedback-card global-feedback-' + item.kind + (item.leaving ? ' is-leaving' : '')} data-feedback-id={item.id} data-feedback-kind={item.kind}
    role={item.kind === 'error' ? 'alert' : 'status'} aria-atomic="true"
    onMouseEnter={() => feedback.pause(item.id, 'hover', true)} onMouseLeave={() => feedback.pause(item.id, 'hover', false)}
    onFocusCapture={() => feedback.pause(item.id, 'focus', true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) feedback.pause(item.id, 'focus', false); }}>
    <Icon className="global-feedback-icon" size={21} aria-hidden="true"/>
    <div className="global-feedback-copy"><strong>{item.title}</strong><p>{item.message}</p>{(item.source || item.count > 1) && <small>{item.source}{item.source && item.count > 1 ? ' · ' : ''}{item.count > 1 ? '相同提示 ' + item.count + ' 次' : ''}</small>}</div>
    <button type="button" aria-label="关闭此提示" onClick={event => { event.stopPropagation(); feedback.dismiss(item.id); }}><X size={17}/></button>
  </article>;
}

/** A native modal owns its top layer. Place feedback inside it rather than behind it. */
export function GlobalFeedback() {
  const state = useSyncExternalStore(feedback.subscribe, feedback.getSnapshot, feedback.getSnapshot);
  const [owner, setOwner] = useState<HTMLElement>(() => document.body);
  useEffect(() => {
    const sync = () => { const dialogs = document.querySelectorAll<HTMLDialogElement>('dialog[open]'); const next = dialogs.item(dialogs.length - 1) || document.body; setOwner(old => old === next ? old : next); };
    const containsDialog = (node: Node) => node instanceof Element && (node.matches('dialog') || !!node.querySelector('dialog'));
    const observer = new MutationObserver(records => { if (records.some(row => row.type === 'attributes' || [...row.addedNodes, ...row.removedNodes].some(containsDialog))) sync(); });
    observer.observe(document.body, {subtree: true, childList: true, attributes: true, attributeFilter: ['open']}); sync();
    const visibility = () => feedback.setHidden(document.hidden); visibility(); document.addEventListener('visibilitychange', visibility);
    const uncaught = (event: ErrorEvent) => { if (!event.message || event.error?.name === 'AbortError') return; notifyFeedback({kind: 'error', key: 'unexpected-page-error', title: '页面运行异常', message: '当前操作未能完成，请保留输入后重试；如果仍然失败，可保存已有修改后刷新页面。'}); };
    const rejected = (event: PromiseRejectionEvent) => { if (event.reason?.name === 'AbortError') return; notifyFeedback({kind: 'error', key: 'unexpected-promise-error', title: '操作出现异常', message: '有一项操作没有正常完成，请查看当前页面的错误原因并保留输入。系统没有自动重新提交。'}); };
    window.addEventListener('error', uncaught); window.addEventListener('unhandledrejection', rejected);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('error', uncaught); window.removeEventListener('unhandledrejection', rejected); feedback.setHidden(false); };
  }, []);
  return createPortal(<section className="global-feedback-region" data-global-feedback="true" aria-label="全局操作提示">{state.items.map(item => <FeedbackCard key={item.id} item={item}/>)}{state.waiting > 0 && <span className="global-feedback-waiting" role="status">还有 {state.waiting} 条提示等待显示</span>}</section>, owner);
}
