import fs from 'fs';
import path from 'path';
import Groq from 'groq-sdk';
import { Pool } from 'pg';
import { loadConfig } from './config.js';
import { analyzeDashboard } from './dashboard-analyzer.js';

const LIVE_ROUTES_FILE = path.join(process.cwd(), 'generated', 'live-routes.json');
const LEARNED_FIXES_FILE = path.join(process.cwd(), 'learned-fixes.json');
const MAX_FILE_CHARS = 8_000;

function loadLearnedFixes(dbKey: string): string {
  if (!fs.existsSync(LEARNED_FIXES_FILE)) return '';
  const data = JSON.parse(fs.readFileSync(LEARNED_FIXES_FILE, 'utf-8')) as {
    universal: string[];
    per_db: Record<string, { table: string; sql: string; hasYearParam: boolean; date: string }[]>;
  };
  const lines: string[] = [];

  if (data.universal?.length) {
    lines.push('PATTERNS UNIVERSAL (áp dụng mọi DB):');
    data.universal.forEach(u => lines.push(`  - ${u}`));
  }

  const dbFixes = data.per_db?.[dbKey] ?? [];
  if (dbFixes.length) {
    lines.push(`\nSQL ĐÃ XÁC NHẬN ĐÚNG cho DB "${dbKey}" (ưu tiên dùng lại):`);
    dbFixes.forEach(f => lines.push(`  [${f.table}] (${f.date}): ${f.sql}`));
  }

  return lines.join('\n');
}

