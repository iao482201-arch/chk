export interface Env {
  TELEGRAM_TOKEN: string;
  MY_BUCKET: R2Bucket;
}

// === BIN RANGES (from neapay.com) ===
const BIN_RANGES: Record<string, [string, string][]> = {
  visa: [["400000", "499999"]],
  mastercard: [["222100", "272000"], ["510000", "559999"]],
  american_express: [["340000", "349999"], ["370000", "399999"]],
  diners: [["300000", "305999"], ["360000", "369999"], ["540000", "549999"]],
  discover: [["601100", "601199"], ["622126", "622925"], ["644000", "649999"], ["650000", "659999"]],
  jcb: [["352800", "358999"]],
  cup: [["620000", "629999"]]
};

// Scheme lengths
const SCHEME_LENGTHS: Record<string, number> = {
  visa: 16,
  mastercard: 16,
  american_express: 15,
  diners: 14,
  discover: 16,
  jcb: 16,
  cup: 16
};

// === SCHEME DETECTION ===
function detectScheme(bin: string): { scheme: string | null; valid: boolean } {
  const prefix = bin.padStart(6, '0').slice(0, 6);
  for (const [scheme, ranges] of Object.entries(BIN_RANGES)) {
    for (const [start, end] of ranges) {
      if (prefix >= start && prefix <= end) {
        return { scheme, valid: true };
      }
    }
  }
  return { scheme: null, valid: false };
}

// === RANDOM BIN IN RANGE ===
function randomBinInRange(scheme: string): string {
  const ranges = BIN_RANGES[scheme];
  const range = ranges[Math.floor(Math.random() * ranges.length)];
  const start = parseInt(range[0]);
  const end = parseInt(range[1]);
  let bin = start + Math.floor(Math.random() * (end - start + 1));
  return bin.toString().padStart(6, '0');
}

// === FAST LUHN (pre-computed) ===
const DOUBLE = new Uint8Array(10);
for (let i = 0; i < 10; i++) DOUBLE[i] = i * 2 > 9 ? i * 2 - 9 : i * 2;

function luhnChecksum(digits: Uint8Array): number {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits[i];
    if (alt) d = DOUBLE[d];
    sum += d;
    alt = !alt;
  }
  return (10 - (sum % 10)) % 10;
}

// === BATCH GENERATOR (scheme-aware length) ===
function generateBatch(bin: string, count: number, length: number): Uint8Array[] {
  const binBytes = bin.split('').map(Number);
  const prefixLen = binBytes.length;
  const fillLen = length - prefixLen - 1; // -1 for checksum
  const cards: Uint8Array[] = [];
  const rnd = new Uint8Array(fillLen);

  for (let i = 0; i < count; i++) {
    crypto.getRandomValues(rnd);
    const card = new Uint8Array(length);
    card.set(binBytes, 0);
    card.set(rnd, prefixLen);
    card[length - 1] = luhnChecksum(card);
    cards.push(card);
  }
  return cards;
}

function formatCard(card: Uint8Array, scheme: string): string {
  const s = Array.from(card).map(d => d.toString()).join('');
  const cvvLen = scheme === 'american_express' ? 4 : 3;
  const cvv = Math.floor(100 + Math.random() * 900).toString().padStart(cvvLen, '0');
  const exp = '12/29';
  return `${s.slice(0,4)} ${s.slice(4,8)} ${s.slice(8,12)} ${s.slice(12)} | ${exp} | ${cvv}`;
}

