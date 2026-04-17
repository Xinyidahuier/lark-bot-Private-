'use strict';

/**
 * One-time script: re-analyze Base records marked as 待审查/low confidence.
 * Re-runs Claude extraction on raw text, upgrades classification if possible.
 *
 * Usage: node review-pending.js
 */

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const NEW_BASE_TOKEN    = 'G0s6bQp3maWmOrsEry3ckCdVnId';
const NEW_BASE_TABLE_ID = 'tbla6yLcFRaLpbhk';
const LARK_CLI          = 'lark-cli';
const CLAUDE_BIN        = 'claude';

const CHILD_ENV = { ...process.env, FORCE_COLOR: '0', ANTHROPIC_API_KEY: '' };

// Brand/category sets from market-intel.js
const BROKERS = new Set([
  'MySave','My Save','Shippop','Me 2 Plus','Me2 Plus','Me2Plus',
  'Point Express','Skybox','Postway','SuperShip','ShipHub','ShipSmile','Shipsmile',
  'DPlus','D Plus','Dplus','SmallWin','My Express','My Order','Order Plus',
  'WeFast','GoShip','Goship','BS Express','iShip','Iship','Quick Service','Yod Express',
  'Shipnity','TaibaanShip','POST SABUY (Prompt Speed)','Shipplan',
  'Order Xpress','PEX','Idrop service',
]);
const CARRIERS = new Set([
  'KEX','SPX','J&T','DHL','BEST','Best Express','Thailand Post',
  'Inter Express','Flash','Flash Home','LEX','EMS',
]);

const MODULE_SHEETS = {
  broker_channel:     '黄牛渠道及分润',
  broker_profile:     '黄牛基础信息表',
  standard_price:     '竞对标准价格',
  fruit_price:        '竞对水果件价格',
  large_parcel:       '竞对大件价格',
  vip_price:          'VIP价格调研',
  promotions:         '活动形式总结',
  dropoff_rebate:     '电商返利送货调研',
  competitor_profile: '竟对基础信息表',
  erp_research:       'ERP调研',
  raw_data:           '市场信息-AMBD 2026',
};

function classifyModule(brand, category) {
  const isBroker  = BROKERS.has(brand);
  const isCarrier = CARRIERS.has(brand);
  let moduleKey = 'raw_data';

  if (isBroker) {
    if (['价格调整','补贴返利','VIP价格'].includes(category)) moduleKey = 'broker_channel';
    else moduleKey = 'broker_profile';
  } else if (isCarrier) {
    if (category === '价格调整' || category === '燃油附加费') moduleKey = 'standard_price';
    else if (category === '水果件') moduleKey = 'fruit_price';
    else if (category === 'VIP价格') moduleKey = 'vip_price';
    else if (category === '促销活动') moduleKey = 'promotions';
    else if (category === 'Drop Off' || category === '补贴返利') moduleKey = 'dropoff_rebate';
    else if (category === '加盟政策' || category === '网点套餐') moduleKey = 'competitor_profile';
    else if (category === '系统功能') moduleKey = 'erp_research';
    else moduleKey = 'competitor_profile';
  }

  return MODULE_SHEETS[moduleKey];
}

function askClaude(prompt) {
  try {
    return execFileSync(CLAUDE_BIN, ['-p', prompt, '--allowedTools', ''], {
      encoding: 'utf8',
      timeout: 120000,
      env: CHILD_ENV,
    }).trim();
  } catch (err) {
    return (err.stdout || '').trim() || null;
  }
}

// ─────────────────────────────────────────────
// Get all Base records
// ─────────────────────────────────────────────

function getBaseRecords() {
  const records = [];
  let offset = 0;

  while (true) {
    try {
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
      const rids = data.record_id_list || [];

      if (!rows.length) break;

      const fi = {};
      fields.forEach((f, i) => { fi[f] = i; });

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const get = (name) => {
          const idx = fi[name];
          if (idx === undefined || idx >= row.length) return '';
          const v = row[idx];
          if (Array.isArray(v)) return v[0] ? String(v[0]) : '';
          return v ? String(v) : '';
        };

        records.push({
          id: rids[i],
          brand: get('品牌'),
          category: get('类别'),
          summary: get('摘要'),
          amount: get('金额'),
          rawText: get('原文'),
          analysis: get('AI分析'),
          dupMark: get('是否重复'),
          priority: get('是否重点'),
          module: get('模块'),
          confidence: get('置信度'),
          needsReview: get('待审查'),
          time: get('发送时间'),
        });
      }

      if (!data.has_more) break;
      offset += rows.length;
    } catch (err) {
      console.error('[review] base read error:', (err.message || '').slice(0, 100));
      break;
    }
  }

  return records;
}

// ─────────────────────────────────────────────
// Re-analyze a record
// ─────────────────────────────────────────────

