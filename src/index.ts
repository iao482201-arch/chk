import { Telegraf } from "telegraf";
import { UserState } from "./do/UserState";

interface Env {
  TELEGRAM_TOKEN: string;
  MOCK_GATEWAY: string;
  BIN_API: string;
  BIN_CACHE: KVNamespace;
  USER_STATE: DurableObjectNamespace;
}

// === Luhn Generator ===
function luhnGenerate(prefix: string, length: number): string {
  let number = prefix;
  while (number.length < length - 1) {
    number += Math.floor(Math.random() * 10);
  }
  let sum = 0;
  let alternate = true;
  for (let i = number.length - 1; i >= 0; i--) {
    let digit = parseInt(number[i], 10);
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

// === BIN Lookup with KV Cache ===
async function getBinInfo(bin: string, env: Env): Promise<string> {
  const cacheKey = `bin:${bin}`;
  const cached = await env.BIN_CACHE.get(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch(`${env.BIN_API}/${bin}/`);
    if (!res.ok) return "BIN lookup failed";

    const data: any = await res.json();
    if (!data.success) return "BIN not found";

    const info = `
<b>BIN:</b> <code>${bin}</code>
<b>Scheme:</b> ${data.scheme || "—"} • <b>Type:</b> ${data.type || "—"}
<b>Category:</b> ${data.category || "—"}
<b>Bank:</b> ${data.bank?.name || "—"}
<b>Country:</b> ${data.country?.emoji || ""} ${data.country?.name || "—"}
    `.trim();

    await env.BIN_CACHE.put(cacheKey, info, { expirationTtl: 86400 });
    return info;
  } catch {
    return "BIN lookup error";
  }
}

// === Card Checker ===
async function checkCard(card: string, env: Env): Promise<{
  status: "live" | "die" | "unknown" | "error";
  result: string;
}> {
  const [cc, mm, yy, cvv] = card.split("|").map(s => s.trim());
  if (!cc || !mm || !yy || !cvv) return { status: "error", result: "Invalid format" };

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

    if (!res.ok) return { status: "error", result: "Gateway error" };

    const json: any = await res.json();
    const html = json.msg || "";
    const bin = cc.slice(0, 6);
    const binInfo = await getBinInfo(bin, env);

    if (/color:#008000.*Live/i.test(html)) {
      return { status: "live", result: `<b>Approved</b> | <code>${card}</code>\n${binInfo}` };
    } else if (/color:#FF0000.*Die/i.test(html)) {
      return { status: "die", result: `<b>Declined</b> | <code>${card}</code>\n${binInfo}` };
    } else if (/color:#800080.*Unknown/i.test(html)) {
      return { status: "unknown", result: `<b>Unknown</b> | <code>${card}</code>\n${binInfo}` };
    } else {
      return { status: "error", result: `<b>Warning</b> | <code>${card}</code>\n${binInfo}` };
    }
  } catch {
    return { status: "error", result: `<b>Warning</b> | <code>${card}</code>\nRequest failed` };
  }
}

// === Generate Cards ===
function generateCards(bin: string, amount: number): string[] {
  const cards: string[] = [];
  const prefix = bin.padEnd(16, "0").slice(0, 16);
  for (let i = 0; i < amount; i++) {
    const cc = luhnGenerate(prefix.slice(0, 15), 16);
    const mm = String(Math.floor(Math.random() * 12) + 1).padStart(2, "0");
    const yy = String(26 + Math.floor(Math.random() * 8)).padStart(2, "0");
    const cvv = String(100 + Math.floor(Math.random() * 900));
    cards.push(`${cc}|${mm}|${yy}|${cvv}`);
  }
  return cards;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/webhook" && request.method === "POST") {
      const update = await request.json<any>();
      const bot = new Telegraf(env.TELEGRAM_TOKEN);

      bot.start((ctx) => {
        ctx.replyWithMarkdownV2(`
*CC Checker & Generator Bot*

*Commands:*
\`/gen bin amount\` – Generate cards
\`/chk\` – Paste cards (cc|mm|yy|cvv)
\`/bin bin\` – Lookup BIN

*Example:*
\`/gen 486796 10\`
        `);
      });

      bot.command("gen", (ctx) => {
        const args = ctx.message.text.split(/\s+/).slice(1);
        if (args.length < 2) return ctx.reply("Usage: /gen bin amount");
        const bin = args[0].replace(/\D/g, "").slice(0, 6);
        const amount = Math.min(parseInt(args[1]) || 10, 50);
        if (bin.length < 6) return ctx.reply("Invalid BIN");
        const cards = generateCards(bin, amount);
        const list = cards.map(c => `<code>${c}</code>`).join("\n");
        ctx.replyWithHTML(`<b>Generated ${amount} Cards</b>\n<i>BIN: ${bin}</i>\n\n${list}`);
      });

      bot.command("bin", async (ctx) => {
        const bin = ctx.message.text.split(/\s+/)[1]?.replace(/\D/g, "").slice(0, 6);
        if (!bin) return ctx.reply("Usage: /bin 601120");
        const info = await getBinInfo(bin, env);
        ctx.replyWithHTML(`<b>BIN Lookup</b>\n\n${info}`);
      });

      bot.command("chk", async (ctx) => {
        const userId = ctx.from!.id;
        const userDO = env.USER_STATE.get(env.USER_STATE.idFromName(userId.toString()));

        // Rate limit
        const rateRes = await userDO.fetch("http://do/rate_check", {
          method: "POST",
          body: JSON.stringify({ action: "rate_check", data: { userId } }),
        });
        const { allowed } = await rateRes.json<any>();
        if (!allowed) return ctx.reply("Rate limit: 3 checks per minute");

        const text = ctx.message.text;
        const lines = text
          .split("\n")
          .map(l => l.trim())
          .filter(l => /^\d{15,19}\|\d{2}\|\d{2,4}\|\d{3,4}$/.test(l))
          .slice(0, 30);

        if (lines.length === 0) {
          return ctx.replyWithHTML("Send cards in format:\n<code>6011201234567890|07|32|839</code>");
        }

        const statusMsg = await ctx.replyWithHTML(
          `<b>Mass Checking Started!</b>\n` +
          `Cards: ${lines.length}\n` +
          `Gateway: Mock Payate\n` +
          `Status: <i>0/${lines.length} checked...</i>`
        );

        await userDO.fetch("http://do/start_check", {
          method: "POST",
          body: JSON.stringify({
            action: "start_check",
            data: { userId, cards: lines, messageId: statusMsg.message_id },
          }),
        });

        let live = 0, die = 0, unknown = 0, error = 0;
        const results: string[] = [];

        for (let i = 0; i < lines.length; i++) {
          const card = lines[i];
          const res = await checkCard(card, env);
          results.push(res.result); // Fixed: was `res,result`

          if (res.status === "live") live++;
          else if (res.status === "die") die++;
          else if (res.status === "unknown") unknown++;
          else error++;

          if (i % 3 === 2 || i === lines.length - 1) {
            await userDO.fetch("http://do/update_progress", {
              method: "POST",
              body: JSON.stringify({
                action: "update_progress",
                data: { index: i, status: res.status, result: res.result },
              }),
            });

            const progRes = await userDO.fetch("http://do/get_progress");
            const p = await progRes.json<any>();

            await ctx.telegram.editMessageText(
              ctx.chat!.id,
              statusMsg.message_id,
              undefined,
              `<b>Mass Checking In Progress...</b>\n` +
              `Cards: ${lines.length}\n` +
              `Time: ${p.elapsed}s\n` +
              `Gateway: Mock Payate\n\n` +
              `Approved ${p.live} Approved\n` +
              `Declined ${p.die} Declined\n` +
              `Unknown ${p.unknown} Unknown\n` +
              `Errors ${p.error} Warning\n\n` +
              `<i>Checked: ${p.progress}</i>`,
              { parse_mode: "HTML" }
            );
          }
        }

        const final = `
*Mass Checking Completed!*
Total Cards: ${lines.length}
Time Taken: ${((Date.now() - (await userDO.fetch("http://do/get_progress")).json<any>().elapsed * 1000) / 1000).toFixed(2)}s
Gateway: Mock Payate

Approved ${live} Approved
Declined ${die} Declined
Unknown ${unknown} Unknown
Errors ${error} Warning

${results.join("\n\n")}
        `.trim();

        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          statusMsg.message_id,
          undefined,
          final,
          { parse_mode: "Markdown" }
        );
      });

      await bot.handleUpdate(update);
      return new Response("OK");
    }

    return new Response("CC Checker Bot – POST /webhook");
  },
};
