const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const BOT_TOKEN = '9100726768:AAFIPksNHSbJw6PluOebpFN3nJpUOruUKJA';
const CHAT_ID = '-1004415125778';

let isBotEnabled = true;
let todayCount = 0;
let lifetimeCount = 0;
let lastDate = new Date().toDateString();

function extractOTP(text) {
    if (!text) return 'N/A';
    const match = text.toString().match(/\b\d{4,8}\b/);
    return match ? match[0] : text;
}

function maskNumber(num) {
    if (!num) return 'Unknown';
    const str = num.toString().replace('+', '').trim();
    if (str.length > 8) {
        return str.substring(0, 3) + 'XXXX' + str.substring(str.length - 5);
    }
    return str;
}

async function sendStartMessage() {
    const startTime = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' });
    const startText = `🚀 <b>OTP Bot সফলভাবে চালু (Started) হয়েছে!</b>\n\n⏰ <b>Time:</b> ${startTime}\n🟢 <b>Status:</b> Active & Waiting for OTP...`;
    
    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: CHAT_ID,
            text: startText,
            parse_mode: 'HTML'
        });
        console.log('Start notification sent to channel.');
    } catch (error) {
        console.error('Failed to send start message:', error.response ? error.response.data : error.message);
    }
}

app.get('/toggle', async (req, res) => {
    isBotEnabled = !isBotEnabled;
    const statusText = `🔄 <b>Bot Status Changed:</b> ${isBotEnabled ? '✅ চালু (ON)' : '❌ বন্ধ (OFF)'}`;
    
    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: CHAT_ID,
            text: statusText,
            parse_mode: 'HTML'
        });
    } catch (e) {}

    res.send(`<h3>Bot Status: ${isBotEnabled ? '✅ চালু (ON)' : '❌ বন্ধ (OFF)'}</h3>`);
});

app.get('/', (req, res) => {
    res.send(`Bot is running! Status: ${isBotEnabled ? 'ON' : 'OFF'}`);
});

app.post('/webhook', async (req, res) => {
    if (!isBotEnabled) {
        return res.status(200).send('Bot is currently OFF.');
    }

    const body = req.body || {};
    console.log('Incoming Payload:', JSON.stringify(body));

    // iprn.pro SMS Records ডেটা নেস্টেড data অবজেক্ট বা সরাসরি পেলোড থেকে নেওয়া
    const record = body.data || body.record || body;

    const rawNumber = record.b_number || record.to || record.recipient || record.number || record.msisdn || '';
    const rawMessage = record.message || record.sms || record.text || record.content || record.body || '';

    // ভেরিফিকেশন পিং বা খালি রেকর্ড বাদ দেওয়া
    if (!rawNumber && !rawMessage) {
        return res.status(200).send('OK');
    }

    const currentDate = new Date().toDateString();
    if (lastDate !== currentDate) {
        todayCount = 0;
        lastDate = currentDate;
    }
    todayCount++;
    lifetimeCount++;

    const time = record.created_at || record.timestamp || record.date || new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' });
    const service = record.a_number || record.from || record.sender_id || record.sender || record.service || 'Telegram';
    const country = record.destination || record.country || record.range || 'China 🇨🇳';

    const maskedNum = maskNumber(rawNumber);
    const otpCode = extractOTP(rawMessage);

    const messageText = 
        `🔔 <b>OTP Received</b>\n\n` +
        `⏰ <b>Time:</b> ${time}\n` +
        `📱 <b>Service:</b> ${service}\n` +
        `🌍 <b>Country:</b> ${country}\n` +
        `☎️ <b>Number:</b> <code>+${maskedNum}</code>\n` +
        `🔑 <b>Your OTP:</b> <code>${otpCode}</code>\n` +
        `📊 <b>Today's SMS:</b> ${todayCount}\n` +
        `📈 <b>Lifetime SMS:</b> ${lifetimeCount}`;

    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: CHAT_ID,
            text: messageText,
            parse_mode: 'HTML'
        });
        res.status(200).send('OK');
    } catch (error) {
        console.error('Telegram Error:', error.response ? error.response.data : error.message);
        res.status(500).send('Failed to send message');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is live on port ${PORT}`);
    sendStartMessage();
});