// === BIN LOOKUP (enhanced with ranges) ===
interface BinInfo {
  length: number;
  scheme: string;
  bank?: string;
  country?: string;
  suggested?: string;
}
async function lookupBin(bin: string): Promise<BinInfo | null> {
  const { scheme: detectedScheme, valid } = detectScheme(bin);
  if (!valid && !detectedScheme) return null;

  try {
    const res = await fetch(`https://binlist.io/lookup/${bin}/`, {
      headers: { 'User-Agent': 'CCGen/1' }
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    if (!data.success && !data.guess) return null;

    const length = data.number?.length ?? SCHEME_LENGTHS[detectedScheme ?? 'visa'];
    return {
      length,
      scheme: data.scheme ?? detectedScheme ?? 'visa',
      bank: data.bank?.name,
      country: data.country?.emoji + ' ' + data.country?.name,
      suggested: valid ? undefined : randomBinInRange(detectedScheme!)
    };
  } catch {
    // Fallback to range-based
    return {
      length: SCHEME_LENGTHS[detectedScheme!],
      scheme: detectedScheme!,
      suggested: valid ? undefined : randomBinInRange(detectedScheme!)
    };
  }
}

function formatBinInfo(info: BinInfo | null, bin: string): string {
  if (!info) return `*BIN:* \`${bin}\` (Invalid range. Use /start for schemes.)`;
  const { scheme, length, bank, country, suggested } = info;
  let msg = `
*BIN Lookup* (${scheme.toUpperCase()})

**BIN:** \`${bin}\`
**Length:** ${length}
**Scheme:** ${scheme.toUpperCase()}
**Bank:** ${bank ?? '—'}
**Country:** ${country ?? '—'}
  `.trim();
  if (suggested) msg += `\n\n*Tip:* Using suggested BIN: \`${suggested}\``;
  return msg;
}

// === TELEGRAM HELPERS ===
async function tgSend(chatId: number, text: string, env: Env, md = true) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: md ? 'Markdown' : undefined
    })
  });
}

async function tgSendFile(chatId: number, url: string, filename: string, env: Env) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendDocument`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      document: url,
      caption: `*${filename}* (${filename.split('_')[0].toUpperCase()})`,
      parse_mode: 'Markdown'
    })
  });
}

// === RATE LIMIT ===
const RATE = new Map<number, number>();
const TTL = 15_000;
setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of RATE.entries()) if (now - ts > TTL) RATE.delete(id);
}, 30_000);

// === MAIN WORKER ===
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ---------- WEBHOOK ----------
    if (url.pathname === '/webhook' && request.method === 'POST') {
      const upd: any = await request.json();
      const msg = upd.message;
      if (!msg?.text || !msg.from) return new Response('OK');

      const chatId = msg.chat.id;
      const userId = msg.from.id;
      const text = msg.text.trim();

      // Rate limit
      const now = Date.now();
      const last = RATE.get(userId);
      if (last && now - last < 12_000) {
        await tgSend(chatId, 'Please wait 12 seconds.', env, false);
        return new Response('OK');
      }
      RATE.set(userId, now);

      // ----- /start -----
      if (text === '/start') {
        const schemes = Object.keys(BIN_RANGES).map(s => `• ${s.toUpperCase()}: ${BIN_RANGES[s].map(r => r[0] + '–' + r[1]).join(', ')}`).join('\n');
        await tgSend(chatId, `
*Accurate CC Generator* (Ranges from neapay.com)

Supported Schemes:\n${schemes}

*/bin 515462* → Lookup + 10 cards (validates range)
*/gen 515462 50000* → Generate (auto-fixes invalid BIN)

< 20 cards → message | ≥ 20 → R2 file

