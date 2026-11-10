import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { applyCheck, decide, getItem, removeTracking, setTarget, upsertUser } from '../src/monitor.js';

const T = (over = {}) => ({ target_price: null, added_price: 1000, baseline_price: 1000, target_hit: 0, ...over });
const on = (price) => ({ price, available: true });
const off = (price) => ({ price, available: false });

test('decide: без цели уведомляет только о заметном падении', () => {
  assert.equal(decide(T(), on(1000), on(990), 3).event, null);
  const { event, next } = decide(T(), on(1000), on(900), 3);
  assert.deepEqual(event, { type: 'drop', from: 1000, price: 900 });
  assert.equal(next.baseline_price, 900);
  // медленное сползание копится относительно базовой цены
  assert.equal(decide(T({ baseline_price: 1000 }), on(980), on(965), 3).event.type, 'drop');
});

test('decide: рост поднимает базу и не шумит', () => {
  const { event, next } = decide(T(), on(1000), on(1200), 3);
  assert.equal(event, null);
  assert.equal(next.baseline_price, 1200);
});

test('decide: цель срабатывает один раз на пересечение', () => {
  const t = T({ target_price: 800 });
  assert.equal(decide(t, on(1000), on(900), 3).event, null);
  const hit = decide(t, on(900), on(790), 3);
  assert.deepEqual(hit.event, { type: 'target', price: 790, target: 800 });
  assert.equal(hit.next.target_hit, 1);
  assert.equal(decide({ ...t, ...hit.next }, on(790), on(780), 3).event, null);
  const up = decide({ ...t, ...hit.next }, on(780), on(850), 3);
  assert.equal(up.next.target_hit, 0);
  assert.equal(decide({ ...t, ...up.next }, on(850), on(800), 3).event.type, 'target');
});

test('decide: возврат в наличие и первая проверка', () => {
  assert.equal(decide(T(), on(1000), off(1000), 3).event, null);
  assert.deepEqual(decide(T(), off(1000), on(950), 3).event, { type: 'back_in_stock', price: 950 });
  const first = decide(T({ added_price: null, baseline_price: null }), null, on(500), 3);
  assert.equal(first.event, null);
  assert.deepEqual(first.next, { added_price: 500, baseline_price: 500, target_hit: 0 });
});

function setup() {
  const db = openDb(':memory:');
  upsertUser(db, { id: 1, first_name: 'A' });
  upsertUser(db, { id: 2, first_name: 'B' });
  const product = (price, cardPrice = null, available = true) => ({ title: 'Чайник', image: null, price, cardPrice, available });
  applyCheck(db, '1234567', product(1000), 100);
  for (const id of [1, 2]) {
    db.prepare('INSERT INTO trackings (user_id, sku, added_price, baseline_price, created_at) VALUES (?, ?, 1000, 1000, 100)').run(id, '1234567');
  }
  return { db, product };
}

test('applyCheck: история пишется только при изменениях, уведомления — по подпискам', () => {
  const { db, product } = setup();
  assert.deepEqual(applyCheck(db, '1234567', product(1000), 200), []);
  setTarget(db, 2, '1234567', 700);

  const notes = applyCheck(db, '1234567', product(900, 850), 300);
  assert.deepEqual(notes.map((n) => [n.userId, n.event.type]), [[1, 'drop']]);

  const hit = applyCheck(db, '1234567', product(700), 400);
  assert.deepEqual(hit.map((n) => [n.userId, n.event.type]).sort(), [[1, 'drop'], [2, 'target']]);

  const item = getItem(db, 1, '1234567');
  assert.deepEqual(item.history.map((p) => p.p), [1000, 850, 700]);
  assert.equal(item.minPrice, 700);
  assert.equal(item.addedPrice, 1000);
});

test('applyCheck: пропажа из продажи без цены сохраняет последнюю цену', () => {
  const { db, product } = setup();
  assert.deepEqual(applyCheck(db, '1234567', { ...product(null), available: false }, 200), []);
  const item = getItem(db, 1, '1234567');
  assert.equal(item.price, 1000);
  assert.equal(item.available, false);
  const back = applyCheck(db, '1234567', product(1000), 300);
  assert.equal(back.length, 2);
  assert.equal(back[0].event.type, 'back_in_stock');
});

test('заблокировавшим бота не шлём; товар без подписчиков удаляется', () => {
  const { db, product } = setup();
  db.prepare('UPDATE users SET blocked = 1 WHERE id = 1').run();
  assert.deepEqual(applyCheck(db, '1234567', product(500), 200).map((n) => n.userId), [2]);
  removeTracking(db, 1, '1234567');
  assert.ok(db.prepare('SELECT 1 FROM products').get());
  removeTracking(db, 2, '1234567');
  assert.equal(db.prepare('SELECT 1 FROM products').get(), undefined);
  assert.equal(db.prepare('SELECT 1 FROM price_history').get(), undefined);
});
