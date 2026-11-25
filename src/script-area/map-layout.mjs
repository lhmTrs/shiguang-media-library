// 泳道图排版：从泳道图会话交的 renderer/template.html 原样移植（几何、编号、自动走线、删除标记）。
// 纯数据，不碰 DOM，node 测试和 React 组件共用。和模板相比只改了三处（数据格式 v1.4）：
//   1. 箭头统一成对象 {from,to,route?,offset?}，模板里的 f 叫 offset；route 省略或写 auto 都自动挑。
//   2. 改动图里被删框的箭头不画，只在原位留删除标记（模板也是这样）。
//   3. 输入是合同 renderData.graph（refs/old/new 只有行号，原句另由 excerpts 回填）。

export const MAP_GEOMETRY = Object.freeze({ GAP: 16, PADX: 14, HEAD: 40, BOXH: 40, R: 7, HERO_W: 196 });

const labelLines = label => Array.isArray(label) ? label.map(String) : [String(label ?? '')];

/** 改动图里「改了因果」的三种：要编号、粗描边。 */
export const isBigChange = (mode, node) => mode === 'diff' && ['chg', 'new', 'del'].includes(node.change);

/**
 * 排版。返回 SVG 要画的一切：泳道、场次带、框、箭头路径、删除标记、画布宽高，
 * 以及 all（含被删框，供弹出卡片和下方说明用）。
 */
