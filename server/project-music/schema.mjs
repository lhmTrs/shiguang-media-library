// 项目音乐：歌曲 › 轮次 › 版本，外加对比与上传回执。SQLite 与 MySQL 共用同一份定义。
// 时间一律为 UTC 毫秒；业务字段放在 data_json 里，需要唯一约束或检索的才单独成列。
const id = ['TEXT', 'VARCHAR(36)'];
const integer = ['INTEGER', 'BIGINT'];
const json = ['TEXT', 'LONGTEXT'];
const hash = ['TEXT', 'CHAR(64)'];

export const MUSIC_TABLES = {
  project_music_songs: {
    id, project_id: id, data_json: json, revision: integer, created_at: integer, updated_at: integer,
  },
  project_music_rounds: {
    id, project_id: id, song_id: id, round_no: integer, data_json: json, revision: integer,
    created_at: integer, updated_at: integer,
  },
  project_music_versions: {
    id, project_id: id, song_id: id, round_id: id, sha256: hash, data_json: json, revision: integer,
    created_at: integer, updated_at: integer,
  },
  project_music_comparisons: {
    id, project_id: id, song_id: id, round_id: id, data_json: json, revision: integer,
    created_at: integer, updated_at: integer,
  },
  project_music_imports: {
    id, project_id: id, data_json: json, created_at: integer, updated_at: integer,
  },
};

const UNIQUE = {
  project_music_rounds: ['UNIQUE(song_id,round_no)'],
};
const INDEXES = {
  project_music_songs: [['project_music_songs_project', 'project_id']],
  project_music_rounds: [['project_music_rounds_project', 'project_id']],
  project_music_versions: [['project_music_versions_project_hash', 'project_id,sha256'], ['project_music_versions_round', 'round_id']],
  project_music_comparisons: [['project_music_comparisons_song', 'song_id']],
  project_music_imports: [['project_music_imports_project', 'project_id']],
};

export function musicConstraints(table) {
  return UNIQUE[table] ?? [];
}

// MySQL 的普通索引随建表一起声明（不支持 CREATE INDEX IF NOT EXISTS）；一次性迁移也用这一份。
export function musicMysqlIndexes(table) {
  return (INDEXES[table] ?? []).map(([name, cols]) => `INDEX ${name} (${cols})`);
}

export function musicColumnType(table, column) {
  const name = typeof column === 'string' ? column : column?.name;
  const type = MUSIC_TABLES[table]?.[name]?.[1];
  if (!type) throw Error('未知项目音乐字段，未迁移');
  return name === 'id' ? `${type} PRIMARY KEY` : type;
}

export function ensureMusicSchema(db) {
  const mysql = db.kind === 'mysql';
  for (const [table, columns] of Object.entries(MUSIC_TABLES)) {
    const fields = Object.entries(columns).map(([column, types]) => {
      const type = types[mysql ? 1 : 0];
      return column === 'id' ? `id ${type} NOT NULL PRIMARY KEY` : `${column} ${type} NOT NULL`;
    });
    const definition = [...fields, ...musicConstraints(table), ...(mysql ? musicMysqlIndexes(table) : [])].join(',');
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (${definition})${mysql ? ' ENGINE=InnoDB' : ''}`);
    if (!mysql) for (const [name, cols] of INDEXES[table] ?? []) db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${cols})`);
  }
}