async function getCompactSchema(cfg: ReturnType<typeof loadConfig>['database']): Promise<string> {
  const pool = new Pool({
    host: cfg.host, port: cfg.port, database: cfg.database,
    user: cfg.username, password: cfg.password, ssl: false, connectionTimeoutMillis: 10_000,
  });
  try {
    const result = await pool.query(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position
    `);
    const tables = new Map<string, string[]>();
    for (const row of result.rows) {
      const cols = tables.get(row.table_name) ?? [];
      cols.push(`${row.column_name}(${row.data_type})`);
      tables.set(row.table_name, cols);
    }
    return Array.from(tables.entries()).map(([t, cols]) => `${t}: ${cols.join(', ')}`).join('\n');
  } finally {
    await pool.end();
  }
}

async function getSampleData(
  cfg: ReturnType<typeof loadConfig>['database'],
  tables: string[]
): Promise<string> {
  const pool = new Pool({
    host: cfg.host, port: cfg.port, database: cfg.database,
    user: cfg.username, password: cfg.password, ssl: false, connectionTimeoutMillis: 8_000,
  });
  const lines: string[] = [];
  try {
    for (const table of tables.slice(0, 10)) {
      try {
        const r = await pool.query(`SELECT * FROM "${table}" LIMIT 2`);
        if (r.rows.length === 0) { lines.push(`[${table}] (bảng rỗng)`); continue; }
        const cols = Object.keys(r.rows[0]);
        const examples = cols.map(c => {
          const vals = r.rows.map(row => row[c]).filter(v => v !== null).slice(0, 2);
          return `${c}=${vals.join('|')}`;
        }).join(', ');
        lines.push(`[${table}] ${examples}`);
      } catch { /* bỏ qua bảng không truy cập được */ }
    }
  } finally {
    await pool.end();
  }
  return lines.join('\n');
}

async function getFullSchemaContext(
  cfg: ReturnType<typeof loadConfig>['database'],
  mainTables: string[]
): Promise<string> {
  const pool = new Pool({
    host: cfg.host, port: cfg.port, database: cfg.database,
    user: cfg.username, password: cfg.password, ssl: false, connectionTimeoutMillis: 15_000,
  });
  const lines: string[] = [];
  const relatedTables = new Set<string>();

  try {
    // 1. FK chính thức từ information_schema
    const fkRes = await pool.query(`
      SELECT kcu.table_name AS src_table, kcu.column_name AS src_col,
             ccu.table_name AS dst_table, ccu.column_name AS dst_col
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
        AND kcu.table_name = ANY($1)
      ORDER BY kcu.table_name, kcu.column_name
    `, [mainTables]);

    const fkLines: string[] = [];
    for (const r of fkRes.rows) {
      fkLines.push(`  ${r.src_table}.${r.src_col} → ${r.dst_table}.${r.dst_col}`);
      relatedTables.add(r.dst_table as string);
    }

    // 2. Heuristic FK: cột _id chưa có trong constraint
    for (const table of mainTables) {
      const idCols = await pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = $1 AND table_schema = 'public'
          AND column_name LIKE '%_id' AND column_name != 'id'
        ORDER BY ordinal_position
      `, [table]);

      for (const row of idCols.rows) {
        const col = row.column_name as string;
        if (fkRes.rows.some((r: {src_table: string; src_col: string}) => r.src_table === table && r.src_col === col)) continue;
        const prefix = col.replace(/_id$/, '');
        const match = await pool.query(`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public'
            AND (table_name = $1 OR table_name LIKE $2 OR table_name LIKE $3)
          ORDER BY CASE WHEN table_name = $1 THEN 0 WHEN table_name LIKE $2 THEN 1 ELSE 2 END
          LIMIT 1
        `, [prefix, `${prefix}_%`, `%${prefix}%`]);
        if (match.rows.length > 0) {
          const refTable = match.rows[0].table_name as string;
          if (!mainTables.includes(refTable) && !relatedTables.has(refTable)) {
            fkLines.push(`  ${table}.${col} → ${refTable}.id`);
            relatedTables.add(refTable);
          }
        }
      }
    }

    if (fkLines.length > 0) {
      lines.push('FOREIGN KEYS (quan hệ bảng — dùng để JOIN lấy tên):');
      lines.push(...fkLines);
    }

    // 3. Lookup tables: schema + sample data
    const lookupTables = [...relatedTables].filter(t => !mainTables.includes(t));
    if (lookupTables.length > 0) {
      lines.push('\nBẢNG LOOKUP (JOIN để lấy tên thật):');
      for (const table of lookupTables.slice(0, 12)) {
        try {
          const colRes = await pool.query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_name = $1 AND table_schema = 'public'
            ORDER BY ordinal_position LIMIT 8
          `, [table]);
          const colStr = colRes.rows.map(r => r.column_name).join(', ');
          lines.push(`  ${table}: (${colStr})`);
          const sample = await pool.query(`SELECT * FROM "${table}" LIMIT 5`);
          if (sample.rows.length > 0) {
            const sampleStr = sample.rows
              .map(r => Object.entries(r).map(([k, v]) => `${k}=${v}`).join(', '))
              .join(' | ');
            lines.push(`    mẫu: ${sampleStr.slice(0, 400)}`);
          }
        } catch { /* bỏ qua */ }
      }
    }

    // 4. Enum/distinct values cho cột text ít giá trị
    const SKIP_COLS = new Set(['so_name', 'service_name', 'sale_name', 'team_name',
      'source_name', 'complete_name', 'name', 'product_category']);
    lines.push('\nGIÁ TRỊ THỰC TẾ (distinct values — dùng đúng trong WHERE/CASE WHEN):');
    for (const table of mainTables) {
      const colRes = await pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = $1 AND table_schema = 'public'
          AND data_type IN ('character varying', 'text', 'character')
          AND column_name NOT LIKE '%_id'
        ORDER BY ordinal_position
      `, [table]);

      for (const row of colRes.rows) {
        const col = row.column_name as string;
        if (SKIP_COLS.has(col) || col.includes('name') || col.includes('desc')) continue;
        try {
          const cntRes = await pool.query(`SELECT COUNT(DISTINCT "${col}") AS cnt FROM "${table}"`);
          const cnt = parseInt(cntRes.rows[0].cnt as string);
          if (cnt >= 1 && cnt <= 20) {
            const vals = await pool.query(
              `SELECT DISTINCT "${col}" FROM "${table}" WHERE "${col}" IS NOT NULL ORDER BY 1 LIMIT 20`
            );
            const valStr = vals.rows.map(r => `'${r[col]}'`).join(', ');
            lines.push(`  ${table}.${col}: [${valStr}]`);
          }
        } catch { /* bỏ qua */ }
      }
    }
  } finally {
    await pool.end();
  }
  return lines.join('\n');
}

