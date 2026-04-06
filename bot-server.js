'use strict';

const { spawn, execFileSync } = require('child_process');
const readline = require('readline');
const https = require('https');
const fs   = require('fs');
const path = require('path');

const config  = require('./config');
const { shouldProcess, stripMention } = require('./message-filter');
const conv    = require('./conversation');
const lark    = require('./lark-executor');
const market  = require('./market-intel');

// MKT market intel group
const MKT_GROUP_ID   = 'oc_12fc8f4549a84a7baead445c0dc1eb05';
const DIGEST_HOUR    = 18; // 6 PM Bangkok time, send daily digest to user DM

// Track last seen message time for backfill on restart
const LAST_SEEN_FILE = path.join(__dirname, '.last-seen-time');

// Direct path to cached claude-code binary
const CLAUDE_BIN = process.platform === 'darwin'
  ? `${process.env.HOME}/.npm/_npx/becf7b9e49303068/node_modules/.bin/claude`
  : 'claude';

// ─────────────────────────────────────────────
// Claude call — pure text Q&A, no tools
// ─────────────────────────────────────────────

function askClaude(prompt) {
  try {
    const result = execFileSync(CLAUDE_BIN, [
      '-p', prompt,
      '--allowedTools', '',
    ], {
      encoding: 'utf8',
      timeout: 120000,
      // Exclude ANTHROPIC_API_KEY so claude uses Claude Code subscription, not API credits
      env: { ...process.env, FORCE_COLOR: '0', ANTHROPIC_API_KEY: '' },
    });
    return result.trim();
  } catch (err) {
    const out = (err.stdout || '').trim();
    if (out) return out;
    console.error('[claude] error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// Intent detection
// ─────────────────────────────────────────────

function detectIntent(text) {
  const t = text.toLowerCase();

  if (/日程|agenda|calendar|schedule|会议|meeting|今天.*安排|明天.*安排|本周.*安排/.test(t))
    return 'calendar';

  if (/待办|任务列表|我的任务|task list|my tasks/.test(t))
    return 'task_list';

  if (/创建任务|新建任务|添加待办|create task|add task/.test(t))
    return 'task_create';

  if (/搜索用户|查找用户|找(.{1,10})(的open_id|邮件|联系方式)|谁是/.test(t))
    return 'search_user';

  if (/新闻|资讯|动态|物流.*新闻|快递.*新闻|news|latest/.test(t))
    return 'news';

  return 'chat';
}

// ─────────────────────────────────────────────
// Intent handlers
// ─────────────────────────────────────────────

function handleCalendar(userText) {
  const today = new Date().toISOString().slice(0, 10);

  // Parse date range from text
  let startDate = today;
  let endDate = today;

  if (/明天/.test(userText)) {
    const d = new Date(); d.setDate(d.getDate() + 1);
    startDate = endDate = d.toISOString().slice(0, 10);
  } else if (/本周|这周/.test(userText)) {
    const d = new Date(); d.setDate(d.getDate() + 6);
    endDate = d.toISOString().slice(0, 10);
  } else if (/今天明天|今明/.test(userText)) {
    const d = new Date(); d.setDate(d.getDate() + 1);
    endDate = d.toISOString().slice(0, 10);
  }

  console.log(`[tool] calendar ${startDate} ~ ${endDate}`);
  const result = lark.getAgenda({ startDate, endDate });

  if (result.error) return `查询日程失败：${JSON.stringify(result.error)}`;

  // Format agenda result
  const raw = JSON.stringify(result, null, 2);
  const prompt = `用户问：${userText}

以下是飞书日历返回的日程数据（JSON）：
${raw}

请用中文整理成易读的格式回复用户，列出每个日程的时间和标题，不要显示原始 JSON。如果没有日程，告知用户今天/明天没有安排。`;

  return askClaude(prompt) || '日程查询完成，但格式化失败。';
}

function handleTaskList() {
  console.log('[tool] task list');
  const result = lark.listMyTasks({ pageSize: 20 });

  if (result.error) return `查询任务失败：${JSON.stringify(result.error)}`;

  const raw = JSON.stringify(result, null, 2);
  const prompt = `以下是飞书任务列表数据（JSON）：
${raw}

请用中文列出未完成的任务，包含任务标题和截止日期（如有），不要显示原始 JSON。如果没有任务，告知用户当前没有待办。`;

  return askClaude(prompt) || '任务查询完成，但格式化失败。';
}

function handleTaskCreate(userText) {
  // Use Claude to extract task title and due date
  const extractPrompt = `从用户消息中提取任务信息，只输出 JSON，格式：{"title":"任务标题","due":"YYYY-MM-DD或null"}
今天是 ${new Date().toISOString().slice(0, 10)}。
用户消息：${userText}`;

  const extracted = askClaude(extractPrompt);
  let title = userText;
  let dueDate = null;

  try {
    const json = JSON.parse(extracted.match(/\{.*\}/s)?.[0] || '{}');
    if (json.title) title = json.title;
    if (json.due && json.due !== 'null') dueDate = json.due;
  } catch {}

  console.log(`[tool] task create: ${title}, due: ${dueDate}`);
  const result = lark.createTask({ title, dueDate });

  if (result.error) return `创建任务失败：${JSON.stringify(result.error)}`;
  return `✅ 任务已创建：**${title}**${dueDate ? `（截止：${dueDate}）` : ''}`;
}

function handleSearchUser(userText) {
  // Extract keyword
  const m = userText.match(/(?:搜索|查找|找|谁是)\s*(.{1,20}?)(?:的|是谁|$)/);
  const keyword = m ? m[1].trim() : userText;

  console.log(`[tool] search user: ${keyword}`);
  const result = lark.searchUser(keyword);

  if (result.error) return `搜索用户失败：${JSON.stringify(result.error)}`;

  const raw = JSON.stringify(result, null, 2);
  const prompt = `搜索"${keyword}"的结果：
${raw}

请用中文列出找到的用户，包括姓名、部门等信息。如果没有结果，告知用户未找到。不要显示原始 JSON。`;

  return askClaude(prompt) || '搜索完成，但格式化失败。';
}

// Fetch real-time news from Google News RSS
function fetchNewsRSS(query) {
  return new Promise((resolve) => {
    const encoded = encodeURIComponent(query);
    const url = `https://news.google.com/rss/search?q=${encoded}&hl=zh-CN&gl=TH&ceid=TH:zh-Hans`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        // Extract titles and links from RSS XML
        const items = [];
        const itemRegex = /<item>([\s\S]*?)<\/item>/g;
        let match;
        while ((match = itemRegex.exec(data)) !== null && items.length < 6) {
          const titleMatch = match[1].match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                             match[1].match(/<title>(.*?)<\/title>/);
          const linkMatch  = match[1].match(/<link>(.*?)<\/link>/);
          const pubMatch   = match[1].match(/<pubDate>(.*?)<\/pubDate>/);
          if (titleMatch) {
            items.push({
              title: titleMatch[1].replace(/ - .*$/, '').trim(), // strip source suffix
              link:  linkMatch ? linkMatch[1].trim() : '',
              date:  pubMatch  ? pubMatch[1].trim()  : '',
            });
          }
        }
        resolve(items);
      });
    }).on('error', () => resolve([]));
  });
}

