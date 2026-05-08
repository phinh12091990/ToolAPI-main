import fs from 'fs';
import path from 'path';

export type DataSourceType = 'supabase' | 'fetch' | 'mock' | 'unknown';

export interface DataFile {
  relativePath: string;
  content: string;
}

export interface DashboardAnalysis {
  type: DataSourceType;
  supabaseTables: string[];
  fetchEndpoints: string[];
  dataFiles: DataFile[]; // files chứa data fetching logic
}

const SUPPORTED_EXT = ['.ts', '.tsx', '.js', '.jsx', '.vue'];
const SKIP_DIRS = ['node_modules', '.git', 'dist', '.next', 'build', 'generated', 'public'];
const MAX_FILE_CHARS = 60_000;

function walkDir(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.includes(entry.name)) files.push(...walkDir(fullPath));
    } else if (SUPPORTED_EXT.includes(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
  return files;
}

function extractSupabaseTables(content: string): string[] {
  const tables: string[] = [];
  const pattern = /supabase\.from\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    if (!tables.includes(match[1])) tables.push(match[1]);
  }
  return tables;
}

function extractFetchEndpoints(content: string): string[] {
  const endpoints: string[] = [];
  const patterns = [
    /fetch\(\s*["'`]([^"'`\${}]+)["'`]/g,
    /axios\.\w+\(\s*["'`]([^"'`\${}]+)["'`]/g,
  ];
  for (const pat of patterns) {
    let match;
    while ((match = pat.exec(content)) !== null) {
      const ep = match[1];
      if ((ep.startsWith('/') || ep.startsWith('http')) && !endpoints.includes(ep)) {
        endpoints.push(ep);
      }
    }
  }
  return endpoints;
}

export function analyzeDashboard(sourceFolder: string): DashboardAnalysis {
  const files = walkDir(sourceFolder);
  const supabaseTables: string[] = [];
  const fetchEndpoints: string[] = [];
  const dataFiles: DataFile[] = [];
  let type: DataSourceType = 'unknown';

  for (const filePath of files) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    if (content.length > MAX_FILE_CHARS) continue;

    const relativePath = path.relative(sourceFolder, filePath).replace(/\\/g, '/');

    const hasSupabase = content.includes('supabase.from(') || content.includes('supabase.from (');
    const hasFetch = /fetch\(\s*["'`]/.test(content) || /axios\.\w+\(/.test(content);
    const hasMockImport = /(import|from).*mock[-_]?data/i.test(content) || /MOCK_[A-Z]/.test(content);

    if (hasSupabase) {
      type = 'supabase';
      const tables = extractSupabaseTables(content);
      tables.forEach(t => { if (!supabaseTables.includes(t)) supabaseTables.push(t); });
      if (tables.length > 0) dataFiles.push({ relativePath, content });
    } else if (hasFetch && type !== 'supabase') {
      type = 'fetch';
      const endpoints = extractFetchEndpoints(content);
      endpoints.forEach(e => { if (!fetchEndpoints.includes(e)) fetchEndpoints.push(e); });
      if (endpoints.length > 0) dataFiles.push({ relativePath, content });
    } else if (hasMockImport && type === 'unknown') {
      type = 'mock';
      dataFiles.push({ relativePath, content });
    }
  }

  if (type === 'unknown') type = 'mock';

  // Giới hạn số file gửi cho AI (tránh quá token)
  const topFiles = dataFiles.slice(0, 4);

  console.log(`\n📊 Phát hiện: ${type.toUpperCase()}`);
  if (supabaseTables.length) console.log(`   Supabase tables: ${supabaseTables.join(', ')}`);
  if (fetchEndpoints.length) console.log(`   API endpoints: ${fetchEndpoints.join(', ')}`);
  console.log(`   Data files: ${topFiles.map(f => f.relativePath).join(', ')}`);

  return { type, supabaseTables, fetchEndpoints, dataFiles: topFiles };
}
