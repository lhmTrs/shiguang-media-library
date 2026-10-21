export function pageSize(value) {
  if (value === undefined) return 60;
  if (typeof value !== "string" || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 200)
    throw Error("每页数量需为 1~200 的整数");
  return Number(value);
}
export function currentPage(value, total, limit) {
  const page = Math.max(1, Math.floor(Number(value) || 1));
  return Math.min(page, Math.max(1, Math.ceil(total / limit)));
}
