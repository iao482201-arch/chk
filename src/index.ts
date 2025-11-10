import { sendMessage, editMessage, answerCallback } from "./telegram";

interface Env {
  TELEGRAM_TOKEN: string;
  MOCK_GATEWAY: string;
  BIN_API: string;
  RATE_KV?: KVNamespace;
}

// ———————————————————————— BIN Ranges ————————————————————————
const BIN_RANGES = {
  visa: [
    { start: 400000, end: 499999 }
  ],
  mastercard: [
    { start: 222100, end: 272099 },
    { start: 510000, end: 559999 }
  ],
  amex: [
    { start: 340000, end: 349999 },
    { start: 370000, end: 379999 }
  ],
  discover: [
    { start: 601100, end: 601199 },
    { start: 644000, end: 659999 }
  ],
  jcb: [
    { start: 352800, end: 358999 }
  ],
  diners: [
    { start: 300000, end: 305999 },
    { start: 360000, end: 369999 },
    { start: 380000, end: 399999 }
  ],
  cup: [
    { start: 620000, end: 629999 }
  ]
};

// ———————————————————————— Luhn Algorithm ————————————————————————
function luhnGenerate(prefix: string, length: number): string {
  let number = prefix;
  while (number.length < length - 1) {
    number += Math.floor(Math.random() * 10);
  }
  let sum = 0;
  let alternate = true;
  for (let i = number.length - 1; i >= 0; i--) {
    let digit = parseInt(number[i]);
    if (alternate) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    alternate = !alternate;
  }
  const check = (10 - (sum % 10)) % 10;
  return number + check;
}

function isValidBin(bin: string): boolean {
  const binNum = parseInt(bin);
  for (const network of Object.values(BIN_RANGES)) {
    for (const range of network) {
      if (binNum >= range.start && binNum <= range.end) {
        return true;
      }
    }
  }
  return false;
}

// ———————————————————————— BIN Lookup ————————————————————————
interface BinData {
  number: { iin: string; length: number; luhn: boolean };
  scheme: string;
  type: string;
  category: string;
  bank: { name?: string; phone?: string; url?: string };
  country: { name: string; emoji: string };
}

async function getBinInfo(bin: string): Promise<string> {
  try {
    const res = await fetch(`https://binlist.io/lookup/${bin}/`);
    if (!res.ok) return "❌ BIN lookup failed";
    const data: BinData = await res.json();

    return (
      `<b>BIN:</b> <code>${bin}</code>\n` +
      `<b>Scheme:</b> ${data.scheme || "—"} • <b>Type:</b> ${data.type || "—"}\n` +
      `<b>Category:</b> ${data.category || "—"}\n` +
      `<b>Bank:</b> ${data.bank.name || "—"}\n` +
      `<b>Country:</b> ${data.country.emoji} ${data.country.name}`
    );
  } catch {
    return "⚠️ BIN lookup error";
  }
}

// ———————————————————————— Card Checker ————————————————————————
async function checkCard(env: Env, card: string): Promise<{
  status: "live" | "die" | "unknown" | "error";
  message: string;
  binInfo: string;
}> {
  const [cc, mm, yy, cvv] = card.split("|");
  if (!cc || !mm || !yy || !cvv) return { status: "error", message: "Invalid format", binInfo: "" };

  const body = `data=${cc}|${mm}|${yy}|${cvv}`;

  try {
    const res = await fetch(env.MOCK_GATEWAY, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
        accept: "*/*",
        "accept-language": "en-US,en;q=0.9",
        "sec-ch-ua": '"Chromium";v="107", "Not=A?Brand";v="24"',
        "sec-ch-ua-mobile": "?1",
        "sec-ch-ua-platform": '"Android"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        referrer: "https://mock.payate.com/",
      },
      body,
    });

    if (!res.ok) {
      return { status: "error", message: `Gateway error: ${res.status}`, binInfo: "" };
    }

    const json: any = await res.json();
    const html = json.msg || json.message || "";
    
    const bin = cc.slice(0, 6);
    const binInfo = await getBinInfo(bin);

    // Clean the HTML response
    const cleanMsg = html.replace(/<[^>]*>/g, "").trim();

    // Parse response - check for keywords
    const lowerHtml = html.toLowerCase();
    
    if (lowerHtml.includes("live") || lowerHtml.includes("approved") || lowerHtml.includes("success")) {
      return { status: "live", message: cleanMsg || "Approved", binInfo };
    } else if (lowerHtml.includes("die") || lowerHtml.includes("declined") || lowerHtml.includes("failed")) {
      return { status: "die", message: cleanMsg || "Declined", binInfo };
    } else if (lowerHtml.includes("unknown") || lowerHtml.includes("pending")) {
      return { status: "unknown", message: cleanMsg || "Unknown", binInfo };
    } else {
      // If no clear status, return the raw response
      return { status: "error", message: cleanMsg || "No response", binInfo };
    }
  } catch (e: any) {
    return { status: "error", message: e.message || "Request failed", binInfo: "" };
  }
}