async function handleNews(userText) {
  const query = /物流|快递|供应链|shipping|logistics/.test(userText)
    ? userText
    : '物流 快递 东南亚 供应链';

  const items = await fetchNewsRSS(query);

  if (items.length === 0) {
    // Fallback to training data if fetch fails
    const prompt = `用户问：${userText}\n请简要介绍最近物流/快递/东南亚供应链动态3-5条，注明信息来自训练数据，建议关注最新资讯。简洁中文回答。`;
    return askClaude(prompt) || '暂时无法获取新闻。';
  }

  const newsText = items.map((n, i) => `${i + 1}. ${n.title}${n.link ? '\n   ' + n.link : ''}`).join('\n');
  const today = new Date().toLocaleDateString('zh-CN');
  const prompt = `今天是${today}。以下是从 Google News 实时抓取的物流/快递相关新闻标题：

${newsText}

请用中文简洁整理成推送格式，每条加一句简短解读（1-2句），去掉重复或不相关的，保留3-5条最有价值的。`;

  return askClaude(prompt) || newsText;
}

function handleChat(chatId, userText) {
  const history = conv.getMessages(chatId);
  let prompt = `${config.systemPrompt}\n\n`;

  const pastTurns = history.slice(0, -1);
  if (pastTurns.length > 0) {
    for (const t of pastTurns) {
      const text = typeof t.content === 'string' ? t.content :
        (t.content.find && t.content.find(b => b.type === 'text')?.text) || '';
      if (t.role === 'user')      prompt += `用户: ${text}\n`;
      if (t.role === 'assistant') prompt += `助手: ${text}\n`;
    }
  }
  prompt += `用户: ${userText}\n助手:`;

  return askClaude(prompt) || '（无回复）';
}

