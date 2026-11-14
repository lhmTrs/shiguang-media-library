// 子编辑器的未保存登记（合并同名人物收口验收 R1）：评分编辑、本集改分、新增造型输入等各自持有未提交内容，
// 父页面发起新的合并 / 撤销 / 重新提交前要一并看到。用法：在子组件里 useUnsavedMark(有未保存内容)。
import { useEffect, useId } from 'react';

const marks = new Set<string>();
export function useUnsavedMark(dirty: boolean) {
  const id = useId();
  useEffect(() => { if (dirty) marks.add(id); else marks.delete(id); return () => { marks.delete(id); }; }, [id, dirty]);
}
/** 当前页面上是否有子编辑器持有未保存内容。 */
export const hasUnsavedChild = () => marks.size > 0;