function reAnalyze(rec) {
  const text = rec.rawText || rec.summary || '';
  if (!text || text.length < 5) return null;

  const prompt = `你是Flash Home（Flash Express泰国加盟网点体系）的市场情报分析员。
重新分析以下MKT群消息，提取竞对/黄牛动向。

背景知识：
- 竞对: KEX, SPX, J&T, DHL, BEST/Best Express, Thailand Post, Inter Express, EMS, LEX
- 黄牛平台: MySave, Shippop, ShipSmile, GoShip, ShipHub, iShip, DPlus, SuperShip, Postway, WeFast, SmallWin, Me2Plus, Point Express, Order Plus, Quick Service, BS Express, My Express, My Order
- 重点关注：价格战/补贴、加盟政策/套餐、水果件竞争、COD/Drop Off费率、VIP价格、促销活动

当前记录：
- 品牌: ${rec.brand}
- 类别: ${rec.category}
- 摘要: ${rec.summary}
- 金额: ${rec.amount || '无'}
- 原文: ${text.slice(0, 500)}

请重新分析，如果能提取出更好的信息就更新，否则保持不变。
只输出JSON：
{
  "brand": "品牌名（如无法识别写'未知品牌'）",
  "category": "类别（价格调整/VIP价格/燃油附加费/加盟政策/网点套餐/促销活动/水果件/COD政策/Drop Off/补贴返利/系统功能/竞对动向/客户投诉/待分类）",
  "summary": "一句话中文摘要，20字以内",
  "amount": "金额或比例（无则null）",
  "confidence": "high/medium/low",
  "needs_review": true或false,
  "analysis": "50字以内，从Flash Home视角分析影响",
  "improved": true或false（是否比原始分析有改进）
}`;

  const result = askClaude(prompt);
  if (!result) return null;

  try {
    const match = result.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// Update Base record
// ─────────────────────────────────────────────

function updateRecord(recordId, updates) {
  try {
    execFileSync(LARK_CLI, [
      'base', '+record-upsert',
      '--as', 'bot',
      '--base-token', NEW_BASE_TOKEN,
      '--table-id', NEW_BASE_TABLE_ID,
      '--record-id', recordId,
      '--json', JSON.stringify(updates),
    ], { encoding: 'utf8', timeout: 30000, env: CHILD_ENV });
    return true;
  } catch (err) {
    console.error(`  update error [${recordId}]:`, (err.message || '').slice(0, 80));
    return false;
  }
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

async function main() {
  console.log('=== Review Pending Records ===\n');

  // 1. Get all records
  console.log('[1/3] Reading Base records...');
  const allRecords = getBaseRecords();
  console.log(`  ${allRecords.length} total records`);

  // 2. Filter records needing review
  const pending = allRecords.filter(r =>
    r.needsReview === 'true' || r.needsReview === true ||
    r.confidence === 'low' || r.confidence === 'medium' ||
    r.brand === '未知品牌' || r.category === '待分类' ||
    r.summary === '内容待人工审查' ||
    (r.analysis || '').includes('待人工审查')
  );
  console.log(`  ${pending.length} records need review\n`);

  if (pending.length === 0) {
    console.log('No records to review. Done.');
    return;
  }

  // 3. Re-analyze each
  let improved = 0, unchanged = 0, failed = 0, updated = 0;

  console.log(`[2/3] Re-analyzing ${pending.length} records...\n`);
  for (let i = 0; i < pending.length; i++) {
    const rec = pending[i];
    console.log(`  [${i + 1}/${pending.length}] ${rec.id} | ${rec.brand} | ${rec.category} | ${rec.summary}`);

    const result = reAnalyze(rec);

    if (!result) {
      console.log(`    ✗ Analysis failed`);
      failed++;
      continue;
    }

    // Check if improved
    const brandChanged = result.brand && result.brand !== '未知品牌' && result.brand !== rec.brand;
    const catChanged = result.category && result.category !== '待分类' && result.category !== rec.category;
    const confUpgraded = result.confidence === 'high' && rec.confidence !== 'high';
    const hasImprovement = result.improved || brandChanged || catChanged || confUpgraded;

    if (!hasImprovement && result.confidence === 'low') {
      console.log(`    → No improvement (still low confidence)`);
      unchanged++;
      continue;
    }

    // Build update
    const updates = {};
    if (brandChanged) {
      updates['品牌'] = result.brand;
      console.log(`    品牌: ${rec.brand} → ${result.brand}`);
    }
    if (catChanged) {
      updates['类别'] = result.category;
      console.log(`    类别: ${rec.category} → ${result.category}`);
    }
    if (result.summary && result.summary !== '内容待人工审查' && result.summary !== rec.summary) {
      updates['摘要'] = result.summary;
      console.log(`    摘要: ${rec.summary} → ${result.summary}`);
    }
    if (result.amount && result.amount !== rec.amount) {
      updates['金额'] = result.amount;
    }
    if (result.analysis && !result.analysis.includes('待人工审查')) {
      updates['AI分析'] = result.analysis;
    }
    if (result.confidence && result.confidence !== rec.confidence) {
      updates['置信度'] = result.confidence;
    }
    if (!result.needs_review) {
      updates['待审查'] = false;
    }

    // Update module classification
    const newBrand = updates['品牌'] || rec.brand;
    const newCat = updates['类别'] || rec.category;
    const moduleTitle = classifyModule(newBrand, newCat);
    if (moduleTitle && moduleTitle !== rec.module) {
      updates['模块'] = moduleTitle;
    }

    // Update dedup mark if confidence upgraded
    if (confUpgraded && rec.dupMark && rec.dupMark.includes('新情报')) {
      // Keep as new, just update emoji if needed
    }

    if (Object.keys(updates).length === 0) {
      console.log(`    → No fields to update`);
      unchanged++;
      continue;
    }

    improved++;
    console.log(`    ✓ Updating ${Object.keys(updates).length} fields...`);

    if (updateRecord(rec.id, updates)) {
      updated++;
    }

    // Rate limit: don't hammer API
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\n=== Summary ===`);
  console.log(`Total reviewed:  ${pending.length}`);
  console.log(`Improved:        ${improved}`);
  console.log(`Updated in Base: ${updated}`);
  console.log(`Unchanged:       ${unchanged}`);
  console.log(`Failed:          ${failed}`);
  console.log(`\nDone.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
