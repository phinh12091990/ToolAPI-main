import fs from 'fs';
import path from 'path';

const SUPPORTED_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.vue'];

// Matches Vietnamese characters (including diacritics)
const VIETNAMESE_PATTERN = /[À-ɏẠ-ỿ]/;

// Matches string content inside JSX attributes, template literals, and regular strings
const STRING_PATTERNS = [
  /"([^"\\]{3,})"/g,        // double-quoted strings (min 3 chars)
  /'([^'\\]{3,})'/g,        // single-quoted strings
  /`([^`\\]{3,})`/g,        // template literals
  />([^<>{}\n]{3,})</g,     // JSX text content between tags
];

const MAX_LABEL_LENGTH = 40;
// Exclude sentences (có dấu chấm/phẩy/chấm hỏi cuối) và các ký tự đặc biệt
const EXCLUDE_PATTERN = /[.!?,:;]$|^\d+$|https?:\/\/|className|import |export |console\.|function |return |const |let |var /;

function extractVietnameseLabels(content: string): string[] {
  const labels = new Set<string>();

  for (const pattern of STRING_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const text = match[1].trim();
      if (
        VIETNAMESE_PATTERN.test(text) &&
        text.length >= 3 &&
        text.length <= MAX_LABEL_LENGTH &&
        !EXCLUDE_PATTERN.test(text)
      ) {
        labels.add(text);
      }
    }
  }

  return Array.from(labels);
}

function walkDirectory(dir: string): string[] {
  const files: string[] = [];

  if (!fs.existsSync(dir)) {
    return files;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!['node_modules', '.git', 'dist', '.next', 'build'].includes(entry.name)) {
        files.push(...walkDirectory(fullPath));
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SUPPORTED_EXTENSIONS.includes(ext)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

export interface ScanResult {
  labels: string[];
  fileCount: number;
  filePaths: string[];
}

export function scanDashboard(sourceFolder: string): ScanResult {
  const files = walkDirectory(sourceFolder);
  const allLabels = new Set<string>();

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const labels = extractVietnameseLabels(content);
    labels.forEach(l => allLabels.add(l));
  }

  return {
    labels: Array.from(allLabels).sort(),
    fileCount: files.length,
    filePaths: files,
  };
}
