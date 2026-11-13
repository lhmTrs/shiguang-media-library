export const ATTRIBUTE_TABLES = {
  project_attribute_configs: { id: 'id', revision: 'integer', data_json: 'text' },
  project_character_attributes: { id: 'id', project_id: 'project', revision: 'integer', data_json: 'text' },
  project_attribute_requests: { id: 'hash', project_id: 'project', data_json: 'text' },
  series_attribute_alignment: { id: 'id', revision: 'integer' },
  project_attribute_history: { id: 'id', history_id: 'project', request_id: 'project', kind: 'history_kind', project_id: 'optional_project', series_id: 'optional_project', created_at: 'integer', data_json: 'text' },
};

export function attributeColumnType(table, { name }) {
  switch (ATTRIBUTE_TABLES[table][name]) {
    case 'id': return 'VARCHAR(36) PRIMARY KEY';
    case 'hash': return 'CHAR(64) PRIMARY KEY';
    case 'optional_project':
    case 'project': return 'VARCHAR(36)';
    case 'history_kind': return 'VARCHAR(24)';
    case 'integer': return 'BIGINT';
    case 'text': return 'LONGTEXT';
    default: throw Error('未知人物属性字段');
  }
}

export function attributeSchema(mysql) {
  return Object.entries(ATTRIBUTE_TABLES).map(([table, fields]) => {
    const columns = Object.entries(fields).map(([name, kind]) => {
      if (mysql) return `${name} ${attributeColumnType(table, { name })}${kind === 'optional_project' ? '' : ' NOT NULL'}`;
      const type = kind === 'integer' ? 'INTEGER' : 'TEXT';
      const key = ['id', 'hash'].includes(kind) ? ' PRIMARY KEY' : '';
      return `${name} ${type}${kind === 'optional_project' ? '' : ' NOT NULL'}${key}`;
    });
    return `CREATE TABLE IF NOT EXISTS ${table}(${columns.join(', ')})` + (mysql ? ' ENGINE=InnoDB' : '');
  });
}
