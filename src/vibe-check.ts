import fs from 'fs';
import { loadConfig, getAuthHeaders } from './config.js';

interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
}

async function checkUrl(label: string, url: string, headers: Record<string, string>): Promise<CheckResult> {
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(8000) });
    const ok = res.status < 500;
    return {
      name: label,
      ok,
      message: ok
        ? `Kết nối thành công (HTTP ${res.status})`
        : `Lỗi phía server (HTTP ${res.status})`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: label,
      ok: false,
      message: `Không thể kết nối — ${msg}`,
    };
  }
}

export async function runVibeCheck(): Promise<void> {
  console.log('\n══════════════════════════════════════════');
  console.log('        KIỂM TRA KẾT NỐI HỆ THỐNG');
  console.log('══════════════════════════════════════════\n');

  const config = loadConfig();
  const authHeaders = getAuthHeaders(config.api.auth);
  const results: CheckResult[] = [];

  // 1. API Server URL
  results.push(await checkUrl('API Server', config.api.url, authHeaders));

  // 2. Swagger URL
  results.push(await checkUrl('Swagger / OpenAPI Spec', config.api.swagger_url, authHeaders));

  // 3. Anthropic API Key format
  const keyOk = config.anthropic.api_key.startsWith('sk-ant-');
  results.push({
    name: 'Anthropic API Key',
    ok: keyOk,
    message: keyOk
      ? 'Định dạng key hợp lệ (sk-ant-...)'
      : 'Key không hợp lệ — phải bắt đầu bằng sk-ant-',
  });

  // 4. Source folder exists
  const folderExists = fs.existsSync(config.dashboard.source_folder);
  results.push({
    name: 'Thư mục Dashboard',
    ok: folderExists,
    message: folderExists
      ? `Tìm thấy: ${config.dashboard.source_folder}`
      : `Không tìm thấy: ${config.dashboard.source_folder}`,
  });

  // 5. Sync toggle status
  results.push({
    name: 'Tự động đồng bộ (sync)',
    ok: true,
    message: config.sync.enabled
      ? `Đang BẬT — chạy theo lịch: ${config.sync.schedule}`
      : 'Đang TẮT — bật bằng cách đặt sync.enabled = true trong settings.json',
  });

  // Print results
  for (const r of results) {
    const icon = r.ok ? '🟢' : '🔴';
    console.log(`${icon}  ${r.name}`);
    console.log(`     ${r.message}\n`);
  }

  console.log('══════════════════════════════════════════');

  const allOk = results.filter(r => r.name !== 'Tự động đồng bộ (sync)').every(r => r.ok);
  if (allOk) {
    console.log('✅ Hệ thống sẵn sàng! Chạy "npm run map" để bắt đầu kết nối dữ liệu.');
  } else {
    const failed = results.filter(r => !r.ok).map(r => r.name);
    console.log(`⚠️  Có ${failed.length} mục cần kiểm tra lại: ${failed.join(', ')}`);
    console.log('   Mở file settings.json để cập nhật thông tin cấu hình.');
  }

  console.log('══════════════════════════════════════════\n');
}
