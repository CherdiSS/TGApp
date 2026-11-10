// Работа с Ozon: разбор ссылок и получение цены.
//
// У Ozon нет публичного API цен. Используется тот же JSON-эндпоинт, которым
// пользуется сам сайт для отрисовки страницы товара. Он защищён антиботом:
// с IP дата-центров и без cookie запросы часто получают 403 — см. README.

import { config } from './config.js';

const OZON_BASE = 'https://www.ozon.ru';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15_000;

export class OzonError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OzonError';
    this.code = code; // 'blocked' | 'not_found' | 'parse' | 'network'
  }
}

const isOzonHost = (host) => host === 'ozon.ru' || host.endsWith('.ozon.ru');

/**
 * Достаёт из произвольного текста ссылку на товар Ozon или артикул.
 * @returns {{sku: string} | {shortUrl: string} | null}
 */
export function parseOzonRef(text) {
  const input = String(text ?? '').trim();
  if (!input) return null;
  if (/^\d{5,15}$/.test(input)) return { sku: input };

  const candidates = input.match(/(?<![\w.-])(?:https?:\/\/)?(?:[\w-]+\.)*ozon\.ru\/[^\s<>"']+/gi) ?? [];
  for (const raw of candidates) {
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      continue;
    }
    if (!isOzonHost(url.hostname.toLowerCase())) continue;

    const product = url.pathname.match(/\/product\/(?:[^/]*-)?(\d{5,15})\/?$/);
    if (product) return { sku: product[1] };
    const productLoose = url.pathname.match(/\/product\/(?:[^/]*-)?(\d{5,15})(?:\/|$)/);
    if (productLoose) return { sku: productLoose[1] };

    if (/^\/t\/[\w-]+\/?$/.test(url.pathname)) {
      return { shortUrl: `https://ozon.ru${url.pathname}` };
    }
  }
  return null;
}

export const productUrl = (sku) => `${OZON_BASE}/product/${sku}/`;

/** "1 234 ₽" → 1234. Возвращает null, если цены нет. */
export function parsePrice(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  if (typeof value !== 'string') return null;
  const whole = value.split(/[.,]\d{1,2}(?!\d)/)[0];
  const digits = whole.replace(/\D/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return n > 0 ? n : null;
}

function safeJson(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const httpsOnly = (url) => (typeof url === 'string' && url.startsWith('https://') ? url : null);

/**
 * Разбирает ответ page/json/v2 для страницы товара.
 * @returns {{title: string|null, image: string|null, price: number|null, cardPrice: number|null, available: boolean}}
 */
export function parseProductPage(page) {
  const out = { title: null, image: null, price: null, cardPrice: null, available: true };
  let sawPriceWidget = false;
  let outOfStock = false;

  for (const [key, raw] of Object.entries(page?.widgetStates ?? {})) {
    if (key.startsWith('webPrice-')) {
      const w = safeJson(raw);
      if (!w) continue;
      sawPriceWidget = true;
      out.price ??= parsePrice(w.price);
      out.cardPrice ??= parsePrice(w.cardPrice);
      if (w.isAvailable === false) outOfStock = true;
    } else if (key.startsWith('webProductHeading-')) {
      out.title ??= safeJson(raw)?.title?.trim() || null;
    } else if (key.startsWith('webGallery-')) {
      const w = safeJson(raw);
      out.image ??= httpsOnly(w?.coverImage) ?? httpsOnly(w?.images?.[0]?.src);
    } else if (key.startsWith('webOutOfStock-')) {
      const w = safeJson(raw);
      outOfStock = true;
      if (w) {
        out.title ??= (w.productTitle || w.skuName || '').trim() || null;
        out.image ??= httpsOnly(w.coverImage);
        out.price ??= parsePrice(w.price);
      }
    }
  }

  // Запасной источник — schema.org-разметка из SEO-блока.
  for (const script of page?.seo?.script ?? []) {
    if (script?.type !== 'application/ld+json') continue;
    const ld = safeJson(script.innerHTML);
    if (!ld) continue;
    out.title ??= typeof ld.name === 'string' ? ld.name.trim() || null : null;
    out.image ??= httpsOnly(Array.isArray(ld.image) ? ld.image[0] : ld.image);
    const offer = Array.isArray(ld.offers) ? ld.offers[0] : ld.offers;
    if (offer) {
      out.price ??= parsePrice(typeof offer.price === 'number' ? offer.price : String(offer.price ?? ''));
      if (!sawPriceWidget && typeof offer.availability === 'string' && /OutOfStock/i.test(offer.availability)) {
        outOfStock = true;
      }
    }
  }

  // Бывает только цена по карте — тогда она и есть обычная.
  if (out.price == null && out.cardPrice != null) {
    out.price = out.cardPrice;
    out.cardPrice = null;
  }
  if (out.cardPrice != null && out.price != null && out.cardPrice >= out.price) out.cardPrice = null;

  out.available = !outOfStock && out.price != null;

  if (out.title == null && out.price == null) {
    throw new OzonError('parse', 'В ответе Ozon не нашлось ни названия, ни цены');
  }
  return out;
}

function requestHeaders() {
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
    'Accept-Language': 'ru-RU,ru;q=0.9',
  };
  if (config.ozonCookie) headers.Cookie = config.ozonCookie;
  return headers;
}

async function ozonFetch(url, init = {}) {
  try {
    return await fetch(url, {
      ...init,
      headers: requestHeaders(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new OzonError('network', `Ozon недоступен: ${err.cause?.code || err.name || err.message}`);
  }
}

async function fetchPageJson(path) {
  const url = `${OZON_BASE}/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(path)}`;
  const res = await ozonFetch(url);
  if (res.status === 404) throw new OzonError('not_found', 'Товар не найден на Ozon');
  if (res.status === 403 || res.status === 429) {
    throw new OzonError('blocked', `Ozon отклонил запрос (HTTP ${res.status}) — сработал антибот`);
  }
  if (!res.ok) throw new OzonError('network', `Ozon ответил HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json')) {
    throw new OzonError('blocked', 'Ozon вернул страницу проверки вместо данных — сработал антибот');
  }
  try {
    return await res.json();
  } catch {
    throw new OzonError('parse', 'Ozon вернул невалидный JSON');
  }
}

async function fetchProductLive(sku) {
  let page = await fetchPageJson(`/product/${sku}/`);
  // Иногда вместо страницы приходит редирект на канонический адрес.
  if (!page.widgetStates && typeof page.redirect === 'string' && page.redirect.startsWith('/')) {
    page = await fetchPageJson(page.redirect);
  }
  return parseProductPage(page);
}

/** Детерминированные «цены» для локальной разработки без доступа к Ozon. */
function fetchProductMock(sku) {
  const seed = [...sku].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 100_003, 7);
  const base = 500 + (seed % 9000);
  const wave = Math.sin(Date.now() / 600_000 + seed) * 0.12;
  const price = Math.round(base * (1 + wave));
  return {
    title: `Тестовый товар №${sku}`,
    image: null,
    price,
    cardPrice: seed % 3 === 0 ? null : Math.round(price * 0.96),
    available: seed % 7 !== 0,
  };
}

/** Текущие данные о товаре по артикулу. Бросает OzonError. */
export async function fetchProduct(sku) {
  return config.ozonMock ? fetchProductMock(sku) : fetchProductLive(sku);
}

/** Раскрывает короткую ссылку ozon.ru/t/… до артикула. */
export async function resolveShortLink(shortUrl) {
  let url = shortUrl;
  for (let hop = 0; hop < 4; hop++) {
    const res = await ozonFetch(url, { redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      const next = new URL(location, url);
      if (!isOzonHost(next.hostname.toLowerCase())) break;
      const ref = parseOzonRef(next.href);
      if (ref?.sku) return ref.sku;
      url = next.href;
      continue;
    }
    if (res.status === 403 || res.status === 429) {
      throw new OzonError('blocked', 'Ozon не дал раскрыть короткую ссылку');
    }
    break;
  }
  throw new OzonError('parse', 'Не удалось раскрыть короткую ссылку');
}