async function testSqlRoutes(
  routes: { table: string; sql: string; hasYearParam: boolean }[],
  cfg: ReturnType<typeof loadConfig>['database']
): Promise<void> {
  const pool = new Pool({
    host: cfg.host, port: cfg.port, database: cfg.database,
    user: cfg.username, password: cfg.password, ssl: false, connectionTimeoutMillis: 10_000,
  });
  const year = new Date().getFullYear();
  console.log('\n🧪 Tự động kiểm tra SQL queries...\n');
  try {
    for (const route of routes) {
      if (!route.sql.trim()) { console.log(`  ⚠️  [${route.table}] — Không có SQL`); continue; }
      try {
        const params = route.hasYearParam ? [year] : [];
        const result = await pool.query(route.sql, params);
        if (result.rows.length === 0) {
          console.log(`  🟡 [${route.table}] — 0 dòng (kiểm tra lại filter/điều kiện)`);
        } else {
          const sample = Object.entries(result.rows[0])
            .slice(0, 4).map(([k, v]) => `${k}: ${v}`).join(' | ');
          console.log(`  🟢 [${route.table}] — ${result.rows.length} dòng → ${sample}`);
        }
      } catch (err) {
        console.log(`  🔴 [${route.table}] — LỖI SQL: ${(err as Error).message}`);
      }
    }
  } finally {
    await pool.end();
  }
}

function buildMockSupabaseClient(): string {
  return `// Auto-generated bởi Tool API tự động — ĐỪNG sửa thủ công
// Gọi về Tool server (localhost:4000) thay vì Supabase cloud
// Để hoàn nguyên: xóa file này, đổi tên supabase.ts.backup → supabase.ts

const TOOL_URL = 'http://localhost:4000/api/live';

class QueryBuilder {
  private _table: string;
  private _filters: Record<string, unknown> = {};

  constructor(table: string) { this._table = table; }

  select(_cols: string) { return this; }
  eq(col: string, val: unknown) { this._filters[col] = val; return this; }
  order(_col: string) { return this; }

  then(
    resolve: (result: { data: unknown[] | null; error: null }) => void,
    reject: (err: unknown) => void,
  ) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(this._filters)) params.set(k, String(v));
    fetch(\`\${TOOL_URL}/\${this._table}?\${params}\`)
      .then(r => r.json())
      .then((data: unknown) => resolve({ data: Array.isArray(data) ? data : null, error: null }))
      .catch(reject);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const supabase = { from: (table: string) => new QueryBuilder(table) } as any;
`;
}

