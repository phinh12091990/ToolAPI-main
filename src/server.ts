import express from 'express';
import path from 'path';
import fs from 'fs';
import { runVibeCheck } from './vibe-check.js';
import { runMapping } from './mapper.js';
import { runValidate } from './validator.js';
import { runGenerate } from './generator.js';
import { runDiff } from './diff.js';
import { scanDashboard } from './scanner.js';
import { loadConfig } from './config.js';
import { checkDbConnection, runDbMapping, DbConfig } from './db-mapper.js';
import { runAutoIntegrate } from './auto-integrator.js';
import { Pool } from 'pg';

const app = express();
app.use(express.json());
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.use(express.static(path.join(process.cwd(), 'public')));

function capture(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => { origLog(...a); lines.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { origErr(...a); lines.push(a.map(String).join(' ')); };
  return fn()
    .then(() => { console.log = origLog; console.error = origErr; return lines.join('\n'); })
    .catch(err => { console.log = origLog; console.error = origErr; return `❌ Lỗi: ${(err as Error).message}`; });
}

app.get('/api/settings', (_req, res) => {
  const p = path.join(process.cwd(), 'settings.json');
  if (!fs.existsSync(p)) { res.json({}); return; }
  res.json(JSON.parse(fs.readFileSync(p, 'utf-8')));
});

app.post('/api/settings', (req, res) => {
  fs.writeFileSync(path.join(process.cwd(), 'settings.json'), JSON.stringify(req.body, null, 2), 'utf-8');
  res.json({ ok: true });
});

app.get('/api/status', (_req, res) => {
  const p = path.join(process.cwd(), 'mapping.json');
  if (!fs.existsSync(p)) { res.json({ hasMapping: false }); return; }
  const m = JSON.parse(fs.readFileSync(p, 'utf-8')) as { generated_at: string; total_pairs: number };
  res.json({ hasMapping: true, generated_at: m.generated_at, total_pairs: m.total_pairs });
});

app.post('/api/vibe-check', async (_req, res) => {
  const output = await capture(() => runVibeCheck());
  res.json({ output });
});

app.post('/api/map', async (_req, res) => {
  const output = await capture(async () => {
    const config = loadConfig();
    const scan = scanDashboard(config.dashboard.source_folder);
    if (scan.labels.length === 0) {
      console.log('⚠️  Không tìm thấy nhãn tiếng Việt trong thư mục Dashboard.');
      return;
    }
    console.log(`📂 Đã quét ${scan.fileCount} file — ${scan.labels.length} nhãn tiếng Việt.`);
    const scopeNotes = (config as unknown as { scope?: { notes?: string } }).scope?.notes;
    await runMapping(config, scan.labels, scopeNotes);
  });
  res.json({ output });
});

app.post('/api/validate', async (_req, res) => {
  const output = await capture(async () => { const c = loadConfig(); await runValidate(c); });
  res.json({ output });
});

app.post('/api/generate', async (_req, res) => {
  const output = await capture(async () => { const c = loadConfig(); runGenerate(c); });
  res.json({ output });
});

app.post('/api/diff', async (_req, res) => {
  const output = await capture(async () => runDiff());
  res.json({ output });
});

app.post('/api/vibe-check-db', async (req, res) => {
  const cfg = req.body as DbConfig;
  const result = await checkDbConnection(cfg);
  const output = result.ok ? `🟢 ${result.message}` : `🔴 ${result.message}`;
  res.json({ output, ok: result.ok });
});

app.post('/api/map-db', async (req, res) => {
  const { dbConfig, anthropicKey, sourceFolder, scopeNotes } = req.body as {
    dbConfig: DbConfig;
    anthropicKey: string; // now gemini key
    sourceFolder: string;
    scopeNotes?: string;
  };
  const output = await capture(async () => {
    const scan = scanDashboard(sourceFolder);
    if (scan.labels.length === 0) {
      console.log('⚠️  Không tìm thấy nhãn tiếng Việt trong thư mục Dashboard.');
      return;
    }
    console.log(`📂 Đã quét ${scan.fileCount} file — ${scan.labels.length} nhãn tiếng Việt.`);
    await runDbMapping(dbConfig, anthropicKey, scan.labels, scopeNotes);
  });
  res.json({ output });
});

app.post('/api/chat', async (req, res) => {
  const { message, history } = req.body as {
    message: string;
    history: { role: 'user' | 'assistant'; content: string }[];
  };
  try {
    const cfg = loadConfig();
    let context = `Bạn là AI assistant của Tool API tự động — công cụ kết nối Dashboard với Database PostgreSQL.
Trả lời ngắn gọn bằng tiếng Việt. Nếu cần sửa SQL hoặc config, đưa ra code cụ thể.

Khi được yêu cầu sửa một SQL query, hãy:
1. Giải thích ngắn vấn đề
2. Đưa ra SQL đã sửa trong code block
3. Thêm vào CUỐI reply (dòng riêng): APPLY_FIX:{"table":"tên_bảng","sql":"...","hasYearParam":true_hoặc_false}
Tên bảng phải khớp chính xác với tên trong danh sách SQL queries bên dưới.`;

    const mappingPath = path.join(process.cwd(), 'mapping.json');
    if (fs.existsSync(mappingPath)) {
      const m = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));
      const pairs = (m.pairs as { label: string; table: string; column: string }[])
        .map(p => `"${p.label}" → ${p.table}.${p.column}`).join('\n');
      context += `\n\nMapping hiện tại (${m.total_pairs} cặp):\n${pairs}`;
    }

    const routesPath = path.join(process.cwd(), 'generated', 'live-routes.json');
    if (fs.existsSync(routesPath)) {
      const r = JSON.parse(fs.readFileSync(routesPath, 'utf-8')) as {
        routes: { table: string; sql: string; hasYearParam: boolean }[];
      };
      context += `\n\nSQL queries đang chạy:\n${r.routes.map(x => `[${x.table}] (hasYearParam:${x.hasYearParam}): ${x.sql}`).join('\n')}`;
    }

    const fixesPath = path.join(process.cwd(), 'learned-fixes.json');
    if (fs.existsSync(fixesPath)) {
      const fixes = JSON.parse(fs.readFileSync(fixesPath, 'utf-8')) as {
        universal: string[];
        per_db: Record<string, { table: string; sql: string; date: string }[]>;
      };
      const dbKey = `${cfg.database.host}:${cfg.database.port}/${cfg.database.database}`;
      const lines: string[] = [];
      if (fixes.universal?.length) {
        lines.push('Patterns universal:', ...fixes.universal.map(u => `  - ${u}`));
      }
      const dbFixes = fixes.per_db?.[dbKey] ?? [];
      if (dbFixes.length) {
        lines.push(`SQL đã xác nhận đúng cho DB này (${dbKey}):`);
        lines.push(...dbFixes.map(f => `  [${f.table}] (${f.date}): ${f.sql}`));
      }
      if (lines.length) context += `\n\nBỘ NHỚ HỌC:\n${lines.join('\n')}`;
    }

    context += `\n\nDatabase: ${cfg.database.host}:${cfg.database.port}/${cfg.database.database}`;
    context += `\nDashboard folder: ${cfg.dashboard.source_folder}`;

    const { default: Groq } = await import('groq-sdk');
    const groq = new Groq({ apiKey: cfg.gemini.api_key });
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: context },
        ...history,
        { role: 'user', content: message },
      ],
      temperature: 0.7,
      max_tokens: 1500,
    });
    res.json({ reply: completion.choices[0].message.content ?? '' });
  } catch (err) {
    res.json({ reply: `❌ Lỗi: ${(err as Error).message}` });
  }
});

