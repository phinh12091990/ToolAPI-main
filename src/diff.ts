import fs from 'fs';
import path from 'path';

interface MappingPair {
  label: string;
  api_endpoint: string;
  api_field: string;
}

interface MappingFile {
  generated_at: string;
  total_pairs: number;
  pairs: MappingPair[];
}

const MAPPING_FILE = path.join(process.cwd(), 'mapping.json');
const BACKUP_FILE = path.join(process.cwd(), 'mapping.backup.json');

export function backupMapping(): void {
  if (fs.existsSync(MAPPING_FILE)) {
    fs.copyFileSync(MAPPING_FILE, BACKUP_FILE);
  }
}

export function runDiff(): void {
  if (!fs.existsSync(MAPPING_FILE)) {
    console.log('\n❌ Chưa có mapping.json — hãy chạy "npm run map" trước.\n');
    return;
  }

  if (!fs.existsSync(BACKUP_FILE)) {
    console.log('\n⚠️  Chưa có phiên bản cũ để so sánh.');
    console.log('   Lần chạy "npm run map" tiếp theo sẽ tự lưu phiên bản cũ lại.\n');
    return;
  }

  const current = JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf-8')) as MappingFile;
  const previous = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf-8')) as MappingFile;

  const currentMap = new Map(current.pairs.map(p => [p.label, p]));
  const previousMap = new Map(previous.pairs.map(p => [p.label, p]));

  const added: MappingPair[] = [];
  const removed: MappingPair[] = [];
  const changed: { label: string; old: MappingPair; updated: MappingPair }[] = [];
  const unchanged: MappingPair[] = [];

  for (const [label, pair] of currentMap) {
    if (!previousMap.has(label)) {
      added.push(pair);
    } else {
      const old = previousMap.get(label)!;
      if (old.api_endpoint !== pair.api_endpoint || old.api_field !== pair.api_field) {
        changed.push({ label, old, updated: pair });
      } else {
        unchanged.push(pair);
      }
    }
  }

  for (const [label, pair] of previousMap) {
    if (!currentMap.has(label)) {
      removed.push(pair);
    }
  }

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('               SO SÁNH PHIÊN BẢN MAPPING');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  Cũ:  ${previous.generated_at} (${previous.total_pairs} cặp)`);
  console.log(`  Mới: ${current.generated_at} (${current.total_pairs} cặp)\n`);

  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    console.log('✅ Không có thay đổi gì — mapping vẫn như cũ.');
    console.log('══════════════════════════════════════════════════════════════\n');
    return;
  }

  if (added.length > 0) {
    console.log(`🆕 THÊM MỚI — ${added.length} cặp:`);
    for (const p of added) {
      console.log(`   + "${p.label}"`);
      console.log(`     → ${p.api_endpoint} › ${p.api_field}`);
    }
    console.log('');
  }

  if (removed.length > 0) {
    console.log(`🗑️  ĐÃ XÓA — ${removed.length} cặp:`);
    for (const p of removed) {
      console.log(`   - "${p.label}"`);
      console.log(`     ← ${p.api_endpoint} › ${p.api_field}`);
    }
    console.log('');
  }

  if (changed.length > 0) {
    console.log(`✏️  ĐÃ THAY ĐỔI — ${changed.length} cặp:`);
    for (const c of changed) {
      console.log(`   ~ "${c.label}"`);
      console.log(`     Cũ:  ${c.old.api_endpoint} › ${c.old.api_field}`);
      console.log(`     Mới: ${c.updated.api_endpoint} › ${c.updated.api_field}`);
    }
    console.log('');
  }

  console.log(`  Không thay đổi: ${unchanged.length} cặp`);
  console.log('══════════════════════════════════════════════════════════════\n');
}
