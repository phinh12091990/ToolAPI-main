import fs from 'fs';
import path from 'path';

const LOG_FILE = path.join(process.cwd(), 'error.log');

function getVietnamTimestamp(): string {
  return new Date().toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function logError(context: string, message: string): void {
  const timestamp = getVietnamTimestamp();
  const entry = `[${timestamp}] [${context}] ${message}\n`;
  fs.appendFileSync(LOG_FILE, entry, 'utf-8');
}

export function clearLog(): void {
  fs.writeFileSync(LOG_FILE, '', 'utf-8');
}
