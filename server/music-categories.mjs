import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
export class MusicCategories {
  constructor(lib, allKinds = false) {
    this.lib = lib;
    this.allKinds = allKinds;
  }
  init() {
    this.lib.db.exec(
      this.lib.db.kind === "mysql"
        ? "CREATE TABLE IF NOT EXISTS music_categories (id VARCHAR(36) PRIMARY KEY,name LONGTEXT NOT NULL,name_hash CHAR(64) GENERATED ALWAYS AS (SHA2(name,256)) STORED UNIQUE) ENGINE=InnoDB"
        : "CREATE TABLE IF NOT EXISTS music_categories (id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE)",
    );
    this.lib.db.exec(
      this.lib.db.kind === "mysql"
        ? "CREATE TABLE IF NOT EXISTS music_category_links (id VARCHAR(36) PRIMARY KEY,asset_id VARCHAR(36) NOT NULL,category_id VARCHAR(36) NOT NULL,UNIQUE(asset_id,category_id),INDEX music_link_category(category_id)) ENGINE=InnoDB"
        : "CREATE TABLE IF NOT EXISTS music_category_links (id TEXT PRIMARY KEY,asset_id TEXT NOT NULL,category_id TEXT NOT NULL,UNIQUE(asset_id,category_id))",
    );
    this.lib.musicLinksAvailable = true;
    if (this.allKinds) this.lib.allCategoryKinds = true;
    this.register();
    return this;
  }
  register() {
    if (this.lib.categoryStore) return;
    const existing = new Set(
      this.lib.db
        .prepare("SELECT name FROM music_categories")
        .all()
        .map((r) => r.name),
    );
    const categories = this.lib.db
      .prepare(
        `SELECT DISTINCT category FROM assets WHERE ${this.allKinds ? "" : "kind='music' AND "}TRIM(category)<>''`,
      )
      .all();
    const insert = this.lib.db.prepare(
      "INSERT INTO music_categories(id,name) VALUES(?,?)",
    );
    this.lib.db.transaction(() => {
      for (const { category } of categories)
        if (!existing.has(category)) {
          insert.run(crypto.randomUUID(), category);
          existing.add(category);
        }
    })();
  }
  list(query = {}) {
    this.register();
    const kind = this.allKinds ? (query.kind || "") : "music";
    if (kind && !["music", "sfx", "photo", "video"].includes(kind)) throw Error("素材类型无效");
    const filter = kind ? " AND a.kind=?" : "";
    const plain = kind ? "kind=? AND " : "";
    const args = kind ? [kind] : [];
    const items = this.lib.db
      .prepare(
        `SELECT c.id,c.name,COUNT(a.id) n,SUM(CASE WHEN a.online=0 THEN 1 ELSE 0 END) offline FROM music_categories c LEFT JOIN assets a ON (a.category=c.name OR EXISTS(SELECT 1 FROM music_category_links l WHERE l.asset_id=a.id AND l.category_id=c.id))${filter} AND a.trashed=0 GROUP BY c.id,c.name ORDER BY c.name`,
      )
      .all(...args);
    const unknown = this.lib.db
      .prepare(
        `SELECT COUNT(*) n,SUM(CASE WHEN online=0 THEN 1 ELSE 0 END) offline FROM assets WHERE ${plain}trashed=0 AND TRIM(category)='' AND NOT EXISTS(SELECT 1 FROM music_category_links l JOIN music_categories c ON c.id=l.category_id WHERE l.asset_id=assets.id)`,
      )
      .get(...args);
    const totals = this.lib.db
      .prepare(
        `SELECT COUNT(*) n,SUM(CASE WHEN online=0 THEN 1 ELSE 0 END) offline FROM assets WHERE ${plain}trashed=0`,
      )
      .get(...args);
    return [
      {
        id: "uncategorized",
        name: "未分类",
        n: Number(unknown.n),
        offline: Number(unknown.offline || 0),
        totalMusic: Number(totals.n),
        totalAssets: Number(totals.n),
        totalOffline: Number(totals.offline || 0),
      },
      ...items.map((c) => ({
        ...c,
        n: Number(c.n),
        offline: Number(c.offline || 0),
      })),
    ];
  }
  get(id) {
    const row = this.lib.db
      .prepare("SELECT id,name FROM music_categories WHERE id=?")
      .get(id);
    if (!row) throw Error("素材分类不存在");
    return row;
  }
  name(input) {
    if (
      typeof input !== "string" ||
      !input.trim() ||
      input.trim().length > 120 ||
      /[\x00-\x1f]/.test(input) ||
      input.trim() === "未分类"
    )
      throw Error("请输入 1–120 字的分类名称，不能使用“未分类”");
    return input.trim();
  }
  assertUnique(name, exceptId) {
    const found = this.lib.db
      .prepare("SELECT id FROM music_categories WHERE name=?")
      .get(name);
    if (found && found.id !== exceptId) throw Error("分类名称已存在");
  }
  create(input) {
    this.register();
    const name = this.name(input.name);
    this.assertUnique(name);
    const row = { id: crypto.randomUUID(), name };
    this.lib.db
      .prepare("INSERT INTO music_categories(id,name) VALUES(?,?)")
      .run(row.id, row.name);
    return row;
  }
  rename(id, input) {
    this.register();
    const old = this.get(id);
    const name = this.name(input.name);
    this.assertUnique(name, id);
    this.lib.db.transaction(() => {
      this.lib.db
        .prepare(
          `UPDATE assets SET category=? WHERE ${this.allKinds ? "" : "kind='music' AND "}category=?`,
        )
        .run(name, old.name);
      this.lib.db
        .prepare("UPDATE music_categories SET name=? WHERE id=?")
        .run(name, id);
    })();
    return { id, name };
  }
  remove(id) {
    const old = this.get(id);
    this.lib.db.transaction(() => {
      this.lib.db
        .prepare(
          `UPDATE assets SET category='',sub='' WHERE ${this.allKinds ? "" : "kind='music' AND "}category=?`,
        )
        .run(old.name);
      if (this.lib.hierarchyAvailable) this.lib.db.prepare("DELETE FROM asset_subcategories WHERE category_id=?").run(id);
      this.lib.db.prepare("DELETE FROM music_categories WHERE id=?").run(id);
      this.lib.db
        .prepare("DELETE FROM music_category_links WHERE category_id=?")
        .run(id);
    })();
    return { removed: true };
  }
  assign(input) {
    if (
      !Array.isArray(input.ids) ||
      !input.ids.length ||
      input.ids.length > 200 ||
      input.ids.some((id) => typeof id !== "string")
    )
      throw Error("每批请选择 1–200 项素材");
    const name =
      input.categoryId === "uncategorized"
        ? ""
        : this.get(input.categoryId).name;
    const ids = [...new Set(input.ids)];
    for (const id of ids) {
      const a = this.lib.asset(id);
      if ((!this.allKinds && a.kind !== "music") || a.trashed)
        throw Error("只能调整未删除素材的分类");
    }
    const update = this.lib.db.prepare(
      "UPDATE assets SET sub=CASE WHEN category=? THEN sub ELSE '' END,category=? WHERE id=?",
    );
    this.lib.db.transaction(() => {
      for (const id of ids) {
        if (!this.allKinds || input.categoryId === "uncategorized") this.lib.db
          .prepare("DELETE FROM music_category_links WHERE asset_id=?")
          .run(id);
        update.run(name, name, id);
      }
    })();
    return { updated: ids.length };
  }
  members(assetId) {
    const a = this.lib.asset(assetId);
    if ((!this.allKinds && a.kind !== "music") || a.trashed)
      throw Error("只能管理未删除素材的分类");
    this.register();
    return this.lib.db
      .prepare(
        "SELECT c.id,c.name FROM music_categories c WHERE c.name=? OR EXISTS(SELECT 1 FROM music_category_links l WHERE l.category_id=c.id AND l.asset_id=?) ORDER BY c.name",
      )
      .all(a.category, assetId);
  }
  add(input) {
    const a = this.lib.asset(input.assetId);
    if ((!this.allKinds && a.kind !== "music") || a.trashed)
      throw Error("只能管理未删除素材的分类");
    const category = this.get(input.categoryId);
    if (this.members(a.id).some((c) => c.id === category.id))
      return { added: false };
    this.lib.db
      .prepare(
        "INSERT INTO music_category_links(id,asset_id,category_id) VALUES(?,?,?)",
      )
      .run(crypto.randomUUID(), a.id, category.id);
    return { added: true };
  }
  detach(input) {
    const a = this.lib.asset(input.assetId);
    if (a.trashed || (!this.allKinds && a.kind !== "music")) throw Error("只能修改未删除素材的分类");
    const category = this.get(input.categoryId);
    this.lib.db.transaction(() => {
      if (a.category === category.name) this.lib.db.prepare("UPDATE assets SET category='',sub='' WHERE id=?").run(a.id);
      this.lib.db.prepare("DELETE FROM music_category_links WHERE asset_id=? AND category_id=?").run(a.id, category.id);
    })();
    return { removed: true };
  }
  save(input) {
    const asset = this.lib.asset(input.assetId);
    if (asset.trashed) throw Error("不能修改已删除素材的分类");
    const primary = input.category === "" ? "" : this.name(input.category);
    const existingPrimary = primary ? this.existingName(primary) : "";
    if (typeof input.sub !== "string" || input.sub.length > 120) throw Error("子类最多 120 字");
    if (!Array.isArray(input.extraIds) || input.extraIds.length > 100 || input.extraIds.some(id => typeof id !== "string")) throw Error("额外分类格式错误，最多 100 个");
    const extras = [...new Set(input.extraIds)].map(id => this.get(id));
    this.lib.db.transaction(() => {
      this.lib.patch(asset.id, { category: existingPrimary, sub: input.sub.trim() });
      this.lib.db.prepare("DELETE FROM music_category_links WHERE asset_id=?").run(asset.id);
      for (const extra of extras) if (extra.name !== existingPrimary)
        this.lib.db.prepare("INSERT INTO music_category_links(id,asset_id,category_id) VALUES(?,?,?)").run(crypto.randomUUID(), asset.id, extra.id);
    })();
    return this.lib.asset(asset.id);
  }
  existingName(name) {
    if (name === "") return "";
    const canonical = this.name(name);
    const row = this.lib.db.prepare("SELECT name FROM music_categories WHERE name=?").get(canonical);
    if (!row) throw Error("分类不存在，请先在分类管理中新建，或创建素材子文件夹后重新扫描");
    return row.name;
  }
  ensureFolder(name) {
    const valid = this.name(name);
    const row = this.lib.db.prepare("SELECT id,name FROM music_categories WHERE name=?").get(valid);
    return row || this.create({ name: valid });
  }
}

