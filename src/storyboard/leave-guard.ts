// 离开分镜页 / 切换项目前的「保存 / 放弃 / 留着」确认（STORYBOARD-CHANGE-LOG v1）。
// 分镜页在显示时登记一个确认函数；主程序切换栏目或项目前调用 confirmStoryboardLeave()，结果为 true 才继续。
type Guard = (reason?: string) => Promise<boolean>;
let guard: Guard | null = null;
export function setStoryboardLeaveGuard(next: Guard) { guard = next; return () => { if (guard === next) guard = null; }; }
export const hasStoryboardLeaveGuard = () => !!guard;
export const confirmStoryboardLeave = (reason?: string) => guard ? guard(reason) : Promise.resolve(true);
