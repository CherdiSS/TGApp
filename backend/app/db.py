"""SQLite-хранилище: меню и заказы."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import aiosqlite

SCHEMA = """
CREATE TABLE IF NOT EXISTS categories (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL,
    emoji TEXT NOT NULL DEFAULT '',
    sort  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price       INTEGER NOT NULL CHECK (price >= 0),
    weight      TEXT NOT NULL DEFAULT '',
    image_url   TEXT NOT NULL DEFAULT '',
    available   INTEGER NOT NULL DEFAULT 1,
    sort        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL,
    user_name        TEXT NOT NULL,
    username         TEXT,
    items_json       TEXT NOT NULL,
    total            INTEGER NOT NULL,
    comment          TEXT NOT NULL DEFAULT '',
    pickup_time      TEXT NOT NULL DEFAULT '',
    status           TEXT NOT NULL DEFAULT 'new',
    owner_chat_id    INTEGER,
    owner_message_id INTEGER,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, id DESC);
"""

_U = "https://images.unsplash.com/{}?w=600&q=70&auto=format&fit=crop"

SEED: list[tuple[str, str, list[tuple[str, str, int, str, str]]]] = [
    ("Кофе", "☕", [
        ("Капучино", "Двойной эспрессо и бархатная молочная пена", 220, "300 мл",
         "photo-1572442388796-11668a67e53d"),
        ("Латте", "Мягкий кофе с большим количеством молока", 240, "400 мл",
         "photo-1517701604599-bb29b565090c"),
        ("Айс-латте", "Эспрессо, холодное молоко и лёд", 260, "400 мл",
         "photo-1461023058943-07fcbe16d735"),
    ]),
    ("Завтраки", "🥞", [
        ("Панкейки с черникой", "Три пышных панкейка, кленовый сироп, ягоды", 390, "250 г",
         "photo-1528207776546-365bb710ee93"),
        ("Французские тосты", "Бриошь, банан, черника и сахарная пудра", 420, "230 г",
         "photo-1484723091739-30a097e8f929"),
        ("Круассан", "Сливочный, из слоёного теста, выпекаем утром", 180, "80 г",
         "photo-1555507036-ab1f4038808a"),
    ]),
    ("Горячее", "🍔", [
        ("Бургер с говядиной", "Котлета 180 г, чеддер, соус барбекю, бриошь", 590, "350 г",
         "photo-1568901346375-23c9450c58cd"),
        ("Пицца с курицей", "Тонкое тесто, моцарелла, курица, красный лук", 650, "30 см",
         "photo-1565299624946-b28f40a0ae38"),
        ("Пенне арабьята", "Острый томатный соус, пармезан, базилик", 460, "300 г",
         "photo-1621996346565-e3dbc646d9a9"),
        ("Стейк с картофелем фри", "Мраморная говядина, фри, зелёное масло", 1190, "380 г",
         "photo-1600891964092-4316c288032e"),
    ]),
    ("Салаты", "🥗", [
        ("Цезарь с курицей", "Романо, курица гриль, гренки, пармезан", 450, "240 г",
         "photo-1546793665-c74683f339c1"),
        ("Боул с авокадо", "Авокадо, нут, батат, черри, микрозелень", 490, "320 г",
         "photo-1512621776951-a57141f2eefd"),
    ]),
    ("Напитки", "🍹", [
        ("Манго-лимонад", "Пюре манго, лайм, газированная вода", 290, "400 мл",
         "photo-1546173159-315724a31696"),
        ("Холодный чай", "Чёрный чай, лимон, лайм и лёд", 250, "400 мл",
         "photo-1556679343-c7306c1976bc"),
    ]),
    ("Десерты", "🍰", [
        ("Шоколадный торт", "Бисквит, ганаш из бельгийского шоколада", 340, "150 г",
         "photo-1578985545062-69928b1d9587"),
        ("Панна-котта", "Сливочная, с клубничным соусом", 290, "140 г",
         "photo-1488477181946-6428a0291777"),
        ("Донаты", "Два пончика с глазурью и посыпкой", 230, "2 шт",
         "photo-1551024601-bec78aea704b"),
    ]),
]


class Database:
    def __init__(self, path: Path | str):
        self.path = Path(path)
        self.conn: aiosqlite.Connection | None = None

    async def connect(self, seed: bool = True) -> None:
        if str(self.path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = await aiosqlite.connect(self.path)
        self.conn.row_factory = aiosqlite.Row
        await self.conn.execute("PRAGMA foreign_keys = ON")
        await self.conn.execute("PRAGMA journal_mode = WAL")
        await self.conn.executescript(SCHEMA)
        await self.conn.commit()
        if seed:
            await self._seed_if_empty()

    async def close(self) -> None:
        if self.conn:
            await self.conn.close()
            self.conn = None

    @property
    def c(self) -> aiosqlite.Connection:
        assert self.conn is not None, "Database is not connected"
        return self.conn

    async def _seed_if_empty(self) -> None:
        async with self.c.execute("SELECT COUNT(*) FROM categories") as cur:
            (count,) = await cur.fetchone()
        if count:
            return
        for c_sort, (cat, emoji, items) in enumerate(SEED):
            cur = await self.c.execute(
                "INSERT INTO categories (name, emoji, sort) VALUES (?, ?, ?)",
                (cat, emoji, c_sort),
            )
            cat_id = cur.lastrowid
            for i_sort, (name, desc, price, weight, photo) in enumerate(items):
                await self.c.execute(
                    "INSERT INTO items (category_id, name, description, price, weight, "
                    "image_url, sort) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (cat_id, name, desc, price, weight, _U.format(photo), i_sort),
                )
        await self.c.commit()

    # ---------- меню ----------

    async def get_menu(self, include_unavailable: bool = False) -> list[dict[str, Any]]:
        async with self.c.execute("SELECT * FROM categories ORDER BY sort, id") as cur:
            cats = [dict(r) for r in await cur.fetchall()]
        q = "SELECT * FROM items"
        if not include_unavailable:
            q += " WHERE available = 1"
        q += " ORDER BY sort, id"
        async with self.c.execute(q) as cur:
            items = [_item(r) for r in await cur.fetchall()]
        by_cat: dict[int, list] = {c["id"]: [] for c in cats}
        for it in items:
            by_cat.setdefault(it["category_id"], []).append(it)
        for c in cats:
            c["items"] = by_cat.get(c["id"], [])
        if not include_unavailable:
            cats = [c for c in cats if c["items"]]
        return cats

    async def get_items_by_ids(self, ids: list[int]) -> dict[int, dict[str, Any]]:
        if not ids:
            return {}
        marks = ",".join("?" * len(ids))
        async with self.c.execute(f"SELECT * FROM items WHERE id IN ({marks})", ids) as cur:
            return {r["id"]: _item(r) for r in await cur.fetchall()}

    async def get_item(self, item_id: int) -> dict[str, Any] | None:
        async with self.c.execute("SELECT * FROM items WHERE id = ?", (item_id,)) as cur:
            r = await cur.fetchone()
        return _item(r) if r else None

    async def create_item(self, data: dict[str, Any]) -> dict[str, Any]:
        cols = ["category_id", "name", "description", "price", "weight", "image_url",
                "available", "sort"]
        vals = [data.get(c) for c in cols]
        vals[6] = int(bool(data.get("available", True)))
        vals[7] = data.get("sort") or 0
        vals[2] = vals[2] or ""
        vals[4] = vals[4] or ""
        vals[5] = vals[5] or ""
        cur = await self.c.execute(
            f"INSERT INTO items ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
            vals,
        )
        await self.c.commit()
        return await self.get_item(cur.lastrowid)  # type: ignore[return-value]

    async def update_item(self, item_id: int, data: dict[str, Any]) -> dict[str, Any] | None:
        allowed = {"category_id", "name", "description", "price", "weight", "image_url",
                   "available", "sort"}
        fields = {k: v for k, v in data.items() if k in allowed and v is not None}
        if "available" in fields:
            fields["available"] = int(bool(fields["available"]))
        if fields:
            sets = ", ".join(f"{k} = ?" for k in fields)
            await self.c.execute(
                f"UPDATE items SET {sets} WHERE id = ?", [*fields.values(), item_id]
            )
            await self.c.commit()
        return await self.get_item(item_id)

    async def delete_item(self, item_id: int) -> bool:
        cur = await self.c.execute("DELETE FROM items WHERE id = ?", (item_id,))
        await self.c.commit()
        return cur.rowcount > 0

    async def create_category(self, name: str, emoji: str = "") -> dict[str, Any]:
        async with self.c.execute("SELECT COALESCE(MAX(sort), -1) + 1 FROM categories") as cur:
            (sort,) = await cur.fetchone()
        cur = await self.c.execute(
            "INSERT INTO categories (name, emoji, sort) VALUES (?, ?, ?)", (name, emoji, sort)
        )
        await self.c.commit()
        return {"id": cur.lastrowid, "name": name, "emoji": emoji, "sort": sort, "items": []}

    async def update_category(self, cat_id: int, name: str | None, emoji: str | None) -> bool:
        cur = await self.c.execute(
            "UPDATE categories SET name = COALESCE(?, name), emoji = COALESCE(?, emoji) "
            "WHERE id = ?",
            (name, emoji, cat_id),
        )
        await self.c.commit()
        return cur.rowcount > 0

    async def delete_category(self, cat_id: int) -> bool:
        cur = await self.c.execute("DELETE FROM categories WHERE id = ?", (cat_id,))
        await self.c.commit()
        return cur.rowcount > 0

    # ---------- заказы ----------

    async def create_order(
        self,
        *,
        user_id: int,
        user_name: str,
        username: str | None,
        items: list[dict[str, Any]],
        total: int,
        comment: str,
        pickup_time: str,
    ) -> dict[str, Any]:
        cur = await self.c.execute(
            "INSERT INTO orders (user_id, user_name, username, items_json, total, comment, "
            "pickup_time) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (user_id, user_name, username, json.dumps(items, ensure_ascii=False), total,
             comment, pickup_time),
        )
        await self.c.commit()
        return await self.get_order(cur.lastrowid)  # type: ignore[return-value]

    async def get_order(self, order_id: int) -> dict[str, Any] | None:
        async with self.c.execute("SELECT * FROM orders WHERE id = ?", (order_id,)) as cur:
            r = await cur.fetchone()
        return _order(r) if r else None

    async def list_user_orders(self, user_id: int, limit: int = 20) -> list[dict[str, Any]]:
        async with self.c.execute(
            "SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT ?", (user_id, limit)
        ) as cur:
            return [_order(r) for r in await cur.fetchall()]

    async def set_owner_message(self, order_id: int, chat_id: int, message_id: int) -> None:
        await self.c.execute(
            "UPDATE orders SET owner_chat_id = ?, owner_message_id = ? WHERE id = ?",
            (chat_id, message_id, order_id),
        )
        await self.c.commit()

    async def set_status(
        self, order_id: int, new_status: str, expected: set[str] | None = None
    ) -> dict[str, Any] | None:
        """Меняет статус. Если задан `expected` — только из этих статусов (защита от гонок)."""
        q = ("UPDATE orders SET status = ?, "
             "updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?")
        params: list[Any] = [new_status, order_id]
        if expected:
            q += f" AND status IN ({','.join('?' * len(expected))})"
            params += sorted(expected)
        cur = await self.c.execute(q, params)
        await self.c.commit()
        if cur.rowcount == 0:
            return None
        return await self.get_order(order_id)


def _item(r: aiosqlite.Row) -> dict[str, Any]:
    d = dict(r)
    d["available"] = bool(d["available"])
    return d


def _order(r: aiosqlite.Row) -> dict[str, Any]:
    d = dict(r)
    d["items"] = json.loads(d.pop("items_json"))
    return d
