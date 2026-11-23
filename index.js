const { Telegraf, Markup } = require('telegraf');
const puppeteer = require('puppeteer');
const fs = require('fs');

// ==========================================
// কনফিগারেশন: এখানে আপনার আসল তথ্যগুলো বসান
// ==========================================
const BOT_TOKEN = '9100726768:AAFIPksNHSbJw6PluOebpFN3nJpUOruUKJA';   // BotFather থেকে পাওয়া টোকেন
const IPRN_EMAIL = 'mirajislam321711@gmail.com';         // ওয়েবসাইটের লগইন ইমেইল
const IPRN_PASSWORD = 'Miraj3217@@';   // ওয়েবসাইটের পাসওয়ার্ড
const GROUP_ID = '-1003930981242';                 // আপনার গ্রুপের আইডি

const SMS_RECORDS_URL = 'https://iprn.pro/sms/?page=0'; // এসএমএস রেকর্ড পেজ লিংক[cite: 2]
const STATS_FILE = './sms_stats.json'; // Today's ও Lifetime SMS হিসাব রাখার ফাইল

const bot = new Telegraf(BOT_TOKEN);

let browserInstance = null;
let sharedPage = null;
let isPollingActive = false;
let lastRefreshClickTime = 0;
let lastSeenRecordSignature = null;

// সাধারণ মেসেজের নিচের বাটন
const refreshOnlyButton = Markup.inlineKeyboard([
  [Markup.button.callback('🔄 Refresh', 'REFRESH_SMS')]
]);

