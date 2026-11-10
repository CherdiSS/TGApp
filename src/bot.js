// Бот на long polling: открывает мини-приложение и принимает ссылки прямо в чате.

import { config } from './config.js';
import { AppError, addTracking, listItems, upsertUser } from './monitor.js';
import { parseOzonRef } from './ozon.js';
import { escapeHtml } from './telegram.js';

const rub = (n) => `${new Intl.NumberFormat('ru-RU').format(n)} ₽`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function appKeyboard() {
  if (!config.webappUrl) return undefined;
  return { inline_keyboard: [[{ text: 'Открыть мои товары', web_app: { url: config.webappUrl } }]] };
}

async function handleMessage(ctx, msg) {
  const { db, tg } = ctx;
  if (msg.chat?.type !== 'private' || !msg.from || msg.from.is_bot) return;
  const text = (msg.text ?? msg.caption ?? '').trim();
  const reply = (body, extra) => tg.sendMessage(msg.chat.id, body, extra);
  upsertUser(db, msg.from);

  if (/^\/(start|help)\b/.test(text)) {
    return reply(
      'Слежу за ценами на Ozon и пишу, когда товар дешевеет.\n\n' +
        'Пришлите ссылку на товар или артикул — добавлю в отслеживание. ' +
        'Список, график цены и желаемую цену смотрите в приложении.',
      { reply_markup: appKeyboard() },
    );
  }

  if (/^\/list\b/.test(text)) {
    const items = listItems(db, msg.from.id);
    if (!items.length) return reply('Пока ничего не отслеживается. Пришлите ссылку на товар Ozon.');
    const lines = items.slice(0, 30).map((it) => {
      const price = it.price == null ? 'ждёт проверки' : it.available ? rub(it.price) : 'нет в наличии';
      return `• <a href="${it.url}">${escapeHtml(it.title ?? `Товар ${it.sku}`)}</a> — ${price}`;
    });
    return reply(lines.join('\n'), { reply_markup: appKeyboard() });
  }

  if (!parseOzonRef(text)) {
    return reply('Не вижу здесь ссылки на Ozon. Пришлите ссылку на товар или его артикул.');
  }

  try {
    const { item, pending } = await addTracking(ctx, msg.from.id, text);
    const title = escapeHtml(item.title ?? `Товар ${item.sku}`);
    const body = pending
      ? `Добавил <b>${title}</b>. Ozon пока не отдал цену — проверю чуть позже.`
      : `Добавил <b>${title}</b>\nСейчас: <b>${item.available ? rub(item.price) : 'нет в наличии'}</b>`;
    return reply(body, { reply_markup: appKeyboard() });
  } catch (err) {
    if (err instanceof AppError) return reply(escapeHtml(err.message));
    throw err;
  }
}

export function startBot(ctx) {
  const { tg } = ctx;
  let stopped = false;

  (async () => {
    try {
      await tg.call('setMyCommands', {
        commands: [
          { command: 'start', description: 'Открыть приложение' },
          { command: 'list', description: 'Что отслеживается' },
        ],
      });
      if (config.webappUrl) {
        await tg.call('setChatMenuButton', {
          menu_button: { type: 'web_app', text: 'Цены', web_app: { url: config.webappUrl } },
        });
      }
    } catch (err) {
      console.error('[bot] настройка не удалась:', err.message);
    }

    let offset = 0;
    while (!stopped) {
      try {
        const updates = await tg.call(
          'getUpdates',
          { offset, timeout: 30, allowed_updates: ['message'] },
          40_000,
        );
        for (const update of updates) {
          offset = update.update_id + 1;
          if (!update.message) continue;
          handleMessage(ctx, update.message).catch((err) => console.error('[bot]', err.message));
        }
      } catch (err) {
        if (stopped) break;
        console.error('[bot] polling:', err.message);
        await sleep(5000);
      }
    }
  })();

  return () => {
    stopped = true;
  };
}
