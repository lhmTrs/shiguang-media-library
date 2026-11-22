// 待处理（后台任务结果通知）：一张 notices 表。SQLite 与 MySQL 共用同一份定义，写法照项目音乐的 schema.mjs。
// 时间一律为 UTC 毫秒；业务字段放在 data_json 里，需要唯一约束或检索的才单独成列。
// (source, source_key, attempt) 唯一：同一个「来源 + 原编号」只有一张进行中的卡；重做又失败时 attempt+1 开新卡。
const id = ['TEXT', 'VARCHAR(36)'];
const integer = ['INTEGER', 'BIGINT'];
const json = ['TEXT', 'LONGTEXT'];

export const NOTICE_TABLES = {
  notices: {
    id, source: ['TEXT', 'VARCHAR(40)'], source_key: ['TEXT', 'VARCHAR(160)'], attempt: integer,
    kind: ['TEXT', 'VARCHAR(16)'], status: ['TEXT', 'VARCHAR(24)'],
    data_json: json, revision: integer, created_at: integer, updated_at: integer,
  },
};

const UNIQUE = {
  notices: ['UNIQUE(source,source_key,attempt)'],
};
const INDEXES = {
  notices: [['notices_status', 'status,updated_at']],
};

export function noticeConstraints(table) {
  return UNIQUE[table] ?? [];
}

// MySQL 的普通索引随建表一起声明（不支持 CREATE INDEX IF NOT EXISTS）；一次性迁移也用这一份。
export function noticeMysqlIndexes(table) {
  return (INDEXES[table] ?? []).map(([name, cols]) => `INDEX ${name} (${cols})`);
}

export function noticeColumnType(table, column) {
  const name = typeof column === 'string' ? column : column?.name;
  const type = NOTICE_TABLES[table]?.[name]?.[1];
  if (!type) throw Error('未知待处理字段，未迁移');
  return name === 'id' ? `${type} PRIMARY KEY` : type;
}

export function ensureNoticeSchema(db) {
  const mysql = db.kind === 'mysql';
  for (const [table, columns] of Object.entries(NOTICE_TABLES)) {
    const fields = Object.entries(columns).map(([column, types]) => {
      const type = types[mysql ? 1 : 0];
      return column === 'id' ? `id ${type} NOT NULL PRIMARY KEY` : `${column} ${type} NOT NULL`;
    });
    const definition = [...fields, ...noticeConstraints(table), ...(mysql ? noticeMysqlIndexes(table) : [])].join(',');
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (${definition})${mysql ? ' ENGINE=InnoDB' : ''}`);
    if (!mysql) for (const [name, cols] of INDEXES[table] ?? []) db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${cols})`);
  }
}
