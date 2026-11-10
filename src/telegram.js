import { createHmac, timingSafeEqual } from 'node:crypto';

const INIT_DATA_MAX_AGE_SEC = 24 * 60 * 60;

/**
 * Проверяет подпись initData из Telegram WebApp.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * @returns {{id: number, first_name?: string} | null} пользователь или null, если подпись не сошлась
 */
export function validateInitData(initData, botToken, nowSec = Math.floor(Date.now() / 1000)) {
  if (!initData || !botToken || initData.length > 8192) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  params.delete('hash');

  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(checkString).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return null;

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || nowSec - authDate > INIT_DATA_MAX_AGE_SEC) return null;

  try {
    const user = JSON.parse(params.get('user') ?? '');
    return Number.isSafeInteger(user?.id) ? user : null;
  } catch {
    return null;
  }
}

export class TelegramError extends Error {
  constructor(method, code, description) {
    super(`Telegram ${method}: ${code} ${description}`);
    this.name = 'TelegramError';
    this.code = code;
  }
}

/** Минимальный клиент Bot API. */
export function createTelegram(token) {
  async function call(method, params = {}, timeoutMs = 20_000) {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => null);
    if (!data?.ok) throw new TelegramError(method, data?.error_code ?? res.status, data?.description ?? 'no body');
    return data.result;
  }

  return {
    call,
    sendMessage: (chatId, text, extra = {}) =>
      call('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...extra,
      }),
  };
}

export const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
