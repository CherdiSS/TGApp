const env = process.env;

function num(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: num(env.PORT, 3000),
  botToken: env.BOT_TOKEN || '',
  webappUrl: (env.WEBAPP_URL || '').replace(/\/+$/, ''),
  dbPath: env.DB_PATH || './data/app.db',
  checkIntervalMin: Math.max(5, num(env.CHECK_INTERVAL_MIN, 60)),
  minDropPercent: Math.max(0, num(env.MIN_DROP_PERCENT, 3)),
  maxItemsPerUser: Math.max(1, num(env.MAX_ITEMS_PER_USER, 50)),
  ozonCookie: env.OZON_COOKIE || '',
  ozonMock: env.OZON_MOCK === '1' || env.OZON_MOCK === 'true',
  devUserId: num(env.DEV_USER_ID, 0),
};