// Keep existing table and row identities so old music memberships remain intact.
export class AssetCategories extends MusicCategories {
  constructor(lib) { super(lib, true); }
  init() {
    super.init();
    const db = this.lib.db;
    db.exec(db.kind === "mysql"
      ? "CREATE TABLE IF NOT EXISTS asset_subcategories (id VARCHAR(36) PRIMARY KEY,category_id VARCHAR(36) NOT NULL,name VARCHAR(120) NOT NULL,UNIQUE(category_id,name)) ENGINE=InnoDB"
      : "CREATE TABLE IF NOT EXISTS asset_subcategories (id TEXT PRIMARY KEY,category_id TEXT NOT NULL,name TEXT NOT NULL,UNIQUE(category_id,name))");
    db.exec(db.kind === "mysql"
      ? "CREATE TABLE IF NOT EXISTS category_hierarchy_meta (id VARCHAR(36) PRIMARY KEY) ENGINE=InnoDB"
      : "CREATE TABLE IF NOT EXISTS category_hierarchy_meta (id TEXT PRIMARY KEY)");
    if (!db.prepare("SELECT id FROM category_hierarchy_meta WHERE id=?").get("legacy-v1")) {
      const rows = db.prepare("SELECT id,category,sub FROM assets WHERE TRIM(sub)<>''").all();
      const dir = path.join(this.lib.dataDir, "backups");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, `before-category-hierarchy-${Date.now()}-${crypto.randomUUID()}.json`), JSON.stringify({ createdAt: new Date().toISOString(), assets: rows, categories: db.prepare("SELECT * FROM music_categories").all() }), { flag: "wx", mode: 0o600 });
      db.transaction(() => {
        const pairs = new Map(rows.map(row => [JSON.stringify([row.category, row.sub]), row]));
        for (const row of pairs.values()) {
          const parent = this.ensureFolder(row.category.trim() || "历史未归类");
          this.ensureSubcategory(parent.id, row.sub.trim());
          db.prepare("UPDATE assets SET category=?,sub=? WHERE category=? AND sub=?").run(parent.name, row.sub.trim(), row.category, row.sub);
        }
        db.prepare("INSERT INTO category_hierarchy_meta(id) VALUES(?)").run("legacy-v1");
      })();
    }
    this.lib.hierarchyAvailable = true;
    this.lib.categoryStore = this;
    return this;
  }
  subcategories(parentId) {
    if (parentId) this.get(parentId);
    return this.lib.db.prepare("SELECT s.id,s.category_id,s.name,COUNT(a.id) n FROM asset_subcategories s JOIN music_categories c ON c.id=s.category_id LEFT JOIN assets a ON a.category=c.name AND a.sub=s.name AND a.trashed=0" + (parentId ? " WHERE s.category_id=?" : "") + " GROUP BY s.id,s.category_id,s.name ORDER BY s.name").all(...(parentId ? [parentId] : []));
  }
  subcategory(id) {
    const row = this.lib.db.prepare("SELECT * FROM asset_subcategories WHERE id=?").get(id);
    if (!row) throw Error("子分类不存在");
    return row;
  }
  createSubcategory(input) {
    this.get(input.categoryId);
    const name = this.name(input.name);
    if (this.lib.db.prepare("SELECT id FROM asset_subcategories WHERE category_id=? AND name=?").get(input.categoryId, name)) throw Error("该主分类下已存在同名子类");
    const row = { id: crypto.randomUUID(), category_id: input.categoryId, name };
    this.lib.db.prepare("INSERT INTO asset_subcategories(id,category_id,name) VALUES(?,?,?)").run(row.id, row.category_id, row.name);
    return row;
  }
  ensureSubcategory(parentId, name) {
    return this.lib.db.prepare("SELECT * FROM asset_subcategories WHERE category_id=? AND name=?").get(parentId, name) || this.createSubcategory({ categoryId: parentId, name });
  }
  renameSubcategory(id, input) {
    const old = this.subcategory(id), parent = this.get(old.category_id), name = this.name(input.name);
    const duplicate = this.lib.db.prepare("SELECT id FROM asset_subcategories WHERE category_id=? AND name=?").get(old.category_id, name);
    if (duplicate && duplicate.id !== id) throw Error("该主分类下已存在同名子类");
    this.lib.db.transaction(() => {
      this.lib.db.prepare("UPDATE assets SET sub=? WHERE category=? AND sub=?").run(name, parent.name, old.name);
      this.lib.db.prepare("UPDATE asset_subcategories SET name=? WHERE id=?").run(name, id);
    })();
    return this.subcategory(id);
  }
  removeSubcategory(id) {
    const old = this.subcategory(id), parent = this.get(old.category_id);
    this.lib.db.transaction(() => {
      this.lib.db.prepare("UPDATE assets SET sub='' WHERE category=? AND sub=?").run(parent.name, old.name);
      this.lib.db.prepare("DELETE FROM asset_subcategories WHERE id=?").run(id);
    })();
    return { removed: true };
  }
  validatePair(category, sub) {
    if (typeof sub !== "string" || sub.trim().length > 120) throw Error("子类最多 120 字");
    const name = sub.trim();
    if (!name) return "";
    const parent = category && this.lib.db.prepare("SELECT id FROM music_categories WHERE name=?").get(category);
    if (!parent || !this.lib.db.prepare("SELECT id FROM asset_subcategories WHERE category_id=? AND name=?").get(parent.id, name)) throw Error("子类不属于所选主分类，请选择已有子类");
    return name;
  }
  folderPair(root, directory) {
    const parts = path.relative(root.path, directory).split(path.sep).filter(Boolean);
    if (!parts.length) return { category: root.kind === "music" ? this.ensureFolder(root.name).name : "", sub: "" };
    const parent = this.ensureFolder(parts[0]);
    return { category: parent.name, sub: parts.length > 1 ? this.ensureSubcategory(parent.id, parts[1]).name : "" };
  }
}
