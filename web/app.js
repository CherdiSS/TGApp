const tg = window.Telegram?.WebApp;
const root = document.getElementById('app');
const toastEl = document.getElementById('toast');

const state = { items: [], maxItems: 50, checkIntervalMin: 60, loading: true, fatal: null, openSku: null };

// ---------- утилиты ----------

const fmt = new Intl.NumberFormat('ru-RU');
const rub = (n) => `${fmt.format(n)} ₽`;
const SVG_NS = 'http://www.w3.org/2000/svg';

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

function svg(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

let toastTimer;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

const haptic = (kind) => {
  try {
    if (kind === 'tap') tg?.HapticFeedback?.impactOccurred('light');
    else tg?.HapticFeedback?.notificationOccurred(kind);
  } catch {
    /* старые клиенты */
  }
};

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`api/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `tma ${tg?.initData ?? ''}` },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Нет связи с сервером');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message ?? 'Что-то пошло не так');
    err.status = res.status;
    throw err;
  }
  return data;
}

function timeAgo(ts) {
  if (!ts) return 'ещё не проверялся';
  const min = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60));
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.round(hours / 24)} дн назад`;
}

const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });

/** Изменение цены относительно момента добавления. */
function delta(item) {
  if (item.price == null || !item.addedPrice || item.price === item.addedPrice) return null;
  const pct = ((item.price - item.addedPrice) / item.addedPrice) * 100;
  const abs = Math.abs(pct);
  const text = `${pct < 0 ? '−' : '+'}${abs < 10 ? abs.toFixed(1).replace('.', ',') : Math.round(abs)}%`;
  return { text, down: pct < 0 };
}

/** Ступенчатая линия: цена держится до следующего изменения и тянется до «сейчас». */
function stepPoints(history, nowTs) {
  const pts = [];
  history.forEach((point, i) => {
    if (i > 0) pts.push([point.t, history[i - 1].p]);
    pts.push([point.t, point.p]);
  });
  const last = history[history.length - 1];
  if (last && nowTs > last.t) pts.push([nowTs, last.p]);
  return pts;
}

