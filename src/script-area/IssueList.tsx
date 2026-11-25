import React from 'react';
import type { Issue } from './types';

/** 校验问题列表：错误在前，提醒在后；path 原样给出，方便 agent 对回数据。不回显原文。 */
export function IssueList({ issues, title }: { issues: Issue[]; title?: string }) {
  if (!issues.length) return null;
  const sorted = [...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  const errors = issues.filter(i => i.severity === 'error').length, warnings = issues.length - errors;
  return <section className="sa-issues" aria-label={title || '校验问题'}>
    <h3>{title || (errors ? `有 ${errors} 处错误，没有收下` : `${warnings} 条提醒（照收）`)}{errors > 0 && warnings > 0 && <small>另有 {warnings} 条提醒</small>}</h3>
    <ol>{sorted.map((i, n) => <li key={n} className={'sa-issue is-' + i.severity} data-code={i.code}>
      <span className="sa-issue-kind">{i.severity === 'error' ? '错误' : '提醒'}</span>
      <span className="sa-issue-msg">{i.message}</span>
      {i.path && <code className="sa-issue-path">{i.path}</code>}
      {!!i.candidateLines?.length && <span className="sa-issue-lines">这段话实际出现在：{i.candidateLines.map(l => 'L' + l).join('、')}</span>}
    </li>)}</ol>
  </section>;
}