async function integrateSupabase(
  cfg: ReturnType<typeof loadConfig>,
  schemaText: string,
  sampleData: string,
  schemaContext: string,
  mappingText: string,
  supabaseTables: string[],
  dataFiles: { relativePath: string; content: string }[],
  groq: Groq,
  dbKey: string,
): Promise<void> {
  const filesContext = dataFiles
    .map(f => `// === ${f.relativePath} ===\n${f.content.slice(0, MAX_FILE_CHARS)}`)
    .join('\n\n---\n\n');

  const learnedFixes = loadLearnedFixes(dbKey);
  const systemPrompt = `Bạn là chuyên gia SQL PostgreSQL và TypeScript.
Nhiệm vụ: Phân tích code Dashboard để hiểu dữ liệu cần thiết, rồi viết SQL queries từ database PostgreSQL tạo ra output tương đương.

Quy tắc:
- Chỉ dùng bảng và cột có trong DATABASE SCHEMA
- Nếu cần filter theo year, dùng $1 và đặt hasYearParam: true
- Dùng alias để tên cột output đúng với những gì Dashboard cần
- Nếu không đủ dữ liệu để tạo bảng, để sql là ""
- Trả về JSON THUẦN TÚY${learnedFixes ? `\n\n${learnedFixes}` : ''}

Format:
{
  "routes": [
    { "table": "tên_bảng", "sql": "SELECT ...", "hasYearParam": true/false }
  ]
}`;

  const userPrompt = `DATABASE SCHEMA (PostgreSQL thực tế):
${schemaText}

DỮ LIỆU MẪU (2 dòng thực tế mỗi bảng):
${sampleData}

QUAN HỆ BẢNG, LOOKUP TABLES & GIÁ TRỊ THỰC TẾ:
${schemaContext}

MAPPING nhãn Dashboard → cột database:
${mappingText}

DASHBOARD CODE (các file xử lý dữ liệu):
${filesContext}

Các Supabase tables mà Dashboard đang dùng: ${supabaseTables.join(', ')}

Hãy viết SQL query cho TỪNG bảng Supabase trên, lấy dữ liệu từ PostgreSQL và trả về đúng columns mà Dashboard đang truy cập.
Lưu ý quan trọng:
- Dùng đúng giá trị từ mục "GIÁ TRỊ THỰC TẾ" cho WHERE/CASE WHEN (không đoán)
- JOIN lookup tables để lấy tên thật thay vì ID
- Cast tất cả SUM/AVG sang ::float8 để tránh lỗi kiểu dữ liệu
- Dùng CTE khi JOIN nhiều bảng để tránh nhân bản dữ liệu
Trả về JSON thuần túy.`;

  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
  });

  const rawText = completion.choices[0].message.content ?? '';
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  if (!jsonMatch) throw new Error('Không tìm thấy JSON trong phản hồi của AI');

  const parsed = JSON.parse(jsonMatch[0]) as {
    routes: { table: string; sql: string; hasYearParam: boolean }[];
  };

  const outputDir = path.join(process.cwd(), 'generated');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(LIVE_ROUTES_FILE, JSON.stringify(parsed, null, 2), 'utf-8');

  const validRoutes = parsed.routes.filter(r => r.sql.trim().length > 0);
  console.log(`✅ Đã tạo ${validRoutes.length}/${parsed.routes.length} SQL queries\n`);

  await testSqlRoutes(validRoutes, cfg.database);

  // Patch supabase.ts
  const supabasePath = path.join(cfg.dashboard.source_folder, 'src', 'lib', 'supabase.ts');
  if (fs.existsSync(supabasePath)) {
    fs.writeFileSync(supabasePath + '.backup', fs.readFileSync(supabasePath, 'utf-8'), 'utf-8');
    console.log('  💾 Đã backup supabase.ts → supabase.ts.backup');
  }
  fs.writeFileSync(supabasePath, buildMockSupabaseClient(), 'utf-8');
  console.log('  ✅ Đã tạo mock supabase client');
}

