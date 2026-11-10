import { config } from './config.js';
import { openDb } from './db.js';
import { startBot } from './bot.js';
import { startScheduler } from './monitor.js';
import { createApp } from './server.js';
import { createTelegram } from './telegram.js';

if (!config.botToken && !config.devUserId) {
  console.error('Нужен BOT_TOKEN (или DEV_USER_ID для локальной разработки). См. .env.example');
  process.exit(1);
}
if (config.devUserId) {
  console.warn('⚠️  DEV_USER_ID задан: API пускает без проверки подписи Telegram. Не для продакшена.');
}
if (config.ozonMock) console.warn('⚠️  OZON_MOCK: цены ненастоящие.');

const db = openDb(config.dbPath);
const tg = config.botToken ? createTelegram(config.botToken) : null;
const ctx = { db, tg };

const server = createApp(ctx);
server.listen(config.port, () => console.log(`HTTP: http://localhost:${config.port}`));

const stopScheduler = startScheduler(ctx);
const stopBot = tg ? startBot(ctx) : () => {};

function shutdown() {
  stopScheduler();
  stopBot();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
