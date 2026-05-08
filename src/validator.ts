import fs from 'fs';
import path from 'path';
import { Config, getAuthHeaders } from './config.js';
import { logError } from './logger.js';

interface MappingPair {
  label: string;
  api_endpoint: string;
  api_field: string;
}

interface MappingFile {
  generated_at: string;
  pairs: MappingPair[];
}

function getNestedValue(obj: unknown, fieldPath: string): unknown {
  return fieldPath.split('.').reduce<unknown>((current, key) => {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, obj);
}

export async function runValidate(config: Config): Promise<void> {
  const mappingPath = path.join(process.cwd(), 'mapping.json');

  if (!fs.existsSync(mappingPath)) {
    console.log('\n❌ Chưa có mapping.json — hãy chạy "npm run map" trước.\n');
    return;
  }

  const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8')) as MappingFile;

  if (mapping.pairs.length === 0) {
    console.log('\n⚠️  mapping.json không có cặp nào để kiểm tra.\n');
    return;
  }

  const authHeaders = getAuthHeaders(config.api.auth);
  const endpointCache = new Map<string, unknown>();

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('              KIỂM TRA THỰC TẾ CÁC KẾT NỐI');
  console.log('══════════════════════════════════════════════════════════════\n');
  console.log(`Đang kiểm tra ${mapping.pairs.length} cặp dữ liệu...\n`);

  let passed = 0;
  let failed = 0;
  let endpointDown = 0;

  for (const pair of mapping.pairs) {
    const url = `${config.api.url}${pair.api_endpoint}`;

    // Fetch + cache per endpoint to avoid duplicate calls
    if (!endpointCache.has(pair.api_endpoint)) {
      try {
        const res = await fetch(url, {
          headers: authHeaders,
          signal: AbortSignal.timeout(8000),
        });

        if (res.ok) {
          const data = await res.json() as unknown;
          endpointCache.set(pair.api_endpoint, data);
        } else {
          endpointCache.set(pair.api_endpoint, `HTTP_ERROR:${res.status}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        endpointCache.set(pair.api_endpoint, `CONNECT_ERROR:${msg}`);
      }
    }

    const cached = endpointCache.get(pair.api_endpoint);

    // Endpoint unreachable
    if (typeof cached === 'string' && cached.startsWith('HTTP_ERROR:')) {
      const status = cached.replace('HTTP_ERROR:', '');
      console.log(`🔴 "${pair.label}"`);
      console.log(`     Endpoint lỗi HTTP ${status}: ${pair.api_endpoint}\n`);
      logError('VALIDATE', `"${pair.label}" — Endpoint ${pair.api_endpoint} lỗi HTTP ${status}`);
      failed++;
      endpointDown++;
      continue;
    }

    if (typeof cached === 'string' && cached.startsWith('CONNECT_ERROR:')) {
      const msg = cached.replace('CONNECT_ERROR:', '');
      console.log(`🔴 "${pair.label}"`);
      console.log(`     Không thể kết nối tới: ${pair.api_endpoint} — ${msg}\n`);
      logError('VALIDATE', `"${pair.label}" — Không kết nối được ${pair.api_endpoint}: ${msg}`);
      failed++;
      endpointDown++;
      continue;
    }

    // Field check
    const fieldValue = getNestedValue(cached, pair.api_field);

    if (fieldValue !== undefined) {
      const preview = JSON.stringify(fieldValue);
      const displayValue = preview.length > 50 ? preview.slice(0, 50) + '...' : preview;
      console.log(`🟢 "${pair.label}"`);
      console.log(`     ${pair.api_endpoint} › ${pair.api_field} = ${displayValue}\n`);
      passed++;
    } else {
      console.log(`🟡 "${pair.label}"`);
      console.log(`     Field "${pair.api_field}" không tồn tại trong response của ${pair.api_endpoint}`);
      console.log(`     → API có thể đã đổi tên field. Chạy "npm run map" để cập nhật.\n`);
      logError('VALIDATE', `"${pair.label}" — Field "${pair.api_field}" không tìm thấy tại ${pair.api_endpoint}`);
      failed++;
    }
  }

  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  🟢 Hợp lệ: ${passed}   🔴 Có vấn đề: ${failed}`);

  if (failed > 0 && endpointDown > 0) {
    console.log(`  ⚠️  ${endpointDown} endpoint không phản hồi — kiểm tra kết nối mạng hoặc API Server.`);
  }
  if (failed > 0 && endpointDown < failed) {
    console.log(`  💡 Một số field không khớp — chạy "npm run map" để cập nhật lại mapping.`);
  }
  if (failed === 0) {
    console.log(`  ✅ Tất cả kết nối đều hoạt động tốt!`);
  }

  console.log('══════════════════════════════════════════════════════════════\n');
}
