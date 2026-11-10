// Ядро: добавление товаров, проверка цен, решение об уведомлениях, планировщик.

import { config } from './config.js';
import { effectivePrice, now, transaction } from './db.js';
import { OzonError, fetchProduct, parseOzonRef, productUrl, resolveShortLink } from './ozon.js';
import { escapeHtml } from './telegram.js';

export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

const HISTORY_KEEP_DAYS = 180;
const HISTORY_POINTS_LIMIT = 300;
const RETRY_BASE_SEC = 15 * 60;
const RETRY_MAX_SEC = 6 * 60 * 60;
const MANUAL_REFRESH_COOLDOWN_SEC = 120;

const rub = (n) => `${new Intl.NumberFormat('ru-RU').format(n)} ₽`;

/**
 * Решает, нужно ли уведомить подписчика, и возвращает новое состояние подписки.
 * Чистая функция — вся логика оповещений здесь.
 *
 * @param t    подписка: {target_price, added_price, baseline_price, target_hit}
 * @param prev прошлое состояние товара {price, available} или null (первая проверка)
 * @param cur  новое состояние товара {price, available}
 */
export function decide(t, prev, cur, minDropPercent) {
  const next = {
    added_price: t.added_price,
    baseline_price: t.baseline_price,
    target_hit: t.target_hit ? 1 : 0,
  };
  if (cur.price == null) return { next, event: null };
  next.added_price ??= cur.price;

  if (!cur.available) {
    next.target_hit = 0;
    return { next, event: null };
  }

  const underTarget = t.target_price != null && cur.price <= t.target_price;

  if (prev && !prev.available) {
    next.baseline_price = cur.price;
    next.target_hit = underTarget ? 1 : 0;
    return { next, event: { type: 'back_in_stock', price: cur.price } };
  }

  if (t.target_price != null) {
    const event =
      underTarget && !next.target_hit ? { type: 'target', price: cur.price, target: t.target_price } : null;
    next.target_hit = underTarget ? 1 : 0;
    next.baseline_price = cur.price;
    return { next, event };
  }

  const base = next.baseline_price;
  if (base == null || cur.price > base) {
    next.baseline_price = cur.price;
    return { next, event: null };
  }
  if (cur.price < base && cur.price <= base * (1 - minDropPercent / 100)) {
    next.baseline_price = cur.price;
    return { next, event: { type: 'drop', from: base, price: cur.price } };
  }
  return { next, event: null };
}

/**
 * Записывает результат проверки товара и возвращает список уведомлений к отправке.
 * @param result {title, image, price, cardPrice, available}
 */
export function applyCheck(db, sku, result, ts = now()) {
  return transaction(db, () => {
    const old = db.prepare('SELECT * FROM products WHERE sku = ?').get(sku);
    const prev = old?.last_checked_at ? { price: effectivePrice(old), available: !!old.available } : null;

    // Товар пропал из продажи без цены — показываем последнюю известную.
    const price = result.price ?? old?.price ?? null;
    const cardPrice = result.price != null ? result.cardPrice : (old?.card_price ?? null);
    const available = result.available ? 1 : 0;
    const nextCheck = ts + config.checkIntervalMin * 60 + Math.floor(Math.random() * 120);

    db.prepare(
      `INSERT INTO products (sku, title, image, price, card_price, available, last_checked_at, next_check_at, fail_count, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
       ON CONFLICT (sku) DO UPDATE SET
         title = COALESCE(excluded.title, title),
         image = COALESCE(excluded.image, image),
         price = excluded.price,
         card_price = excluded.card_price,
         available = excluded.available,
         last_checked_at = excluded.last_checked_at,
         next_check_at = excluded.next_check_at,
         fail_count = 0,
         last_error = NULL`,
    ).run(sku, result.title, result.image, price, cardPrice, available, ts, nextCheck);

    const cur = { price: cardPrice ?? price, available: !!available };
    if (cur.price != null && (!prev || prev.price !== cur.price || prev.available !== cur.available)) {
      db.prepare('INSERT INTO price_history (sku, ts, price, available) VALUES (?, ?, ?, ?)').run(
        sku,
        ts,
        cur.price,
        available,
      );
    }

    const notifications = [];
    const trackings = db
      .prepare(
        `SELECT t.*, u.blocked FROM trackings t JOIN users u ON u.id = t.user_id WHERE t.sku = ?`,
      )
      .all(sku);
    const update = db.prepare(
      `UPDATE trackings SET added_price = ?, baseline_price = ?, target_hit = ? WHERE user_id = ? AND sku = ?`,
    );
    const title = result.title ?? old?.title ?? `Товар ${sku}`;
    for (const t of trackings) {
      const { next, event } = decide(t, prev, cur, config.minDropPercent);
      update.run(next.added_price, next.baseline_price, next.target_hit, t.user_id, sku);
      if (event && !t.blocked) notifications.push({ userId: t.user_id, sku, title, event });
    }
    return notifications;
  });
}

