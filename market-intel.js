'use strict';

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DB_PATH        = path.join(__dirname, 'market-intel-db.json');
const CLAUDE_BIN     = process.platform === 'darwin'
  ? `${process.env.HOME}/.npm/_npx/becf7b9e49303068/node_modules/.bin/claude`
  : 'claude';
const LARK_CLI       = process.platform === 'darwin' ? '/opt/homebrew/bin/lark-cli' : 'lark-cli';
const SHEET_TOKEN    = 'CzQJseP6OhchaKtHNjxc8VfqnEp';
const SHEET_ID       = 'c54bde';
const BASE_TOKEN     = 'LMZvbR705a9P6gsndJCcoQOVnpc';
const BASE_TABLE_ID  = 'tblVMYncStg04W6z';

// New bot-controlled Base
const NEW_BASE_TOKEN    = 'G0s6bQp3maWmOrsEry3ckCdVnId';
const NEW_BASE_TABLE_ID = 'tbla6yLcFRaLpbhk';
const IMAGE_FIELD_ID    = 'fldIAH2rzj';  // 图片 attachment field
const IMG_TEMP_DIR      = path.join(require('os').tmpdir(), 'mkt-imgs');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// Market info collection spreadsheet
const COLLECTION_SHEET_TOKEN = 'D4FxsO9RvhwbI2txLtFcnsnFnRd';
const AMBD_SHEET_ID          = 'I0rTfC';

// ─────────────────────────────────────────────
// Module classification
// ─────────────────────────────────────────────

const BROKERS = new Set([
  'MySave','My Save','Shippop','Me 2 Plus','Me2 Plus','Me2Plus',
  'Point Express','Skybox','Postway','SuperShip','ShipHub','ShipSmile','Shipsmile',
  'DPlus','D Plus','Dplus','SmallWin','My Express','My Order','Order Plus',
  'WeFast','GoShip','Goship','BS Express','iShip','Iship','Quick Service','Yod Express','ยอด เอ็กซ์เพรส',
  'Shipnity','TaibaanShip','POST SABUY (Prompt Speed)','Shipplan',
  'Order Xpress','PEX','Idrop service',
]);

const CARRIERS = new Set([
  'KEX','SPX','J&T','DHL','BEST','Best Express','Thailand Post',
  'Inter Express','Flash','Flash Home','LEX','EMS',
]);

// Brand → Competitors name in DropDown sheet
const BRAND_TO_COMPETITOR_NAME = {
  'KEX': 'KEX Thailand', 'SPX': 'SPX Express TH', 'J&T': 'J&T Express Thailand',
  'DHL': 'DHL Express Thailand', 'BEST': 'Best Express', 'Best Express': 'Best Express',
  'Thailand Post': 'Thailand Post', 'Inter Express': 'Inter Express',
  'Flash': 'Flash Express', 'Flash Home': 'Flash Express',
  'My Save': 'My Save', 'MySave': 'My Save', 'Shippop': 'SHIPPOP',
  'Me 2 Plus': 'Me2 Plus', 'Me2Plus': 'Me2 Plus',
  'Point Express': 'Point Express (Prompt Speed)',
  'ShipSmile': 'Shipsmile Services (Prompt Speed)', 'Shipsmile': 'Shipsmile Services (Prompt Speed)',
  'Quick Service': 'Quick Service', 'GoShip': 'Goship', 'Goship': 'Goship',
  'SmallWin': 'SmallWin', 'iShip': 'iShip', 'Iship': 'iShip',
  'DPlus': 'Dplus', 'D Plus': 'Dplus', 'Dplus': 'Dplus',
  'My Express': 'My Express', 'My Order': 'My Order', 'Order Plus': 'Order Plus',
  'Postway': 'Postway', 'SuperShip': 'SuperShip', 'ShipHub': 'ShipHub',
  'WeFast': 'WeFast', 'BS Express': 'BS Express',
};

// Category → Information Type in DropDown sheet
const CATEGORY_TO_INFO_TYPE = {
  '价格调整': 'Standard Price', 'VIP价格': 'VIP Price', '水果件': 'Fruit Price',
  '燃油附加费': 'Standard Price', '加盟政策': 'Package / Product / System',
  '网点套餐': 'Package / Product / System', '促销活动': 'Promotion',
  'COD政策': 'Services', 'Drop Off': 'Services', '补贴返利': 'Profit / Commission / Incentive',
  '系统功能': 'Package / Product / System', '竞对动向': 'Other Information',
  '客户投诉': 'Other Information',
};

// Module sheet classification
const MODULE_SHEETS = {
  broker_channel:     { sheetId: '0luuYq', title: '黄牛渠道及分润' },
  broker_profile:     { sheetId: 'zmfFm8', title: '黄牛基础信息表' },
  standard_price:     { sheetId: '4eLIlq', title: '竞对标准价格' },
  fruit_price:        { sheetId: 'bCmtWu', title: '竞对水果件价格' },
  large_parcel:       { sheetId: 'ccn7mk', title: '竞对大件价格' },
  vip_price:          { sheetId: 'M2W0yd', title: 'VIP价格调研' },
  promotions:         { sheetId: 'eO4r0j', title: '活动形式总结' },
  dropoff_rebate:     { sheetId: '6f4aPT', title: '电商返利送货调研' },
  competitor_profile: { sheetId: 'FIKNdr', title: '竟对基础信息表' },
  erp_research:       { sheetId: 'f91AqC', title: 'ERP调研' },
  unlimited_size:     { sheetId: 'jJreqK', title: '不限尺寸价格政策' },
  label_printing:     { sheetId: 'mbOwbQ', title: '黄牛WEB打印面单调研' },
  raw_data:           { sheetId: 'I0rTfC', title: '市场信息-AMBD 2026' },
};

