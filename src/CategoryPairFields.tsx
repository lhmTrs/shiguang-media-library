import { useEffect, useState } from "react";
import { CategoryFilter } from "./CategoryFilter";

export type Subcategory = { id: string; category_id: string; name: string; n: number };
type Request = <T = unknown>(url: string, body?: unknown, method?: string) => Promise<T>;
export function CategoryPairFields({ category, sub, categories, request, onChange, disabled = false, categoryLabel = "主分类", subLabel = "子类" }: {
  category: string; sub: string; categories: { id: string; name: string }[]; request: Request;
  onChange: (category: string, sub: string) => void; disabled?: boolean; categoryLabel?: string; subLabel?: string;
}) {
  const [children, setChildren] = useState<Subcategory[]>([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    request<Subcategory[]>("/subcategories").then(rows => { if (live) setChildren(rows); })
      .catch(() => { if (live) setError("子类读取失败，请关闭后重试"); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);
  const parentId = categories.find(c => c.name === category)?.id;
  return <>
    <div className="field"><span>主分类</span><CategoryFilter ariaLabel={categoryLabel} expandLabel="展开主分类" listLabel="主分类选项" allLabel="未分类"
      value={category} categories={categories.filter(c => c.id !== "uncategorized").map(c => ({ category: c.name, n: 0 }))}
      disabled={disabled || loading || !!error} showCounts={false} formatName={name => name}
      onChange={value => onChange(value, value === category ? sub : "")}/></div>
    <div className="field"><span>子类</span><CategoryFilter ariaLabel={subLabel} expandLabel="展开子类" listLabel="子类选项" allLabel="未选择子类"
      value={sub} categories={children.filter(c => c.category_id === parentId).map(c => ({ category: c.name, n: Number(c.n) }))}
      disabled={disabled || loading || !!error || !parentId} showCounts={false} formatName={name => name}
      onChange={value => onChange(category, value)}/></div>
    {error && <p className="database-error" role="alert">{error}</p>}
  </>;
}