function recordFailure(db, sku, err, ts = now()) {
  const row = db.prepare('SELECT fail_count FROM products WHERE sku = ?').get(sku);
  if (!row) return;
  const fails = row.fail_count + 1;
  const delay =
    err.code === 'not_found' ? 24 * 60 * 60 : Math.min(RETRY_BASE_SEC * 2 ** (fails - 1), RETRY_MAX_SEC);
  db.prepare('UPDATE products SET fail_count = ?, last_error = ?, next_check_at = ? WHERE sku = ?').run(
    fails,
    err.code ?? 'unknown',
    ts + delay,
    sku,
  );
}

export function formatNotification({ sku, title, event }) {
  const link = `<a href="${productUrl(sku)}">${escapeHtml(title)}</a>`;
  switch (event.type) {
    case 'drop': {
      const pct = ((1 - event.price / event.from) * 100).toFixed(1).replace('.', ',');
      return `📉 <b>Цена снизилась</b>\n${link}\n${rub(event.from)} → <b>${rub(event.price)}</b> (−${pct}%)`;
    }
    case 'target':
      return `🎯 <b>Цена дошла до цели</b>\n${link}\nСейчас <b>${rub(event.price)}</b>, вы ждали ${rub(event.target)}`;
    case 'back_in_stock':
      return `✅ <b>Снова в наличии</b>\n${link}\nЦена <b>${rub(event.price)}</b>`;
    default:
      return link;
  }
}

async function sendNotifications({ db, tg }, notifications) {
  for (const n of notifications) {
    if (!tg) {
      console.log('[notify] (бот не настроен)', n.userId, n.sku, n.event);
      continue;
    }
    const buttons = [[{ text: 'Открыть на Ozon', url: productUrl(n.sku) }]];
    if (config.webappUrl) buttons.push([{ text: 'Мои товары', web_app: { url: config.webappUrl } }]);
    try {
      await tg.sendMessage(n.userId, formatNotification(n), { reply_markup: { inline_keyboard: buttons } });
    } catch (err) {
      if (err.code === 403) {
        db.prepare('UPDATE users SET blocked = 1 WHERE id = ?').run(n.userId);
      } else {
        console.error('[notify] не отправилось:', err.message);
      }
    }
  }
}

/** Запрашивает Ozon и обновляет товар. Не бросает — возвращает исход. */
export async function refreshProduct(ctx, sku) {
  try {
    const result = await fetchProduct(sku);
    const notifications = applyCheck(ctx.db, sku, result);
    await sendNotifications(ctx, notifications);
    return { ok: true };
  } catch (err) {
    if (!(err instanceof OzonError)) console.error(`[check] ${sku}:`, err);
    recordFailure(ctx.db, sku, err);
    return { ok: false, code: err.code ?? 'unknown', message: err.message };
  }
}

export function upsertUser(db, user) {
  db.prepare(
    `INSERT INTO users (id, first_name, created_at) VALUES (?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET first_name = excluded.first_name, blocked = 0`,
  ).run(user.id, user.first_name ?? null, now());
}