function classifyModule(intel) {
  const brand = intel.brand || '';
  const cat   = intel.category || '';
  const isBroker  = BROKERS.has(brand);
  const isCarrier = CARRIERS.has(brand);

  let moduleKey = 'raw_data'; // default

  if (isBroker) {
    if (['价格调整','补贴返利','VIP价格'].includes(cat)) moduleKey = 'broker_channel';
    else moduleKey = 'broker_profile';
  } else if (isCarrier) {
    if (cat === '价格调整' || cat === '燃油附加费') moduleKey = 'standard_price';
    else if (cat === '水果件') moduleKey = 'fruit_price';
    else if (cat === 'VIP价格') moduleKey = 'vip_price';
    else if (cat === '促销活动') moduleKey = 'promotions';
    else if (cat === 'Drop Off' || cat === '补贴返利') moduleKey = 'dropoff_rebate';
    else if (cat === '加盟政策' || cat === '网点套餐') moduleKey = 'competitor_profile';
    else if (cat === '系统功能') moduleKey = 'erp_research';
    else moduleKey = 'competitor_profile';
  }

  return { moduleKey, ...MODULE_SHEETS[moduleKey] };
}

/**
 * Append a row to "市场信息-AMBD 2026" (I0rTfC)
 * Columns: Date | Week# | AM | BD | Competitors | Competitors Type | Information Type |
 *          Image | Details | Source | Status | Link | Notes
 */
function appendAMBDRow(intel, senderName, dateStr) {
  // Excel serial date: 2026-01-01 = 46023, each day +1
  const d = new Date(dateStr + 'T00:00:00Z');
  const excelDate = Math.floor((d.getTime() / 86400000) + 25569);

  // Week number (ISO week)
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);

  const competitorName = BRAND_TO_COMPETITOR_NAME[intel.brand] || intel.brand;
  const infoType = CATEGORY_TO_INFO_TYPE[intel.category] || 'Other Information';
  const module = classifyModule(intel);

  const row = [
    excelDate,                              // A: Date
    weekNum,                                // B: Week#
    '',                                     // C: AM (auto-filled by formula or manual)
    senderName || '',                       // D: BD
    competitorName,                         // E: Competitors
    '',                                     // F: Competitors Type (XLOOKUP formula, leave empty)
    infoType,                               // G: Information Type
    '',                                     // H: Image (can't programmatically insert)
    (intel.rawText || '').slice(0, 500),     // I: Details
    'MKT群(自动)',                           // J: Source
    intel.duplicate ? '旧' : '新',           // K: Status
    '',                                     // L: Link
    `[${module.title}] ${intel.analysis || ''}`, // M: Notes (module classification + AI analysis)
  ];

  try {
    execFileSync(LARK_CLI, [
      'sheets', '+append',
      '--as', 'user',
      '--spreadsheet-token', COLLECTION_SHEET_TOKEN,
      '--range', `${AMBD_SHEET_ID}!A1:M1`,
      '--values', JSON.stringify([row]),
    ], { encoding: 'utf8', timeout: 30000, env: CHILD_ENV });
    console.log(`[market-intel] AMBD row appended: [${intel.brand}] ${intel.summary}`);
  } catch (err) {
    console.error('[market-intel] AMBD append error:', (err.stderr || err.message || '').slice(0, 200));
  }
}

// How many days to look back for duplicate detection (default 30 days)
const DEFAULT_LOOKBACK_DAYS = 30;

// HQ focus topics — set dynamically from group messages
// Format: { keywords: [...], from: timestamp, until: timestamp }
const HQ_FOCUS_PATH = path.join(__dirname, 'hq-focus.json');

function loadHqFocus() {
  try {
    if (fs.existsSync(HQ_FOCUS_PATH)) return JSON.parse(fs.readFileSync(HQ_FOCUS_PATH, 'utf8'));
  } catch {}
  return { topics: [] };
}

function saveHqFocus(data) {
  fs.writeFileSync(HQ_FOCUS_PATH, JSON.stringify(data, null, 2));
}

/**
 * Detect if a message is an HQ focus request (e.g. "请大家重点收集XXX").
 * Returns { keywords, days } or null.
 */
function detectFocusRequest(text) {
  if (!text) return null;
  const prompt = `判断这条消息是否是MKT总部在布置信息收集任务（如"请大家重点关注/收集XXX"）。
如果是，提取关键词和持续天数，只输出JSON：
{"is_focus_request": true, "keywords": ["关键词1","关键词2"], "days": 7}
如果不是普通的信息收集任务布置，输出：
{"is_focus_request": false}

消息：${text.slice(0, 300)}`;

  const result = askClaude(prompt);
  if (!result) return null;
  try {
    const match = result.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const json = JSON.parse(match[0]);
    return json.is_focus_request ? json : null;
  } catch { return null; }
}

/**
 * Check if intel matches any active HQ focus topic.
 */