export function layoutMap(graph) {
  const { GAP, PADX, HEAD, BOXH, HERO_W } = MAP_GEOMETRY;
  const mode = graph.kind === 'diff' ? 'diff' : 'single';
  const rawLanes = Array.isArray(graph.lanes) ? graph.lanes : [];
  const sideW = rawLanes.length > 5 ? 112 : 120;
  const lanes = rawLanes.map((l, i) => ({ ...l, i, w: l.hero ? HERO_W : sideW, x: 0, cx: 0 }));
  const L = Object.fromEntries(lanes.map(l => [l.id, l]));
  let nodes = (Array.isArray(graph.nodes) ? graph.nodes : []).filter(n => L[n.lane]).map(n => ({ ...n, label: labelLines(n.label) }));
  let bands = (Array.isArray(graph.bands) ? graph.bands : []).map(b => ({ ...b }));
  let edges = (Array.isArray(graph.edges) ? graph.edges : []).map(e => ({ from: e.from, to: e.to, route: e.route && e.route !== 'auto' ? e.route : undefined, offset: typeof e.offset === 'number' ? e.offset : undefined }));

  // 编号：改动图给「改了因果」的编号，单版图给 AI 补的编号；按行、再按泳道排序
  { let k = 0; [...nodes].sort((a, b) => a.row - b.row || L[a.lane].i - L[b.lane].i).forEach(n => { if (mode === 'diff' ? isBigChange(mode, n) : !!n.ai) n.num = ++k; }); }
  const all = Object.fromEntries(nodes.map(n => [n.id, n]));

  const delMarks = [];
  const compact = () => {
    const used = [...new Set([...nodes.map(n => n.row), ...bands.map(b => b.row)])].sort((a, b) => a - b);
    const remap = Object.fromEntries(used.map((r, i) => [r, i + 1]));
    return { used, remap };
  };
  if (mode === 'diff') {
    const gone = nodes.filter(n => n.change === 'del');
    const goneIds = new Set(gone.map(n => n.id));
    nodes = nodes.filter(n => !goneIds.has(n.id));
    edges = edges.filter(e => !goneIds.has(e.from) && !goneIds.has(e.to));
    const { used, remap } = compact();
    for (const g of gone) { const next = used.find(r => r > g.row); delMarks.push({ id: g.id, lane: g.lane, before: next !== undefined ? remap[next] : used.length + 1, num: g.num }); }
    nodes = nodes.map(n => ({ ...n, row: remap[n.row] })); bands = bands.map(b => ({ ...b, row: remap[b.row] }));
  } else {
    const { remap } = compact();
    nodes = nodes.map(n => ({ ...n, row: remap[n.row] })); bands = bands.map(b => ({ ...b, row: remap[b.row] }));
  }

  // 几何
  const ROWH = mode === 'diff' ? 56 : 58;
  let x = PADX; for (const l of lanes) { l.x = x; l.cx = x + l.w / 2; x += l.w + GAP; }
  const W = Math.max(x - GAP + PADX, PADX * 2);
  const maxRow = Math.max(1, ...nodes.map(n => n.row), ...bands.map(b => b.row));
  const rowY = r => HEAD + (r - 1) * ROWH + 10;
  const H = rowY(maxRow) + BOXH + 16;
  const N = {}, cell = {};
  nodes = nodes.map(n => { const l = L[n.lane]; const box = { ...n, l, x: l.x + 6, w: l.w - 12, y: rowY(n.row), h: BOXH }; N[n.id] = box; cell[n.lane + '@' + n.row] = box; return box; });
  const occ = (laneIdx, row) => !!cell[lanes[laneIdx].id + '@' + row];
  const warnings = [];

  // 自动走线：同泳道竖线；同行横线；相邻泳道相邻行斜线；否则先横后竖或先竖后横，挑不压框的那条
  function pickRoute(s, t) {
    const si = s.l.i, ti = t.l.i, dir = ti > si ? 1 : -1;
    if (si === ti) return 'v';
    if (s.row === t.row) return 'h';
    if (Math.abs(si - ti) === 1 && t.row - s.row === 1) return 'd';
    let hvOk = true; for (let i = si + dir; i !== ti + dir; i += dir) if (occ(i, s.row)) hvOk = false;
    for (let r = s.row + 1; r < t.row; r++) if (occ(ti, r)) hvOk = false;
    if (hvOk) return 'hv';
    let vhOk = true; for (let r = s.row + 1; r < t.row; r++) if (occ(si, r)) vhOk = false;
    for (let i = si + dir; i !== ti; i += dir) if (occ(i, t.row)) vhOk = false;
    if (vhOk) return 'vh';
    warnings.push({ from: s.id, to: t.id, message: '走线会压到别的框' }); return 'hv';
  }

  const paths = [];
  for (const e of edges) {
    const s = N[e.from], t = N[e.to]; if (!s || !t) continue;
    const route = e.route || pickRoute(s, t), f = e.offset;
    const right = t.l.cx > s.l.cx, smid = s.y + s.h / 2, tmid = t.y + t.h / 2; let d;
    if (route === 'v') d = `M${s.l.cx} ${s.y + s.h} L${t.l.cx} ${t.y - 3}`;
    else if (route === 'h') d = right ? `M${s.x + s.w} ${smid} L${t.x - 3} ${tmid}` : `M${s.x} ${smid} L${t.x + t.w + 3} ${tmid}`;
    else if (route === 'd') { const sx = right ? s.x + s.w - 14 : s.x + 14, tx = right ? t.x + 14 : t.x + t.w - 14; d = `M${sx} ${s.y + s.h} L${tx} ${t.y - 3}`; }
    else if (route === 'hv') { const tx = f != null ? t.x + t.w * f : t.l.cx, sx = right ? s.x + s.w : s.x; d = `M${sx} ${smid} L${tx} ${smid} L${tx} ${t.y - 3}`; }
    else if (route === 'vh') { const sx = f != null ? s.x + s.w * f : s.l.cx, ex = right ? t.x - 3 : t.x + t.w + 3; d = `M${sx} ${s.y + s.h} L${sx} ${tmid} L${ex} ${tmid}`; }
    else if (route === 'leader') { d = right ? `M${s.x + s.w} ${smid} L${t.x} ${tmid}` : `M${s.x} ${smid} L${t.x + t.w} ${tmid}`; paths.push({ from: e.from, to: e.to, route, d, leader: true }); continue; }
    else continue;
    paths.push({ from: e.from, to: e.to, route, d, leader: false });
  }

  const marks = delMarks.map(m => {
    const l = L[m.lane], off = delMarks.filter(o => o.lane === m.lane && o.before === m.before).indexOf(m);
    return { ...m, cx: l.x + 34 + off * 38, cy: rowY(m.before) - 8 };
  });

  const bandShapes = bands.map(b => {
    const y = rowY(b.row) + BOXH / 2, tw = Math.max(64, [...String(b.label ?? '')].length * 12.5 + 28);
    return { ...b, y, tw, tx: W - PADX - tw - 6 };
  });

  return { mode, lanes, laneById: L, nodes, bands: bandShapes, edges: paths, delMarks: marks, all, W, H, PADX, warnings };
}

/** 弹出卡片和图例用的徽章宽度（模板：一个字 17，两个字以上 28）。 */
export const pillWidth = label => [...String(label)].length > 1 ? 28 : 17;

/** 行号显示：L13 或 L13–L15。 */
export function lineRange(start, end) {
  return end != null && end !== start ? `L${start}–L${end}` : `L${start}`;
}

/** excerpts 的查找键：source + start + end（end 省略即单行）。 */
export const excerptKey = (source, start, end) => `${source}\u0000${start}\u0000${end ?? start}`;

/** Unix 毫秒 → 「11-25」或「11-25 10:30」。null 给空串。 */
export function shortDate(ms, withTime = false) {
  if (ms == null || !Number.isFinite(ms)) return '';
  const d = new Date(ms), p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}` + (withTime ? ` ${p(d.getHours())}:${p(d.getMinutes())}` : '');
}

/** 来源名带日期：「文学稿（11-24 上传）」；原件删了另行标注。 */
export function sourceCaption(source) {
  const verb = { material: '上传', version: '定稿', snapshot: '冻结', legacy: '' }[source.kind] ?? '';
  const date = shortDate(source.at);
  return source.label + (date ? `（${date}${verb ? ' ' + verb : ''}）` : '') + (source.sourceState === 'deleted' ? ' · 原件已删除' : '');
}
