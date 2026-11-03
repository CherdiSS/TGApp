import dataclasses
import hashlib
import hmac
import json
import time
from contextlib import asynccontextmanager
from urllib.parse import urlencode

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import auth
from app.api import router
from app.auth import InitDataError, validate_init_data
from app.bot import TRANSITIONS, format_order_for_owner, owner_keyboard
from app.db import Database

TOKEN = "123456:TEST-TOKEN"
ADMIN_ID = 777
USER_ID = 42


def make_init_data(user: dict, token: str = TOKEN, auth_date: int | None = None, **extra) -> str:
    fields = {
        "query_id": "AAH",
        "user": json.dumps(user, separators=(",", ":")),
        "auth_date": str(auth_date or int(time.time())),
        **extra,
    }
    dcs = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    fields["hash"] = hmac.new(secret, dcs.encode(), hashlib.sha256).hexdigest()
    return urlencode(fields)


def hdr(user_id: int = USER_ID, **kw) -> dict:
    user = {"id": user_id, "first_name": "Иван", "username": "ivan"}
    return {"Authorization": "tma " + make_init_data(user, **kw)}


# ---------- initData ----------

def test_valid_init_data():
    data = validate_init_data(make_init_data({"id": 1, "first_name": "A"}), TOKEN)
    assert data["user"]["id"] == 1


def test_signature_field_is_part_of_check_string():
    raw = make_init_data({"id": 1, "first_name": "A"}, signature="abc")
    assert validate_init_data(raw, TOKEN)["signature"] == "abc"


def test_tampered_user_rejected():
    raw = make_init_data({"id": 1, "first_name": "A"})
    forged = raw.replace("%22id%22%3A1", "%22id%22%3A2")
    assert forged != raw
    with pytest.raises(InitDataError, match="signature"):
        validate_init_data(forged, TOKEN)


def test_wrong_token_rejected():
    with pytest.raises(InitDataError):
        validate_init_data(make_init_data({"id": 1}), "other:token")


def test_expired_rejected():
    raw = make_init_data({"id": 1}, auth_date=int(time.time()) - 100_000)
    with pytest.raises(InitDataError, match="expired"):
        validate_init_data(raw, TOKEN, max_age=3600)


def test_missing_hash_rejected():
    with pytest.raises(InitDataError):
        validate_init_data("user=%7B%7D&auth_date=1", TOKEN)


# ---------- API ----------

class FakeNotifier:
    def __init__(self):
        self.orders = []

    async def notify_new_order(self, order):
        self.orders.append(order)


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(
        auth, "settings",
        dataclasses.replace(auth.settings, bot_token=TOKEN, admin_ids={ADMIN_ID}, dev_mode=False),
    )
    notifier = FakeNotifier()

    @asynccontextmanager
    async def lifespan(app):
        db = Database(":memory:")
        await db.connect()
        app.state.db = db
        app.state.notifier = notifier
        yield
        await db.close()

    app = FastAPI(lifespan=lifespan)
    app.include_router(router)
    with TestClient(app) as c:
        c.notifier = notifier
        yield c


def first_item(client):
    return client.get("/api/menu").json()[0]["items"][0]


def test_menu_is_public_and_seeded(client):
    menu = client.get("/api/menu").json()
    assert len(menu) >= 5
    assert all(c["items"] for c in menu)


def test_order_requires_init_data(client):
    r = client.post("/api/orders", json={"items": [{"item_id": 1, "qty": 1}]})
    assert r.status_code == 401


def test_order_with_forged_init_data(client):
    r = client.post("/api/orders", json={"items": [{"item_id": 1, "qty": 1}]},
                    headers=hdr(token="999:EVIL"))
    assert r.status_code == 401


def test_create_order_uses_server_prices(client):
    item = first_item(client)
    r = client.post(
        "/api/orders",
        json={"items": [{"item_id": item["id"], "qty": 2, "price": 1}], "comment": " без сахара "},
        headers=hdr(),
    )
    assert r.status_code == 201, r.text
    order = r.json()
    assert order["total"] == item["price"] * 2
    assert order["status"] == "new"
    assert order["comment"] == "без сахара"
    assert client.notifier.orders[0]["user_id"] == USER_ID

    mine = client.get("/api/orders", headers=hdr()).json()
    assert [o["id"] for o in mine] == [order["id"]]
    # чужой пользователь не видит заказ
    assert client.get(f"/api/orders/{order['id']}", headers=hdr(user_id=5)).status_code == 404


def test_unavailable_item_rejected(client):
    item = first_item(client)
    r = client.patch(f"/api/admin/items/{item['id']}", json={"available": False},
                     headers=hdr(ADMIN_ID))
    assert r.status_code == 200
    assert item["id"] not in [i["id"] for c in client.get("/api/menu").json() for i in c["items"]]
    r = client.post("/api/orders", json={"items": [{"item_id": item["id"], "qty": 1}]},
                    headers=hdr())
    assert r.status_code == 409


