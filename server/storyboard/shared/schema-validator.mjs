import { schema } from './schema.mjs';
// All keywords used by our published schema are evaluated here; relationship checks live in model.mjs.
export function validateSchema(value) {
    const errors = [];
    const add = (path, message) => errors.push({ path, message });
    const type = (v, t) => t === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v) : t === 'array' ? Array.isArray(v) : t === 'integer' ? Number.isSafeInteger(v) : t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === 'null' ? v === null : typeof v === t;
    function visit(v, s, path) { if (s.$ref) {
        s = s.$ref.split('/').slice(1).reduce((o, k) => o[k], schema);
    } if (s.type && !([s.type].flat().some(t => type(v, t)))) {
        add(path, '类型须为 ' + [s.type].flat().join(' / '));
        return;
    } if ('const' in s && v !== s.const)
        add(path, '固定值应为 ' + s.const); if (s.enum && !s.enum.includes(v))
        add(path, '值须为 ' + s.enum.join('、')); if (typeof v === 'string') {
        if (s.minLength && v.length < s.minLength)
            add(path, '文本不能为空');
        if (s.maxLength && v.length > s.maxLength)
            add(path, '文本超过最大长度 ' + s.maxLength);
        if (s.pattern && !new RegExp(s.pattern).test(v))
            add(path, '格式不符合约定 ' + s.pattern);
    } if (typeof v === 'number') {
        if (s.minimum !== undefined && v < s.minimum)
            add(path, '不得小于 ' + s.minimum);
        if (s.maximum !== undefined && v > s.maximum)
            add(path, '不得大于 ' + s.maximum);
    } if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const key of s.required ?? [])
            if (!(key in v))
                add(path + '.' + key, '缺少必填字段');
        for (const [key, def] of Object.entries(s.properties ?? {}))
            if (key in v)
                visit(v[key], def, path + '.' + key);
    } if (Array.isArray(v)) {
        if (s.uniqueItems && new Set(v.map(x => JSON.stringify(x))).size !== v.length)
            add(path, '数组元素不能重复');
        if (s.items)
            v.forEach((item, i) => visit(item, s.items, `${path}[${i}]`));
    } }
    visit(value, schema, '$');
    return errors;
}