// ─────────────────────────────────────────────
// Main dispatcher
// ─────────────────────────────────────────────

async function getReply(chatId, userText) {
  const intent = detectIntent(userText);
  console.log(`[intent] ${intent}: ${userText.slice(0, 60)}`);

  switch (intent) {
    case 'calendar':    return handleCalendar(userText);
    case 'task_list':   return handleTaskList();
    case 'task_create': return handleTaskCreate(userText);
    case 'search_user': return handleSearchUser(userText);
    case 'news':        return await handleNews(userText);
    default:            return handleChat(chatId, userText);
  }
}

// ─────────────────────────────────────────────
// Market intel: react to a message with emoji
// ─────────────────────────────────────────────

function reactToMessage(messageId, emojiType) {
  try {
    const { execFileSync: ef } = require('child_process');
    ef('lark-cli', [
      'im', 'reactions', 'create',
      '--message-id', messageId,
      '--data', JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
      '--as', 'bot',
      '--format', 'json',
    ], { encoding: 'utf8', timeout: 10000, env: process.env });
    console.log(`[market] reacted ${emojiType} to ${messageId}`);
  } catch (err) {
    console.error('[market] react failed:', err.message?.slice(0, 80));
  }
}

// ─────────────────────────────────────────────
// Market intel: handle MKT group messages
// ─────────────────────────────────────────────

async function handleMarketMessage(event) {
  const { message_id, content, message_type, sender_id } = event;
  if (!['text', 'post', 'image'].includes(message_type)) return;

  // Extract image keys from content (text/post have inline images, image type has image_key)
  let imageKeys = (content || '').match(/img_v3_\S+/g) || [];
  // For pure image messages, also try to extract img_ keys
  if (message_type === 'image' && imageKeys.length === 0) {
    const imgMatch = (content || '').match(/img_\S+/g);
    if (imgMatch) imageKeys = imgMatch;
  }
  // Clean trailing brackets from image keys
  const cleanedImageKeys = imageKeys.map(k => k.replace(/[\]\)]+$/, ''));

  const hasImages = cleanedImageKeys.length > 0;
  if (!hasImages && (!content || content.trim().length < 20)) return;

  console.log(`[market] processing: ${(content || '').slice(0, 60)} (images: ${cleanedImageKeys.length})`);
  const result = market.processMessage(content, message_id, undefined, {
    imageKeys: cleanedImageKeys,
    senderId: sender_id || '',
    senderName: event.sender_name || '',
  });

  if (result.skip) {
    console.log('[market] skipped (irrelevant)');
    return;
  }

  if (result.duplicate) {
    // Mark duplicate with 👀
    reactToMessage(message_id, 'EYES');
    console.log(`[market] duplicate: ${result.intel.brand} ${result.intel.category}`);
  } else if (result.isHqPriority) {
    // Mark HQ priority with 🔥
    reactToMessage(message_id, 'FIRE');
    console.log(`[market] ⭐ HQ priority: ${result.intel.summary}`);
  } else {
    // Mark normal new intel with ✅
    reactToMessage(message_id, 'OK');
    console.log(`[market] new intel: ${result.intel.summary}`);
  }
}

// ─────────────────────────────────────────────
// Event handler
// ─────────────────────────────────────────────