def test_admin_requires_admin(client):
    assert client.get("/api/admin/menu", headers=hdr()).status_code == 403
    assert client.get("/api/me", headers=hdr()).json()["is_admin"] is False
    assert client.get("/api/me", headers=hdr(ADMIN_ID)).json()["is_admin"] is True


def test_admin_crud(client):
    h = hdr(ADMIN_ID)
    cat = client.post("/api/admin/categories", json={"name": "Супы", "emoji": "🍲"}, headers=h).json()
    item = client.post("/api/admin/items", json={
        "category_id": cat["id"], "name": "Том ям", "price": 590}, headers=h)
    assert item.status_code == 201
    item = item.json()
    assert client.patch(f"/api/admin/items/{item['id']}", json={"price": 610},
                        headers=h).json()["price"] == 610
    bad = client.post("/api/admin/items", json={"category_id": 9999, "name": "x", "price": 1},
                      headers=h)
    assert bad.status_code == 400
    assert client.delete(f"/api/admin/items/{item['id']}", headers=h).status_code == 204
    assert client.delete(f"/api/admin/categories/{cat['id']}", headers=h).status_code == 204


# ---------- бот ----------

def test_owner_message_and_keyboard():
    order = {"id": 7, "status": "new", "user_id": 1, "user_name": "<Bob>", "username": None,
             "items": [{"name": "Латте", "price": 240, "qty": 2}], "total": 480,
             "comment": "", "pickup_time": "к 12:30"}
    text = format_order_for_owner(order)
    assert "&lt;Bob&gt;" in text and "480 ₽" in text and "к 12:30" in text
    kb = owner_keyboard(order)
    assert [b.callback_data for b in kb.inline_keyboard[0]] == ["order:7:accepted", "order:7:cancelled"]
    assert owner_keyboard({**order, "status": "completed"}) is None


async def test_status_transitions_are_guarded():
    db = Database(":memory:")
    await db.connect(seed=False)
    o = await db.create_order(user_id=1, user_name="A", username=None, items=[], total=0,
                              comment="", pickup_time="")
    # нельзя сразу из new в ready
    assert await db.set_status(o["id"], "ready", TRANSITIONS["ready"]) is None
    assert (await db.set_status(o["id"], "accepted", TRANSITIONS["accepted"]))["status"] == "accepted"
    # повторное нажатие «Принят» ничего не делает
    assert await db.set_status(o["id"], "accepted", TRANSITIONS["accepted"]) is None
    await db.close()


# ---------- кнопки владельца (с подменённым Telegram API) ----------

class FakeTgBot:
    def __init__(self):
        self.sent, self.edited = [], []

    async def send_message(self, chat_id, text, reply_markup=None):
        self.sent.append((chat_id, text))
        from types import SimpleNamespace
        return SimpleNamespace(chat=SimpleNamespace(id=chat_id), message_id=len(self.sent))

    async def edit_message_text(self, chat_id, message_id, text, reply_markup=None):
        self.edited.append((chat_id, message_id, text, reply_markup))


class FakeCallback:
    def __init__(self, data, user_id, chat_id):
        from types import SimpleNamespace
        self.data = data
        self.from_user = SimpleNamespace(id=user_id)
        self.message = SimpleNamespace(chat=SimpleNamespace(id=chat_id))
        self.answers = []

    async def answer(self, text=None, show_alert=False):
        self.answers.append(text)


async def test_owner_buttons_flow(monkeypatch):
    from app import bot as bot_module
    from app.bot import CafeBot

    OWNER = -100500
    monkeypatch.setattr(bot_module, "settings", dataclasses.replace(
        bot_module.settings, owner_chat_id=OWNER, admin_ids={ADMIN_ID}, webapp_url=""))
    db = Database(":memory:")
    await db.connect()
    cafe = CafeBot(TOKEN, db)
    fake = FakeTgBot()
    cafe.bot = fake

    items = [{"item_id": 1, "name": "Латте", "price": 240, "qty": 1}]
    order = await db.create_order(user_id=USER_ID, user_name="Иван", username="ivan",
                                  items=items, total=240, comment="", pickup_time="")
    await cafe.notify_new_order(order)
    assert [c for c, _ in fake.sent] == [OWNER, USER_ID]  # владельцу и клиенту

    # посторонний не может менять статус
    cb = FakeCallback(f"order:{order['id']}:accepted", user_id=999, chat_id=999)
    await cafe._handle_status_callback(cb)
    assert cb.answers == ["Нет доступа"]
    assert (await db.get_order(order["id"]))["status"] == "new"

    # сотрудник в группе нажимает «Принят», затем «Готов»
    for st in ("accepted", "ready"):
        await cafe._handle_status_callback(FakeCallback(f"order:{order['id']}:{st}", 1, OWNER))
    assert (await db.get_order(order["id"]))["status"] == "ready"
    assert "готов" in fake.sent[-1][1] and fake.sent[-1][0] == USER_ID
    assert "Готов к выдаче" in fake.edited[-1][2]
    await db.close()
