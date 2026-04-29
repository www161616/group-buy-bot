const express = require('express');
const line = require('@line/bot-sdk');
const { google } = require('googleapis');
const cors = require('cors');

const app = express();
app.use(cors());

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
const SHEET_NAME = '文案庫';            // #開團：直接進開團清單
const SHEET_NAME_CANDIDATE = '候選池';  // #選品：進候選池待老闆評估

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

  // ── 觸發方式 3：#選品（進候選池、待老闆評估）──
  if (text.includes('#選品')) {
    const cleanText = text.replace(/#選品/g, '').trim();
    if (!cleanText) return;

    const sheetData = {
      text: cleanText,
      productName: extractProductName(cleanText),
      userId,
      timestamp,
      trigger: 'hashtag',
    };

    const sheetOk = await saveToSheet(sheetData, SHEET_NAME_CANDIDATE, '待評估');

    // forward 到 LT-ERP 候選池（Sheet 寫成功才 forward、避免兩邊不一致）
    if (sheetOk) {
      try {
        await forwardToErp({ ...sheetData, messageId });
      } catch (e) {
        // helper 內部已 catch、這層是深度防禦
        console.error('forwardToErp unexpected error:', e.message);
      }
    }

    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: `📥 已加入候選池！\n【${extractProductName(cleanText)}】\n老闆會晚點決定要不要開團。` }],
    });
    return;
  }

  // ── 觸發方式 4：回覆「選品」──
  if (text === '選品') {
    const quotedId = event.message?.quotedMessageId;
    if (quotedId && messageCache.has(quotedId)) {
      const original = messageCache.get(quotedId);
      const sheetData = {
        text: original.text,
        productName: extractProductName(original.text),
        userId,
        timestamp,
        trigger: 'reply',
      };

      const sheetOk = await saveToSheet(sheetData, SHEET_NAME_CANDIDATE, '待評估');

      // forward 到 LT-ERP 候選池（Sheet 寫成功才 forward）
      // dedup key 用 quotedId (被引用的商品文案 id)、不是當下「選品」這則訊息的 id
      // 理由：同一商品文案被多人 reply「選品」應視為同一筆候選 → 用商品文案 id 才能 dedup
      if (sheetOk) {
        try {
          await forwardToErp({ ...sheetData, messageId: quotedId });
        } catch (e) {
          console.error('forwardToErp unexpected error:', e.message);
        }
      }

      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: `📥 已加入候選池！\n【${extractProductName(original.text)}】` }],
      });
    } else {
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: '⚠️ 找不到原始文案。\n請在文案最後加上 #選品 再傳送。' }],
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

async function saveToSheet(data, sheetName = SHEET_NAME, status = '待上架') {
  try {
    const sheets = await getSheetClient();

    // 確保標題列存在
    const check = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${sheetName}!A1:F1`,
    });

    if (!check.data.values || check.data.values.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${sheetName}!A1`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [['時間', '商品名稱', '文案', '來源帳號', '觸發方式', '狀態']],
        },
      });
    }

    const time = new Date(data.timestamp).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${sheetName}!A:F`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[time, data.productName, data.text, data.userId, data.trigger, status]],
      },
    });

    console.log(`Saved to ${sheetName}: ${data.productName}`);
    return true;
  } catch (err) {
    console.error('Sheet error:', err.message);
    return false;
  }
}

// ── Forward 候選池資料到 LT-ERP Edge Function ──
// 設計原則 (依 BRIEF + codex review)：
//   - 只在 #選品 / 「選品」reply 路徑呼叫；#開團 流程不轉發
//   - 失敗只 log、不 throw、不擋 LINE reply
//   - env 沒設 → log skip → return（不掛 bot）
//   - duplicate:true 視為成功（同一 messageId 重送不會壞）
async function forwardToErp(data) {
  const url = process.env.ERP_INGEST_URL;
  const secret = process.env.COMMUNITY_BOT_SECRET;

  if (!url || !secret) {
    console.log('forwardToErp: skip (ERP_INGEST_URL or COMMUNITY_BOT_SECRET not set)');
    return;
  }

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bot-Secret': secret,
      },
      body: JSON.stringify({
        text: data.text,
        messageId: data.messageId,
        userId: data.userId,
        productName: data.productName,
      }),
    });

    let result = {};
    try {
      result = await resp.json();
    } catch {
      // 不是 JSON、忽略
    }

    if (resp.ok) {
      // resp.ok 包含 duplicate:true (Edge Function 對 dup 回 200)
      console.log(
        `forwardToErp ok: messageId=${data.messageId}, dup=${result.duplicate ?? '?'}, id=${result.id ?? '?'}`
      );
    } else {
      console.error(
        `forwardToErp http ${resp.status}: messageId=${data.messageId}`,
        result
      );
    }
  } catch (err) {
    console.error('forwardToErp error:', err.message);
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
