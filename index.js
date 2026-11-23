const { Telegraf, Markup } = require('telegraf');
const puppeteer = require('puppeteer');
const fs = require('fs');

// ==========================================
// কনফিগারেশন (নিরাপত্তার স্বার্থে টোকেন পরিবর্তন করে নেওয়া ভালো)
// ==========================================
const BOT_TOKEN = '9100726768:AAFIPksNHSbJw6PluOebpFN3nJpUOruUKJA';
const IPRN_EMAIL = 'mirajislam321711@gmail.com';
const IPRN_PASSWORD = 'miraj@#26';
const GROUP_ID = '-1003930981242';

const SMS_RECORDS_URL = 'https://iprn.pro/sms/?page=0';
const STATS_FILE = './sms_stats.json';

const bot = new Telegraf(BOT_TOKEN);

let browserInstance = null;
let sharedPage = null;
let isPollingActive = false;
let lastRefreshClickTime = 0;
let lastSeenRecordSignature = null;
let isBotInitialized = false;

const refreshOnlyButton = Markup.inlineKeyboard([
  [Markup.button.callback('🔄 Refresh', 'REFRESH_SMS')]
]);

const notFoundButtons = Markup.inlineKeyboard([
  [Markup.button.callback('🔄 Refresh', 'REFRESH_SMS')],
  [Markup.button.callback('🗑️ Delete', 'DELETE_MSG')]
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// গ্লোবাল এরর হ্যান্ডলার (যাতে বট কখনো ক্র্যাশ না করে)
bot.catch((err) => {
  console.error('Bot Global Error:', err.message);
});

function maskPhoneNumber(rawNumber) {
  if (!rawNumber || rawNumber === 'N/A') return '+Unknown';
  const digits = rawNumber.replace(/\D/g, '');
  if (digits.length <= 6) return `+${digits}`;
  const firstTwo = digits.slice(0, 2);
  const lastFour = digits.slice(-4);
  const stars = '*'.repeat(digits.length - 6);
  return `+${firstTwo}${stars}${lastFour}`;
}

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

async function getReadyPage() {
  if (!browserInstance || !browserInstance.connected) {
    browserInstance = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
    sharedPage = null;
    isBotInitialized = false;
  }

  if (!sharedPage || sharedPage.isClosed()) {
    sharedPage = await browserInstance.newPage();
    await sharedPage.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
  }

  return sharedPage;
}

// লগইন নিশ্চিত করার আলাদা ফাংশন
async function ensureLoggedIn() {
  const page = await getReadyPage();
  const currentUrl = page.url();

  if (!currentUrl || currentUrl === 'about:blank' || currentUrl.includes('/login') || !currentUrl.includes('/sms')) {
    await page.goto(SMS_RECORDS_URL, { waitUntil: 'networkidle2', timeout: 35000 });
  }

  const isLoginPage = await page.$('input[type="password"]');
  if (isLoginPage || page.url().includes('/login')) {
    console.log('Login page detected. Attempting auto-login...');
    await page.waitForSelector('input[type="email"], input[name="email"], input[type="text"]', { timeout: 15000 });
    
    const emailInput = await page.$('input[type="email"], input[name="email"], input[type="text"]');
    await emailInput.click({ clickCount: 3 });
    await emailInput.type(IPRN_EMAIL, { delay: 20 });

    const passInput = await page.$('input[type="password"]');
    await passInput.click({ clickCount: 3 });
    await passInput.type(IPRN_PASSWORD, { delay: 20 });

    await Promise.all([
      page.click('button[type="submit"], input[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 35000 }).catch(() => {})
    ]);

    await sleep(2000);

    // লগইন শেষে যদি এখনো লগইন পেজেই থাকে তবে এরর থ্রো করবে
    if (page.url().includes('/login') || await page.$('input[type="password"]')) {
      throw new Error('লগইন ব্যর্থ হয়েছে! ইমেইল, পাসওয়ার্ড বা ক্যাপচা চেক করুন।');
    }

    if (!page.url().includes('/sms')) {
      await page.goto(SMS_RECORDS_URL, { waitUntil: 'networkidle2', timeout: 35000 });
    }
  }

  // সফলভাবে SMS পেজে পৌঁছালে গ্রুপে মেসেজ পাঠাবে
  if (!isBotInitialized && page.url().includes('/sms')) {
    isBotInitialized = true;
    console.log('Successfully reached SMS Records page!');
    await bot.telegram.sendMessage(
      GROUP_ID,
      '✅ *সিস্টেম রেডি:* ওয়েবসাইটে সফলভাবে লগইন হয়েছে এবং এসএমএস রেকর্ড পেজে যুক্ত হওয়া হয়েছে।',
      { parse_mode: 'Markdown', ...refreshOnlyButton }
    ).catch((e) => console.error('Init msg error:', e.message));
  }

  return page;
}

async function refreshAndScrape() {
  const page = await ensureLoggedIn();
  await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(1500);

  return await page.evaluate(() => {
    const firstRow = document.querySelector('table tbody tr');
    if (!firstRow) return null;

    const cells = Array.from(firstRow.querySelectorAll('td')).map((td) =>
      td.innerText.trim()
    );

    if (cells.length < 2) return null;

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

function scheduleAutoDelete(chatId, messageId, delayMs = 150000) {
  setTimeout(async () => {
    try {
      await bot.telegram.deleteMessage(chatId, messageId);
    } catch (e) {}
  }, delayMs);
}

bot.command('start', async (ctx) => {
  if (String(ctx.chat.id) !== GROUP_ID) return;
  await ctx.reply(
    '⏳ *ওয়েবসাইটে লগইন ও কানেক্ট করা হচ্ছে...* অনুগ্রহ করে কয়েক সেকেন্ড অপেক্ষা করুন।',
    { parse_mode: 'Markdown' }
  );

  try {
    await ensureLoggedIn();
  } catch (err) {
    await ctx.reply(`❌ *লগইন সমস্যা:* ${err.message}`, { parse_mode: 'Markdown' });
  }
});

bot.action('DELETE_MSG', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (String(ctx.chat.id) !== GROUP_ID) return;
  try {
    await ctx.deleteMessage();
  } catch (e) {}
});

bot.action('REFRESH_SMS', async (ctx) => {
  // পুরনো বাটন ক্লিকের এরর এড়াতে সবার আগে answerCbQuery কল করা হলো
  await ctx.answerCbQuery('🔄 রিফ্রেশ রিকোয়েস্ট গ্রহণ করা হয়েছে...').catch(() => {});

  if (String(ctx.chat.id) !== GROUP_ID) return;

  lastRefreshClickTime = Date.now();

  if (isPollingActive) {
    return;
  }

  isPollingActive = true;

  try {
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

        return;
      }

      if (Date.now() - lastRefreshClickTime < 60000) {
        await sleep(3000);
      }
    }

    const notFoundMsg = await bot.telegram.sendMessage(
      GROUP_ID,
      '⚠️ *কোনো তথ্য পাওয়া যায়নি।*\nআবার চেষ্টা করতে নিচের Refresh বাটনে ক্লিক করুন।',
      {
        parse_mode: 'Markdown',
        ...notFoundButtons
      }
    );

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

// বট চালু হওয়ার সাথে সাথেই অটোমেটিক ওয়েবসাইটে লগইন শুরু করবে
bot.launch().then(async () => {
  console.log('Bot is running for group:', GROUP_ID);
  try {
    await ensureLoggedIn();
  } catch (err) {
    console.error('Startup Login Error:', err.message);
    await bot.telegram.sendMessage(
      GROUP_ID,
      `❌ *স্টার্টআপ লগইন ব্যর্থ হয়েছে:* ${err.message}`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  }
});

process.once('SIGINT', async () => {
  if (browserInstance) await browserInstance.close();
  bot.stop('SIGINT');
});
process.once('SIGTERM', async () => {
  if (browserInstance) await browserInstance.close();
  bot.stop('SIGTERM');
});