// "কোনো তথ্য পাওয়া যায়নি" মেসেজের নিচের বাটন (Refresh + Delete)
const notFoundButtons = Markup.inlineKeyboard([
  [Markup.button.callback('🔄 Refresh', 'REFRESH_SMS')],
  [Markup.button.callback('🗑️ Delete', 'DELETE_MSG')]
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// নাম্বারের প্রথম ২টি ও শেষের ৪টি সংখ্যা রেখে মাঝের সংখ্যা স্টার (*) করার ফাংশন
function maskPhoneNumber(rawNumber) {
  if (!rawNumber || rawNumber === 'N/A') return '+Unknown';
  const digits = rawNumber.replace(/\D/g, '');
  if (digits.length <= 6) return `+${digits}`;
  const firstTwo = digits.slice(0, 2);
  const lastFour = digits.slice(-4);
  const stars = '*'.repeat(digits.length - 6);
  return `+${firstTwo}${stars}${lastFour}`;
}

// দেশের নাম, পতাকা ও সার্ভিস শনাক্ত করার ফাংশন
function detectCountryAndService(rowText, digits) {
  let country = 'China 🇨🇳';
  if (digits.startsWith('86') || /china/i.test(rowText)) country = 'China 🇨🇳';
  else if (digits.startsWith('1') || /usa|united states/i.test(rowText)) country = 'USA 🇺🇸';
  else if (digits.startsWith('44') || /uk|united kingdom/i.test(rowText)) country = 'UK 🇬🇧';
  else if (digits.startsWith('880') || /bangladesh/i.test(rowText)) country = 'Bangladesh 🇧🇩';
  else if (digits.startsWith('91') || /india/i.test(rowText)) country = 'India 🇮🇳';
  else if (digits.startsWith('7') || /russia/i.test(rowText)) country = 'Russia 🇷🇺';

  let service = 'Telegram';
  if (/whatsapp/i.test(rowText)) service = 'WhatsApp';
  else if (/facebook/i.test(rowText)) service = 'Facebook';
  else if (/google/i.test(rowText)) service = 'Google';
  else if (/tiktok/i.test(rowText)) service = 'TikTok';

  return { country, service };
}

// Today's SMS এবং Lifetime SMS আপডেট করার ফাংশন
function updateSmsStats() {
  const todayStr = new Date().toISOString().split('T')[0];
  let stats = { date: todayStr, todayCount: 0, lifetimeCount: 0 };

  try {
    if (fs.existsSync(STATS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
      stats.lifetimeCount = saved.lifetimeCount || 0;
      if (saved.date === todayStr) {
        stats.todayCount = saved.todayCount || 0;
      }
    }
  } catch (e) {}

  stats.todayCount += 1;
  stats.lifetimeCount += 1;

  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (e) {}

  return stats;
}

// ব্রাউজার এবং শেয়ার্ড পেজ চালু রাখার ফাংশন
async function getReadyPage() {
  if (!browserInstance || !browserInstance.connected) {
    browserInstance = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    });
    sharedPage = null;
  }

  if (!sharedPage || sharedPage.isClosed()) {
    sharedPage = await browserInstance.newPage();
    await sharedPage.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await sharedPage.goto(SMS_RECORDS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  }

  return sharedPage;
}

// লগইন চেক ও ওয়েবসাইট রিফ্রেশ করে সর্বশেষ ডাটা আনার ফাংশন
async function refreshAndScrape() {
  const page = await getReadyPage();

  // লগআউট হয়ে গেলে অটোমেটিক লগইন করবে
  const isLoginPage = await page.$('input[type="password"]');
  if (isLoginPage || page.url().includes('/login')) {
    await page.waitForSelector('input[type="email"], input[name="email"], input[type="text"]', { timeout: 15000 });
    const emailInput = await page.$('input[type="email"], input[name="email"], input[type="text"]');
    await emailInput.type(IPRN_EMAIL, { delay: 20 });
    await page.type('input[type="password"]', IPRN_PASSWORD, { delay: 20 });

    await Promise.all([
      page.click('button[type="submit"], input[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 })
    ]);

    if (!page.url().includes('/sms')) {
      await page.goto(SMS_RECORDS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    }
  } else {
    // প্রতি ক্লিকে ওয়েবসাইট রিফ্রেশ করবে
    await page.reload({ waitUntil: 'networkidle2', timeout: 25000 });
  }

  await sleep(1500);

  return await page.evaluate(() => {
    const firstRow = document.querySelector('table tbody tr');
    if (!firstRow) return null;

    const cells = Array.from(firstRow.querySelectorAll('td')).map((td) =>
      td.innerText.trim()
    );

    if (cells.length < 2) return null;

    // ডান পাশের কলাম Message এবং তার আগের কলাম B number[cite: 2]
    const message = cells[cells.length - 1] || 'N/A';
    const bNumber = cells[cells.length - 2] || 'N/A';
    const fullRowText = cells.join(' ');
    const signature = `${bNumber}|${message}`;

    return {
      number: bNumber,
      message,
      fullRowText,
      signature
    };
  });
}

// মেসেজ ২.৫ মিনিট (১৫০ সেকেন্ড) পর অটো ডিলিট করার ফাংশন
function scheduleAutoDelete(chatId, messageId, delayMs = 150000) {
  setTimeout(async () => {
    try {
      await bot.telegram.deleteMessage(chatId, messageId);
    } catch (e) {
      // ইউজার আগেই ডিলিট করে ফেললে কোনো এরর দেবে না
    }
  }, delayMs);
}

// গ্রুপে বট অ্যাক্টিভ করার কমান্ড
bot.command('start', async (ctx) => {
  if (String(ctx.chat.id) !== GROUP_ID) return;
  await ctx.reply(
    '✅ *OTP রিসিভার বট সক্রিয় হয়েছে!*\nনতুন কোড চেক করতে নিচের বাটনে ক্লিক করুন।',
    { parse_mode: 'Markdown', ...refreshOnlyButton }
  );
});

// Delete বাটনে ক্লিক করলে মেসেজ ডিলিট হবে
bot.action('DELETE_MSG', async (ctx) => {
  if (String(ctx.chat.id) !== GROUP_ID) return;
  try {
    await ctx.deleteMessage();
    await ctx.answerCbQuery('🗑️ মেসেজ ডিলিট করা হয়েছে।');
  } catch (e) {
    await ctx.answerCbQuery('মেসেজটি ইতিমধ্যে ডিলিট হয়ে গেছে।');
  }
});

// Refresh বাটনে ক্লিক করলে যা ঘটবে
bot.action('REFRESH_SMS', async (ctx) => {
  if (String(ctx.chat.id) !== GROUP_ID) {
    return ctx.answerCbQuery('অনুমোদিত গ্রুপ নয়।', { show_alert: true });
  }

  // প্রতি ক্লিকেই রিকোয়েস্ট নেবে এবং ১ মিনিটের টাইমার রিসেট করবে
  lastRefreshClickTime = Date.now();
  await ctx.answerCbQuery('🔄 রিফ্রেশ রিকোয়েস্ট গ্রহণ করা হয়েছে...');

  // যদি ইতিমধ্যে ব্যাকগ্রাউন্ডে চেক চলতে থাকে, তবে আলাদা মেসেজ না পাঠিয়ে ওয়েবসাইট রিফ্রেশ ট্রিগার করবে
  if (isPollingActive) {
    return;
  }

  isPollingActive = true;

  try {
    // সর্বশেষ ক্লিকের পর থেকে পুরো ১ মিনিট (৬০০০০ ms) পর্যন্ত চেক করতে থাকবে
    while (Date.now() - lastRefreshClickTime < 60000) {
      const record = await refreshAndScrape();

      if (record && record.signature !== lastSeenRecordSignature) {
        lastSeenRecordSignature = record.signature;

        const otpMatch = record.message.match(/\b\d{4,8}\b/);
        const otpCode = otpMatch ? otpMatch[0] : (record.message || 'N/A');

        const digits = record.number.replace(/\D/g, '');
        const maskedNumber = maskPhoneNumber(record.number);
        const { country, service } = detectCountryAndService(record.fullRowText, digits);
        const stats = updateSmsStats();
        const currentTimeISO = new Date().toISOString();

        const formattedMessage =
          `🔔 *OTP Received*\n\n` +
          `⏰ *Time:* ${currentTimeISO}\n` +
          `📱 *Service:* ${service}\n` +
          `🌍 *Country:* ${country}\n` +
          `☎️ *Number:* \`${maskedNumber}\`\n` +
          `🔑 *Your OTP:* \`${otpCode}\`\n` +
          `📊 *Today's SMS:* ${stats.todayCount}\n` +
          `📈 *Lifetime SMS:* ${stats.lifetimeCount}`;

        await bot.telegram.sendMessage(GROUP_ID, formattedMessage, {
          parse_mode: 'Markdown',
          ...refreshOnlyButton
        });

        // ডাটা পাওয়া গেলে লুপ শেষ করবে
        return;
      }

      // পরের রিফ্রেশের আগে ৩ সেকেন্ড অপেক্ষা করবে (যদি ১ মিনিট পূর্ণ না হয়ে থাকে)
      if (Date.now() - lastRefreshClickTime < 60000) {
        await sleep(3000);
      }
    }

    // পুরো ১ মিনিট চেক করার পরও কোনো নতুন ডাটা না পাওয়া গেলে এই মেসেজ দেবে
    const notFoundMsg = await bot.telegram.sendMessage(
      GROUP_ID,
      '⚠️ *কোনো তথ্য পাওয়া যায়নি।*\nআবার চেষ্টা করতে নিচের Refresh বাটনে ক্লিক করুন।',
      {
        parse_mode: 'Markdown',
        ...notFoundButtons
      }
    );

    // ২.৫ মিনিট (২ থেকে ৩ মিনিটের মধ্যে) পর মেসেজটি অটোমেটিক ডিলিট হয়ে যাবে
    scheduleAutoDelete(GROUP_ID, notFoundMsg.message_id, 150000);

  } catch (error) {
    const errMsg = await bot.telegram.sendMessage(
      GROUP_ID,
      `❌ *সমস্যা হয়েছে:* ${error.message}`,
      {
        parse_mode: 'Markdown',
        ...notFoundButtons
      }
    );
    scheduleAutoDelete(GROUP_ID, errMsg.message_id, 150000);
  } finally {
    isPollingActive = false;
  }
});

bot.launch().then(() => {
  console.log('Bot is running for group:', GROUP_ID);
});

process.once('SIGINT', async () => {
  if (browserInstance) await browserInstance.close();
  bot.stop('SIGINT');
});
process.once('SIGTERM', async () => {
  if (browserInstance) await browserInstance.close();
  bot.stop('SIGTERM');
});
