// 测试辅助：在顶部层级栏里切到某个项目（按项目 ID）。层级栏取代了原来的原生下拉（SERIES-P1）。
// programmatic: true 时直接派发点击、不做鼠标命中检测——等同旧测试里对原生下拉 selectOption 的程序化切换，
// 只用于“弹窗遮罩还开着时切换项目”这类原本就绕过鼠标的场景。
export async function selectProjectInBar(page, projectId, { programmatic = false } = {}) {
  const bar = page.locator('.ppb');
  const trigger = bar.getByRole('navigation', { name: '当前项目' }).getByRole('button').first();
  if (programmatic) await trigger.dispatchEvent('click'); else await trigger.click();
  const option = bar.locator(`.ppb-option[data-target-project="${projectId}"]`).first();
  await option.waitFor();
  if (programmatic) await option.dispatchEvent('click'); else await option.click();
}

// 顶栏统一（TOPBAR-UNIFY）：项目资产页的公共人物库改为页内切换；切回当前项目用同一组按钮。
export async function showPublicAssets(page, on = true) {
  const group = page.getByRole('group', { name: '看哪里的资产' });
  await (on ? group.getByRole('button', { name: '公共人物库' }) : group.getByRole('button').first()).click();
}
/** 顶栏当前项目 ID（层级栏根节点 data-project；未选项目时为 null）。 */
export const projectInBar = page => page.locator('.ppb').first();
