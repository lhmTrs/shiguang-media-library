// 离开分镜页前的「保存 / 放弃 / 留着」确认（STORYBOARD-CHANGE-LOG v1）。
// 分镜页在显示时登记一个确认函数；主程序切换栏目前调用 confirmStoryboardLeave()，结果为 true 才继续切换。
let guard: (() => Promise<boolean>) | null = null;
export function setStoryboardLeaveGuard(next: () => Promise<boolean>) { guard = next; return () => { if (guard === next) guard = null; }; }
export const confirmStoryboardLeave = () => guard ? guard() : Promise.resolve(true);