app.post('/api/apply-fix', async (req, res) => {
  const { table, sql, hasYearParam } = req.body as {
    table: string; sql: string; hasYearParam: boolean;
  };
  const routesPath = path.join(process.cwd(), 'generated', 'live-routes.json');
  if (!fs.existsSync(routesPath)) {
    res.json({ ok: false, output: '❌ Chưa có live-routes.json' }); return;
  }
  const data = JSON.parse(fs.readFileSync(routesPath, 'utf-8')) as {
    routes: { table: string; sql: string; hasYearParam: boolean }[];
  };
  const idx = data.routes.findIndex(r => r.table === table);
  if (idx === -1) {
    res.json({ ok: false, output: `❌ Không tìm thấy route: ${table}` }); return;
  }
  data.routes[idx].sql = sql;
  data.routes[idx].hasYearParam = hasYearParam;
  fs.writeFileSync(routesPath, JSON.stringify(data, null, 2), 'utf-8');

  const cfg = loadConfig();
  const pool = new Pool({
    host: cfg.database.host, port: cfg.database.port,
    database: cfg.database.database, user: cfg.database.username,
    password: cfg.database.password, ssl: false, connectionTimeoutMillis: 10_000,
  });
  try {
    const year = new Date().getFullYear();
    const params = hasYearParam ? [year] : [];
    const result = await pool.query(sql, params);
    const sample = result.rows.length > 0
      ? Object.entries(result.rows[0]).slice(0, 4).map(([k, v]) => `${k}: ${v}`).join(' | ')
      : '(0 dòng)';

    // Lưu vào learned-fixes.json — phân tách universal vs per_db
    const cfg2 = loadConfig();
    const dbKey = `${cfg2.database.host}:${cfg2.database.port}/${cfg2.database.database}`;
    const fixesPath = path.join(process.cwd(), 'learned-fixes.json');
    const fixes = fs.existsSync(fixesPath)
      ? JSON.parse(fs.readFileSync(fixesPath, 'utf-8')) as {
          universal: string[];
          per_db: Record<string, { table: string; sql: string; hasYearParam: boolean; date: string }[]>;
        }
      : { universal: [], per_db: {} };
    if (!fixes.per_db[dbKey]) fixes.per_db[dbKey] = [];
    const dbFixes = fixes.per_db[dbKey];
    const existingIdx = dbFixes.findIndex(f => f.table === table);
    const entry = { table, sql, hasYearParam, date: new Date().toISOString().slice(0, 10) };
    if (existingIdx >= 0) dbFixes[existingIdx] = entry;
    else dbFixes.push(entry);
    fs.writeFileSync(fixesPath, JSON.stringify(fixes, null, 2), 'utf-8');

    // Level 2: AI tự rút bài học ngầm
    let lessonNote = '';
    try {
      const { default: Groq } = await import('groq-sdk');
      const groq = new Groq({ apiKey: cfg2.gemini.api_key });
      const lessonRes = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [{
          role: 'user',
          content: `Một SQL query vừa được sửa thành công cho bảng "${table}".\nSQL đúng: ${sql}\nHasYearParam: ${hasYearParam}\n\nRút ra 1 bài học kỹ thuật ngắn gọn (1 câu, tối đa 120 ký tự) áp dụng cho MỌI database PostgreSQL (không phải chỉ DB này). Nếu bài học chỉ đặc thù cho DB/bảng này thì trả về JSON: {"lesson":"","scope":"skip"}.\nTrả về JSON: {"lesson":"...","scope":"universal" hoặc "skip"}`
        }],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 200,
      });
      const parsed = JSON.parse(lessonRes.choices[0].message.content ?? '{}') as {
        lesson: string; scope: string;
      };
      if (parsed.scope === 'universal' && parsed.lesson?.trim()) {
        const lesson = parsed.lesson.trim();
        const alreadyExists = fixes.universal.some(u =>
          u.toLowerCase().includes(lesson.slice(0, 20).toLowerCase())
        );
        if (!alreadyExists) {
          fixes.universal.push(lesson);
          fs.writeFileSync(fixesPath, JSON.stringify(fixes, null, 2), 'utf-8');
          lessonNote = `\n💡 Đã học: ${lesson}`;
        }
      }
    } catch { /* bài học không quan trọng, bỏ qua nếu lỗi */ }

    res.json({ ok: true, output: `✅ Đã áp dụng SQL mới cho [${table}]\n🧪 Test: ${result.rows.length} dòng → ${sample}\n💾 Đã lưu vào bộ nhớ học${lessonNote}` });
  } catch (err) {
    res.json({ ok: false, output: `❌ SQL vẫn lỗi: ${(err as Error).message}` });
  } finally {
    await pool.end();
  }
});

