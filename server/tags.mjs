import crypto from "node:crypto";
export class Tags {
  constructor(lib) {
    this.lib = lib;
  }
  init() {
    this.lib.db.exec(
      this.lib.db.kind === "mysql"
        ? "CREATE TABLE IF NOT EXISTS asset_tags (id VARCHAR(36) PRIMARY KEY,name LONGTEXT NOT NULL,name_hash CHAR(64) GENERATED ALWAYS AS (SHA2(name,256)) STORED UNIQUE) ENGINE=InnoDB"
        : "CREATE TABLE IF NOT EXISTS asset_tags (id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE)",
    );
    return this;
  }
  rows() {
    return this.lib.db
      .prepare("SELECT id,tags,trashed FROM assets")
      .all()
      .map((a) => ({ ...a, tags: JSON.parse(a.tags) }));
  }
  register(rows) {
    const existing = new Set(
      this.lib.db
        .prepare("SELECT name FROM asset_tags")
        .all()
        .map((t) => t.name),
    );
    const names = new Set(rows.flatMap((a) => a.tags));
    const insert = this.lib.db.prepare(
      "INSERT INTO asset_tags(id,name) VALUES(?,?)",
    );
    const missing = [...names].filter((n) => !existing.has(n));
    if (missing.length)
      this.lib.db.transaction(() => {
        for (const name of missing) insert.run(crypto.randomUUID(), name);
      })();
  }
  list() {
    const rows = this.rows();
    this.register(rows);
    const counts = new Map();
    let untagged = 0,
      total = 0;
    for (const a of rows) {
      if (a.trashed) continue;
      total++;
      if (!a.tags.length) untagged++;
      for (const tag of new Set(a.tags))
        counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    return [
      { id: "untagged", name: "未标记", n: untagged, total },
      ...this.lib.db
        .prepare("SELECT id,name FROM asset_tags ORDER BY name")
        .all()
        .map((t) => ({ ...t, n: counts.get(t.name) || 0 })),
    ];
  }
  get(id) {
    const t = this.lib.db
      .prepare("SELECT id,name FROM asset_tags WHERE id=?")
      .get(id);
    if (!t) throw Error("标签不存在");
    return t;
  }
  name(value) {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.trim().length > 60 ||
      /[\x00-\x1f]/.test(value) ||
      value.trim() === "未标记"
    )
      throw Error("请输入 1–60 字的标签名称，不能使用“未标记”");
    return value.trim();
  }
  unique(name, except) {
    const found = this.lib.db
      .prepare("SELECT id FROM asset_tags WHERE name=?")
      .get(name);
    if (found && found.id !== except) throw Error("标签名称已存在");
  }
  create(input) {
    this.register(this.rows());
    const name = this.name(input.name);
    this.unique(name);
    const t = { id: crypto.randomUUID(), name };
    this.lib.db
      .prepare("INSERT INTO asset_tags(id,name) VALUES(?,?)")
      .run(t.id, t.name);
    return t;
  }
  rename(id, input) {
    const old = this.get(id);
    const name = this.name(input.name);
    this.register(this.rows());
    this.unique(name, id);
    const rows = this.rows().filter((a) => a.tags.includes(old.name));
    this.lib.db.transaction(() => {
      for (const a of rows)
        this.lib.db
          .prepare("UPDATE assets SET tags=? WHERE id=?")
          .run(
            JSON.stringify([
              ...new Set(a.tags.map((t) => (t === old.name ? name : t))),
            ]),
            a.id,
          );
      this.lib.db
        .prepare("UPDATE asset_tags SET name=? WHERE id=?")
        .run(name, id);
    })();
    return { id, name };
  }
  remove(id) {
    const tag = this.get(id);
    const rows = this.rows().filter((a) => a.tags.includes(tag.name));
    this.lib.db.transaction(() => {
      for (const a of rows)
        this.lib.db
          .prepare("UPDATE assets SET tags=? WHERE id=?")
          .run(JSON.stringify(a.tags.filter((t) => t !== tag.name)), a.id);
      this.lib.db.prepare("DELETE FROM asset_tags WHERE id=?").run(id);
    })();
    return { removed: true };
  }
  apply(input) {
    if (
      !["add", "remove"].includes(input.action) ||
      !Array.isArray(input.ids) ||
      !input.ids.length ||
      input.ids.length > 200 ||
      input.ids.some((id) => typeof id !== "string")
    )
      throw Error("请选择 1–200 个素材和有效操作");
    const tag = this.get(input.tagId);
    const rows = [...new Set(input.ids)].map((id) => this.lib.asset(id));
    for (const a of rows) {
      if (a.trashed) throw Error("不能修改已删除素材的标签");
      if (
        input.action === "add" &&
        !a.tags.includes(tag.name) &&
        a.tags.length >= 40
      )
        throw Error("素材最多保存 40 个标签");
    }
    this.lib.db.transaction(() => {
      for (const a of rows) {
        const tags =
          input.action === "add"
            ? [...new Set([...a.tags, tag.name])]
            : a.tags.filter((t) => t !== tag.name);
        this.lib.db
          .prepare("UPDATE assets SET tags=? WHERE id=?")
          .run(JSON.stringify(tags), a.id);
      }
    })();
    this.lib.onMetadataChanged?.(); // 批量标签改动：让清单尽快跟上（不传 rootId = 全部根）
    return { updated: rows.length };
  }
}
