import Groq from 'groq-sdk';
import fs from 'fs';
import path from 'path';
import { Config, getAuthHeaders } from './config.js';
import { logError } from './logger.js';
import { backupMapping } from './diff.js';

const MAPPING_FILE = path.join(process.cwd(), 'mapping.json');
const MAX_SWAGGER_CHARS = 50_000;

interface MappingPair {
  label: string;
  api_endpoint: string;
  api_field: string;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

interface MappingFile {
  generated_at: string;
  total_pairs: number;
  pairs: Omit<MappingPair, 'confidence' | 'reasoning'>[];
}

async function fetchSwaggerSpec(url: string, headers: Record<string, string>): Promise<string> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`Swagger trả về HTTP ${res.status}`);
  }
  const text = await res.text();
  // Truncate to prevent token overflow
  if (text.length > MAX_SWAGGER_CHARS) {
    return text.slice(0, MAX_SWAGGER_CHARS) + '\n\n... [đã cắt bớt để tiết kiệm token]';
  }
  return text;
}

export async function runMapping(config: Config, labels: string[], scopeNotes?: string): Promise<void> {
  console.log('\n🤖 Đang kết nối Groq AI để phân tích...\n');

  const groq = new Groq({ apiKey: config.gemini.api_key });
  const systemInstruction = `Bạn là chuyên gia kết nối dữ liệu giữa Dashboard và API Server.
Nhiệm vụ: Phân tích Swagger/OpenAPI spec và ánh xạ từng nhãn tiếng Việt từ Dashboard sang đúng API endpoint và field tương ứng.

Quy tắc bắt buộc:
- Chỉ ánh xạ khi bạn CHẮC CHẮN (confidence: "high" hoặc "medium")
- Nếu không chắc hoặc không tìm thấy field phù hợp: đặt confidence: "low"
- Trả về JSON THUẦN TÚY, không có markdown, không có giải thích ngoài JSON

Định dạng JSON bắt buộc:
{
  "pairs": [
    {
      "label": "Nhãn tiếng Việt từ Dashboard",
      "api_endpoint": "/path/to/endpoint",
      "api_field": "field_name_in_response",
      "confidence": "high | medium | low",
      "reasoning": "Lý do ngắn gọn bằng tiếng Việt"
    }
  ]
}`;

  const authHeaders = getAuthHeaders(config.api.auth);
  const swaggerSpec = await fetchSwaggerSpec(config.api.swagger_url, authHeaders);

  const userPrompt = `Swagger/OpenAPI Spec của API Server:
${swaggerSpec}

Danh sách nhãn từ Dashboard cần ánh xạ:
${labels.map((l, i) => `${i + 1}. ${l}`).join('\n')}

Hãy ánh xạ từng nhãn trên sang API endpoint và field tương ứng trong Swagger spec. Trả về JSON thuần túy.${scopeNotes ? `\n\nGhi chú phạm vi dữ liệu (BẮT BUỘC tuân theo):\n${scopeNotes}` : ''}`;

  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
  });
  const rawText = completion.choices[0].message.content ?? '';
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  if (!jsonMatch) {
    throw new Error('Không tìm thấy JSON trong phản hồi của AI');
  }

  const parsed = JSON.parse(jsonMatch[0]) as { pairs: MappingPair[] };
  const allPairs = parsed.pairs;

  // Safety guardrail: filter out low-confidence pairs
  const confirmed: MappingPair[] = [];
  const uncertain: MappingPair[] = [];

  for (const pair of allPairs) {
    if (pair.confidence === 'low') {
      uncertain.push(pair);
      logError('MAPPER', `Bỏ qua "${pair.label}" — Độ tin cậy thấp. Lý do: ${pair.reasoning}`);
    } else {
      confirmed.push(pair);
    }
  }

  // Save mapping.json
  const mappingOutput: MappingFile = {
    generated_at: new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
    total_pairs: confirmed.length,
    pairs: confirmed.map(p => ({
      label: p.label,
      api_endpoint: p.api_endpoint,
      api_field: p.api_field,
    })),
  };

  // Backup old mapping before overwriting (for "npm run diff")
  backupMapping();
  fs.writeFileSync(MAPPING_FILE, JSON.stringify(mappingOutput, null, 2), 'utf-8');

  // Print results table
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('              KẾT QUẢ ÁNH XẠ DỮ LIỆU');
  console.log('══════════════════════════════════════════════════════════════\n');

  if (confirmed.length > 0) {
    console.log(`✅ Đã kết nối thành công ${confirmed.length} cặp dữ liệu:\n`);
    for (const p of confirmed) {
      const badge = p.confidence === 'high' ? '🟢' : '🟡';
      console.log(`  ${badge}  "${p.label}"`);
      console.log(`       → ${p.api_endpoint}  ›  ${p.api_field}\n`);
    }
  }

  if (uncertain.length > 0) {
    console.log(`⚠️  ${uncertain.length} nhãn không đủ tự tin để kết nối (đã ghi vào error.log):\n`);
    for (const p of uncertain) {
      console.log(`  🔴  "${p.label}" — ${p.reasoning}`);
    }
    console.log('');
  }

  console.log(`📄 Đã lưu mapping.json với ${confirmed.length} cặp hợp lệ.`);
  console.log('══════════════════════════════════════════════════════════════\n');
}
