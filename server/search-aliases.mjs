// Conservative search-only vocabulary. It never writes tags or renames media.
const groups = [
  ["转场", "whoosh", "swoosh", "swish", "transition"],
  ["撞击", "impact", "hit", "hits"],
  ["脚步", "footstep", "footsteps", "footfall", "footfalls"],
  ["上升", "riser", "uplifter"], ["下沉", "downlifter", "downer"],
  ["渐强", "crescendo", "buildup", "build up"], ["循环", "loop", "looping"],
  ["悬疑", "suspense", "suspenseful"], ["紧张", "tension", "tense"],
  ["恐怖", "horror", "scary", "creepy"], ["神秘", "mystery", "mysterious"],
  ["搞笑", "funny", "comedy", "comical"], ["可爱", "cute", "playful"],
  ["悲伤", "sad", "sorrow", "melancholy"],
  ["低沉", "low pitch", "low frequency", "sub bass", "subbass"],
  ["持续低鸣", "ambient drone", "drone tone"],
  ["氛围", "ambience", "ambiance", "ambient"],
  ["铃声", "bell", "bells", "chime", "chimes"],
  ["呼吸", "breath", "breathing"], ["心跳", "heartbeat", "heart beat"],
  ["掌声", "applause", "clapping"], ["风声", "wind"],
  ["雨声", "rain", "rainfall"], ["雷声", "thunder"],
  ["流水", "river", "stream", "running water"], ["火焰", "fire", "flames"],
  ["破碎", "shatter", "shattering"], ["门声", "door", "doors"],
  ["电流", "electric", "electricity"], ["机械", "machine", "machinery", "mechanical"],
  ["车辆", "vehicle", "vehicles", "car", "cars"], ["火车", "train", "trains"],
  ["飞机", "aircraft", "airplane", "aeroplane"],
  ["爆炸", "explosion", "explosions", "blast"], ["枪声", "gunshot", "gunfire"],
  ["打斗", "fight", "fighting", "combat"], ["眼神", "gaze", "glance", "stare"],
  ["眨眼", "blink", "wink"],
];
const normalize = value => value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
const vocabulary = new Map(groups.flatMap(group => group.map(word => [normalize(word), group])));
const registered = new WeakSet();
const regexCache = new Map();
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function pattern(word) {
  const escaped = escapeRegex(word).replace(/ /g, "[ _-]+");
  return /^[a-z0-9 ]+$/i.test(word) ? `(^|[^a-z0-9])${escaped}([^a-z0-9]|$)` : escaped;
}
function registerRegex(db) {
  if (db.kind === "mysql" || registered.has(db)) return;
  db.function("regexp", { deterministic: true }, (expression, value) => {
    if (value == null) return 0;
    let regex = regexCache.get(expression);
    if (!regex) {
      if (regexCache.size >= 256) regexCache.clear();
      regex = new RegExp(expression, "u");
      regexCache.set(expression, regex);
    }
    return Number(regex.test(String(value)));
  });
  registered.add(db);
}

export function keywordPredicate(word, db, { nameOnly = false, expandAliases = true } = {}) {
  const fields = nameOnly ? ["name"] : ["name", "tags", "note", "category", "sub"];
  const group = expandAliases ? vocabulary.get(normalize(word)) : null;
  const values = [];
  const regexMatch = expression => {
    registerRegex(db);
    values.push(...fields.map(() => expression));
    return "(" + fields.map(field => `LOWER(COALESCE(${field},'')) REGEXP ?`).join(" OR ") + ")";
  };
  // Known English words use boundaries: "hit" must not match "white".
  const literal = group && /^[a-z0-9 _-]+$/i.test(word)
    ? regexMatch(pattern(normalize(word)))
    : (() => {
      const term = "%" + word.replace(/[\\%_]/g, "\\$&") + "%";
      values.push(...fields.map(() => term));
      return "(" + fields.map(field => `${field} LIKE ? ESCAPE '\\'`).join(" OR ") + ")";
    })();
  if (!group) return { sql: literal, values };
  const aliases = regexMatch(group.map(pattern).join("|"));
  return { sql: `(${literal} OR (kind='sfx' AND ${aliases}))`, values };
}
