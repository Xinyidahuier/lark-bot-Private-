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
const project = require('./project-tracker');

// MKT market intel group
const MKT_GROUP_ID   = 'oc_12fc8f4549a84a7baead445c0dc1eb05';
// Report destination group
const REPORT_GROUP_ID = 'oc_24241b5a95135178db2a7303b9e255bd'; // FH_ล็อบสเตอร์ผัดผงกะหรี่
const DIGEST_HOUR    = 18; // 6 PM Bangkok time, send daily digest to user DM
const PROJECT_SUMMARY_HOUR = 9; // 9 AM Bangkok time, send project summary

// Reliable Bangkok time helper (UTC+7, no locale parsing)
function getBangkokNow() {
  const now = new Date();
  const bkk = new Date(now.getTime() + 7 * 3600 * 1000);
  return {
    hours: bkk.getUTCHours(),
    day: bkk.getUTCDay(),        // 0=Sun, 6=Sat
    date: bkk.toISOString().slice(0, 10), // YYYY-MM-DD
    year: bkk.getUTCFullYear(),
    // ISO week number
    weekKey: (() => {
      const jan1 = new Date(Date.UTC(bkk.getUTCFullYear(), 0, 1));
      const days = Math.floor((bkk - jan1) / 86400000);
      const wn = Math.ceil((days + jan1.getUTCDay() + 1) / 7);
      return `${bkk.getUTCFullYear()}-W${wn}`;
    })(),
  };
}

// Convert UTC ISO string to Bangkok ISO string (for Feishu API)
function utcToBangkokISO(utcStr) {
  const d = new Date(utcStr);
  const bkk = new Date(d.getTime() + 7 * 3600 * 1000);
  return bkk.toISOString().replace('Z', '+07:00');
}

// Track last seen message time for backfill on restart
const LAST_SEEN_FILE = path.join(__dirname, '.last-seen-time');
// Track last sent dates to avoid re-sending on restart
const SENT_TRACKER_FILE = path.join(__dirname, '.sent-tracker.json');
// Track processed message IDs to avoid double-processing (persistent, max 500)
const PROCESSED_IDS_FILE = path.join(__dirname, '.processed-msg-ids.json');
const processedMsgIds = new Set();

function loadProcessedIds() {
  try {
    if (fs.existsSync(PROCESSED_IDS_FILE)) {
      const arr = JSON.parse(fs.readFileSync(PROCESSED_IDS_FILE, 'utf8'));
      if (Array.isArray(arr)) arr.forEach(id => processedMsgIds.add(id));
      console.log(`[dedup] loaded ${processedMsgIds.size} processed message IDs`);
    }
  } catch {}
}

function saveProcessedIds() {
  try {
    const arr = [...processedMsgIds].slice(-500);
    atomicWriteJSON(PROCESSED_IDS_FILE, arr);
  } catch {}
}

loadProcessedIds();

