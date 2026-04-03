const express = require('express');
const line = require('@line/bot-sdk');
const { google } = require('googleapis');

const app = express();

// LINE SDK config
const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
});

// Google Sheets setup
async function getSheetClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = '文案庫';

// 存訊息到記憶體（用來抓 reply 的原始訊息）
// key: messageId, value: { text, userId, timestamp }
const messageCache = new Map();
const CACHE_MAX = 200;

// ── Webhook ──
app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  res.status(200).end(); // 先回 200，再處理

  const events = req.body.events || [];
  for (const event of events) {
    try {
      await handleEvent(event);
    } catch (err) {
      console.error('Event error:', err.message);
    }
  }
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message?.type !== 'text') return;

  const text = event.message.text.trim();
  const userId = event.source?.userId || 'unknown';
  const messageId = event.message.id;
  const timestamp = event.timestamp;

  // 快取所有訊息（為了 reply 方式能找到原始文案）
  messageCache.set(messageId, { text, userId, timestamp });
  if (messageCache.size > CACHE_MAX) {
    const firstKey = messageCache.keys().next().value;
    messageCache.delete(firstKey);
  }

  // ── 觸發方式 1：#開團 ──
  if (text.includes('#開團')) {
    const cleanText = text.replace(/#開團/g, '').trim();
    if (!cleanText) return;

    await saveToSheet({
      text: cleanText,
      productName: extractProductName(cleanText),
      userId,
      timestamp,
      trigger: 'hashtag',
    });

    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: `✅ 已收到！\n【${extractProductName(cleanText)}】\n已加入今日開團清單。` }],
    });
    return;
  }

  // ── 觸發方式 2：回覆「開團」──
  if (text === '開團') {
    // 找被引用的訊息
    const quotedId = event.message?.quotedMessageId;
    if (quotedId && messageCache.has(quotedId)) {
      const original = messageCache.get(quotedId);
      await saveToSheet({
        text: original.text,
        productName: extractProductName(original.text),
        userId,
        timestamp,
        trigger: 'reply',
      });

      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: `✅ 已收到！\n【${extractProductName(original.text)}】\n已加入今日開團清單。` }],
      });
    } else {
      // 找不到原始訊息，提示改用 #開團
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: '⚠️ 找不到原始文案。\n請在文案最後加上 #開團 再傳送。' }],
      });
    }
    return;
  }
}

function extractProductName(text) {
  const firstLine = text.split('\n')[0].trim();
  return firstLine
    .replace(/^[【\[＊*◆▶▸•·\-－—「『]+/, '')
    .replace(/[】\]」』]+$/, '')
    .replace(/\$[\d,]+/, '')
    .trim()
    .slice(0, 30); // 最多30字
}

async function saveToSheet(data) {
  try {
    const sheets = await getSheetClient();

    // 確保標題列存在
    const check = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A1:F1`,
    });

    if (!check.data.values || check.data.values.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A1`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [['時間', '商品名稱', '文案', '來源帳號', '觸發方式', '狀態']],
        },
      });
    }

    const time = new Date(data.timestamp).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A:F`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[time, data.productName, data.text, data.userId, data.trigger, '待上架']],
      },
    });

    console.log(`Saved: ${data.productName}`);
  } catch (err) {
    console.error('Sheet error:', err.message);
  }
}

// ── 讀取今日文案（給開團助手工具用）──
app.get('/today', async (req, res) => {
  try {
    const sheets = await getSheetClient();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A:F`,
    });

    const rows = result.data.values || [];
    if (rows.length <= 1) return res.json({ ok: true, data: [] });

    const today = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });

    const data = rows.slice(1)
      .map((row, i) => ({
        rowIndex: i + 2,
        time: row[0] || '',
        productName: row[1] || '',
        text: row[2] || '',
        userId: row[3] || '',
        trigger: row[4] || '',
        status: row[5] || '待上架',
      }))
      .filter(d => d.time.startsWith(today));

    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/', (req, res) => res.send('Group Buy Bot OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