function matchesHqFocus(intel) {
  const focus = loadHqFocus();
  const now = Date.now();
  const active = focus.topics.filter(t => now < t.until);
  if (active.length === 0) return false;

  const text = `${intel.brand} ${intel.category} ${intel.summary} ${intel.analysis || ''}`.toLowerCase();
  return active.some(t =>
    t.keywords.some(kw => text.includes(kw.toLowerCase()))
  );
}

// Shared env: node must be in PATH for lark-cli to work
const CHILD_ENV = {
  ...process.env,
  PATH: process.platform === 'darwin' ? `/opt/homebrew/bin:${process.env.PATH}` : process.env.PATH,
  FORCE_COLOR: '0',
  ANTHROPIC_API_KEY: '',
};

// ─────────────────────────────────────────────
// DB helpers (JSON cache – fast dedup / digest)
// ─────────────────────────────────────────────

function loadDb() {
  try {
    if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {}
  return { entries: [] };
}

function saveDb(db) {
  // Keep only last 60 days in local cache
  const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
  db.entries = db.entries.filter(e => e.timestamp > cutoff);
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// Old Base snapshot — one-time export, no API calls needed
const OLD_BASE_SNAPSHOT = path.join(__dirname, 'old-base-snapshot.json');

/**
 * Sync local db from new Base + old Base snapshot.
 * Old Base: read from local JSON file (0 API calls)
 * New Base: 1 API call to get latest records
 */
function syncFromBase() {
  const db = loadDb();

  // 1) Load old Base snapshot (local file, instant)
  try {
    if (fs.existsSync(OLD_BASE_SNAPSHOT)) {
      const snapshot = JSON.parse(fs.readFileSync(OLD_BASE_SNAPSHOT, 'utf8'));
      let added = 0;
      for (const rec of snapshot) {
        const { brand, summary } = rec;
        if (!brand) continue;
        const alreadyExists = db.entries.some(e =>
          e.brand === brand && e.summary &&
          summary && (e.summary.slice(0, 10) === summary.slice(0, 10))
        );
        if (alreadyExists) continue;
        db.entries.push({
          brand, category: '', summary: summary || '', amount: '',
          timestamp: Date.now() - 60 * 24 * 3600 * 1000,
          duplicate: false, mark: '✅', source: 'old_base',
        });
        added++;
      }
      if (added > 0) console.log(`[market-intel] loaded ${added} records from old Base snapshot`);
    }
  } catch (err) {
    console.error('[market-intel] old Base snapshot error:', (err.message || '').slice(0, 100));
  }

  // 2) Sync from new Base (1 API call)
  try {
    const out = execFileSync(LARK_CLI, [
      'base', '+record-list', '--as', 'bot',
      '--base-token', NEW_BASE_TOKEN,
      '--table-id', NEW_BASE_TABLE_ID,
      '--limit', '200',
    ], { encoding: 'utf8', timeout: 30000, env: CHILD_ENV });
    const resp = JSON.parse(out);
    const data = resp.data || {};
    // New Base uses array format: fields list + data rows
    const fields = data.fields || [];
    const rows = data.data || [];
    const rids = data.record_id_list || [];
    if (!fields.length || !rows.length) { saveDb(db); return; }

    // Build field index map
    const fi = {};
    fields.forEach((f, i) => { fi[f] = i; });

    let added = 0;
    for (const row of rows) {
      const brand = extractField(row, fi, '品牌');
      const category = extractField(row, fi, '类别');
      const summary = extractField(row, fi, '摘要');
      const amount = extractField(row, fi, '金额');
      if (!brand) continue;

      const alreadyExists = db.entries.some(e =>
        e.brand === brand && summary &&
        (e.summary || '').slice(0, 10) === summary.slice(0, 10)
      );
      if (alreadyExists) continue;

      const dupField = extractField(row, fi, '是否重复');
      db.entries.push({
        brand, category, summary, amount,
        timestamp: Date.now(),
        duplicate: (dupField || '').includes('重复'),
        mark: (dupField || '').includes('重复') ? '👀' : '✅',
      });
      added++;
    }
    if (added > 0) console.log(`[market-intel] synced ${added} records from new Base`);
  } catch (err) {
    console.error('[market-intel] new Base sync error:', (err.message || '').slice(0, 100));
  }

  saveDb(db);
}

/** Extract a field value from array-format row */
function extractField(row, fieldIndex, fieldName) {
  const idx = fieldIndex[fieldName];
  if (idx === undefined || idx >= row.length) return '';
  const val = row[idx];
  if (Array.isArray(val)) return val[0] ? String(val[0]) : '';
  return val ? String(val) : '';
}

// Sync on module load
syncFromBase();

// ─────────────────────────────────────────────
// Claude helper
// ─────────────────────────────────────────────

function askClaude(prompt) {
  try {
    return execFileSync(CLAUDE_BIN, ['-p', prompt, '--allowedTools', ''], {
      encoding: 'utf8',
      timeout: 120000,
      env: CHILD_ENV,
    }).trim();
  } catch (err) {
    const out = (err.stdout || '').trim();
    return out || null;
  }
}

// ─────────────────────────────────────────────
// Feishu sheet helpers
// ─────────────────────────────────────────────

/**
 * Append one row to the Feishu spreadsheet.
 * Columns: 日期 | 时间 | 品牌 | 类别 | 摘要 | 金额 | 生效日期 | 标记 | 总部重点 | 原文摘录 | 消息ID | 分析
 */
function appendSheetRow(intel, mark, messageId, dateStr, timeStr) {
  const row = [
    dateStr,
    timeStr,
    intel.brand      || '',
    intel.category   || '',
    intel.summary    || '',
    intel.amount     || '',
    intel.effective_date || '',
    mark,
    intel.is_hq_priority ? '⭐是' : '否',
    (intel.rawText  || '').slice(0, 200),
    messageId        || '',
    intel.analysis   || '',
  ];

  try {
    execFileSync(LARK_CLI, [
      'sheets', '+append',
      '--spreadsheet-token', SHEET_TOKEN,
      '--sheet-id',          SHEET_ID,
      '--range',             'A1:L1',
      '--values',            JSON.stringify([row]),
    ], {
      encoding: 'utf8',
      timeout:  30000,
      env:      CHILD_ENV,
    });
  } catch (err) {
    // Non-fatal: log but don't break message processing
    console.error('[market-intel] sheet append error:', (err.stderr || err.message || '').slice(0, 300));
  }
}

/**
 * Scan Base for records missing the 3 AI fields and fill them in.
 * Called periodically (every 30 min) to enrich records created by the other bot.
 */
function fillMissingBaseFields() {
  const HQ_BRANDS = new Set(['KEX', 'SPX', 'J&T', 'DHL', 'Best Express']);

  // Get last 100 records (most recent page)
  let raw;
  try {
    raw = execFileSync(LARK_CLI, [
      'base', '+record-list',
      '--base-token', BASE_TOKEN,
      '--table-id',   BASE_TABLE_ID,
      '--offset', '0', '--limit', '200',
    ], { encoding: 'utf8', timeout: 30000, env: CHILD_ENV });
  } catch (err) {
    console.error('[market-intel] base list error:', (err.stderr || err.message || '').slice(0, 200));
    return 0;
  }

  let data;
  try { data = JSON.parse(raw); } catch { return 0; }

  const fields = data.data.fields;
  const records = data.data.data;
  const ids = data.data.record_id_list;
  const fi = {};
  fields.forEach((f, i) => fi[f] = i);

  // Also try to read more pages to find the latest records
  let allRecords = records.map((r, i) => ({ rec: r, id: ids[i] }));

  // Check if there are more pages and get the last page
  if (data.data.has_more) {
    // Get total by trying high offsets
    for (const offset of [2000, 2200, 2400, 2600]) {
      try {
        const page = execFileSync(LARK_CLI, [
          'base', '+record-list',
          '--base-token', BASE_TOKEN,
          '--table-id',   BASE_TABLE_ID,
          '--offset', String(offset), '--limit', '200',
        ], { encoding: 'utf8', timeout: 30000, env: CHILD_ENV });
        const pd = JSON.parse(page);
        if (pd.data.data.length > 0) {
          pd.data.data.forEach((r, i) => allRecords.push({ rec: r, id: pd.data.record_id_list[i] }));
        }
        if (!pd.data.has_more) break;
      } catch { break; }
    }
  }

  // Filter: records that have no 是否重复 value
  const dupIdx = fi['是否重复'];
  const unfilled = allRecords.filter(r => !r.rec[dupIdx]);

  if (unfilled.length === 0) {
    console.log('[market-intel] base: no unfilled records found');
    return 0;
  }

  console.log(`[market-intel] base: found ${unfilled.length} records to fill`);

  const seenCombos = new Set();
  let filled = 0;

  for (const { rec, id } of unfilled) {
    const comp = rec[fi['Competitors']];
    const brand = Array.isArray(comp) ? comp[0] : comp;
    const topic = String(rec[fi['主题']] || '');
    const infoType = rec[fi['Information Type']];

    // Dedup within this batch
    const combo = `${brand}|${infoType}`;
    const isDup = seenCombos.has(combo);
    seenCombos.add(combo);

    const dupLabel = isDup ? '👀重复' : '✅新情报';
    const priorityLabel = HQ_BRANDS.has(brand) ? '🔥总部重点' : '普通';

    // Analysis
    let analysis = `${brand || '未知'}竞对信息`;
    const cleanTopic = topic.replace(/\[image\]/g, '').trim();
    if (cleanTopic.length > 20) {
      try {
        const a = askClaude(
          `用一句话（30字以内中文）分析以下竞对信息对Flash Express的影响：\n品牌：${brand}\n内容：${cleanTopic.slice(0, 500)}`
        );
        if (a) analysis = a.slice(0, 100);
      } catch {}
    }

    // Update record
    try {
      execFileSync(LARK_CLI, [
        'base', '+record-upsert',
        '--base-token', BASE_TOKEN,
        '--table-id',   BASE_TABLE_ID,
        '--record-id',  id,
        '--json', JSON.stringify({ '是否重复': dupLabel, '是否重点': priorityLabel, 'AI分析': analysis }),
      ], { encoding: 'utf8', timeout: 30000, env: CHILD_ENV });
      filled++;
    } catch (err) {
      console.error(`[market-intel] base update ${id} error:`, (err.stderr || err.message || '').slice(0, 200));
    }
  }

  console.log(`[market-intel] base: filled ${filled}/${unfilled.length} records`);
  return filled;
}

// ─────────────────────────────────────────────
// User name cache & resolver
// ─────────────────────────────────────────────

const userNameCache = {
  // External tenant users (can't be resolved via contact API)
  'ou_eba1381a4329b7c19c1c4d969fcc2bd1': 'เกลว BD 669365 BKK3,C4',
};

function resolveUserName(openId) {
  if (!openId) return '';
  if (userNameCache[openId]) return userNameCache[openId];

  // Try bot first, then user identity
  for (const identity of ['bot', 'user']) {
    try {
      const raw = execFileSync(LARK_CLI, [
        'contact', '+get-user',
        '--as', identity,
        '--user-id', openId,
      ], { encoding: 'utf8', timeout: 10000, env: CHILD_ENV });
      const data = JSON.parse(raw);
      const name = data?.data?.user?.name || '';
      if (name) {
        userNameCache[openId] = name;
        return name;
      }
    } catch {}
  }

  return openId;  // fallback to open_id
}

// ─────────────────────────────────────────────
// Image download helper
// ─────────────────────────────────────────────

function downloadImage(messageId, imageKey) {
  if (!fs.existsSync(IMG_TEMP_DIR)) fs.mkdirSync(IMG_TEMP_DIR, { recursive: true });
  const outFile = `${imageKey.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`;
  try {
    execFileSync(LARK_CLI, [
      'im', '+messages-resources-download',
      '--as', 'bot',
      '--message-id', messageId,
      '--file-key', imageKey,
      '--type', 'image',
      '--output', outFile,
    ], { encoding: 'utf8', timeout: 30000, env: CHILD_ENV, cwd: IMG_TEMP_DIR });
    return path.join(IMG_TEMP_DIR, outFile);
  } catch (err) {
    console.error('[market-intel] image download error:', (err.message || '').slice(0, 100));
    return null;
  }
}

function analyzeImage(imagePath) {
  if (!imagePath || !fs.existsSync(imagePath)) return null;
  try {
    const prompt = `Read the image file at ${imagePath} and analyze it. 这是泰国物流/快递行业的竞对情报图片（广告/价格表/海报）。请提取所有关键信息：品牌名、价格数字、重量阶梯、促销政策、服务内容。用中文简洁描述，150字以内。如果图片无法读取或不相关，回复"无"。`;

    const result = execFileSync(CLAUDE_BIN, [
      '-p', prompt,
      '--output-format', 'text',
      '--model', 'claude-opus-4-5',
      '--allowedTools', 'Read',
      '--max-turns', '2',
    ], { encoding: 'utf8', timeout: 60000 });

    const text = (result || '').trim();
    if (!text || text === '无') return null;
    console.log(`[market-intel] image analyzed: ${text.slice(0, 80)}`);
    return text;
  } catch (err) {
    console.error('[market-intel] image analysis error:', (err.message || '').slice(0, 100));
    return null;
  }
}

// ─────────────────────────────────────────────
// New Base record helper
// ─────────────────────────────────────────────

function upsertNewBaseRecord(intel, mark, messageId, timestamp, senderInfo) {
  const isHqFocus = matchesHqFocus(intel);

  const record = {
    '品牌':     intel.brand    || '',
    '类别':     intel.category || '',
    '摘要':     intel.summary  || '',
    '金额':     intel.amount   || '',
    '生效日期': intel.effective_date || '',
    '是否重复': mark === '👀' ? '👀重复' : '✅新情报',
    '是否重点': isHqFocus ? '🔥总部重点' : '普通',
    'AI分析':   intel.analysis || '',
    '发送时间': timestamp || Date.now(),
    '发送人':   senderInfo || '',
    '原文':     (intel.rawText || '').slice(0, 300),
    '模块':     intel.moduleTitle || '',
  };

  try {
    const output = execFileSync(LARK_CLI, [
      'base', '+record-upsert',
      '--as', 'bot',
      '--base-token', NEW_BASE_TOKEN,
      '--table-id',   NEW_BASE_TABLE_ID,
      '--json', JSON.stringify(record),
    ], { encoding: 'utf8', timeout: 30000, env: CHILD_ENV });
    console.log('[market-intel] new base record created');
    try {
      const data = JSON.parse(output);
      const rid = data.data && data.data.record && data.data.record.record_id_list && data.data.record.record_id_list[0];
      if (rid) console.log(`[market-intel] record_id: ${rid}`);
      return rid || null;
    } catch { return null; }
  } catch (err) {
    console.error('[market-intel] new base upsert error:', (err.stderr || err.message || '').slice(0, 200));
    return null;
  }
}

function uploadImagesToBase(recordId, imagePaths) {
  if (!recordId || !imagePaths || imagePaths.length === 0) return;
  for (const imgPath of imagePaths) {
    if (!fs.existsSync(imgPath)) continue;
    const fileName = path.basename(imgPath);
    const dirName  = path.dirname(imgPath);
    try {
      execFileSync(LARK_CLI, [
        'base', '+record-upload-attachment',
        '--as', 'bot',
        '--base-token', NEW_BASE_TOKEN,
        '--table-id',   NEW_BASE_TABLE_ID,
        '--record-id',  recordId,
        '--field-id',   IMAGE_FIELD_ID,
        '--file',       `./${fileName}`,
      ], { encoding: 'utf8', timeout: 30000, env: CHILD_ENV, cwd: dirName });
      console.log(`[market-intel] image uploaded to base: ${fileName}`);
    } catch (err) {
      console.error('[market-intel] image upload error:', (err.stderr || err.message || '').slice(0, 200));
    }
  }
}

// ─────────────────────────────────────────────
// Extract intel from message text
// ─────────────────────────────────────────────

function extractIntel(text) {
  const prompt = `你是Flash Home（Flash Express泰国加盟网点体系）的市场情报分析员。
你的任务是从MKT群消息中提取竞对/黄牛动向，并分析对Flash Home的影响。

背景知识：
- Flash Home通过返现(Rebate)支持网点，不直接压低市场价
- 竞对(KEX/SPX/J&T/DHL/BEST/邮政)和黄牛平台(MySave/ShipSmile/GoShip/Shippop/DPlus/SuperShip/Postway等)是主要监控对象
- 重点关注：价格战/补贴动向、网点争夺(加盟政策/套餐)、水果件竞争、COD/Drop Off费率、VIP价格、促销活动
- 总部重点=会直接影响Flash Home定价策略或网点流失的重大情报

严格过滤！只有以下情况才算情报(is_relevant=true)：
- 有具体的价格/费率数字（如起价XX฿、佣金X%、返利X฿/件）
- 有明确的政策变动（新政策、取消、调整生效日期）
- 有具体的竞对加盟/套餐方案细节
- 有可验证的市场动向（某品牌进入/退出某区域、抢网点）
- 有明确的服务策略（免费上门取件、免系统费、免退件费等，即使没有具体金额也算情报）
- 有促销活动详情（4.4/11.11大促、开业折扣、限时优惠等）

以下不算情报(is_relevant=false)：
- Flash/Flash Home/Flash Express 自身官方发布的信息（如Flash官方价格表、内部政策）。但如果是黄牛/第三方平台代理Flash件的价格（如iShip/ShipHub代理Flash起价XX฿），这属于黄牛情报，算is_relevant=true！
- 日常聊天、问候、感谢、表情
- 笼统的讨论/抱怨，没有具体数字或事实
- 转发但无实质内容的消息
- 已知的旧信息重复提及
- 内部工作协调（排班、会议、系统操作指导）

只输出JSON，不要其他内容：
{
  "brand": "品牌（Flash/KEX/SPX/J&T/DHL/BEST/邮政/MySave/ShipSmile/GoShip/Shippop/ShipHub/WeFast/SuperShip/DPlus/Postway等，如果是新品牌直接写品牌名，不要写'其他'）",
  "category": "类别（价格调整/VIP价格/燃油附加费/加盟政策/网点套餐/促销活动/水果件/COD政策/Drop Off/补贴返利/系统功能/竞对动向/客户投诉/无关）",
  "summary": "一句话中文摘要，20字以内",
  "amount": "金额或比例（如起价18฿、+2฿/件、COD 1.5%、返利3฿/件，无则null）",
  "effective_date": "生效日期（如4月20日，无则null）",
  "is_hq_priority": false,
  "is_relevant": true或false,
  "analysis": "50字以内中文，从Flash Home视角分析：①对Flash Home网点/客户的具体影响 ②建议关注点或应对方向。无关内容为null"
}

消息：
${text.slice(0, 800)}`;

  const result = askClaude(prompt);
  if (!result) return null;

  try {
    const match = result.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const json = JSON.parse(match[0]);
    return (json.brand && json.category) ? json : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// Duplicate detection (uses JSON cache)
// lookbackDays: how far back to check (default DEFAULT_LOOKBACK_DAYS)
// ─────────────────────────────────────────────

function isDuplicate(intel, db, lookbackDays) {
  const days   = lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const all = db.entries.filter(e => !e.duplicate);

  // Fast check 1: same brand + similar summary prefix
  if (intel.summary) {
    const prefix = intel.summary.slice(0, 10);
    const found = all.some(e =>
      e.brand === intel.brand &&
      e.summary && e.summary.slice(0, 10) === prefix
    );
    if (found) return true;
  }

  // Fast check 2: same brand + category + amount
  const recent = all.filter(e => e.timestamp > cutoff);
  const exactMatch = recent.some(e =>
    e.brand === intel.brand &&
    e.category === intel.category &&
    e.amount && e.amount === intel.amount
  );
  if (exactMatch) return true;

  // Semantic check: same brand + same category → ask Claude if it's the same event
  const sameBrandCat = recent.filter(e =>
    e.brand === intel.brand && e.category === intel.category && e.summary
  );
  if (sameBrandCat.length > 0 && intel.summary) {
    const existing = sameBrandCat.map(e =>
      `- ${e.summary}${e.amount ? ' (' + e.amount + ')' : ''}`
    ).join('\n');
    const prompt = `判断新情报是否与已有记录描述同一事件。同品牌+同类事件+同政策=重复，不同事件=不重复。只回答YES或NO。

已有[${intel.brand}/${intel.category}]：
${existing}

新情报：${intel.summary}${intel.amount ? ' (' + intel.amount + ')' : ''}`;

    const answer = askClaude(prompt);
    if (answer && answer.trim().toUpperCase().includes('YES')) {
      return true;
    }
  }

  return false;
}

// ─────────────────────────────────────────────
// Main: process a single incoming message
// Returns: { skip, duplicate, isHqPriority, intel, mark }
// ─────────────────────────────────────────────

function processMessage(text, messageId, lookbackDays, { imageKeys, senderId, senderName } = {}) {
  // Check if this is an HQ focus request (e.g. "请大家重点收集XXX")
  if (text && text.length >= 20) {
    const focusReq = detectFocusRequest(text);
    if (focusReq) {
      const focus = loadHqFocus();
      const days = focusReq.days || 7;
      focus.topics.push({
        keywords: focusReq.keywords,
        from: Date.now(),
        until: Date.now() + days * 24 * 60 * 60 * 1000,
        raw: text.slice(0, 200),
      });
      // Keep only active topics
      focus.topics = focus.topics.filter(t => Date.now() < t.until);
      saveHqFocus(focus);
      console.log(`[market-intel] HQ focus set: ${focusReq.keywords.join(', ')} for ${days} days`);
    }
  }

  // Skip very short messages and pure image captions (unless has images)
  const hasImages = imageKeys && imageKeys.length > 0;
  if (!hasImages && (!text || text.trim().length < 20)) return { skip: true };

  // Download images, analyze, and build context
  let imageContext = '';
  const downloadedImagePaths = [];
  if (hasImages) {
    const analyses = [];
    for (const imgKey of imageKeys) {
      const imgPath = downloadImage(messageId, imgKey);
      if (imgPath) {
        downloadedImagePaths.push(imgPath);
        console.log(`[market-intel] downloaded image: ${imgKey.slice(0, 30)}`);
        const analysis = analyzeImage(imgPath);
        if (analysis) analyses.push(analysis);
      }
    }
    if (analyses.length > 0) {
      imageContext = '\n[图片内容]\n' + analyses.join('\n');
    }
  }

  const combinedText = ((text || '') + imageContext).trim() || '(图片消息)';
  const intel = extractIntel(combinedText);

  // Not relevant to logistics industry
  if (!intel || !intel.is_relevant || intel.category === '无关') {
    return { skip: true };
  }

  const db        = loadDb();
  const duplicate = isDuplicate(intel, db, lookbackDays);

  // Determine emoji mark — HQ priority is based on active focus topics
  const isHqFocus = matchesHqFocus(intel);
  let mark;
  if (duplicate) {
    mark = '👀';
  } else if (isHqFocus) {
    mark = '🔥';
  } else {
    mark = '✅';
  }

  // Bangkok time strings
  const nowBKK    = new Date(Date.now() + 7 * 60 * 60 * 1000); // UTC+7
  const dateStr   = nowBKK.toISOString().slice(0, 10);
  const timeStr   = nowBKK.toISOString().slice(11, 16);        // HH:MM

  // Append to Feishu sheet (non-fatal if it fails)
  appendSheetRow({ ...intel, rawText: text }, mark, messageId, dateStr, timeStr);

  // Classify module
  const module = classifyModule(intel);
  console.log(`[market-intel] module: ${module.title}`);

  // Write to new bot-controlled Base
  const resolvedName = senderName || (senderId ? resolveUserName(senderId) : '');
  const recordId = upsertNewBaseRecord(
    { ...intel, rawText: combinedText || '', moduleTitle: module.title },
    mark,
    messageId,
    Date.now(),
    resolvedName
  );

  // Upload images to Base attachment field
  if (downloadedImagePaths.length > 0 && recordId) {
    uploadImagesToBase(recordId, downloadedImagePaths);
  }

  // Append to AMBD sheet (市场信息-AMBD 2026) — only for new intel
  if (!duplicate) {
    try {
      appendAMBDRow({ ...intel, rawText: text || '', duplicate }, resolvedName, dateStr);
    } catch (err) {
      console.error('[market-intel] AMBD error:', (err.message || '').slice(0, 100));
    }
  }

  // Update local JSON cache
  db.entries.push({
    ...intel,
    messageId,
    timestamp: Date.now(),
    date:      dateStr,
    time:      timeStr,
    duplicate,
    mark,
    rawText:   (text || '').slice(0, 300),
  });
  saveDb(db);

  return {
    skip:        false,
    duplicate,
    isHqPriority: isHqFocus,
    intel,
    mark,
  };
}

// ─────────────────────────────────────────────
// Daily digest: summarize today's new intel
// ─────────────────────────────────────────────

function getDailyDigest() {
  const db = loadDb();
  const nowBKK = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const today  = nowBKK.toISOString().slice(0, 10);

  const newEntries   = db.entries.filter(e => e.date === today && !e.duplicate && e.is_relevant !== false);
  const dupCount     = db.entries.filter(e => e.date === today && e.duplicate).length;

  if (newEntries.length === 0) {
    return `📊 市场情报日报 ${today}\n\n今日无新情报（过滤重复 ${dupCount} 条）`;
  }

  // Group by category
  const grouped = {};
  for (const e of newEntries) {
    if (!grouped[e.category]) grouped[e.category] = [];
    grouped[e.category].push(
      `${e.mark || '✅'} ${e.brand}：${e.summary}` +
      `${e.amount ? `（${e.amount}）` : ''}` +
      `${e.effective_date ? `，${e.effective_date}` : ''}`
    );
  }

  const sections = Object.entries(grouped)
    .map(([cat, items]) => `【${cat}】\n${items.join('\n')}`)
    .join('\n\n');

  const hqItems = newEntries.filter(e => e.is_hq_priority);

  let digest = `📊 市场情报日报 ${today}\n`;
  digest += `（新增 ${newEntries.length} 条 | 过滤重复 ${dupCount} 条）\n\n`;
  digest += sections;

  if (hqItems.length > 0) {
    digest += '\n\n⭐ 总部关注重点：\n';
    digest += hqItems.map(e => `• ${e.brand} ${e.category}：${e.summary}`).join('\n');
  }

  digest += `\n\n📋 完整记录：https://flashexpress-th.feishu.cn/base/${NEW_BASE_TOKEN}?table=${NEW_BASE_TABLE_ID}`;

  return digest;
}

// ─────────────────────────────────────────────
// Weekly report: summarize this week's new intel
// ─────────────────────────────────────────────

function getWeeklyReport() {
  const nowBKK = new Date(Date.now() + 7 * 60 * 60 * 1000);

  // Find Monday of this week (Bangkok time)
  const dayOfWeek = nowBKK.getDay(); // 0=Sun, 6=Sat
  const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(nowBKK);
  monday.setDate(monday.getDate() - mondayOffset);
  const mondayStr = monday.toISOString().slice(0, 10);
  const todayStr  = nowBKK.toISOString().slice(0, 10);

  // Read from Base instead of local db
  let allRecords = [];
  try {
    let offset = 0;
    while (true) {
      const out = execFileSync(LARK_CLI, [
        'base', '+record-list', '--as', 'bot',
        '--base-token', NEW_BASE_TOKEN,
        '--table-id', NEW_BASE_TABLE_ID,
        '--limit', '200', '--offset', String(offset),
      ], { encoding: 'utf8', timeout: 30000, env: CHILD_ENV });
      const resp = JSON.parse(out);
      const data = resp.data || {};
      const fields = data.fields || [];
      const rows = data.data || [];
      if (!rows.length) break;
      const fi = {};
      fields.forEach((f, i) => { fi[f] = i; });
      for (const row of rows) {
        const get = (name) => {
          const idx = fi[name];
          if (idx === undefined || idx >= row.length) return '';
          const v = row[idx];
          if (Array.isArray(v)) return v[0] ? String(v[0]) : '';
          return v ? String(v) : '';
        };
        allRecords.push({
          brand: get('品牌'), category: get('类别'), summary: get('摘要'),
          amount: get('金额'), analysis: get('AI分析'), time: get('发送时间'),
          dup: get('是否重复'), priority: get('是否重点'), module: get('模块'),
        });
      }
      if (!data.has_more) break;
      offset += rows.length;
    }
  } catch (err) {
    console.error('[market-intel] weekly report Base read error:', (err.message || '').slice(0, 100));
  }

  // Filter this week's records by 发送时间
  const weekEntries = allRecords.filter(e => {
    const dateStr = (e.time || '').slice(0, 10);
    return dateStr >= mondayStr && dateStr <= todayStr && !e.dup.includes('重复');
  });
  const dupCount = allRecords.filter(e => {
    const dateStr = (e.time || '').slice(0, 10);
    return dateStr >= mondayStr && dateStr <= todayStr && e.dup.includes('重复');
  }).length;

  if (weekEntries.length === 0) {
    return `📊 竞对市场情报周报 ${mondayStr} ~ ${todayStr}\n\n本周无新情报。`;
  }

  // Group by brand
  const byBrand = {};
  for (const e of weekEntries) {
    if (!byBrand[e.brand]) byBrand[e.brand] = [];
    byBrand[e.brand].push(e);
  }

  // Use Claude to generate structured weekly report
  const entriesJson = weekEntries.map(e => ({
    brand: e.brand, category: e.category, summary: e.summary,
    amount: e.amount || '', date: (e.time || '').slice(0, 10),
    analysis: e.analysis || '', module: e.module || '',
  }));

  const prompt = `你是Flash Home（Flash Express泰国加盟网点体系）的市场情报分析师。
根据本周（${mondayStr} ~ ${todayStr}）收集的情报，生成中文竞对周报。

要求：
1. 按品牌分组，每个品牌一个段落
2. 每个品牌：列出关键动态 + 对Flash Home的影响 + 建议行动
3. 最后给出"本周总结"：3-5个要点，突出最重要的市场变化
4. 语言简洁专业，有数据引用具体数字

情报数据：
${JSON.stringify(entriesJson, null, 0)}`;

  const reportBody = askClaude(prompt);

  // Build final report
  const totalNew = weekEntries.length;
  const hqItems  = weekEntries.filter(e => e.priority.includes('重点'));
  const brandCount = Object.keys(byBrand).length;

  let report = `📊 竞对市场情报周报\n`;
  report += `📅 ${mondayStr} ~ ${todayStr}\n`;
  report += `📈 新情报 ${totalNew} 条 | 重复过滤 ${dupCount} 条 | 涉及 ${brandCount} 个品牌\n`;

  if (hqItems.length > 0) {
    report += `\n🔥 总部重点关注 (${hqItems.length} 条)：\n`;
    report += hqItems.map(e => `  • ${e.brand} ${e.category}：${e.summary}${e.amount ? ` (${e.amount})` : ''}`).join('\n');
    report += '\n';
  }

  report += '\n' + (reportBody || '(报告生成失败)');
  report += `\n\n📋 完整数据：https://flashexpress-th.feishu.cn/base/${NEW_BASE_TOKEN}`;

  return report;
}

module.exports = { processMessage, getDailyDigest, getWeeklyReport, fillMissingBaseFields };
