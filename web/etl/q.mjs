// Ad-hoc read-only query helper: node etl/q.mjs <db> "<sql>" ["<sql>" ...]
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2], { readOnly: true });
for (const q of process.argv.slice(3)) {
  try {
    console.log('>', q);
    console.table(db.prepare(q).all());
  } catch (e) {
    console.log(String(e));
  }
}