async function integrateFetch(
  cfg: ReturnType<typeof loadConfig>,
  schemaText: string,
  sampleData: string,
  schemaContext: string,
  mappingText: string,
  fetchEndpoints: string[],
  dataFiles: { relativePath: string; content: string }[],
  groq: Groq,
  dbKey: string,
): Promise<void> {
  const filesContext = dataFiles
    .map(f => `// === ${f.relativePath} ===\n${f.content.slice(0, MAX_FILE_CHARS)}`)
    .join('\n\n---\n\n');

  const learnedFixes = loadLearnedFixes(dbKey);
  const systemPrompt = `Bạn là chuyên gia SQL PostgreSQL và TypeScript/Express.
Nhiệm vụ: Phân tích Dashboard code, viết SQL queries và Express routes để serve dữ liệu thật từ PostgreSQL.
Trả về JSON THUẦN TÚY.${learnedFixes ? `\n\n${learnedFixes}` : ''}

Format:
{
  "routes": [
    { "table": "tên_endpoint_ngắn", "sql": "SELECT ...", "hasYearParam": false, "originalPath": "/api/..." }
  ]
}`;

  const userPrompt = `DATABASE SCHEMA:
${schemaText}

DỮ LIỆU MẪU (2 dòng thực tế mỗi bảng):
${sampleData}

QUAN HỆ BẢNG, LOOKUP TABLES & GIÁ TRỊ THỰC TẾ:
${schemaContext}

MAPPING nhãn Dashboard → cột database:
${mappingText}

DASHBOARD CODE:
${filesContext}

API endpoints Dashboard đang gọi: ${fetchEndpoints.join(', ')}

Viết SQL query cho từng endpoint trên.
Lưu ý quan trọng:
- Dùng đúng giá trị từ mục "GIÁ TRỊ THỰC TẾ" cho WHERE/CASE WHEN (không đoán)
- JOIN lookup tables để lấy tên thật thay vì ID
- Cast tất cả SUM/AVG sang ::float8 để tránh lỗi kiểu dữ liệu
- Dùng CTE khi JOIN nhiều bảng để tránh nhân bản dữ liệu
Trả về JSON thuần túy.`;

  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
  });

  const rawText = completion.choices[0].message.content ?? '';
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  if (!jsonMatch) throw new Error('Không tìm thấy JSON trong phản hồi của AI');

  const parsed = JSON.parse(jsonMatch[0]) as {
    routes: { table: string; sql: string; hasYearParam: boolean; originalPath?: string }[];
  };

  const outputDir = path.join(process.cwd(), 'generated');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(LIVE_ROUTES_FILE, JSON.stringify(parsed, null, 2), 'utf-8');

  const validRoutes = parsed.routes.filter(r => r.sql.trim().length > 0);
  console.log(`✅ Đã tạo ${validRoutes.length}/${parsed.routes.length} SQL queries\n`);

  await testSqlRoutes(validRoutes, cfg.database);

  // Ghi live-data.ts vào Dashboard src
  const liveDataPath = path.join(cfg.dashboard.source_folder, 'src', 'lib', 'live-data.ts');
  const liveDataCode = `// Auto-generated bởi Tool API tự động
// Fetch dữ liệu thật từ Tool server (localhost:4000)

const TOOL_URL = 'http://localhost:4000/api/live';

${parsed.routes.filter(r => r.sql.trim()).map(r => {
  const fn = 'fetch' + r.table.charAt(0).toUpperCase() + r.table.slice(1).replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return `export async function ${fn}(year?: number) {
  const params = year ? \`?year=\${year}\` : '';
  const res = await fetch(\`\${TOOL_URL}/${r.table}\${params}\`);
  return res.ok ? res.json() : [];
}`;
}).join('\n\n')}
`;
  fs.writeFileSync(liveDataPath, liveDataCode, 'utf-8');
  console.log(`  ✅ Đã tạo ${liveDataPath}`);
  console.log('  ⚠️  Hãy import từ live-data.ts thay vì fetch trực tiếp trong Dashboard');
}

export async function runAutoIntegrate(): Promise<void> {
  console.log('\n📖 Đang phân tích Dashboard...');
  const cfg = loadConfig();

  const mappingPath = path.join(process.cwd(), 'mapping.json');
  if (!fs.existsSync(mappingPath)) throw new Error('Chưa có mapping.json — hãy chạy Bước 2 trước');
  const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));
  if (mapping.type !== 'database') throw new Error('Chỉ hỗ trợ Database mapping');

  // Phân tích dashboard
  const analysis = analyzeDashboard(cfg.dashboard.source_folder);

  if (analysis.type === 'mock') {
    throw new Error('Dashboard chỉ dùng mock data tĩnh — không có API/Supabase để tự động tích hợp. Hãy trao đổi thêm.');
  }

  console.log('🔌 Đang đọc schema database...');
  const schemaText = await getCompactSchema(cfg.database);

  const pairs = mapping.pairs as { label: string; table: string; column: string }[];
  const uniqueTables = [...new Set(pairs.map(p => p.table))];

  console.log('📋 Đang lấy dữ liệu mẫu...');
  const sampleData = await getSampleData(cfg.database, uniqueTables);

  console.log('🔍 Đang phân tích FK, lookup tables & enum values...');
  const schemaContext = await getFullSchemaContext(cfg.database, uniqueTables);

  const mappingText = pairs.map(p => `"${p.label}" → ${p.table}.${p.column}`).join('\n');

  console.log('🤖 Đang nhờ AI viết SQL queries...\n');
  const groq = new Groq({ apiKey: cfg.gemini.api_key });
  const dbKey = `${cfg.database.host}:${cfg.database.port}/${cfg.database.database}`;

  if (analysis.type === 'supabase') {
    await integrateSupabase(cfg, schemaText, sampleData, schemaContext, mappingText, analysis.supabaseTables, analysis.dataFiles, groq, dbKey);
  } else {
    await integrateFetch(cfg, schemaText, sampleData, schemaContext, mappingText, analysis.fetchEndpoints, analysis.dataFiles, groq, dbKey);
  }

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('          TÍCH HỢP TỰ ĐỘNG THÀNH CÔNG');
  console.log('══════════════════════════════════════════════════════════════\n');
  console.log('📋 Tiếp theo:');
  console.log('  → Đảm bảo tool đang chạy (localhost:4000)');
  console.log('  → Mở Dashboard (localhost:4001) — dữ liệu thật sẽ tự load\n');
  console.log('══════════════════════════════════════════════════════════════\n');
}