app.post('/api/integrate', async (_req, res) => {
  const output = await capture(() => runAutoIntegrate());
  res.json({ output });
});

app.get('/api/live/:table', async (req, res) => {
  const routesPath = path.join(process.cwd(), 'generated', 'live-routes.json');
  if (!fs.existsSync(routesPath)) { res.json([]); return; }

  const { routes } = JSON.parse(fs.readFileSync(routesPath, 'utf-8')) as {
    routes: { table: string; sql: string; hasYearParam: boolean }[];
  };
  const route = routes.find(r => r.table === req.params.table);
  if (!route || !route.sql.trim()) { res.json([]); return; }

  const cfg = loadConfig();
  const pool = new Pool({
    host: cfg.database.host, port: cfg.database.port,
    database: cfg.database.database, user: cfg.database.username,
    password: cfg.database.password, ssl: false, connectionTimeoutMillis: 10_000,
  });
  try {
    const params = route.hasYearParam ? [req.query['year'] ?? new Date().getFullYear()] : [];
    const result = await pool.query(route.sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error(`[live/${req.params.table}]`, (err as Error).message);
    res.json([]);
  } finally {
    await pool.end();
  }
});

const PORT = Number(process.env.PORT) || 4000;
app.listen(PORT, () => {
  console.log('\n══════════════════════════════════════════');
  console.log('        TOOL API TỰ ĐỘNG — Web UI');
  console.log('══════════════════════════════════════════');
  console.log(`\n🌐 Mở trình duyệt vào: http://localhost:${PORT}`);
  console.log('\n   Nhấn Ctrl+C để dừng.');
  console.log('══════════════════════════════════════════\n');
});
