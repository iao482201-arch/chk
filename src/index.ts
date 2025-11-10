export interface Env {
  TELEGRAM_TOKEN: string;
  MY_BUCKET: R2Bucket;
}

// === BIN RANGES (neapay.com) ===
const BIN_RANGES: Record<string, [string, string][]> = {
  visa: [["400000", "499999"]],
  mastercard: [["222100", "272000"], ["510000", "559999"]],
  american_express: [["340000", "349999"], ["370000", "399999"]],
  diners: [["300000", "305999"], ["360000", "369999"], ["540000", "549999"]],
  discover: [["601100", "601199"], ["622126", "622925"], ["644000", "649999"], ["650000", "659999"]],
  jcb: [["352800", "358999"]],
  cup: [["620000", "629999"]]
};

const SCHEME_LENGTHS: Record<string, number> = {
  visa: 16,
  mastercard: 16,
  american_express: 15,
  diners: 14,
  discover: 16,
  jcb: 16,
  cup: 16
};

// === LUHN (pre-computed) ===
const DOUBLE = Uint8Array.from({ length: 10 }, (_, i) => (i * 2 > 9 ? i * 2 - 9 : i * 2));

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

// === BATCH GENERATOR ===
function generateBatch(bin: string, count: number, length: number): string[] {
  const binDigits = bin.split('').map(Number);
  const prefixLen = binDigits.length;
  const fillLen = length - prefixLen - 1;
  const cards: string[] = [];
  const rnd = new Uint8Array(fillLen);

  for (let i = 0; i < count; i++) {
    crypto.getRandomValues(rnd);
    const card = new Uint8Array(length);
    card.set(binDigits, 0);
    card.set(rnd, prefixLen);
    card[length - 1] = luhnChecksum(card);
    cards.push(Array.from(card).join(''));
  }
  return cards;
}

function formatCard(num: string, scheme: string): string {
  const cvvLen = scheme === 'american_express' ? 4 : 3;
  const cvv = Math.floor(100 + Math.random() * 900).toString().padStart(cvvLen, '0');
  return `${num.slice(0,4)} ${num.slice(4,8)} ${num.slice(8,12)} ${num.slice(12)} | 12/29 | ${cvv}`;
}

// === SCHEME DETECTION ===
function detectScheme(bin6: string): { scheme: string | null; valid: boolean } {
  for (const [scheme, ranges] of Object.entries(BIN_RANGES)) {
    for (const [start, end] of ranges) {
      if (bin6 >= start && bin6 <= end) {
        return { scheme, valid: true };
      }
    }
  }
  return { scheme: null, valid: false };
}

function randomBin(scheme: string): string {
  const ranges = BIN_RANGES[scheme];
  const [start, end] = ranges[Math.floor(Math.random() * ranges.length)];
  const n = parseInt(start) + Math.floor(Math.random() * (parseInt(end) - parseInt(start) + 1));
  return n.toString().padStart(6, '0');
}

// === BIN LOOKUP (fallback to ranges) ===
async function lookupBin(bin6: string): Promise<{
  scheme: string;
  length: number;
  bank?: string;
  country?: string;
  suggested?: string;
} | null> {
  const { scheme: detected, valid } = detectScheme(bin6);
  if (!detected) return null;

  try {
    const res = await fetch(`https://binlist.io/lookup/${bin6}/`, {
      headers: { 'User-Agent': 'CCGenBot/1' }
    });
    if (!res.ok) throw 0;
    const data: any = await res.json();
    if (!data.success && !data.guess) throw 0;

    return {
      scheme: data.scheme?.toLowerCase() ?? detected,
      length: data.number?.length ?? SCHEME_LENGTHS[detected],
      bank: data.bank?.name,
      country: data.country?.emoji + ' ' + data.country?.name,
      suggested: valid ? undefined : randomBin(detected)
    };
  } catch {
    return {
      scheme: detected,
      length: SCHEME_LENGTHS[detected],
      suggested: valid ? undefined : randomBin(detected)
    };
  }
}

function formatBinInfo(info: any, bin: string): string {
  const { scheme, length, bank, country, suggested } = info;
  let msg = `
*BIN Lookup* (${scheme.toUpperCase()})

**BIN:** \`${bin}\`
**Length:** ${length}
**Scheme:** ${scheme.toUpperCase()}
**Bank:** ${bank ?? '—'}
**Country:** ${country ?? '—'}
  `.trim();
  if (suggested) msg += `\n\n*Using suggested BIN:* \`${suggested}\``;
  return msg;
}

// === TELEGRAM ===
async function tgSend(chatId: number, text: string, env: Env, md = true) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: md ? 'Markdown' : undefined })
  });
}

