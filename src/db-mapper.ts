import { Pool } from 'pg';
import Groq from 'groq-sdk';
import fs from 'fs';
import path from 'path';
import { logError } from './logger.js';
import { backupMapping } from './diff.js';

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

interface DbMappingPair {
  label: string;
  table: string;
  column: string;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

interface TableColumn {
  table_name: string;
  column_name: string;
  data_type: string;
}

const MAPPING_FILE = path.join(process.cwd(), 'mapping.json');
const MAX_SCHEMA_CHARS = 18_000;
const BATCH_SIZE = 50;

function createPool(cfg: DbConfig) {
  return new Pool({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.username,
    password: cfg.password,
    ssl: false,
    connectionTimeoutMillis: 10_000,
  });
}

async function getSchema(cfg: DbConfig): Promise<TableColumn[]> {
  const pool = createPool(cfg);
  try {
    const result = await pool.query<TableColumn>(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position
    `);
    return result.rows;
  } finally {
    await pool.end();
  }
}

function formatSchema(columns: TableColumn[]): string {
  const tables = new Map<string, { column: string; type: string }[]>();
  for (const col of columns) {
    if (!tables.has(col.table_name)) tables.set(col.table_name, []);
    tables.get(col.table_name)!.push({ column: col.column_name, type: col.data_type });
  }
  const lines: string[] = [];
  for (const [table, cols] of tables) {
    lines.push(`Bảng: ${table}`);
    for (const col of cols) lines.push(`  - ${col.column} (${col.type})`);
    lines.push('');
  }
  return lines.join('\n');
}

export async function checkDbConnection(cfg: DbConfig): Promise<{ ok: boolean; message: string }> {
  try {
    const pool = createPool(cfg);
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(DISTINCT table_name)::text AS count FROM information_schema.columns WHERE table_schema = 'public'`
    );
    await pool.end();
    const tableCount = parseInt(result.rows[0].count);
    return { ok: true, message: `Kết nối thành công — ${tableCount} bảng trong database` };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export async function runDbMapping(cfg: DbConfig, groqKey: string, labels: string[], scopeNotes?: string): Promise<void> {
  console.log('\n🔌 Đang kết nối database...');
  const schema = await getSchema(cfg);

  if (schema.length === 0) throw new Error('Database không có bảng nào trong schema public');

  const tableCount = new Set(schema.map(c => c.table_name)).size;
  console.log(`✅ Đã đọc ${tableCount} bảng, ${schema.length} cột.\n`);
  console.log('🤖 Đang kết nối Groq AI để phân tích...\n');

  const groq = new Groq({ apiKey: groqKey });

  const systemInstruction = `Bạn là chuyên gia kết nối dữ liệu giữa Dashboard và Database PostgreSQL.
Nhiệm vụ: Phân tích cấu trúc database và ánh xạ từng nhãn tiếng Việt từ Dashboard sang đúng bảng và cột tương ứng.

Quy tắc bắt buộc:
- Chỉ ánh xạ khi bạn CHẮC CHẮN (confidence: "high" hoặc "medium")
- Nếu không chắc hoặc không tìm thấy cột phù hợp: đặt confidence: "low"
- Trả về JSON THUẦN TÚY, không có markdown

Định dạng JSON bắt buộc:
{
  "pairs": [
    {
      "label": "Nhãn tiếng Việt",
      "table": "ten_bang",
      "column": "ten_cot",
      "confidence": "high | medium | low",
      "reasoning": "Lý do ngắn gọn bằng tiếng Việt"
    }
  ]
}`;

  let schemaText = formatSchema(schema);
  if (schemaText.length > MAX_SCHEMA_CHARS) {
    schemaText = schemaText.slice(0, MAX_SCHEMA_CHARS) + '\n\n... [schema đã cắt bớt]';
    console.log(`⚠️  Schema quá lớn, đã cắt bớt còn ${MAX_SCHEMA_CHARS} ký tự.\n`);
  }

  const allPairs: DbMappingPair[] = [];
  const batches: string[][] = [];
  for (let i = 0; i < labels.length; i += BATCH_SIZE) {
    batches.push(labels.slice(i, i + BATCH_SIZE));
  }
  console.log(`📦 Chia thành ${batches.length} batch (${BATCH_SIZE} nhãn/batch)...\n`);

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    console.log(`🔄 Batch ${b + 1}/${batches.length} — ${batch.length} nhãn...`);
    const userPrompt = `Cấu trúc Database:\n${schemaText}\n\nDanh sách nhãn từ Dashboard cần ánh xạ:\n${batch.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n\nHãy ánh xạ từng nhãn sang bảng và cột tương ứng. Trả về JSON thuần túy.${scopeNotes ? `\n\nGhi chú phạm vi dữ liệu (BẮT BUỘC tuân theo):\n${scopeNotes}` : ''}`;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    });

    const rawText = completion.choices[0].message.content ?? '';
    const jsonMatch = rawText.match(/\{[\s\S]+\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { pairs: DbMappingPair[] };
      allPairs.push(...parsed.pairs);
    }
    if (b < batches.length - 1) await new Promise(r => setTimeout(r, 800));
  }

  const confirmed: DbMappingPair[] = [];
  const uncertain: DbMappingPair[] = [];

  for (const pair of allPairs) {
    if (pair.confidence === 'low') {
      uncertain.push(pair);
      logError('DB-MAPPER', `Bỏ qua "${pair.label}" — Độ tin cậy thấp. Lý do: ${pair.reasoning}`);
    } else {
      confirmed.push(pair);
    }
  }

  backupMapping();
  fs.writeFileSync(
    MAPPING_FILE,
    JSON.stringify({
      type: 'database',
      generated_at: new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
      total_pairs: confirmed.length,
      pairs: confirmed.map(p => ({ label: p.label, table: p.table, column: p.column })),
    }, null, 2),
    'utf-8'
  );

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('              KẾT QUẢ ÁNH XẠ DATABASE');
  console.log('══════════════════════════════════════════════════════════════\n');

  if (confirmed.length > 0) {
    console.log(`✅ Đã kết nối thành công ${confirmed.length} cặp dữ liệu:\n`);
    for (const p of confirmed) {
      const badge = p.confidence === 'high' ? '🟢' : '🟡';
      console.log(`  ${badge}  "${p.label}"`);
      console.log(`       → ${p.table}.${p.column}\n`);
    }
  }

  if (uncertain.length > 0) {
    console.log(`⚠️  ${uncertain.length} nhãn không đủ tự tin (đã ghi vào error.log):\n`);
    for (const p of uncertain) console.log(`  🔴  "${p.label}" — ${p.reasoning}`);
    console.log('');
  }

  console.log(`📄 Đã lưu mapping.json với ${confirmed.length} cặp hợp lệ.`);
  console.log('══════════════════════════════════════════════════════════════\n');
}