function thumb(item, big = false) {
  const cls = `thumb${big ? ' big' : ''}`;
  if (!item.image) return h('div', { class: cls }, '🛍');
  const img = h('img', { class: cls, src: item.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.replaceWith(h('div', { class: cls }, '🛍')));
  return img;
}

// ---------- список ----------

function sparkline(item) {
  if (item.history.length < 2) return null;
  const nowTs = Date.now() / 1000;
  const pts = stepPoints(item.history, nowTs);
  const t0 = pts[0][0];
  const span = Math.max(1, nowTs - t0);
  const lo = Math.min(...pts.map((p) => p[1]));
  const hi = Math.max(...pts.map((p) => p[1]));
  const range = Math.max(1, hi - lo);
  const d = pts
    .map(([t, p], i) => `${i ? 'L' : 'M'}${(((t - t0) / span) * 64).toFixed(1)} ${(20 - ((p - lo) / range) * 18).toFixed(1)}`)
    .join('');
  const first = item.history[0].p;
  const color = item.price < first ? 'var(--good)' : item.price > first ? 'var(--bad)' : 'var(--hint)';
  const el = svg('svg', { class: 'spark', viewBox: '0 0 64 22', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  const path = svg('path', { d });
  path.style.stroke = color;
  el.append(path);
  return el;
}

function priceLabel(item) {
  if (item.status === 'pending') return h('div', { class: 'price off' }, 'ждёт проверки');
  if (!item.available) return h('div', { class: 'price off' }, 'нет в наличии');
  return h('div', { class: 'price num' }, rub(item.price));
}

function itemRow(item) {
  const d = delta(item);
  const reached = item.targetPrice != null && item.available && item.price != null && item.price <= item.targetPrice;
  return h(
    'button',
    { class: 'item', onclick: () => openItem(item.sku) },
    thumb(item),
    h(
      'div',
      { class: 'body' },
      h('div', { class: 'title' }, item.title ?? `Товар ${item.sku}`),
      h(
        'div',
        { class: 'meta' },
        d && h('span', { class: `chip num ${d.down ? 'good' : 'bad'}` }, d.text),
        item.targetPrice != null &&
          h('span', { class: `chip num ${reached ? 'good' : ''}` }, `${reached ? '🎯' : 'цель'} ${rub(item.targetPrice)}`),
        !d && item.targetPrice == null && h('span', {}, timeAgo(item.lastCheckedAt)),
      ),
    ),
    h('div', { class: 'side' }, priceLabel(item), sparkline(item)),
  );
}

function listView() {
  const input = h('input', {
    class: 'field',
    type: 'text',
    inputmode: 'url',
    enterkeyhint: 'done',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    placeholder: 'Ссылка на товар или артикул',
    'aria-label': 'Ссылка на товар Ozon или артикул',
  });
  const button = h('button', { class: 'btn', type: 'submit' }, 'Добавить');
  const form = h('form', { class: 'add' }, input, button);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const url = input.value.trim();
    if (!url || button.disabled) return;
    button.disabled = true;
    button.textContent = 'Ищу…';
    try {
      const { item, pending } = await api('POST', 'items', { url });
      state.items.unshift(item);
      haptic('success');
      toast(pending ? 'Добавлено. Ozon пока не отдал цену — проверим позже' : 'Добавлено');
      render();
    } catch (err) {
      haptic('error');
      toast(err.message);
      button.disabled = false;
      button.textContent = 'Добавить';
    }
  });

  let body;
  if (state.loading) {
    body = h('div', { class: 'list' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }));
  } else if (!state.items.length) {
    body = h(
      'div',
      { class: 'empty' },
      h('div', { class: 'glyph' }, '🏷'),
      h('b', {}, 'Пока пусто'),
      'Вставьте ссылку на товар с Ozon — и мы напишем в Telegram, когда он подешевеет.',
    );
  } else {
    body = h('div', { class: 'list' }, state.items.map(itemRow));
  }

  return [
    h(
      'div',
      { class: 'head' },
      h('h1', {}, 'Цены Ozon'),
      !state.loading && h('span', { class: 'num' }, `${state.items.length} из ${state.maxItems}`),
    ),
    form,
    body,
    state.items.length > 0 &&
      h('div', { class: 'foot' }, `Цены перепроверяются примерно раз в ${intervalText(state.checkIntervalMin)}`),
  ];
}

function intervalText(min) {
  if (min < 60) return `${min} мин`;
  const hours = Math.round(min / 60);
  return hours === 1 ? 'час' : `${hours} ч`;
}

// ---------- карточка товара ----------

