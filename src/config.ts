import fs from 'fs';
import path from 'path';

interface AuthConfig {
  type: 'none' | 'bearer' | 'api_key' | 'basic';
  token?: string;
  api_key?: string;
  username?: string;
  password?: string;
}

interface ApiConfig {
  url: string;
  swagger_url: string;
  auth: AuthConfig;
}

interface DashboardConfig {
  source_folder: string;
}

interface SyncConfig {
  enabled: boolean;
  schedule: string;
}

interface GeminiConfig {
  api_key: string;
}

export interface Config {
  api: ApiConfig;
  dashboard: DashboardConfig;
  sync: SyncConfig;
  gemini: GeminiConfig;
  scope?: { notes?: string };
}

export function loadConfig(): Config {
  const settingsPath = path.join(process.cwd(), 'settings.json');

  if (!fs.existsSync(settingsPath)) {
    console.error('❌ Không tìm thấy file settings.json');
    console.error('   Hãy tạo file settings.json từ template và điền thông tin vào.');
    process.exit(1);
  }

  const raw = fs.readFileSync(settingsPath, 'utf-8');
  const settings = JSON.parse(raw) as Record<string, unknown>;

  // Remove comment keys before processing
  const clean = JSON.parse(
    JSON.stringify(settings, (key, value) => (key === '_ghi_chú' ? undefined : value))
  ) as Config;

  return clean;
}

export function getAuthHeaders(auth: AuthConfig): Record<string, string> {
  switch (auth.type) {
    case 'bearer':
      return { Authorization: `Bearer ${auth.token}` };
    case 'api_key':
      return { 'X-API-Key': auth.api_key || '' };
    case 'basic': {
      const credentials = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
      return { Authorization: `Basic ${credentials}` };
    }
    case 'none':
    default:
      return {};
  }
}
