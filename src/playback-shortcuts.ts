/** Reserve plain Space for the active preview, without stealing text or native controls. */
export function bindPlaybackSpace(root: HTMLElement, toggle: () => void, enabled = () => true) {
  let held = false;
  const space = (event: KeyboardEvent) => event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar';
  const down = (event: KeyboardEvent) => {
    if (!space(event) || event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (event.target instanceof Element && event.target.closest('input,textarea,select,video,audio,[role="textbox"],[role="slider"],[role="combobox"],[role="alertdialog"],[data-global-feedback],[contenteditable]:not([contenteditable="false"])')) return;
    event.preventDefault(); event.stopPropagation();
    if (event.repeat || held) return;
    held = true;
    if (enabled()) toggle();
  };
  const up = (event: KeyboardEvent) => {
    if (!held || !space(event)) return;
    held = false; event.preventDefault(); event.stopPropagation();
  };
  const blur = () => { held = false; };
  root.addEventListener('keydown', down, true); root.addEventListener('keyup', up, true);
  window.addEventListener('blur', blur);
  return () => { root.removeEventListener('keydown', down, true); root.removeEventListener('keyup', up, true); window.removeEventListener('blur', blur); };
}
