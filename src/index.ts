import cron from 'node-cron';
import { runVibeCheck } from './vibe-check.js';
import { scanDashboard } from './scanner.js';
import { runMapping } from './mapper.js';
import { runGenerate } from './generator.js';
import { runValidate } from './validator.js';
import { runDiff } from './diff.js';
import { checkDbConnection, runDbMapping } from './db-mapper.js';
import { loadConfig } from './config.js';

const command = process.argv[2];

async function runMap(): Promise<void> {
  const config = loadConfig();

  console.log('\n📂 Đang quét thư mục Dashboard...');
  const scanResult = scanDashboard(config.dashboard.source_folder);

  if (scanResult.labels.length === 0) {
    console.log('⚠️  Không tìm thấy nhãn tiếng Việt nào trong thư mục:');
    console.log(`   ${config.dashboard.source_folder}`);
    console.log('   Kiểm tra lại đường dẫn trong settings.json → dashboard.source_folder\n');
    return;
  }

  console.log(`✅ Đã quét ${scanResult.fileCount} file — tìm thấy ${scanResult.labels.length} nhãn tiếng Việt.\n`);
  console.log('📋 Danh sách nhãn sẽ được kết nối:');
  scanResult.labels.forEach((label, i) => {
    console.log(`   ${String(i + 1).padStart(2, ' ')}. ${label}`);
  });
  console.log('');

  await runMapping(config, scanResult.labels);
}

async function runSync(): Promise<void> {
  const config = loadConfig();

  if (!config.sync.enabled) {
    console.log('\n⏸️  Sync đang TẮT. Bật lên bằng cách đặt sync.enabled = true trong settings.json\n');
    return;
  }

  console.log('\n🔄 Sync đang chạy...');
  await runMap();
}

async function runSchedule(): Promise<void> {
  const config = loadConfig();
  const schedule = config.sync.schedule || '59 23 * * *';

  if (!cron.validate(schedule)) {
    console.error(`❌ Lịch chạy không hợp lệ: "${schedule}"`);
    console.error('   Định dạng đúng ví dụ: "59 23 * * *" (23:59 mỗi ngày)');
    process.exit(1);
  }

  console.log('\n🕐 Đã khởi động lịch tự động đồng bộ.');
  console.log(`   Lịch chạy: ${schedule}`);
  console.log('   (Giữ cửa sổ này mở để lịch hoạt động. Nhấn Ctrl+C để dừng.)\n');

  cron.schedule(schedule, async () => {
    console.log(`\n⏰ [${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}] Đang chạy sync tự động...`);
    await runSync();
  }, {
    timezone: 'Asia/Ho_Chi_Minh',
  });
}

function printHelp(): void {
  console.log(`
╔══════════════════════════════════════════╗
║       TOOL API TỰ ĐỘNG — Hướng dẫn      ║
╚══════════════════════════════════════════╝

  npm run vibe-check   Kiểm tra kết nối hệ thống
  npm run map          Quét Dashboard và kết nối dữ liệu với AI
  npm run validate     Kiểm tra từng kết nối có thực sự hoạt động không
  npm run generate     Sinh code API tự động → copy vào Dashboard dùng ngay
  npm run diff         So sánh mapping cũ vs mới, xem có gì thay đổi
  npm run sync         Đồng bộ thủ công (nếu sync.enabled = true)
  npm run schedule     Bật lịch tự động chạy mỗi ngày lúc 23:59

Quy trình chuẩn:
  1. Điền thông tin vào settings.json
  2. npm run vibe-check    → kiểm tra kết nối
  3. npm run map           → AI mapping tự động
  4. npm run validate      → xác nhận kết nối thật sự hoạt động
  5. npm run generate      → lấy code → paste vào Dashboard
`);
}

(async () => {
  try {
    switch (command) {
      case 'vibe-check':
        await runVibeCheck();
        break;
      case 'map':
        await runMap();
        break;
      case 'sync':
        await runSync();
        break;
      case 'validate': {
        const config = loadConfig();
        await runValidate(config);
        break;
      }
      case 'generate': {
        const config = loadConfig();
        runGenerate(config);
        break;
      }
      case 'diff':
        runDiff();
        break;
      case 'map-db': {
        const config = loadConfig();
        const db = (config as unknown as { database: { host: string; port: number; database: string; username: string; password: string } }).database;
        const scan = scanDashboard(config.dashboard.source_folder);
        if (scan.labels.length === 0) { console.log('⚠️  Không tìm thấy nhãn tiếng Việt.'); break; }
        console.log(`📂 Đã quét ${scan.fileCount} file — ${scan.labels.length} nhãn.`);
        await runDbMapping(db, config.anthropic.api_key, scan.labels);
        break;
      }
      case 'schedule':
        await runSchedule();
        break;
      default:
        printHelp();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Lỗi: ${msg}\n`);
    process.exit(1);
  }
})();
