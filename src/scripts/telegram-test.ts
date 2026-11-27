import 'dotenv/config';
import { TelegramNotifier } from '../notify/telegram.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
if (!token || !chatId) {
  console.error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env first');
  process.exit(1);
}
await new TelegramNotifier(token, chatId).send('✅ <b>FDFS Radar</b> test message — Telegram is wired up.');
console.log('sent');