/** Добавляет товар в отслеживание по ссылке, тексту со ссылкой или артикулу. */
export async function addTracking(ctx, userId, input) {
  const { db } = ctx;
  const ref = parseOzonRef(input);
  if (!ref) throw new AppError(400, 'bad_link', 'Это не похоже на ссылку Ozon или артикул товара');

  let sku = ref.sku;
  if (!sku) {
    try {
      sku = await resolveShortLink(ref.shortUrl);
    } catch {
      throw new AppError(
        502,
        'short_link',
        'Не получилось раскрыть короткую ссылку. Откройте товар и пришлите полную ссылку или артикул',
      );
    }
  }

  if (db.prepare('SELECT 1 FROM trackings WHERE user_id = ? AND sku = ?').get(userId, sku)) {
    throw new AppError(409, 'exists', 'Этот товар уже отслеживается');
  }
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM trackings WHERE user_id = ?').get(userId);
  if (n >= config.maxItemsPerUser) {
    throw new AppError(409, 'limit', `Достигнут лимит: ${config.maxItemsPerUser} товаров`);
  }

  let product = db.prepare('SELECT * FROM products WHERE sku = ?').get(sku);
  const fresh = product?.last_checked_at && now() - product.last_checked_at < config.checkIntervalMin * 60;
  let pending = false;

  if (!fresh) {
    try {
      applyCheck(db, sku, await fetchProduct(sku));
    } catch (err) {
      if (!(err instanceof OzonError)) throw err;
      if (err.code === 'not_found') throw new AppError(404, 'not_found', 'Такого товара на Ozon нет');
      // Ozon сейчас не отдал данные — сохраняем и проверим позже.
      pending = !product?.last_checked_at;
      if (!product) {
        db.prepare('INSERT INTO products (sku, next_check_at, last_error) VALUES (?, ?, ?)').run(
          sku,
          now() + 5 * 60,
          err.code,
        );
      }
    }
    product = db.prepare('SELECT * FROM products WHERE sku = ?').get(sku);
  }

  const price = product.last_checked_at ? effectivePrice(product) : null;
  db.prepare(
    `INSERT INTO trackings (user_id, sku, added_price, baseline_price, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(userId, sku, price, price, now());

  return { item: getItem(db, userId, sku), pending };
}

export function removeTracking(db, userId, sku) {
  const { changes } = db.prepare('DELETE FROM trackings WHERE user_id = ? AND sku = ?').run(userId, sku);
  if (!changes) throw new AppError(404, 'not_tracked', 'Товар не отслеживается');
  db.prepare('DELETE FROM products WHERE sku = ? AND NOT EXISTS (SELECT 1 FROM trackings WHERE sku = ?)').run(
    sku,
    sku,
  );
}

export function setTarget(db, userId, sku, targetPrice) {
  const row = db
    .prepare(
      `SELECT p.* FROM trackings t JOIN products p ON p.sku = t.sku WHERE t.user_id = ? AND t.sku = ?`,
    )
    .get(userId, sku);
  if (!row) throw new AppError(404, 'not_tracked', 'Товар не отслеживается');
  const price = effectivePrice(row);
  // Если цена уже ниже цели — не шлём «цель достигнута» при следующей проверке.
  const hit = targetPrice != null && price != null && row.available && price <= targetPrice ? 1 : 0;
  db.prepare(
    `UPDATE trackings SET target_price = ?, target_hit = ?, baseline_price = COALESCE(?, baseline_price)
     WHERE user_id = ? AND sku = ?`,
  ).run(targetPrice, hit, price, userId, sku);
  return getItem(db, userId, sku);
}

/** Ручное обновление из приложения, с защитой от долбёжки Ozon. */
export async function manualRefresh(ctx, userId, sku) {
  const { db } = ctx;
  const row = db
    .prepare(
      `SELECT p.last_checked_at FROM trackings t JOIN products p ON p.sku = t.sku WHERE t.user_id = ? AND t.sku = ?`,
    )
    .get(userId, sku);
  if (!row) throw new AppError(404, 'not_tracked', 'Товар не отслеживается');
  if (row.last_checked_at && now() - row.last_checked_at < MANUAL_REFRESH_COOLDOWN_SEC) {
    return { item: getItem(db, userId, sku), refreshed: false };
  }
  const outcome = await refreshProduct(ctx, sku);
  if (!outcome.ok) {
    const message =
      outcome.code === 'blocked'
        ? 'Ozon сейчас не отдаёт цену, попробуем позже'
        : outcome.code === 'not_found'
          ? 'Товар больше не находится на Ozon'
          : 'Не удалось получить цену, попробуем позже';
    throw new AppError(502, `ozon_${outcome.code}`, message);
  }
  return { item: getItem(db, userId, sku), refreshed: true };
}

function toItem(db, row) {
  const history = db
    .prepare(
      `SELECT ts AS t, price AS p, available AS a FROM (
         SELECT ts, price, available FROM price_history WHERE sku = ? ORDER BY ts DESC LIMIT ?
       ) ORDER BY ts`,
    )
    .all(row.sku, HISTORY_POINTS_LIMIT);
  const prices = history.map((h) => h.p);
  const current = row.last_checked_at ? effectivePrice(row) : null;
  return {
    sku: row.sku,
    url: productUrl(row.sku),
    title: row.title,
    image: row.image,
    price: current,
    regularPrice: row.card_price != null ? row.price : null,
    available: !!row.available,
    status: !row.last_checked_at ? 'pending' : row.last_error ? 'stale' : 'ok',
    targetPrice: row.target_price,
    addedPrice: row.added_price,
    minPrice: prices.length ? Math.min(...prices) : current,
    maxPrice: prices.length ? Math.max(...prices) : current,
    addedAt: row.created_at,
    lastCheckedAt: row.last_checked_at,
    history,
  };
}

const ITEM_QUERY = `SELECT p.*, t.target_price, t.added_price, t.created_at
  FROM trackings t JOIN products p ON p.sku = t.sku WHERE t.user_id = ?`;

export function listItems(db, userId) {
  return db
    .prepare(`${ITEM_QUERY} ORDER BY t.created_at DESC, p.sku`)
    .all(userId)
    .map((row) => toItem(db, row));
}

export function getItem(db, userId, sku) {
  const row = db.prepare(`${ITEM_QUERY} AND t.sku = ?`).get(userId, sku);
  return row ? toItem(db, row) : null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Раз в минуту берёт товары, которым пора на проверку, и обходит их по одному с паузами. */
export function startScheduler(ctx, { tickMs = 60_000, batch = 15, pauseMs = [2000, 6000] } = {}) {
  let running = false;
  let stopped = false;
  let lastPrune = 0;

  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      const due = ctx.db
        .prepare(
          `SELECT sku FROM products p
           WHERE next_check_at <= ? AND EXISTS (SELECT 1 FROM trackings t WHERE t.sku = p.sku)
           ORDER BY next_check_at LIMIT ?`,
        )
        .all(now(), batch);
      for (const { sku } of due) {
        if (stopped) break;
        const outcome = await refreshProduct(ctx, sku);
        if (!outcome.ok) console.warn(`[check] ${sku}: ${outcome.message}`);
        // Антибот сработал — нет смысла стучаться дальше в этом заходе.
        if (outcome.code === 'blocked') break;
        await sleep(pauseMs[0] + Math.random() * (pauseMs[1] - pauseMs[0]));
      }
      if (now() - lastPrune > 24 * 60 * 60) {
        lastPrune = now();
        ctx.db.prepare('DELETE FROM price_history WHERE ts < ?').run(now() - HISTORY_KEEP_DAYS * 86400);
      }
    } catch (err) {
      console.error('[scheduler]', err);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(tick, tickMs);
  tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
