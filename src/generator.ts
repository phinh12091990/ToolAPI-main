import fs from 'fs';
import path from 'path';
import { Config } from './config.js';

interface ApiMappingPair {
  label: string;
  api_endpoint: string;
  api_field: string;
}

interface DbMappingPair {
  label: string;
  table: string;
  column: string;
}

type MappingPair = ApiMappingPair | DbMappingPair;

interface MappingFile {
  type?: 'database' | 'api';
  generated_at: string;
  total_pairs: number;
  pairs: MappingPair[];
}

function endpointToFuncName(endpoint: string): string {
  return (
    'fetch' +
    endpoint
      .replace(/^\//, '')
      .split(/[\/\-_{}]/)
      .filter(Boolean)
      .map(s => s.charAt(0).toUpperCase() + s.slice(1))
      .join('')
  );
}

function labelToVarName(label: string): string {
  return label
    .toLowerCase()
    .replace(/[àáạảãâầấậẩẫăằắặẳẵ]/g, 'a')
    .replace(/[èéẹẻẽêềếệểễ]/g, 'e')
    .replace(/[ìíịỉĩ]/g, 'i')
    .replace(/[òóọỏõôồốộổỗơờớợởỡ]/g, 'o')
    .replace(/[ùúụủũưừứựửữ]/g, 'u')
    .replace(/[ỳýỵỷỹ]/g, 'y')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join('');
}

export function runGenerate(config: Config): void {
  const mappingPath = path.join(process.cwd(), 'mapping.json');

  if (!fs.existsSync(mappingPath)) {
    console.log('\n❌ Chưa có mapping.json — hãy chạy Bước 2 trước.\n');
    return;
  }

  const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8')) as MappingFile;

  if (mapping.pairs.length === 0) {
    console.log('\n⚠️  mapping.json không có cặp nào hợp lệ.\n');
    return;
  }

  const outputDir = path.join(process.cwd(), 'generated');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const timestamp = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

  if (mapping.type === 'database') {
    generateDbCode(mapping.pairs as DbMappingPair[], config, timestamp, outputDir);
  } else {
    generateApiCode(mapping.pairs as ApiMappingPair[], config, timestamp, outputDir);
  }
}

function generateDbCode(pairs: DbMappingPair[], config: Config, timestamp: string, outputDir: string): void {
  const db = config.database;
  const lines: string[] = [
    `// ================================================`,
    `// Auto-generated bởi Tool API tự động`,
    `// Thời gian: ${timestamp}`,
    `// Loại: Database PostgreSQL`,
    `// ĐỪNG chỉnh sửa thủ công — chạy Bước 4 để cập nhật`,
    `// ================================================`,
    ``,
    `import { Pool } from 'pg';`,
    ``,
    `const pool = new Pool({`,
    `  host: '${db?.host ?? ''}',`,
    `  port: ${db?.port ?? 5432},`,
    `  database: '${db?.database ?? ''}',`,
    `  user: '${db?.username ?? ''}',`,
    `  password: '${db?.password ?? ''}',`,
    `  ssl: false,`,
    `});`,
    ``,
    `// ------------------------------------------------`,
    `// Queries theo từng bảng`,
    `// ------------------------------------------------`,
    ``,
  ];

  // Group by table
  const byTable = new Map<string, DbMappingPair[]>();
  for (const pair of pairs) {
    const list = byTable.get(pair.table) || [];
    list.push(pair);
    byTable.set(pair.table, list);
  }

  for (const [table, tablePairs] of byTable) {
    const funcName = 'fetch' + table.charAt(0).toUpperCase() + table.slice(1).replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    const columns = tablePairs.map(p => p.column).join(', ');
    lines.push(`/** Nhãn: ${tablePairs.map(p => `"${p.label}"`).join(', ')} */`);
    lines.push(`export async function ${funcName}() {`);
    lines.push(`  const result = await pool.query('SELECT ${columns} FROM ${table} LIMIT 1000');`);
    lines.push(`  return result.rows;`);
    lines.push(`}`);
    lines.push(``);
  }

  // Mapping comment
  lines.push(`// ------------------------------------------------`);
  lines.push(`// Bảng ánh xạ nhãn Dashboard → cột Database`);
  lines.push(`// ------------------------------------------------`);
  lines.push(``);
  lines.push(`export const LABEL_MAPPING = {`);
  for (const pair of pairs) {
    const varName = labelToVarName(pair.label);
    lines.push(`  ${varName}: { table: '${pair.table}', column: '${pair.column}' }, // "${pair.label}"`);
  }
  lines.push(`} as const;`);

  const outputPath = path.join(outputDir, 'db-client.ts');
  fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8');

  console.log('\n══════════════════════════════════════════');
  console.log('         SINH CODE DATABASE THÀNH CÔNG');
  console.log('══════════════════════════════════════════\n');
  console.log(`✅ Đã tạo: generated/db-client.ts`);
  console.log(`   Gồm ${byTable.size} hàm query + bảng ánh xạ LABEL_MAPPING\n`);
  console.log(`📋 Mapping (${pairs.length} cặp):`);
  for (const p of pairs) {
    console.log(`   "${p.label}" → ${p.table}.${p.column}`);
  }
  console.log('\n══════════════════════════════════════════\n');
}

function generateApiCode(pairs: ApiMappingPair[], config: Config, timestamp: string, outputDir: string): void {
  const byEndpoint = new Map<string, ApiMappingPair[]>();
  for (const pair of pairs) {
    const list = byEndpoint.get(pair.api_endpoint) || [];
    list.push(pair);
    byEndpoint.set(pair.api_endpoint, list);
  }

  const apiBase = config.api.url;
  const lines: string[] = [
    `// ================================================`,
    `// Auto-generated bởi Tool API tự động`,
    `// Thời gian: ${timestamp}`,
    `// ĐỪNG chỉnh sửa thủ công — chạy Bước 4 để cập nhật`,
    `// ================================================`,
    ``,
    `import React from 'react';`,
    ``,
    `const API_BASE = '${apiBase}';`,
    ``,
  ];

  for (const [endpoint, epPairs] of byEndpoint) {
    const funcName = endpointToFuncName(endpoint);
    lines.push(`export async function ${funcName}(headers: Record<string, string> = {}) {`);
    lines.push(`  const res = await fetch(\`\${API_BASE}${endpoint}\`, { headers });`);
    lines.push(`  if (!res.ok) throw new Error(\`HTTP \${res.status}\`);`);
    lines.push(`  const data = await res.json();`);
    lines.push(`  return {`);
    for (const pair of epPairs) {
      lines.push(`    ${labelToVarName(pair.label)}: data?.${pair.api_field}, // "${pair.label}"`);
    }
    lines.push(`  };`);
    lines.push(`}`);
    lines.push(``);
  }

  const funcNames = Array.from(byEndpoint.keys()).map(endpointToFuncName);
  const resultNames = funcNames.map(f => f.replace('fetch', '').charAt(0).toLowerCase() + f.replace('fetch', '').slice(1) + 'Data');
  lines.push(`export function useApiData() {`);
  lines.push(`  const [data, setData] = React.useState<Record<string, unknown>>({});`);
  lines.push(`  const [loading, setLoading] = React.useState(true);`);
  lines.push(`  const [error, setError] = React.useState<string | null>(null);`);
  lines.push(`  React.useEffect(() => {`);
  lines.push(`    Promise.all([${funcNames.map(f => `${f}()`).join(', ')}])`);
  lines.push(`      .then(([${resultNames.join(', ')}]) => setData({ ${resultNames.map(r => `...${r}`).join(', ')} }))`);
  lines.push(`      .catch(err => setError((err as Error).message))`);
  lines.push(`      .finally(() => setLoading(false));`);
  lines.push(`  }, []);`);
  lines.push(`  return { data, loading, error };`);
  lines.push(`}`);

  const outputPath = path.join(outputDir, 'api-client.ts');
  fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8');

  console.log('\n══════════════════════════════════════════');
  console.log('         SINH CODE API THÀNH CÔNG');
  console.log('══════════════════════════════════════════\n');
  console.log(`✅ Đã tạo: generated/api-client.ts`);
  console.log(`   Gồm ${byEndpoint.size} hàm fetch + React hook useApiData()\n`);
  console.log('\n══════════════════════════════════════════\n');
}
