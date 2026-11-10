import test from 'node:test';
import assert from 'node:assert/strict';
import { OzonError, parseOzonRef, parsePrice, parseProductPage } from '../src/ozon.js';

test('parseOzonRef: ссылки, артикулы, мусор', () => {
  assert.deepEqual(parseOzonRef('https://www.ozon.ru/product/smartfon-apple-iphone-15-128gb-1234567890/?at=abc'), { sku: '1234567890' });
  assert.deepEqual(parseOzonRef('https://ozon.ru/product/1234567890'), { sku: '1234567890' });
  assert.deepEqual(parseOzonRef('ozon.ru/product/chaynik-2000-vt-987654321/'), { sku: '987654321' });
  assert.deepEqual(parseOzonRef('Смотри что нашёл https://www.ozon.ru/product/kniga-555666777/reviews/ огонь'), { sku: '555666777' });
  assert.deepEqual(parseOzonRef(' 1234567890 '), { sku: '1234567890' });
  assert.deepEqual(parseOzonRef('https://ozon.ru/t/AbC12dE'), { shortUrl: 'https://ozon.ru/t/AbC12dE' });
  assert.equal(parseOzonRef('https://evil.com/?u=ozon.ru.evil.com/product/1234567'), null);
  assert.equal(parseOzonRef('https://notozon.ru/product/x-1234567/'), null);
  assert.equal(parseOzonRef('https://www.ozon.ru/category/chayniki/'), null);
  assert.equal(parseOzonRef('привет'), null);
  assert.equal(parseOzonRef(''), null);
});

test('parsePrice', () => {
  assert.equal(parsePrice('1 234 ₽'), 1234);
  assert.equal(parsePrice('12 990 ₽'), 12990);
  assert.equal(parsePrice('999,50 ₽'), 999);
  assert.equal(parsePrice('2199.00'), 2199);
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice(undefined), null);
});

const page = (widgets, seo) => ({
  widgetStates: Object.fromEntries(Object.entries(widgets).map(([k, v]) => [k, JSON.stringify(v)])),
  seo,
});

test('parseProductPage: обычный товар с ценой по карте', () => {
  const result = parseProductPage(
    page({
      'webPrice-3121879-default-1': { isAvailable: true, cardPrice: '2 057 ₽', price: '2 199 ₽', originalPrice: '4 500 ₽' },
      'webProductHeading-3385933-default-1': { title: ' Чайник электрический ' },
      'webGallery-3311626-default-1': { coverImage: 'https://ir.ozone.ru/s3/multimedia-1/1.jpg' },
    }),
  );
  assert.deepEqual(result, {
    title: 'Чайник электрический',
    image: 'https://ir.ozone.ru/s3/multimedia-1/1.jpg',
    price: 2199,
    cardPrice: 2057,
    available: true,
  });
});

test('parseProductPage: нет в наличии', () => {
  const result = parseProductPage(
    page({ 'webOutOfStock-1-default-1': { productTitle: 'Чайник', coverImage: 'http://insecure/x.jpg', price: '1 999 ₽' } }),
  );
  assert.equal(result.available, false);
  assert.equal(result.title, 'Чайник');
  assert.equal(result.price, 1999);
  assert.equal(result.image, null);
});

test('parseProductPage: запасной разбор из ld+json', () => {
  const ld = { name: 'Книга', image: 'https://cdn1.ozone.ru/b.jpg', offers: { price: '549', availability: 'http://schema.org/InStock' } };
  const result = parseProductPage(page({}, { script: [{ type: 'application/ld+json', innerHTML: JSON.stringify(ld) }] }));
  assert.deepEqual(result, { title: 'Книга', image: 'https://cdn1.ozone.ru/b.jpg', price: 549, cardPrice: null, available: true });
});

test('parseProductPage: пустая страница — ошибка разбора', () => {
  assert.throws(() => parseProductPage({ widgetStates: {} }), (err) => err instanceof OzonError && err.code === 'parse');
});