// ———————————————————————— Generate Cards ————————————————————————
function generateCards(bin: string, amount: number): string[] {
  const cards: string[] = [];
  const length = 16;
  
  // Validate BIN is in valid range
  if (!isValidBin(bin)) {
    return [];
  }

  for (let i = 0; i < amount; i++) {
    const prefix = bin.padEnd(length - 1, "0").slice(0, length - 1);
    const cc = luhnGenerate(prefix, length);
    const mm = String(Math.floor(Math.random() * 12) + 1).padStart(2, "0");
    const yy = String(26 + Math.floor(Math.random() * 8)).padStart(2, "0");
    const cvv = String(100 + Math.floor(Math.random() * 900));
    cards.push(`${cc}|${mm}|${yy}|${cvv}`);
  }
  return cards;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ———————————————————————— Main Handler ————————————————————————
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/webhook" && request.method === "POST") {
      const update: any = await request.json();
      const msg = update.message;
      const callback = update.callback_query;

      if (callback) {
        await answerCallback(env, callback.id);
        return new Response("ok");
      }

      if (!msg?.text) return new Response("ok");

      const chatId = msg.chat.id;
      const text = msg.text.trim();
      const userId = msg.from.id;
      const [cmd, ...args] = text.split(/\s+/);

      // Rate limit: 3 checks per minute
      if (env.RATE_KV) {
        const key = `rate:${userId}`;
        const now = Date.now();
        const recent = ((await env.RATE_KV.get(key, { type: "json" })) as number[]) || [];
        const valid = recent.filter(t => now - t < 60_000);
        if (valid.length >= 3 && !["/start", "/help", "/bin"].includes(cmd)) {
          await sendMessage(env, chatId, "⚠️ Rate limit: 3 commands/min", "HTML");
          return new Response("ok");
        }
        valid.push(now);
        await env.RATE_KV.put(key, JSON.stringify(valid), { expirationTtl: 120 });
      }

      // ————— /start —————
      if (cmd === "/start") {
        const welcome = `<b>💳 CC Checker &amp; Generator Bot</b>

<b>📋 Commands:</b>
<code>/gen bin amount</code> – Generate cards
<code>/chk</code> – Check cards (cc|mm|yy|cvv)
<code>/bin bin</code> – Lookup BIN info
<code>/test card</code> – Test single card with debug info

<b>📝 Example:</b>
<code>/gen 486796 10</code>
<code>/test 5154620020062707|02|2028|144</code>

<b>Supported Networks:</b>
• Visa (4xxxxx)
• Mastercard (51-55, 2221-2720)
• Amex (34, 37)
• Discover (6011, 644-659)
• JCB (3528-3589)
• Diners (300-305, 36-39)
• UnionPay (62)`;
        await sendMessage(env, chatId, welcome, "HTML");
        return new Response("ok");
      }

      // ————— /gen —————
      if (cmd === "/gen" && args.length >= 2) {
        const bin = args[0].replace(/\D/g, "").slice(0, 6);
        const amount = Math.min(parseInt(args[1]) || 10, 50);
        
        if (bin.length < 6) {
          await sendMessage(env, chatId, "❌ Invalid BIN (minimum 6 digits required)", "HTML");
          return new Response("ok");
        }

        if (!isValidBin(bin)) {
          await sendMessage(env, chatId, "❌ Invalid BIN - not in valid card network range", "HTML");
          return new Response("ok");
        }

        const cards = generateCards(bin, amount);
        if (cards.length === 0) {
          await sendMessage(env, chatId, "❌ Failed to generate cards", "HTML");
          return new Response("ok");
        }

        const list = cards.map(c => `<code>${c}</code>`).join("\n");

        await sendMessage(
          env,
          chatId,
          `<b>✅ Generated ${amount} Cards</b>\n<i>BIN: ${bin}</i>\n\n${list}`,
          "HTML"
        );
        return new Response("ok");
      }

      // ————— /bin —————
      if (cmd === "/bin" && args[0]) {
        const bin = args[0].replace(/\D/g, "").slice(0, 6);
        if (bin.length < 6) {
          await sendMessage(env, chatId, "❌ Invalid BIN (minimum 6 digits required)", "HTML");
          return new Response("ok");
        }
        const info = await getBinInfo(bin);
        await sendMessage(env, chatId, `<b>🔍 BIN Lookup</b>\n\n${info}`, "HTML");
        return new Response("ok");
      }

      // ————— /test —————
      if (cmd === "/test" && args[0]) {
        const testCard = args[0];
        if (!/^\d{15,19}\|\d{2}\|\d{2,4}\|\d{3,4}$/.test(testCard)) {
          await sendMessage(env, chatId, "❌ Invalid format. Use: <code>/test 5154620020062707|02|2028|144</code>", "HTML");
          return new Response("ok");
        }

        await sendMessage(env, chatId, "🔍 Testing card...", "HTML");
        
        const result = await checkCard(env, testCard);
        
        const debugInfo = `<b>🔬 Debug Test Result</b>

<b>Card:</b> <code>${testCard}</code>

<b>Status:</b> ${result.status}
<b>Message:</b> <code>${escapeHtml(result.message)}</code>

<b>BIN Info:</b>
${result.binInfo}`;

        await sendMessage(env, chatId, debugInfo, "HTML");
        return new Response("ok");
      }

      // ————— /chk —————
      if (cmd === "/chk") {
        const lines = text
          .split("\n")
          .map(l => l.trim())
          .filter(l => /^\d{15,19}\|\d{2}\|\d{2,4}\|\d{3,4}$/.test(l))
          .slice(0, 30);

        if (lines.length === 0) {
          await sendMessage(
            env, 
            chatId, 
            "<b>ℹ️ Send cards in format:</b>\n<code>6011201234567890|07|32|839</code>\n\n<i>You can send multiple cards, one per line (max 30)</i>", 
            "HTML"
          );
          return new Response("ok");
        }

        const startMsg = await sendMessage(
          env,
          chatId,
          `<b>🔄 Mass Checking Started!</b>\n\n` +
          `<b>Cards:</b> ${lines.length}\n` +
          `<b>Gateway:</b> Mock Payate\n` +
          `<b>Status:</b> <i>0/${lines.length} checked...</i>`,
          "HTML"
        );

        const messageId = (startMsg as any).result.message_id;
        const startTime = Date.now();

        let live = 0, die = 0, unknown = 0, error = 0;
        const results: string[] = [];

        for (let i = 0; i < lines.length; i++) {
          const card = lines[i];
          const res = await checkCard(env, card);

          if (res.status === "live") live++;
          else if (res.status === "die") die++;
          else if (res.status === "unknown") unknown++;
          else error++;

          const icon = res.status === "live" ? "✅" : res.status === "die" ? "❌" : res.status === "unknown" ? "⚠️" : "🚫";
          const statusText = res.status === "live" ? "Approved" : res.status === "die" ? "Declined" : res.status === "unknown" ? "Unknown" : "Error";
          
          const responseMsg = res.message ? `<i>${escapeHtml(res.message)}</i>` : '';
          
          results.push(
            `${icon} <b>${statusText}</b>\n<code>${card}</code>\n${responseMsg ? responseMsg + '\n' : ''}${res.binInfo}`
          );

          // Update progress every 3 cards or on last card
          if (i % 3 === 2 || i === lines.length - 1) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            await editMessage(
              env,
              chatId,
              messageId,
              `<b>🔄 Mass Checking In Progress...</b>\n\n` +
              `<b>Cards:</b> ${lines.length}\n` +
              `<b>Time:</b> ${elapsed}s\n` +
              `<b>Gateway:</b> Mock Payate\n\n` +
              `✅ Approved: ${live}\n` +
              `❌ Declined: ${die}\n` +
              `⚠️ Unknown: ${unknown}\n` +
              `🚫 Errors: ${error}\n\n` +
              `<i>Progress: ${i + 1}/${lines.length}</i>`,
              "HTML"
            );
          }
        }

        const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);

        const final = `<b>✅ Mass Checking Completed!</b>

<b>Total Cards:</b> ${lines.length}
<b>Time Taken:</b> ${totalTime}s
<b>Gateway:</b> Mock Payate

<b>Results:</b>
✅ Approved: ${live}
❌ Declined: ${die}
⚠️ Unknown: ${unknown}
🚫 Errors: ${error}

━━━━━━━━━━━━━━━━━━━━

${results.join("\n\n━━━━━━━━━━━━━━━━━━━━\n\n")}`;

        await editMessage(env, chatId, messageId, final, "HTML");
        return new Response("ok");
      }

      await sendMessage(env, chatId, "❌ Unknown command. Use /start", "HTML");
      return new Response("ok");
    }

    return new Response("CC Checker Bot – POST /webhook");
  },
};