async function handleEvent(event) {
  saveLastSeenTime(); // track for backfill on restart
  const { chat_id, chat_type, content, sender_id, message_type, message_id } = event;

  // MKT group: silent intel collection, no regular bot reply
  if (chat_id === MKT_GROUP_ID) {
    // Ignore bot's own messages
    if (sender_id === config.botOpenId) return;
    await handleMarketMessage(event);
    return;
  }

  if (!shouldProcess(event)) return;
  if (!['text', 'post'].includes(message_type)) return;

  const userText = chat_type === 'group' ? stripMention(content) : content;
  if (!userText) return;

  console.log(`[msg] [${chat_type}] ${sender_id}: ${userText.slice(0, 80)}`);

  // Manual weekly report trigger
  if (/^[\/]?周报$/.test(userText.trim())) {
    console.log('[market] manual weekly report triggered');
    try {
      const report = market.getWeeklyReport();
      lark.sendMessage({ chatId: chat_id, text: report });
      console.log('[market] weekly report sent ✓');
    } catch (err) {
      console.error('[market] weekly report error:', err.message);
      lark.sendMessage({ chatId: chat_id, text: '周报生成失败，请稍后再试。' });
    }
    return;
  }

  conv.addUserMessage(chat_id, userText);

  const reply = await getReply(chat_id, userText);

  conv.addAssistantMessage(chat_id, reply);
  console.log(`[reply] ${reply.slice(0, 80)}`);

  const result = lark.sendMessage({ chatId: chat_id, text: reply });
  if (result && result.error) {
    console.error('[bot] Send failed:', JSON.stringify(result.error));
  } else {
    console.log(`[bot] Sent ✓`);
  }
}

// ─────────────────────────────────────────────
// Daily digest scheduler (18:00 Bangkok time)
// ─────────────────────────────────────────────

function startDigestScheduler() {
  let lastDigestDate = null;

  setInterval(() => {
    const now = new Date();
    const bkk = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
    const today = bkk.toISOString().slice(0, 10);

    if (bkk.getHours() >= DIGEST_HOUR && lastDigestDate !== today) {
      lastDigestDate = today;
      console.log('[market] sending daily digest...');
      const digest = market.getDailyDigest();
      lark.sendMessage({ openId: config.myOpenId, text: digest });
      console.log('[market] digest sent ✓');
    }
  }, 60 * 1000); // check every minute

  console.log(`[market] digest scheduler started (sends at ${DIGEST_HOUR}:00 Bangkok)`);
}

// ─────────────────────────────────────────────
// Weekly report scheduler — Saturday 14:00 Bangkok
// ─────────────────────────────────────────────

function startWeeklyReportScheduler() {
  let lastReportWeek = null;

  setInterval(() => {
    const now = new Date();
    const bkk = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
    const isSaturday = bkk.getDay() === 6;
    const isAfternoon = bkk.getHours() >= 14;

    // Use ISO week number to track
    const jan1 = new Date(bkk.getFullYear(), 0, 1);
    const weekNum = Math.ceil(((bkk - jan1) / 86400000 + jan1.getDay() + 1) / 7);
    const weekKey = `${bkk.getFullYear()}-W${weekNum}`;

    if (isSaturday && isAfternoon && lastReportWeek !== weekKey) {
      lastReportWeek = weekKey;
      console.log('[market] generating weekly report...');
      try {
        const report = market.getWeeklyReport();
        // Test phase: only send to admin (config.myOpenId)
        lark.sendMessage({ openId: config.myOpenId, text: report });
        console.log('[market] weekly report sent to admin ✓');
      } catch (err) {
        console.error('[market] weekly report error:', err.message);
      }
    }
  }, 5 * 60 * 1000); // check every 5 minutes

  console.log('[market] weekly report scheduler started (Saturday 14:00 Bangkok, test mode → admin only)');
}

// ─────────────────────────────────────────────
// Main: spawn lark-cli event listener
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// Backfill: catch up on missed MKT messages
// ─────────────────────────────────────────────

function saveLastSeenTime() {
  try {
    fs.writeFileSync(LAST_SEEN_FILE, new Date().toISOString());
  } catch {}
}

function loadLastSeenTime() {
  try {
    if (fs.existsSync(LAST_SEEN_FILE)) {
      return fs.readFileSync(LAST_SEEN_FILE, 'utf8').trim();
    }
  } catch {}
  return null;
}