async function tgSendFile(chatId: number, url: string, filename: string, env: Env) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendDocument`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      document: url,
      caption: `*${filename}*`,
      parse_mode: 'Markdown'
    })
  });
}

// === RATE LIMIT (per request) ===
const RATE_LIMIT = new Map<number, number>();

// === MAIN HANDLER ===
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // === SERVE R2 FILES ===
    if (url.pathname.startsWith('/gen/')) {
      const obj = await env.MY_BUCKET.get(url.pathname.slice(1));
      if (!obj) return new Response('Not found', { status: 404 });
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Cache-Control', 'public, max-age=31536000');
      return new Response(obj.body, { headers });
    }

    // === WEBHOOK ===
    if (url.pathname === '/webhook' && request.method === 'POST') {
      const upd: any = await request.json();
      const msg = upd.message;
      if (!msg?.text || !msg.from) return new Response('OK');

      const chatId = msg.chat.id;
      const userId = msg.from.id;
      const text = msg.text.trim();

      // Rate limit
      const now = Date.now();
      const last = RATE_LIMIT.get(userId);
      if (last && now - last < 12_000) {
        await tgSend(chatId, 'Please wait 12 seconds.', env, false);
        return new Response('OK');
      }
      RATE_LIMIT.set(userId, now);

      // /start
      if (text === '/start') {
        const ranges = Object.entries(BIN_RANGES)
          .map(([s, r]) => `• *${s.toUpperCase()}:* ${r.map(([a,b])=>`\`${a}\`–\`${b}\``).join(', ')}`)
          .join('\n');
        await tgSend(chatId, `
*Accurate CC Generator*

${ranges}

*/bin 515462* → 10 test cards
*/gen 515462 50000* → up to 50k cards

< 20 → message | ≥ 20 → file
*Test cards only.*
        `, env);
        return new Response('OK');
      }

      // /bin
      if (text.startsWith('/bin')) {
        let bin = text.split(' ')[1]?.replace(/\D/g, '');
        if (!bin || bin.length < 6) {
          await tgSend(chatId, 'Usage: `/bin 515462`', env);
          return new Response('OK');
        }
        bin = bin.slice(0, 6);

        const info = await lookupBin(bin);
        if (!info) {
          await tgSend(chatId, `Invalid BIN \`${bin}\`. See /start.`, env);
          return new Response('OK');
        }

        const useBin = info.suggested || bin;
        const cards = generateBatch(useBin, 10, info.length);
        const lines = cards.map(c => formatCard(c, info.scheme));

        const fullMsg = `${formatBinInfo(info, bin)}\n\n*10 Cards*\n\`\`\`\n${lines.join('\n')}\n\`\`\``;

        if (lines.length < 20 && fullMsg.length <= 4000) {
          await tgSend(chatId, fullMsg, env);
        } else {
          const key = `gen/${Date.now()}_${useBin}_10.txt`;
          const stream = new ReadableStream({
            start(ctrl) {
              for (const line of lines) {
                ctrl.enqueue(new TextEncoder().encode(line + '\n'));
              }
              ctrl.close();
            }
          });
          await env.MY_BUCKET.put(key, stream);
          const fileUrl = `${url.origin}/${key}`;
          await tgSendFile(chatId, fileUrl, `${useBin}_10.txt`, env);
          await tgSend(chatId, formatBinInfo(info, bin), env);
        }
        return new Response('OK');
      }

      // /gen
      if (text.startsWith('/gen')) {
        const parts = text.split(' ').slice(1);
        let bin = parts[0]?.replace(/\D/g, '');
        const count = Math.min(parseInt(parts[1]) || 10, 50_000);

        if (!bin || bin.length < 6) {
          await tgSend(chatId, 'Usage: `/gen 515462 50000`', env);
          return new Response('OK');
        }
        bin = bin.slice(0, 6);

        const { scheme: detected, valid } = detectScheme(bin);
        if (!detected) {
          await tgSend(chatId, `Invalid BIN \`${bin}\`. See /start.`, env);
          return new Response('OK');
        }

        const useBin = valid ? bin : randomBin(detected);
        const length = SCHEME_LENGTHS[detected];

        await tgSend(chatId, `Generating *${count.toLocaleString()}* ${detected.toUpperCase()} cards…`, env);

        const key = `gen/${Date.now()}_${useBin}_${count}.txt`;
        const stream = new ReadableStream({
          async start(ctrl) {
            const batchSize = 5_000;
            for (let i = 0; i < count; i += batchSize) {
              const take = Math.min(batchSize, count - i);
              const batch = generateBatch(useBin, take, length);
              for (const card of batch) {
                ctrl.enqueue(new TextEncoder().encode(formatCard(card, detected) + '\n'));
              }
              await new Promise(r => setTimeout(r, 0)); // yield
            }
            ctrl.close();
          }
        });

        await env.MY_BUCKET.put(key, stream, { httpMetadata: { contentType: 'text/plain' } });
        const fileUrl = `${url.origin}/${key}`;

        if (count < 20) {
          const sample = generateBatch(useBin, count, length).map(c => formatCard(c, detected)).join('\n');
          await tgSend(chatId, `*${count} Cards*\n\`\`\`\n${sample}\n\`\`\`\n[Full](${fileUrl})`, env);
        } else {
          await tgSendFile(chatId, fileUrl, `${useBin}_${count}.txt`, env);
          await tgSend(chatId, `File ready: [${useBin}_${count}.txt](${fileUrl})`, env);
        }

        return new Response('OK');
      }

      return new Response('OK');
    }

    return new Response('CC Gen Bot + R2 + Accurate BINs');
  }
};
