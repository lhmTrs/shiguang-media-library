const id = ["TEXT", "VARCHAR(36)"];
const integer = ["INTEGER", "BIGINT"];
const name = ["TEXT", "VARCHAR(120)"];
const hash = ["TEXT", "CHAR(64)"];

export const SERIES_TABLES = {
  project_series_lock: { id: integer },
  project_series: {
    id, name, name_key: hash, software: ["TEXT", "VARCHAR(32)"],
    revision: integer, max_season_no: integer, max_root_episode_no: integer,
    created_at: integer, updated_at: integer,
  },
  project_series_seasons: {
    id, series_id: id, season_no: integer, label: name, revision: integer,
    max_episode_no: integer, created_at: integer, updated_at: integer,
  },
  project_series_members: {
    id, series_id: id, season_id: id, container_key: id, episode_no: integer, revision: integer,
  },
  project_series_requests: {
    id, request_hash: hash, kind: ["TEXT", "VARCHAR(24)"], result_json: ["TEXT", "LONGTEXT"],
    created_at: integer,
  },
};

const nullable = {
  project_series_seasons: ["label"],
  project_series_members: ["series_id", "season_id", "episode_no"],
};

export function seriesConstraints(table) {
  return {
    project_series: ["UNIQUE(name_key)"],
    project_series_seasons: ["UNIQUE(series_id,season_no)"],
    project_series_members: ["UNIQUE(series_id,container_key,episode_no)"],
  }[table] ?? [];
}

export function seriesMysqlColumnType(table, column) {
  const type = SERIES_TABLES[table][column]?.[1];
  if (!type) throw Error("未知剧集目录字段，未迁移");
  return type;
}

export function ensureSeriesSchema(db) {
  const mysql = db.kind === "mysql";
  for (const [table, columns] of Object.entries(SERIES_TABLES)) {
    const fields = Object.entries(columns).map(([column, types]) => {
      const type = types[mysql ? 1 : 0];
      if (column === "id") return `id ${type} NOT NULL PRIMARY KEY`;
      return `${column} ${type}${nullable[table]?.includes(column) ? "" : " NOT NULL"}`;
    });
    const definition = [...fields, ...seriesConstraints(table)].join(",");
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (${definition})${mysql ? " ENGINE=InnoDB" : ""}`);
  }
  db.exec(`${mysql ? "INSERT IGNORE" : "INSERT OR IGNORE"} INTO project_series_lock (id) VALUES (1)`);
}

export function lockSeriesDirectory(db) {
  if (db.kind === "mysql") db.prepare("SELECT id FROM project_series_lock WHERE id=1 FOR UPDATE").get();
}
