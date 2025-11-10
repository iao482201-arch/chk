export interface Env {
  TELEGRAM_TOKEN: string;
}

export async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  parse_mode = "HTML"
): Promise<any> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode, disable_web_page_preview: true }),
  });
  return res.json();
}

export async function editMessage(
  env: Env,
  chatId: number,
  messageId: number,
  text: string,
  parse_mode = "HTML"
) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/editMessageText`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode,
      disable_web_page_preview: true,
    }),
  });
}

export async function answerCallback(env: Env, callbackId: string) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/answerCallbackQuery`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId }),
  });
}