function loadSentTracker() {
  try {
    if (fs.existsSync(SENT_TRACKER_FILE)) {
      return JSON.parse(fs.readFileSync(SENT_TRACKER_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

// Atomic write: write to tmp file then rename to avoid corruption on crash
function atomicWriteJSON(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, filePath);
}

function saveSentTracker(tracker) {
  try { atomicWriteJSON(SENT_TRACKER_FILE, tracker); } catch {}
}

// Robust Claude binary resolution
const CLAUDE_BIN = (() => {
  if (process.platform !== 'darwin') return 'claude';
  try {
    const p = execFileSync('which', ['claude'], { encoding: 'utf8', timeout: 3000 }).trim();
    if (p) return p;
  } catch {}
  const npxPath = `${process.env.HOME}/.npm/_npx/becf7b9e49303068/node_modules/.bin/claude`;
  if (fs.existsSync(npxPath)) return npxPath;
  return 'claude';
})();

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

  if (/给.{1,20}(发消息|说|发|转告|通知)|发消息给.{1,20}|转告.{1,20}/.test(t))
    return 'send_message';

  if (/找.{0,5}(文档|文件|doc|表格|sheet)|搜索.{0,5}(文档|文件)|帮我找|查找文档/.test(t))
    return 'search_doc';

  // Feishu link + action (总结/看/读/分析)
  if (/feishu\.cn\/.+/.test(t) && /总结|帮我|看看|分析|读|整理|汇总/.test(t))
    return 'summarize_link';

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

// Known colleagues: name aliases → open_id
const CONTACTS = {
  'ou_da8bfdc32c3feb01d5de226ab9add344': ['邓晓丹', '晓丹'],
  'ou_3c4b59ceb7046a739b7ed4cb5c2835c8': ['Kritsada', 'Joe', 'kritsada', 'joe'],
  'ou_4c58562316b75c550e654f8a76cf568c': ['Tang Meilin', 'Meilin', '美琳', 'tang meilin'],
  'ou_8b25c8ee32a3bcc400cc05ec89dd0bb6': ['Miao Li', '苗力', 'miao li'],
  'ou_160bc415e95496f754f6fdc05c5996a9': ['Wang Xinyi', 'Xinyi', '心怡', '王心怡', 'wang xinyi'],
};

function findContactOpenId(name) {
  const lower = name.toLowerCase();
  for (const [openId, aliases] of Object.entries(CONTACTS)) {
    if (aliases.some(a => a.toLowerCase() === lower || lower.includes(a.toLowerCase()) || a.toLowerCase().includes(lower))) {
      return { openId, displayName: aliases[0] };
    }
  }
  return null;
}

function handleSendMessage(userText) {
  let name, message;
  let match;

  match = userText.match(/给\s*(.+?)\s*(?:发消息|说|发|转告|通知)[：:\s]*(.+)/s);
  if (match) {
    name = match[1].trim();
    message = match[2].trim();
  }

  if (!match) {
    match = userText.match(/(?:发消息给|转告)\s*(.+?)[：:\s]*(.+)/s);
    if (match) {
      name = match[1].trim();
      message = match[2].trim();
    }
  }

  if (!name || !message) {
    return '格式示例：\n"给邓晓丹发消息：明天下午3点开会"\n"给Kritsada说请更新负数网点清单"';
  }

  console.log(`[tool] send message to "${name}": ${message.slice(0, 50)}`);

  // Look up in local contacts first
  const contact = findContactOpenId(name);

  if (contact) {
    const sendResult = lark.sendMessage({ openId: contact.openId, text: message });
    if (sendResult.ok || (sendResult.data && !sendResult.error)) {
      return `✅ 已发送给 ${contact.displayName}:\n"${message}"`;
    }
    return `发送失败: ${JSON.stringify(sendResult.error || sendResult).slice(0, 200)}`;
  }

  // Fallback: try searching (only works if user is logged in)
  const searchResult = lark.run([
    'contact', '+search-user', '--query', name,
  ], { asUser: true });

  if (searchResult.ok && searchResult.data?.users?.length > 0) {
    const target = searchResult.data.users[0];
    const sendResult = lark.sendMessage({ openId: target.open_id, text: message });
    if (sendResult.ok || (sendResult.data && !sendResult.error)) {
      return `✅ 已发送给 ${target.name}:\n"${message}"`;
    }
    return `发送失败: ${JSON.stringify(sendResult.error || sendResult).slice(0, 200)}`;
  }

  return `找不到"${name}"。目前支持的联系人：${Object.values(CONTACTS).map(a => a[0]).join('、')}`;
}

function handleSummarizeLink(userText) {
  // Extract Feishu URL
  const urlMatch = userText.match(/(https?:\/\/[^\s]+feishu\.cn\/[^\s]+)/);
  if (!urlMatch) return '请发送飞书文档链接，我来帮你总结';

  const url = urlMatch[1];
  const userRequest = userText.replace(url, '').trim();
  console.log(`[tool] summarize link: ${url}`);

  let content = '';
  let title = '';

  // Detect link type and fetch content
  const wikiMatch = url.match(/\/wiki\/([A-Za-z0-9]+)/);
  const baseMatch = url.match(/\/base\/([A-Za-z0-9]+)/);
  const docxMatch = url.match(/\/docx\/([A-Za-z0-9]+)/);
  const tableMatch = url.match(/[?&]table=([A-Za-z0-9]+)/);

  try {
    if (wikiMatch) {
      // Wiki link — resolve to real obj_type and obj_token
      const nodeResp = lark.run([
        'wiki', 'spaces', 'get_node',
        '--params', JSON.stringify({ token: wikiMatch[1] }),
      ]);

      if (!nodeResp.data?.node) return '无法访问该知识库文档，请检查权限';

      const node = nodeResp.data.node;
      title = node.title || '';
      const objToken = node.obj_token;
      const objType = node.obj_type;

      if (objType === 'bitable') {
        // It's a Base — read records
        const tableId = tableMatch ? tableMatch[1] : null;
        content = fetchBaseContent(objToken, tableId);
      } else if (objType === 'docx' || objType === 'doc') {
        content = fetchDocContent(objToken);
      } else {
        return `这是一个 ${objType} 类型的文档，暂不支持总结`;
      }
    } else if (baseMatch) {
      const tableId = tableMatch ? tableMatch[1] : null;
      content = fetchBaseContent(baseMatch[1], tableId);
    } else if (docxMatch) {
      content = fetchDocContent(docxMatch[1]);
    } else {
      return '暂不支持该类型的链接';
    }
  } catch (err) {
    console.error('[summarize] fetch error:', err.message);
    return `读取文档失败: ${err.message.slice(0, 100)}`;
  }

  if (!content || content.length < 10) return '文档内容为空或无法读取';

  // Truncate if too long
  const maxLen = 8000;
  const truncated = content.length > maxLen ? content.slice(0, maxLen) + '\n...(内容过长已截断)' : content;

  // Use Claude to summarize
  const prompt = `${title ? `文档标题: ${title}\n` : ''}用户要求: ${userRequest || '总结这个文档的内容'}

以下是文档内容:
${truncated}

请用中文简洁总结要点。如果是表格数据，提取关键趋势和数字。`;

  const summary = askClaude(prompt);
  return summary || '总结生成失败，请稍后再试';
}

function fetchBaseContent(baseToken, tableId) {
  // If no table specified, list tables first
  if (!tableId) {
    const tablesResp = lark.run(['base', '+table-list', '--base-token', baseToken]);
    if (!tablesResp.ok) return '';
    const tables = tablesResp.data?.items || [];
    if (tables.length === 0) return '';
    tableId = tables[0].table_id;
  }

  // Fetch records
  const resp = lark.run([
    'base', '+record-list', '--base-token', baseToken, '--table-id', tableId, '--limit', '50',
  ]);

  if (!resp.ok || !resp.data) return '';

  const fields = resp.data.fields || [];
  const rows = resp.data.data || [];

  // Build text table
  let text = `字段: ${fields.join(' | ')}\n\n`;
  rows.forEach((row, i) => {
    const vals = fields.map((f, j) => {
      const v = row[j];
      if (v == null) return '';
      if (Array.isArray(v)) return v.join(',');
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v);
    });
    text += `${i + 1}. ${vals.join(' | ')}\n`;
  });

  return text;
}

function fetchDocContent(docToken) {
  const resp = lark.run(['docs', '+fetch', '--doc', docToken]);
  if (resp.ok && resp.data?.content) return resp.data.content;
  if (resp.ok && resp.data) {
    // May return blocks - stringify
    return typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data).slice(0, 8000);
  }
  return '';
}

function handleSearchDoc(userText) {
  // Extract keyword
  const m = userText.match(/(?:找|搜索|查找|帮我找)\s*(?:文档|文件|doc|表格|sheet)?\s*[「「]?(.+?)[」」]?\s*(?:文档|文件|doc|表格)?$/);
  const keyword = m ? m[1].trim() : userText.replace(/找|搜索|查找|帮我找|文档|文件/g, '').trim();

  if (!keyword) return '请告诉我要搜索的关键词，比如"找sales sop文档"';

  console.log(`[tool] search doc: ${keyword}`);
  const result = lark.run(['docs', '+search', '--query', keyword, '--page-size', '5'], { asUser: true });

  if (result.error || !result.ok) {
    return `搜索失败: ${JSON.stringify(result.error || '未知错误').slice(0, 100)}`;
  }

  const items = result.data?.results || [];
  if (items.length === 0) return `没找到包含"${keyword}"的文档`;

  let reply = `📄 搜索"${keyword}"的结果：\n\n`;
  items.forEach((item, i) => {
    const meta = item.result_meta || {};
    const title = (item.title_highlighted || '').replace(/<\/?h>/g, '') || meta.token;
    const url = meta.url || '';
    const owner = meta.owner_name || '';
    const type = meta.doc_types || item.entity_type || '';
    reply += `${i + 1}. ${title}\n`;
    if (type) reply += `   类型: ${type}\n`;
    if (owner) reply += `   创建者: ${owner}\n`;
    if (url) reply += `   ${url}\n`;
    reply += '\n';
  });

  return reply.trim();
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
    case 'send_message': return handleSendMessage(userText);
    case 'search_doc':   return handleSearchDoc(userText);
    case 'summarize_link': return handleSummarizeLink(userText);
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
      '--params', JSON.stringify({ message_id: messageId }),
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

  // Track processed message IDs (persistent, cap at 500)
  if (message_id) {
    if (processedMsgIds.has(message_id)) return; // already processed
    processedMsgIds.add(message_id);
    if (processedMsgIds.size > 500) {
      const first = processedMsgIds.values().next().value;
      processedMsgIds.delete(first);
    }
    saveProcessedIds();
  }

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

  // Project summary trigger
  if (/^[\/]?(项目|项目进展|项目汇总)$/.test(userText.trim())) {
    console.log('[project] manual summary triggered');
    try {
      const summary = project.generateDailySummary();
      lark.sendMessage({ chatId: chat_id, text: summary });
    } catch (err) {
      console.error('[project] summary error:', err.message);
      lark.sendMessage({ chatId: chat_id, text: '项目汇总生成失败，请稍后再试。' });
    }
    return;
  }

  // Project update commands — single line (把XXX改成YYY)
  const projectCmd = project.parseProjectCommand(userText.trim());
  if (projectCmd) {
    console.log(`[project] update: ${projectCmd.task} → ${projectCmd.field}=${projectCmd.value}`);
    try {
      const result = project.findAndUpdateTask(projectCmd.task, projectCmd.field, projectCmd.value);
      lark.sendMessage({ chatId: chat_id, text: result.message });
    } catch (err) {
      console.error('[project] update error:', err.message);
      lark.sendMessage({ chatId: chat_id, text: '更新失败: ' + err.message });
    }
    return;
  }

  // Project update commands — multi-line batch
  const multiCmds = project.parseMultiProjectCommands(userText.trim());
  if (multiCmds && multiCmds.length > 0) {
    console.log(`[project] batch update: ${multiCmds.length} tasks → ${multiCmds[0].value}`);
    const results = [];
    for (const cmd of multiCmds) {
      try {
        const result = project.findAndUpdateTask(cmd.task, cmd.field, cmd.value);
        results.push(result.message);
      } catch (err) {
        results.push(`❌ ${cmd.task}: ${err.message}`);
      }
    }
    lark.sendMessage({ chatId: chat_id, text: results.join('\n') });
    return;
  }

  // Manual weekly report trigger
  if (/^[\/]?周报$/.test(userText.trim())) {
    console.log('[market] manual weekly report doc triggered');
    try {
      const result = market.createWeeklyReportDoc();
      lark.sendMessage({ chatId: chat_id, text: result.message });
      console.log('[market] weekly report doc sent ✓');
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
  setInterval(() => {
    try {
      const bkk = getBangkokNow();
      const tracker = loadSentTracker();

      if (bkk.hours >= DIGEST_HOUR && tracker.lastDigestDate !== bkk.date) {
        console.log('[market] sending daily digest...');
        const digest = market.getDailyDigest();
        lark.sendMessage({ openId: config.myOpenId, text: digest });
        lark.sendMessage({ chatId: REPORT_GROUP_ID, text: digest });
        tracker.lastDigestDate = bkk.date;
        saveSentTracker(tracker);
        console.log('[market] digest sent ✓ (DM + group)');
      }
    } catch (err) {
      console.error('[market] digest error:', err.message);
    }
  }, 60 * 1000);

  console.log(`[market] digest scheduler started (sends at ${DIGEST_HOUR}:00 Bangkok)`);
}

// ─────────────────────────────────────────────
// Weekly report scheduler — Saturday 14:00 Bangkok
// ─────────────────────────────────────────────

function startWeeklyReportScheduler() {
  setInterval(() => {
    try {
      const bkk = getBangkokNow();
      const tracker = loadSentTracker();

      if (bkk.day === 6 && bkk.hours >= 14 && tracker.lastReportWeek !== bkk.weekKey) {
        console.log('[market] generating weekly report...');
        const result = market.createWeeklyReportDoc();
        lark.sendMessage({ openId: config.myOpenId, text: result.message });
        lark.sendMessage({ chatId: REPORT_GROUP_ID, text: result.message });
        tracker.lastReportWeek = bkk.weekKey;
        saveSentTracker(tracker);
        console.log('[market] weekly report doc sent ✓ (DM + group)');
      }
    } catch (err) {
      console.error('[market] weekly report error:', err.message);
    }
  }, 5 * 60 * 1000);

  console.log('[market] weekly report scheduler started (Saturday 14:00 Bangkok)');
}

// ─────────────────────────────────────────────
// Project summary scheduler (09:00 Bangkok time)
// ─────────────────────────────────────────────

function startProjectSummaryScheduler() {
  setInterval(() => {
    try {
      const bkk = getBangkokNow();
      const tracker = loadSentTracker();

      if (bkk.hours >= PROJECT_SUMMARY_HOUR && tracker.lastSummaryDate !== bkk.date) {
        console.log('[project] sending daily project summary...');
        const summary = project.generateDailySummary();
        lark.sendMessage({ openId: config.myOpenId, text: summary });
        tracker.lastSummaryDate = bkk.date;
        saveSentTracker(tracker);
        console.log('[project] summary sent ✓');
      }
    } catch (err) {
      console.error('[project] summary error:', err.message);
    }
  }, 60 * 1000);

  console.log(`[project] summary scheduler started (sends at ${PROJECT_SUMMARY_HOUR}:00 Bangkok)`);
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

  // Convert UTC timestamps to Bangkok time (UTC+7) ISO format
  function utcToBangkokISO(utcStr) {
    const d = new Date(utcStr);
    const bkk = new Date(d.getTime() + 7 * 3600 * 1000);
    return bkk.toISOString().replace('Z', '+07:00');
  }
  const startISO = utcToBangkokISO(lastSeen);
  const endISO = utcToBangkokISO(now.toISOString());

  try {
    const out = execFileSync('lark-cli', [
      'im', '+chat-messages-list', '--as', 'user',
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

      // Skip if already processed (persistent dedup)
      if (messageId && processedMsgIds.has(messageId)) continue;
      if (messageId) {
        processedMsgIds.add(messageId);
        if (processedMsgIds.size > 500) {
          const first = processedMsgIds.values().next().value;
          processedMsgIds.delete(first);
        }
        saveProcessedIds();
      }

      // Extract image keys
      const imageKeys = [];
      // Pattern 1: [Image: img_v3_xxx] format
      const imgTagMatches = content.matchAll(/\[Image:\s*(img_[^\]]+)\]/g);
      for (const m of imgTagMatches) imageKeys.push(m[1].replace(/[\]\)"'\s]+$/, ''));
      // Pattern 2: bare img_v3_ references
      if (imageKeys.length === 0) {
        const bare = content.match(/img_v3_\S+/g) || [];
        imageKeys.push(...bare.map(k => k.replace(/[\]\)"'\s]+$/, '')));
      }
      // Pattern 3: pure image messages
      if (msgType === 'image' && imageKeys.length === 0) {
        const imgM = content.match(/img_\S+/g);
        if (imgM) imageKeys.push(...imgM.map(k => k.replace(/[\]\)"'\s]+$/, '')));
      }

      const textOnly = content.replace(/\[Image:\s*[^\]]+\]/g, '').trim();

      const hasImages = imageKeys.length > 0;
      if (!hasImages && (!textOnly || textOnly.length < 20)) continue;

      console.log(`[backfill] processing: ${textOnly.slice(0, 50)} (images: ${imageKeys.length})`);

      // Yield event loop between messages so real-time events can be handled
      await new Promise(r => setTimeout(r, 100));

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

// ─────────────────────────────────────────────
// Periodic poll: safety net for dropped WebSocket events
// ─────────────────────────────────────────────
const POLL_INTERVAL = 2 * 60 * 1000; // 2 minutes — more aggressive polling as safety net

async function pollMktGroup() {
  try {
    const now = new Date();
    // Look back 60 minutes — wide window to catch dropped WebSocket events
    // processedMsgIds prevents double-processing, isDuplicate prevents double-recording
    const since = new Date(now.getTime() - 60 * 60 * 1000);
    console.log(`[poll] checking MKT group (last 60 min)`);

    function utcToBangkokISO(utcStr) {
      const d = new Date(utcStr);
      const bkk = new Date(d.getTime() + 7 * 3600 * 1000);
      return bkk.toISOString().replace('Z', '+07:00');
    }
    const startISO = utcToBangkokISO(since.toISOString());
    const endISO = utcToBangkokISO(now.toISOString());

    const out = execFileSync('lark-cli', [
      'im', '+chat-messages-list', '--as', 'user',
      '--chat-id', MKT_GROUP_ID,
      '--start', startISO, '--end', endISO,
      '--page-size', '50', '--format', 'json',
    ], { encoding: 'utf8', timeout: 30000, env: process.env });

    const resp = JSON.parse(out);
    if (!resp.ok || !resp.data || !resp.data.messages) return;

    const msgs = resp.data.messages
      .filter(m => m.sender && m.sender.sender_type !== 'bot')
      .sort((a, b) => (a.create_time || '').localeCompare(b.create_time || ''));

    let newCount = 0;
    for (const msg of msgs) {
      const messageId = msg.message_id || '';
      if (!messageId || processedMsgIds.has(messageId)) continue;

      // Mark as processed (persistent)
      processedMsgIds.add(messageId);
      if (processedMsgIds.size > 500) {
        const first = processedMsgIds.values().next().value;
        processedMsgIds.delete(first);
      }
      saveProcessedIds();

      const content = msg.content || '';
      const msgType = msg.msg_type || 'text';

      // Extract image keys from content
      const imageKeys = [];
      // Pattern 1: [Image: img_v3_xxx] format from lark-cli
      const tagMatches = content.matchAll(/\[Image:\s*(img_[^\]]+)\]/g);
      for (const m of tagMatches) imageKeys.push(m[1].replace(/[\]\)"'\s]+$/, ''));
      // Pattern 2: bare img_v3_ references
      if (imageKeys.length === 0) {
        const bareMatches = content.matchAll(/img_v3_\S+/g);
        for (const m of bareMatches) imageKeys.push(m[0].replace(/[\]\)"'\s]+$/, ''));
      }
      // Pattern 3: pure image messages
      if (msgType === 'image' && imageKeys.length === 0) {
        const imgMatch = content.match(/img_\S+/g);
        if (imgMatch) imageKeys.push(...imgMatch.map(k => k.replace(/[\]\)"'\s]+$/, '')));
      }
      const textOnly = content.replace(/\[Image:\s*[^\]]+\]/g, '').trim();
      const hasImages = imageKeys.length > 0;
      if (!hasImages && (!textOnly || textOnly.length < 20)) continue;

      console.log(`[poll] processing: ${textOnly.slice(0, 50)} (images: ${imageKeys.length})`);

      try {
        const result = market.processMessage(textOnly, messageId, undefined, {
          imageKeys,
          senderId: msg.sender ? msg.sender.id : '',
          senderName: msg.sender ? msg.sender.name : '',
        });

        if (result.skip) {
          console.log('[poll] skipped (irrelevant)');
        } else if (result.duplicate) {
          console.log(`[poll] duplicate: ${result.intel.brand}`);
        } else {
          console.log(`[poll] new: ${result.intel.brand} - ${result.intel.summary}`);
          newCount++;
        }
      } catch (err) {
        console.error(`[poll] error: ${err.message.slice(0, 80)}`);
      }

      // Yield between messages
      await new Promise(r => setTimeout(r, 100));
    }

    if (newCount > 0) console.log(`[poll] picked up ${newCount} missed messages`);
  } catch (err) {
    console.error(`[poll] error: ${(err.message || '').slice(0, 100)}`);
  }

  saveLastSeenTime();
}

let schedulersStarted = false;
let lastEventTime = Date.now();
let eventProc = null;
let eventRl = null;  // readline interface reference for cleanup
let eventRestartAttempts = 0;  // track consecutive restart failures
const EVENT_WATCHDOG_INTERVAL = 10 * 60 * 1000; // 10 min
const EVENT_STALE_THRESHOLD   = 30 * 60 * 1000; // 30 min without events → restart

function cleanupEventListener() {
  if (eventRl) { try { eventRl.close(); } catch {} eventRl = null; }
  if (eventProc) {
    try { eventProc.kill('SIGKILL'); } catch {}
    eventProc = null;
  }
}

function startEventListener() {
  cleanupEventListener(); // ensure no leftover from previous run
  console.log('[bot] Starting Feishu event listener...');
  lastEventTime = Date.now();

  // Verify lark-cli exists before spawning
  try {
    execFileSync('which', ['lark-cli'], { encoding: 'utf8', timeout: 3000 });
  } catch {
    console.error('[bot] FATAL: lark-cli not found in PATH. Event listener cannot start.');
    console.error('[bot] PATH:', process.env.PATH);
    // Don't exit — poll-based fallback will still work
    return;
  }

  const proc = spawn('lark-cli', [
    'event', '+subscribe',
    '--event-types', 'im.message.receive_v1',
    '--compact', '--quiet', '--as', 'bot', '--force',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  eventProc = proc;

  proc.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) {
      console.error('[lark-cli]', msg);
      lastEventTime = Date.now();
    }
  });

  proc.on('error', (err) => {
    // DON'T exit the process — just log and retry with backoff
    console.error('[bot] spawn error:', err.message);
    eventRestartAttempts++;
    const delay = Math.min(5000 * Math.pow(2, eventRestartAttempts), 300000); // max 5 min
    console.error(`[bot] will retry event listener in ${Math.round(delay/1000)}s (attempt ${eventRestartAttempts})`);
    setTimeout(startEventListener, delay);
  });
  proc.on('close', (code) => {
    eventProc = null;
    if (eventRl) { try { eventRl.close(); } catch {} eventRl = null; }
    if (code === 0) {
      // Normal exit — likely killed by watchdog or signal, restart quickly
      eventRestartAttempts = 0;
      console.log(`[bot] lark-cli exited normally. Restarting event listener in 5s...`);
      setTimeout(startEventListener, 5000);
    } else {
      // Error exit — apply backoff
      eventRestartAttempts++;
      const delay = Math.min(5000 * Math.pow(2, eventRestartAttempts), 300000);
      console.error(`[bot] lark-cli exited (code ${code}). Restarting in ${Math.round(delay/1000)}s (attempt ${eventRestartAttempts})`);
      setTimeout(startEventListener, delay);
    }
  });

  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
  eventRl = rl;
  rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    lastEventTime = Date.now();
    eventRestartAttempts = 0; // reset backoff on successful data
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type !== 'im.message.receive_v1') return;
    console.log(`[event] chat_type=${event.chat_type} content=${JSON.stringify(event.content)}`);
    handleEvent(event).catch(err => console.error('[bot] error:', err.message));
  });
}

function startupSelfTest() {
  console.log('[selftest] Running startup checks...');
  let ok = true;

  // 1. Check lark-cli
  try {
    const ver = execFileSync('lark-cli', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
    console.log(`[selftest] lark-cli: ${ver}`);
  } catch (err) {
    console.error('[selftest] ✗ lark-cli not found or not working:', err.message?.slice(0, 80));
    ok = false;
  }

  // 2. Check lark-cli auth (bot)
  try {
    const out = execFileSync('lark-cli', ['auth', 'status', '--as', 'bot'], { encoding: 'utf8', timeout: 5000 }).trim();
    console.log(`[selftest] bot auth: ${out.slice(0, 80)}`);
  } catch (err) {
    console.error('[selftest] ✗ bot auth failed:', (err.stdout || err.message || '').slice(0, 80));
  }

  // 3. Check claude binary
  try {
    execFileSync(CLAUDE_BIN, ['--version'], { encoding: 'utf8', timeout: 5000 });
    console.log(`[selftest] claude: OK (${CLAUDE_BIN})`);
  } catch (err) {
    console.error(`[selftest] ⚠ claude not available (${CLAUDE_BIN}): ${(err.message || '').slice(0, 60)}`);
    console.error('[selftest]   (image analysis and AI features will not work)');
  }

  // 4. Check required files
  const requiredFiles = ['config.js', 'market-intel.js', 'message-filter.js', 'conversation.js', 'lark-executor.js'];
  for (const f of requiredFiles) {
    if (!fs.existsSync(path.join(__dirname, f))) {
      console.error(`[selftest] ✗ missing required file: ${f}`);
      ok = false;
    }
  }

  console.log(`[selftest] ${ok ? '✓ All critical checks passed' : '⚠ Some checks failed — bot may have limited functionality'}`);
  return ok;
}

function start() {
  console.log(`[bot] Bot: ${config.botOpenId}`);
  console.log(`[market] Monitoring MKT group: ${MKT_GROUP_ID}`);

  // Run self-test before starting
  startupSelfTest();

  // Backfill missed messages from downtime
  backfillMissedMessages().catch(err => console.error('[backfill] error:', err.message));

  startDigestScheduler();
  startWeeklyReportScheduler();
  startProjectSummaryScheduler();

  // Every 30 min, fill AI fields on Base records
  setInterval(() => {
    try {
      const filled = market.fillMissingBaseFields();
      if (filled > 0) console.log(`[market] Base: filled ${filled} records`);
    } catch (err) {
      console.error('[market] Base fill error:', err.message);
    }
  }, 30 * 60 * 1000);
  console.log('[market] Base enrichment scheduler started (every 30 min)');

  // Poll MKT group every 5 min as safety net for dropped WebSocket events
  setInterval(() => {
    pollMktGroup().catch(err => console.error('[poll] interval error:', err.message));
  }, POLL_INTERVAL);
  setTimeout(() => {
    pollMktGroup().catch(err => console.error('[poll] initial error:', err.message));
  }, 30 * 1000); // first poll 30s after startup
  console.log('[poll] MKT group polling started (every 2 min)');

  // Watchdog: restart event listener if no events for 30 min
  setInterval(() => {
    const silentMin = Math.round((Date.now() - lastEventTime) / 60000);
    if (silentMin >= EVENT_STALE_THRESHOLD / 60000) {
      console.log(`[watchdog] no events for ${silentMin} min — restarting event listener`);
      lastEventTime = Date.now();
      startEventListener(); // cleanupEventListener() is called inside
    }
  }, EVENT_WATCHDOG_INTERVAL);
  console.log('[watchdog] event listener watchdog started (30 min threshold)');

  // Temp image cleanup every 6 hours — delete images older than 1 day
  setInterval(() => {
    try {
      const imgDir = path.join(require('os').tmpdir(), 'mkt-imgs');
      if (!fs.existsSync(imgDir)) return;
      const cutoff = Date.now() - 24 * 3600 * 1000;
      for (const f of fs.readdirSync(imgDir)) {
        const fp = path.join(imgDir, f);
        const stat = fs.statSync(fp);
        if (stat.mtimeMs < cutoff) { fs.unlinkSync(fp); }
      }
    } catch {}
  }, 6 * 3600 * 1000);
  console.log('[cleanup] temp image cleanup scheduled (every 6h)');

  startEventListener();
}

// Signal handlers — registered ONCE at top level
process.on('SIGINT',  () => { cleanupEventListener(); process.exit(0); });
process.on('SIGTERM', () => { cleanupEventListener(); process.exit(0); });

// Global error handlers — prevent silent crashes
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaught exception:', err.message, err.stack?.slice(0, 200));
  // Don't exit — let pm2 handle restart if needed
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandled rejection:', String(reason).slice(0, 200));
});

start();
