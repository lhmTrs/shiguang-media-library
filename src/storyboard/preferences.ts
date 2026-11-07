export type StoryboardAppearance = { density: 'comfortable' | 'compact'; showScenes: boolean; showDetails: boolean };
export const storyboardAppearanceKey = 'shiguang.storyboardAppearance.v1';
export function readStoryboardAppearance(): StoryboardAppearance {
  const defaults: StoryboardAppearance = { density: 'comfortable', showScenes: innerWidth > 1050, showDetails: innerWidth > 760 };
  try {
    const saved = JSON.parse(localStorage.getItem(storyboardAppearanceKey) || 'null');
    return { density: saved?.density === 'compact' ? 'compact' : 'comfortable', showScenes: typeof saved?.showScenes === 'boolean' ? saved.showScenes : defaults.showScenes, showDetails: typeof saved?.showDetails === 'boolean' ? saved.showDetails : defaults.showDetails };
  } catch { return defaults; }
}
