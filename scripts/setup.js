// Loads everything from samples/ into the app, so there is something there
// the first time you open it. Safe to run again: it starts from empty.
import { readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { open } from '../src/db/index.js';
import { importFile } from '../src/import/index.js';

const path = process.env.DB_PATH || 'data/tipsy.db';
if (process.argv.includes('--fresh')) {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = path + suffix;
    if (existsSync(f)) rmSync(f);
  }
  console.log('Started from empty.');
}

const db = open(path);
const dirs = ['samples', 'templates'].filter((d) => existsSync(d));
let chars = 0, books = 0, chats = 0, skipped = 0;

for (const dir of dirs) {
  for (const f of readdirSync(dir).filter((x) => /\.(json|png|charx)$/i.test(x))) {
    try {
      const r = importFile(f, new Uint8Array(readFileSync(join(dir, f))));
      if (r.kind === 'character') { db.saveCharacter(r.data); chars++; }
      else if (r.kind === 'lorebook') { db.saveLorebook(r.data); books++; }
      else if (r.kind === 'chat') {
        const sid = db.createStory({ title: r.name || 'Imported', settings: {} });
        let parent = null;
        for (const m of r.data.messages) {
          if (!m.content.trim()) continue;
          parent = db.addMessage({ storyId: sid, parentId: parent, role: m.role, content: m.content });
        }
        chats++;
      }
    } catch (e) {
      skipped++;
      console.log(`  skipped ${f} — ${e.message}`);
    }
  }
}

const s = db.stats();
console.log(`\n${chars} characters, ${books} lorebooks, ${chats} saved conversations${skipped ? `, ${skipped} skipped` : ''}`);
console.log(`Library now holds ${s.characters} characters, ${s.lorebooks} lorebooks, ${s.entries} lore entries, ${s.stories} stories.`);
db.close();
