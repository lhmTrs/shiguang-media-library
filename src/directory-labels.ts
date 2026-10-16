export type DirectoryOption = { id?: string; name?: string; category: string; sub?: string; rootId?: string; rootName?: string; rootPath?: string; n: number };

// Identity remains root + relative directory. Prefixes are presentation only.
export function displayDirectoryOptions(options: DirectoryOption[], universe = options) {
  const owners = new Map<string, Set<string>>();
  const base = (c: DirectoryOption) => c.sub ? `${c.category} / ${c.sub}` : c.category;
  for (const c of universe) {
    const key = base(c), roots = owners.get(key) || new Set<string>();
    if (c.rootId) roots.add(c.rootId);
    owners.set(key, roots);
  }
  return options.map(c => ({ ...c, category: (owners.get(base(c))?.size || 0) > 1 && c.rootName ? `${c.rootName}_${base(c)}` : base(c) }));
}
