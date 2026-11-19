// 界面测试共用：找出实际显示文字里对比度不足的元素。
/** 文字和实际背景的对比度，按 WCAG 公式计算。 */
export const lowContrast = (page, selector, minimum) => page.evaluate(([css, min]) => {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const rgba = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data; return [r, g, b, a / 255]; };
  const over = (top, under) => top.slice(0, 3).map((value, i) => value * top[3] + under[i] * (1 - top[3]));
  const backdrop = el => { const layers = []; for (let node = el; node; node = node.parentElement) { const c = rgba(getComputedStyle(node).backgroundColor); if (c[3]) layers.push(c); if (c[3] === 1) break; } return layers.reverse().reduce((under, top) => over(top, under), [255, 255, 255]); };
  const light = c => { const [r, g, b] = c.map(v => { const x = v / 255; return x <= .03928 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
  return [...document.querySelectorAll(css)].filter(el => el.textContent.trim() && el.getClientRects().length).flatMap(el => {
    const bg = backdrop(el), fg = over(rgba(getComputedStyle(el).color), bg), [a, b] = [light(fg), light(bg)].sort((x, y) => y - x), ratio = (a + .05) / (b + .05);
    return ratio < min ? [el.className + ':' + el.textContent.trim().slice(0, 16) + ':' + ratio.toFixed(2)] : [];
  });
}, [selector, minimum]);