*Test cards only – for dev/education.*
        `, env);
        return new Response('OK');
      }

      // ----- /bin -----
      if (text.startsWith('/bin')) {
        let bin = text.split(' ')[1]?.replace(/\D/g, '');
        if (!bin || bin.length < 6) {
          await tgSend(chatId, 'Usage: `/bin 515462` (6+ digits)', env);
          return new Response('OK');
        }
        bin = bin.slice(0, 6); // Use first 6 for lookup

        const info = await lookupBin(bin);
        if (!info) {
          await tgSend(chatId, `❌ Invalid BIN range for \`${bin}\`. See /start.`, env);
          return new Response('OK');
        }

        const useBin = info.suggested || bin;
        const cards = generateBatch(useBin, 10, info.length);
        const lines = cards.map(c => formatCard(c, info.scheme));

        const msgText = `${formatBinInfo(info, bin)}\n\n*10 Test Cards*\n\`\`\`\n${lines.join('\n')}\n\`\`\``;

        if (lines.length < 20 && msgText.length <= 4000) {
          await tgSend(chatId, msgText, env);
        } else {
          const fileKey = `gen/${Date.now()}_${useBin}_10.txt`;
          const stream = new ReadableStream({
            start(ctrl) {
              lines.forEach(l => ctrl.enqueue(new TextEncoder().encode(l + '\n')));
              ctrl.close();
            }
          });
          await env.MY_BUCKET.put(fileKey, stream);
          const fileUrl = `${url.origin}/${fileKey}`;
          await tgSendFile(chatId, fileUrl, `${useBin}_10.txt`, env);
          await tgSend(chatId, formatBinInfo(info, bin), env);
        }
        return new Response('OK');
      }

      // ----- /gen -----
      if (text.startsWith('/gen')) {
        let bin = text.split(' ')[1]?.replace(/\D/g, '');
        const raw = parseInt(text.split(' ')[2]) || 10;
        const count = Math.min(raw, 50_000);

        if (!bin || bin.length < 6 || count < 1) {
          await tgSend(chatId, 'Usage: `/gen 515462 50000` (max 50k)', env);
          return new Response('OK');
        }
        bin = bin.slice(0, 6);

        const { scheme: detectedScheme, valid } = detectScheme(bin);
        if (!detectedScheme) {
          await tgSend(chatId, `❌ Invalid BIN range for \`${bin}\`. See /start.`, env);
          return new Response('OK');
        }

        const useBin = valid ? bin : randomBinInRange(detectedScheme);
        const length = SCHEME_LENGTHS[detectedScheme];

        await tgSend(chatId, `Generating *${count.toLocaleString()}* ${detectedScheme.toUpperCase()} cards (BIN: ${useBin})…`, env);

        // Stream to R2
        const fileKey = `gen/${Date.now()}_${useBin}_${count}.txt`;
        const stream = new ReadableStream({
          async start(ctrl) {
            const batchSize = 5_000;
            for (let offset = 0; offset < count; offset += batchSize) {
              const take = Math.min(batchSize, count - offset);
              const batch = generateBatch(useBin, take, length);
              for (const card of batch) {
                ctrl.enqueue(new TextEncoder().encode(formatCard(card, detectedScheme) + '\n'));
              }
              await new Promise(r => setTimeout(r, 0));
            }
            ctrl.close();
          }
        });

        await env.MY_BUCKET.put(fileKey, stream, {
          httpMetadata: { contentType: 'text/plain' }
        });

        const fileUrl = `${url.origin}/${fileKey}`;

        if (count < 20) {
          const sample = generateBatch(useBin, count, length).map(c => formatCard(c, detectedScheme)).join('\n');
          await tgSend(chatId, `*${count} Test Cards*\n\`\`\`\n${sample}\n\`\`\`\n[Full](${fileUrl})`, env);
        } else {
          await tgSendFile(chatId, fileUrl, `${useBin}_${count}.txt`, env);
          await tgSend(chatId, `✅ File ready: [${useBin}_${count}.txt](${fileUrl}) (${detectedScheme.toUpperCase()})`, env);
        }
        return new Response('OK');
      }

      return new Response('OK');
    }

    // ---------- SERVE R2 ----------
    if (url.pathname.startsWith('/gen/')) {
      const obj = await env.MY_BUCKET.get(url.pathname.slice(1));
      if (!obj) return new Response('Not found', { status: 404 });
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Cache-Control', 'public, max-age=31536000');
      return new Response(obj.body, { headers });
    }

    return new Response('Accurate CC Gen Bot + Ranges + R2');
  }
};
