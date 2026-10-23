// Isolated probe for the already-landed audio backend (no real media/data dir).
// Uses an in-memory SQLite database and a deliberately missing engine binary.
import Database from "better-sqlite3";
import { AudioAnalysis } from "../../../server/audio-analysis.mjs";

const db = new Database(":memory:");
db.exec("CREATE TABLE assets (id TEXT PRIMARY KEY, path TEXT, name TEXT, sha256 TEXT)");
db.prepare("INSERT INTO assets (id,path,name,sha256) VALUES (?,?,?,?)").run(
  "probe-1",
  "/tmp/does-not-exist-probe.wav",
  "probe.wav",
  "0".repeat(64),
);

const lib = { db, mysql: false };
const engine = { binaryPath: "/nonexistent/audio-analyze", version: "1.0.0" };
const analysis = new AudioAnalysis(lib, engine);
await analysis.init();

const columns = db.prepare("PRAGMA table_info(asset_audio)").all().map((c) => c.name);
let errorCode = null;
try {
  await analysis.analyze("probe-1");
} catch (e) {
  errorCode = e.code;
}
console.log(JSON.stringify({ columns, emptyResult: analysis.get("probe-1"), errorCode }, null, 2));
db.close();
