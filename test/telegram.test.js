import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { validateInitData } from '../src/telegram.js';

const TOKEN = '123456:TEST-TOKEN';

function sign(fields, token = TOKEN) {
  const checkString = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(checkString).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const nowSec = 1_800_000_000;
const fields = { auth_date: String(nowSec - 60), query_id: 'AAE', user: JSON.stringify({ id: 42, first_name: 'Тест' }) };

test('validateInitData: верная подпись', () => {
  assert.deepEqual(validateInitData(sign(fields), TOKEN, nowSec), { id: 42, first_name: 'Тест' });
});

test('validateInitData: чужой токен, подмена, протухание', () => {
  assert.equal(validateInitData(sign(fields, 'other:token'), TOKEN, nowSec), null);
  const tampered = sign(fields).replace('%22id%22%3A42', '%22id%22%3A43');
  assert.equal(validateInitData(tampered, TOKEN, nowSec), null);
  assert.equal(validateInitData(sign(fields), TOKEN, nowSec + 2 * 86400), null);
  assert.equal(validateInitData('', TOKEN, nowSec), null);
  assert.equal(validateInitData('hash=zz', TOKEN, nowSec), null);
});