async function backfillMissedMessages() {
  const lastSeen = loadLastSeenTime();
  if (!lastSeen) {
    console.log('[backfill] no last-seen time, skipping');
    saveLastSeenTime();
    return;
  }

  const now = new Date();
  const lastTime = new Date(lastSeen);
  const diffMin = (now - lastTime) / 60000;

  if (diffMin < 2) {
    console.log('[backfill] downtime < 2min, skipping');
    saveLastSeenTime();
    return;
  }

  console.log(`[backfill] bot was offline for ${Math.round(diffMin)} min (${lastSeen} → ${now.toISOString()})`);

  // Convert to Bangkok time ISO format
  const startISO = lastSeen.replace('Z', '+07:00');
  const endISO = now.toISOString().replace('Z', '+07:00');

  try {
    const out = execFileSync('lark-cli', [
      'im', '+chat-messages-list', '--as', 'bot',
      '--chat-id', MKT_GROUP_ID,
      '--start', startISO, '--end', endISO,
      '--page-size', '50', '--format', 'json',
    ], { encoding: 'utf8', timeout: 30000, env: process.env });

    const resp = JSON.parse(out);
    if (!resp.ok || !resp.data || !resp.data.messages) {
      console.log('[backfill] no messages found');
      saveLastSeenTime();
      return;
    }

    const msgs = resp.data.messages
      .filter(m => m.sender && m.sender.sender_type !== 'bot')
      .sort((a, b) => (a.create_time || '').localeCompare(b.create_time || ''));

    console.log(`[backfill] found ${msgs.length} missed messages`);

    for (const msg of msgs) {
      const content = msg.content || '';
      const msgType = msg.msg_type || 'text';
      const senderId = msg.sender ? msg.sender.id : '';
      const senderName = msg.sender ? msg.sender.name : '';
      const messageId = msg.message_id || '';

      // Extract image keys
      const imageKeys = [];
      const imgMatches = content.matchAll(/\[Image:\s*(img_v3_\S+?)\]/g);
      for (const m of imgMatches) imageKeys.push(m[1]);

      const textOnly = content.replace(/\[Image:\s*img_v3_\S+?\]/g, '').trim();

      const hasImages = imageKeys.length > 0;
      if (!hasImages && (!textOnly || textOnly.length < 20)) continue;

      console.log(`[backfill] processing: ${textOnly.slice(0, 50)} (images: ${imageKeys.length})`);

      try {
        const result = market.processMessage(textOnly, messageId, undefined, {
          imageKeys, senderId, senderName,
        });

        if (result.skip) {
          console.log('[backfill] skipped (irrelevant)');
        } else if (result.duplicate) {
          console.log(`[backfill] duplicate: ${result.intel.brand}`);
        } else {
          console.log(`[backfill] new: ${result.intel.brand} - ${result.intel.summary}`);
        }
      } catch (err) {
        console.error(`[backfill] error: ${err.message.slice(0, 80)}`);
      }
    }

    console.log('[backfill] done');
  } catch (err) {
    console.error(`[backfill] fetch error: ${(err.message || '').slice(0, 100)}`);
  }

  saveLastSeenTime();
}

function start() {
  console.log('[bot] Starting Feishu event listener...');
  console.log(`[bot] Bot: ${config.botOpenId}`);
  console.log(`[market] Monitoring MKT group: ${MKT_GROUP_ID}`);

  // Backfill missed messages from downtime
  backfillMissedMessages().catch(err => console.error('[backfill] error:', err.message));

  startDigestScheduler();
  startWeeklyReportScheduler();

  // Every 30 min, fill 3 AI fields on Base records created by the other bot
  setInterval(() => {
    try {
      const filled = market.fillMissingBaseFields();
      if (filled > 0) console.log(`[market] Base: filled ${filled} records`);
    } catch (err) {
      console.error('[market] Base fill error:', err.message);
    }
  }, 30 * 60 * 1000);
  console.log('[market] Base enrichment scheduler started (every 30 min)');

  const proc = spawn('lark-cli', [
    'event', '+subscribe',
    '--event-types', 'im.message.receive_v1',
    '--compact', '--quiet', '--as', 'bot', '--force',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  proc.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.error('[lark-cli]', msg);
  });

  proc.on('error', (err) => { console.error('[bot] spawn error:', err.message); process.exit(1); });
  proc.on('close', (code) => {
    console.error(`[bot] lark-cli exited (${code}). Restarting in 5s...`);
    setTimeout(start, 5000);
  });

  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type !== 'im.message.receive_v1') return;
    console.log(`[event] chat_type=${event.chat_type} content=${JSON.stringify(event.content)}`);
    handleEvent(event).catch(err => console.error('[bot] error:', err.message));
  });

  process.on('SIGINT',  () => { proc.kill(); process.exit(0); });
  process.on('SIGTERM', () => { proc.kill(); process.exit(0); });
}

start();