function chart(item) {
  const history = item.history;
  if (!history.length) return h('div', { class: 'sub' }, 'Истории пока нет — появится после первой проверки.');

  const W = 320;
  const H = 150;
  const PAD_TOP = 10;
  const PAD_BOTTOM = 10;
  const nowTs = Math.max(Date.now() / 1000, history[history.length - 1].t + 1);
  const pts = stepPoints(history, nowTs);
  const t0 = pts[0][0];
  const span = Math.max(1, nowTs - t0);

  const values = pts.map((p) => p[1]);
  if (item.targetPrice != null) values.push(item.targetPrice);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi === lo) {
    hi += Math.max(1, hi * 0.05);
    lo -= Math.max(1, lo * 0.05);
  }
  const x = (t) => ((t - t0) / span) * W;
  const y = (p) => PAD_TOP + (1 - (p - lo) / (hi - lo)) * (H - PAD_TOP - PAD_BOTTOM);

  const line = pts.map(([t, p], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)} ${y(p).toFixed(1)}`).join('');
  const el = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img' });
  el.setAttribute('aria-label', `График цены: от ${rub(item.minPrice)} до ${rub(item.maxPrice)}`);
  el.append(
    svg('line', { class: 'grid', x1: 0, x2: W, y1: y(hi), y2: y(hi) }),
    svg('line', { class: 'grid', x1: 0, x2: W, y1: y(lo), y2: y(lo) }),
    svg('path', { class: 'area', d: `${line}L${W} ${H}L0 ${H}Z` }),
    svg('path', { class: 'line', d: line }),
  );
  if (item.targetPrice != null) {
    el.append(svg('line', { class: 'target', x1: 0, x2: W, y1: y(item.targetPrice), y2: y(item.targetPrice) }));
  }
  const cursor = svg('line', { class: 'cursor', y1: 0, y2: H, x1: 0, x2: 0, visibility: 'hidden' });
  el.append(cursor);

  const dot = h('div', { class: 'dot', hidden: true });
  const box = h(
    'div',
    { class: 'chart' },
    el,
    h('div', { class: 'ylabel num', style: `top:${(y(hi) / H) * 100}%` }, rub(Math.round(hi))),
    h('div', { class: 'ylabel num', style: `top:${(y(lo) / H) * 100}%` }, rub(Math.round(lo))),
    dot,
  );

  const idle = [h('span', {}, dayFmt.format(new Date(t0 * 1000))), h('span', {}, 'сейчас')];
  const readout = h('div', { class: 'readout' }, idle);

  function point(event) {
    const rect = box.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const t = t0 + ratio * span;
    let current = history[0];
    for (const p of history) if (p.t <= t) current = p;
    cursor.setAttribute('x1', x(t));
    cursor.setAttribute('x2', x(t));
    cursor.setAttribute('visibility', 'visible');
    dot.hidden = false;
    dot.style.left = `${ratio * 100}%`;
    dot.style.top = `${(y(current.p) / H) * 100}%`;
    readout.replaceChildren(
      h('span', {}, dateFmt.format(new Date(t * 1000))),
      h('b', { class: 'num' }, current.a ? rub(current.p) : `${rub(current.p)} · нет в наличии`),
    );
  }
  function leave() {
    cursor.setAttribute('visibility', 'hidden');
    dot.hidden = true;
    readout.replaceChildren(...idle);
  }
  box.addEventListener('pointerdown', point);
  box.addEventListener('pointermove', point);
  box.addEventListener('pointerleave', leave);
  box.addEventListener('pointercancel', leave);

  return [box, readout];
}

function replaceItem(item) {
  const index = state.items.findIndex((it) => it.sku === item.sku);
  if (index >= 0) state.items[index] = item;
}

function detailView(item) {
  const d = delta(item);

  const targetInput = h('input', {
    class: 'field num',
    type: 'text',
    inputmode: 'numeric',
    enterkeyhint: 'done',
    placeholder: item.price ? `например, ${fmt.format(Math.floor(item.price * 0.9))}` : 'Цена в рублях',
    value: item.targetPrice ?? '',
    'aria-label': 'Желаемая цена в рублях',
  });
  const saveBtn = h('button', { class: 'btn', type: 'submit' }, 'Сохранить');
  const targetForm = h('form', { class: 'target-row' }, targetInput, saveBtn);
  targetForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const raw = targetInput.value.replace(/[\s ₽]/g, '');
    if (raw && !/^\d{1,9}$/.test(raw)) return toast('Введите цену целым числом');
    saveBtn.disabled = true;
    try {
      const { item: updated } = await api('PATCH', `items/${item.sku}`, { targetPrice: raw ? Number(raw) : null });
      replaceItem(updated);
      haptic('success');
      toast(raw ? 'Напишем, когда цена дойдёт до цели' : 'Цель убрана');
      render();
    } catch (err) {
      haptic('error');
      toast(err.message);
      saveBtn.disabled = false;
    }
  });

  const refreshBtn = h('button', { class: 'btn ghost' }, 'Обновить');
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Проверяю…';
    try {
      const { item: updated, refreshed } = await api('POST', `items/${item.sku}/refresh`);
      replaceItem(updated);
      toast(refreshed ? 'Цена обновлена' : 'Цена и так свежая');
    } catch (err) {
      haptic('error');
      toast(err.message);
    }
    render();
  });

  const removeBtn = h('button', { class: 'btn danger' }, 'Удалить');
  removeBtn.addEventListener('click', () => {
    const run = async (ok) => {
      if (!ok) return;
      try {
        await api('DELETE', `items/${item.sku}`);
        state.items = state.items.filter((it) => it.sku !== item.sku);
        haptic('success');
        closeItem();
      } catch (err) {
        toast(err.message);
      }
    };
    if (tg?.showConfirm && tg.isVersionAtLeast?.('6.2')) tg.showConfirm('Перестать следить за этим товаром?', run);
    else run(window.confirm('Перестать следить за этим товаром?'));
  });

  const openOzon = () => {
    if (tg?.openLink && tg.initData) tg.openLink(item.url);
    else window.open(item.url, '_blank', 'noopener');
  };

  let nowBlock;
  if (item.status === 'pending') {
    nowBlock = h('div', { class: 'now' }, h('span', { class: 'old' }, 'Ozon пока не отдал цену — проверим позже'));
  } else {
    nowBlock = h(
      'div',
      { class: 'now' },
      h('span', { class: 'big num' }, rub(item.price)),
      item.regularPrice != null && h('span', { class: 'old num' }, `без карты ${rub(item.regularPrice)}`),
      d && h('span', { class: `chip num ${d.down ? 'good' : 'bad'}` }, `${d.text} с добавления`),
    );
  }

  const statusLine = [
    !item.available && item.status !== 'pending' ? 'Нет в наличии · ' : '',
    `Проверено: ${timeAgo(item.lastCheckedAt)}`,
    item.status === 'stale' ? ' · последняя попытка не удалась' : '',
  ].join('');

  return [
    !tg?.initData && h('button', { class: 'back', onclick: closeItem }, '‹ Назад'),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'hero' }, thumb(item, true), h('div', { class: 'title' }, item.title ?? `Товар ${item.sku}`)),
      nowBlock,
      h('div', { class: 'sub' }, statusLine),
    ),
    h(
      'div',
      { class: 'card' },
      h('h2', {}, 'История цены'),
      chart(item),
      item.history.length > 0 &&
        h(
          'div',
          { class: 'stats' },
          h('div', {}, 'Минимум', h('b', { class: 'num' }, rub(item.minPrice))),
          h('div', {}, 'Максимум', h('b', { class: 'num' }, rub(item.maxPrice))),
          h('div', {}, 'При добавлении', h('b', { class: 'num' }, item.addedPrice ? rub(item.addedPrice) : '—')),
        ),
    ),
    h(
      'div',
      { class: 'card' },
      h('h2', {}, 'Желаемая цена'),
      targetForm,
      h(
        'div',
        { class: 'hintline' },
        item.targetPrice != null
          ? 'Сообщим один раз, когда цена опустится до цели. Очистите поле, чтобы получать уведомления о любом заметном снижении.'
          : 'Без цели сообщаем о каждом заметном снижении цены и о возвращении в продажу.',
      ),
    ),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'btn wide', onclick: openOzon }, 'Открыть на Ozon'),
      h('div', { class: 'pair' }, refreshBtn, removeBtn),
    ),
  ];
}

// ---------- навигация и запуск ----------

function openItem(sku) {
  haptic('tap');
  state.openSku = sku;
  state.scrollY = window.scrollY;
  render();
  window.scrollTo(0, 0);
}

function closeItem() {
  state.openSku = null;
  render();
  window.scrollTo(0, state.scrollY ?? 0);
}

function render() {
  const item = state.openSku && state.items.find((it) => it.sku === state.openSku);
  if (state.openSku && !item) state.openSku = null;

  try {
    if (item) tg?.BackButton?.show();
    else tg?.BackButton?.hide();
  } catch {
    /* старые клиенты */
  }

  if (state.fatal) {
    root.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'glyph' }, '🔒'), h('b', {}, state.fatal.title), state.fatal.text));
    return;
  }
  root.replaceChildren(...[item ? detailView(item) : listView()].flat().filter(Boolean));
}

async function load() {
  try {
    const data = await api('GET', 'items');
    Object.assign(state, { items: data.items, maxItems: data.maxItems, checkIntervalMin: data.checkIntervalMin });
  } catch (err) {
    state.fatal =
      err.status === 401
        ? { title: 'Откройте через Telegram', text: 'Это мини-приложение работает только внутри Telegram — запустите его из бота.' }
        : { title: 'Не удалось загрузить', text: err.message };
  }
  state.loading = false;
  render();
}

try {
  tg?.ready();
  tg?.expand();
  tg?.BackButton?.onClick(closeItem);
} catch {
  /* вне Telegram */
}
render();
load();
