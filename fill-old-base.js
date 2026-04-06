'use strict';

/**
 * 独立脚本：扫描旧 Base，填写三列：AI分析、是否重复、是否重点
 * 其他字段一律不动。
 *
 * 用法:
 *   node fill-old-base.js              # 所有 AI分析 为空的记录
 *   node fill-old-base.js 2026-04-04   # 指定日期
 *   node fill-old-base.js last20       # 最后20条空记录
 *   node fill-old-base.js all          # 强制重做全部（包括已有分析的）
 */

const { execFileSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

// ── Config ──
const LARK_CLI  = process.platform === 'darwin' ? '/opt/homebrew/bin/lark-cli' : 'lark-cli';
const CLAUDE_BIN = process.platform === 'darwin'
  ? `${process.env.HOME}/.npm/_npx/becf7b9e49303068/node_modules/.bin/claude`
  : 'claude';
const CHILD_ENV = { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}`, FORCE_COLOR: '0', ANTHROPIC_API_KEY: '' };
const IMG_TEMP_DIR = path.join(__dirname, 'tmp_images');

const BASE_TOKEN = 'LMZvbR705a9P6gsndJCcoQOVnpc';
const TABLE_ID   = 'tblVMYncStg04W6z';

// Field IDs (stable across pages)
const FID = {
  主题:           'fldfIa2TNY',  // text - 原文/标题
  InformationType:'fldta9Qfmf',  // select
  CompetitorsType:'fldQitxc3o',  // select
  是否重复:       'fldgffzXGR',  // select
  Competitors:    'fldLRoOpti',  // select - 品牌
  图片:           'fld6oVUKzP',  // attachment
  发送时间:       'fldk1LcPSa',  // text/date
  是否重点:       'fld4o8Ktxs',  // select
  AI分析:         'fldbWUUPJL',  // text
};

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ── Helpers ──

function getByFieldId(row, fieldIds, fieldIdList, targetFid) {
  const idx = fieldIdList.indexOf(targetFid);
  if (idx < 0 || idx >= row.length) return null;
  return row[idx];
}

function getString(val) {
  if (val === null || val === undefined) return '';
  if (Array.isArray(val)) {
    if (val.length === 0) return '';
    const first = val[0];
    if (typeof first === 'object' && first !== null) return first.name || first.text || JSON.stringify(first);
    return String(first);
  }
  if (typeof val === 'object') return val.name || val.text || JSON.stringify(val);
  return String(val);
}

function askClaude(prompt) {
  try {
    return execFileSync(CLAUDE_BIN, ['-p', prompt, '--allowedTools', ''], {
      encoding: 'utf8', timeout: 120000, env: CHILD_ENV,
    }).trim();
  } catch (err) {
    return (err.stdout || '').trim() || null;
  }
}

// ── Load all records with field_id mapping ──

function loadAllRecords() {
  const all = [];
  let offset = 0;
  while (true) {
    let out;
    try {
      out = execFileSync(LARK_CLI, [
        'base', '+record-list', '--as', 'bot',
        '--base-token', BASE_TOKEN, '--table-id', TABLE_ID,
        '--limit', '200', '--offset', String(offset),
      ], { encoding: 'utf8', timeout: 30000, env: CHILD_ENV });
    } catch (err) {
      // Rate limit - wait and retry
      console.log('  rate limited, waiting 30s...');
      sleep(30000);
      continue;
    }
    const resp = JSON.parse(out);
    const data = resp.data || {};
    const rows = data.data || [];
    const rids = data.record_id_list || [];
    const fidList = data.field_id_list || [];
    if (!rows.length) break;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const g = (fid) => {
        const idx = fidList.indexOf(fid);
        return idx >= 0 && idx < row.length ? row[idx] : null;
      };
      all.push({
        rid:      rids[i],
        row,
        fidList,
        brand:    getString(g(FID.Competitors)),
        summary:  getString(g(FID.主题)),
        category: getString(g(FID.InformationType)),
        type:     getString(g(FID.CompetitorsType)),
        dup:      getString(g(FID.是否重复)),
        priority: getString(g(FID.是否重点)),
        analysis: getString(g(FID.AI分析)),
        time:     getString(g(FID.发送时间)),
        imgField: g(FID.图片),  // raw attachment array
      });
    }
    if (!data.has_more) break;
    offset += rows.length;
    console.log(`  loaded ${all.length} records...`);
    sleep(500); // avoid rate limit
  }
  return all;
}

// ── Image analysis ──

function downloadBaseAttachment(fileToken) {
  if (!fs.existsSync(IMG_TEMP_DIR)) fs.mkdirSync(IMG_TEMP_DIR, { recursive: true });
  const outFile = `${fileToken}.jpg`;
  const outPath = path.join(IMG_TEMP_DIR, outFile);
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 100) return outPath;
  try {
    execFileSync(LARK_CLI, [
      'drive', '+download', '--as', 'bot',
      '--file-token', fileToken,
      '--output', `./${outFile}`, '--overwrite',
    ], { encoding: 'utf8', timeout: 30000, env: CHILD_ENV, cwd: IMG_TEMP_DIR });
    return fs.existsSync(outPath) ? outPath : null;
  } catch (err) {
    console.error(`  img download err: ${(err.message || '').slice(0, 60)}`);
    return null;
  }
}

function analyzeImage(imagePath) {
  if (!imagePath || !fs.existsSync(imagePath)) return null;
  try {
    const prompt = `Read the image file at ${imagePath}. 这是泰国物流/快递行业的竞对情报图片。请提取关键信息：品牌名、价格数字、促销政策、服务内容。用中文简洁描述，100字以内。无法读取回复"无"。`;
    const result = execFileSync(CLAUDE_BIN, [
      '-p', prompt, '--output-format', 'text',
      '--allowedTools', 'Read', '--max-turns', '2',
    ], { encoding: 'utf8', timeout: 60000, env: CHILD_ENV });
    const text = (result || '').trim();
    if (!text || text === '无') return null;
    return text;
  } catch (err) {
    return null;
  }
}

function getImageContext(record) {
  const imgs = record.imgField;
  if (!imgs || !Array.isArray(imgs) || imgs.length === 0) return '';
  const analyses = [];
  for (const img of imgs) {
    const token = img && img.file_token;
    if (!token) continue;
    console.log(`  downloading image ${token.slice(0, 15)}...`);
    const imgPath = downloadBaseAttachment(token);
    if (imgPath) {
      const a = analyzeImage(imgPath);
      if (a) {
        console.log(`  image: ${a.slice(0, 50)}`);
        analyses.push(a);
      }
    }
    sleep(500);
  }
  return analyses.length > 0 ? '\n[图片内容]\n' + analyses.join('\n') : '';
}

// ── Duplicate check ──

function isDuplicate(brand, summary, allEntries) {
  if (!brand || !summary || summary.length < 5) return false;
  const prefix = summary.slice(0, 15);
  for (const e of allEntries) {
    if (e.brand === brand && e.summary && e.summary.slice(0, 15) === prefix) return true;
  }
  return false;
}

// ── Priority check ──

function isHqPriority(brand, category, summary) {
  if (/调|涨|降/.test(summary || '')) return true;
  const major = ['KEX', 'SPX', 'J&T', 'DHL', 'BEST'];
  if (major.includes(brand) && /价格|VIP|补贴|返利/.test((category || '') + (summary || ''))) return true;
  if (/加盟|网点/.test((category || '') + (summary || ''))) return true;
  return false;
}

// ── AI Analysis ──

function generateAnalysis(brand, category, fullText) {
  const prompt = `你是Flash Home（Flash Express泰国加盟网点体系）的市场情报分析员。
用50字以内中文，从Flash Home视角分析这条竞对情报的影响和建议。

品牌：${brand || '未知'}
类别：${category || '未知'}
内容：${(fullText || '').slice(0, 500)}

只输出分析文字。`;
  return askClaude(prompt);
}

// ── Update record (only 3 fields) ──

function updateRecord(recordId, dupMark, priorityMark, analysis) {
  const updates = {};
  updates[FID.是否重复] = dupMark;
  updates[FID.是否重点] = priorityMark;
  updates[FID.AI分析]  = analysis;

  try {
    execFileSync(LARK_CLI, [
      'base', '+record-upsert', '--as', 'user',
      '--base-token', BASE_TOKEN, '--table-id', TABLE_ID,
      '--record-id', recordId,
      '--json', JSON.stringify(updates),
    ], { encoding: 'utf8', timeout: 15000, env: CHILD_ENV });
    return true;
  } catch (err) {
    console.error(`  update err: ${(err.message || '').slice(0, 80)}`);
    return false;
  }
}

// ── Main ──

function main() {
  const arg = process.argv[2] || null;
  const lastN = arg && arg.startsWith('last') ? parseInt(arg.slice(4)) : null;
  const forceAll = arg === 'all';
  const filterDate = arg && !lastN && !forceAll ? arg : null;

  console.log('=== 旧 Base 三列填写工具 ===');
  console.log(`模式: ${lastN ? `最后${lastN}条` : filterDate ? `日期=${filterDate}` : forceAll ? '全部重做' : '空记录'}\n`);

  console.log('1. 加载所有记录...');
  const allRecords = loadAllRecords();
  console.log(`   共 ${allRecords.length} 条记录\n`);

  // Filter records to process
  let toProcess;
  if (forceAll) {
    toProcess = [...allRecords];
  } else {
    toProcess = allRecords.filter(r => !r.analysis || r.analysis.trim() === '' || r.analysis === '未知竞对信息');
  }

  if (filterDate) {
    toProcess = toProcess.filter(r => (r.time || '').startsWith(filterDate));
  }
  if (lastN) {
    toProcess = toProcess.slice(-lastN);
  }

  console.log(`2. 需要处理: ${toProcess.length} 条\n`);

  if (toProcess.length === 0) {
    console.log('无需处理，退出。');
    return;
  }

  // Build dedup reference: all records with actual content
  const knownEntries = allRecords
    .filter(r => r.brand && r.summary && !toProcess.includes(r))
    .map(r => ({ brand: r.brand, summary: r.summary, category: r.category }));

  console.log(`   去重参考: ${knownEntries.length} 条\n`);

  let updated = 0, errors = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const r = toProcess[i];
    console.log(`\n[${i + 1}/${toProcess.length}] ${r.brand || '?'} | ${(r.summary || '').slice(0, 40)} | ${r.time || 'no-time'}`);

    if (!r.brand && !r.summary && (!r.imgField || r.imgField.length === 0)) {
      console.log('  → skip (空记录)');
      continue;
    }

    // 1. Read images
    const imageContext = getImageContext(r);
    const fullText = ((r.summary || '') + imageContext).trim();

    if (!r.brand && !fullText) {
      console.log('  → skip (无内容)');
      continue;
    }

    // 2. Duplicate check
    let dupMark = '✅新情报';
    if (isDuplicate(r.brand, r.summary || fullText, knownEntries)) {
      dupMark = '👀重复';
    }

    // 3. Priority check
    let priorityMark = '普通';
    if (isHqPriority(r.brand, r.category, fullText)) {
      priorityMark = '🔥总部重点';
    }

    // 4. AI Analysis
    const analysis = generateAnalysis(r.brand, r.category, fullText) || '(分析失败)';

    console.log(`  → ${dupMark} | ${priorityMark} | ${analysis.slice(0, 60)}`);

    // 5. Update record
    if (updateRecord(r.rid, dupMark, priorityMark, analysis)) {
      updated++;
      knownEntries.push({ brand: r.brand, summary: r.summary || fullText, category: r.category });
    } else {
      errors++;
    }

    // Rate limit
    sleep(1000);
  }

  console.log(`\n=== 完成: ${updated} 已更新, ${errors} 错误 ===`);
}

main();
