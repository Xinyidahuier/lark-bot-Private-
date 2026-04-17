'use strict';

/**
 * One-time script: backfill images for MKT group messages since April 10, 2026.
 *
 * Steps:
 * 1. List all messages from MKT group since April 10
 * 2. For messages with images, download them (--as user)
 * 3. Find matching Base record by timestamp/brand
 * 4. Upload images to the Base record's attachment field
 *
 * Usage: node backfill-images.js
 */

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MKT_GROUP_ID      = 'oc_12fc8f4549a84a7baead445c0dc1eb05';
const NEW_BASE_TOKEN    = 'G0s6bQp3maWmOrsEry3ckCdVnId';
const NEW_BASE_TABLE_ID = 'tbla6yLcFRaLpbhk';
const IMAGE_FIELD_ID    = 'fldIAH2rzj';
const IMG_TEMP_DIR      = path.join(require('os').tmpdir(), 'mkt-imgs-backfill');
const LARK_CLI          = 'lark-cli';

const CHILD_ENV = { ...process.env, FORCE_COLOR: '0' };

if (!fs.existsSync(IMG_TEMP_DIR)) fs.mkdirSync(IMG_TEMP_DIR, { recursive: true });

// ─────────────────────────────────────────────
// Step 1: Fetch all messages since April 10
// ─────────────────────────────────────────────

function fetchMessages(startDate, endDate) {
  const allMessages = [];
  // Fetch day by day to avoid pagination issues
  const start = new Date(startDate + 'T00:00:00+07:00');
  const end   = new Date(endDate + 'T23:59:59+07:00');

  let cursor = new Date(start);
  while (cursor < end) {
    const dayEnd = new Date(cursor);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const startISO = cursor.toISOString().replace('Z', '+07:00');
    const endISO   = dayEnd.toISOString().replace('Z', '+07:00');
    const dateLabel = cursor.toISOString().slice(0, 10);

    console.log(`[backfill] fetching messages for ${dateLabel}...`);

    try {
      const out = execFileSync(LARK_CLI, [
        'im', '+chat-messages-list', '--as', 'user',
        '--chat-id', MKT_GROUP_ID,
        '--start', startISO, '--end', endISO,
        '--page-size', '50', '--format', 'json',
      ], { encoding: 'utf8', timeout: 30000, env: CHILD_ENV });

      const resp = JSON.parse(out);
      const items = resp?.data?.items || [];
      console.log(`  found ${items.length} messages`);

      for (const msg of items) {
        allMessages.push(msg);
      }
    } catch (err) {
      console.error(`  error fetching ${dateLabel}:`, (err.message || '').slice(0, 100));
    }

    cursor = dayEnd;
  }

  return allMessages;
}

// ─────────────────────────────────────────────
// Step 2: Extract image keys from message
// ─────────────────────────────────────────────

function extractImageKeys(msg) {
  const content = JSON.stringify(msg.body || msg.content || msg);
  const msgType = msg.msg_type || msg.message_type || '';

  let imageKeys = (content || '').match(/img_v3_\S+/g) || [];

  if (msgType === 'image' && imageKeys.length === 0) {
    const imgMatch = (content || '').match(/img_\S+/g);
    if (imgMatch) imageKeys = imgMatch;
  }

  // Clean trailing brackets/quotes
  return imageKeys.map(k => k.replace(/[\]\)"'}\s]+$/, ''));
}

// ─────────────────────────────────────────────
// Step 3: Download image
// ─────────────────────────────────────────────

function downloadImage(messageId, imageKey) {
  const outFile = `${imageKey.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`;
  const outPath = path.join(IMG_TEMP_DIR, outFile);

  // Skip if already downloaded
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
    return outPath;
  }

  try {
    execFileSync(LARK_CLI, [
      'im', '+messages-resources-download',
      '--as', 'user',
      '--message-id', messageId,
      '--file-key', imageKey,
      '--type', 'image',
      '--output', outFile,
    ], { encoding: 'utf8', timeout: 30000, env: CHILD_ENV, cwd: IMG_TEMP_DIR });

    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
      return outPath;
    }
    return null;
  } catch (err) {
    console.error(`  download error [${imageKey.slice(0, 30)}]:`, (err.message || '').slice(0, 80));
    return null;
  }
}

// ─────────────────────────────────────────────
// Step 4: Get all Base records
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

        // Check if record has attachment in 图片 field
        const imgIdx = fi['图片'];
        const hasImage = imgIdx !== undefined && row[imgIdx] &&
          (Array.isArray(row[imgIdx]) ? row[imgIdx].length > 0 : !!row[imgIdx]);

        records.push({
          id: rids[i],
          brand: get('品牌'),
          summary: get('摘要'),
          time: get('发送时间'),
          rawText: get('原文'),
          hasImage,
        });
      }

      if (!data.has_more) break;
      offset += rows.length;
    } catch (err) {
      console.error('[backfill] base read error:', (err.message || '').slice(0, 100));
      break;
    }
  }

  return records;
}

// ─────────────────────────────────────────────
// Step 5: Upload image to Base record
// ─────────────────────────────────────────────

function uploadToBase(recordId, imagePath) {
  const fileName = path.basename(imagePath);
  const dirName  = path.dirname(imagePath);

  try {
    execFileSync(LARK_CLI, [
      'base', '+record-upload-attachment',
      '--as', 'bot',
      '--base-token', NEW_BASE_TOKEN,
      '--table-id', NEW_BASE_TABLE_ID,
      '--record-id', recordId,
      '--field-id', IMAGE_FIELD_ID,
      '--file', `./${fileName}`,
    ], { encoding: 'utf8', timeout: 30000, env: CHILD_ENV, cwd: dirName });
    return true;
  } catch (err) {
    console.error(`  upload error [${recordId}]:`, (err.message || '').slice(0, 80));
    return false;
  }
}

// ─────────────────────────────────────────────
// Step 6: Match message to Base record
// ─────────────────────────────────────────────

function findMatchingRecord(msg, baseRecords) {
  // Try to match by raw text content
  const content = msg.body?.content || '';
  let text = '';
  try {
    const parsed = JSON.parse(content);
    text = parsed.text || '';
  } catch {
    text = content;
  }

  if (!text || text.length < 5) text = '(图片消息)';

  // Match by text prefix overlap with 原文 field
  const textPrefix = text.replace(/\s+/g, '').slice(0, 20);

  for (const rec of baseRecords) {
    const recText = (rec.rawText || '').replace(/\s+/g, '').slice(0, 20);
    if (textPrefix && recText && textPrefix === recText) {
      return rec;
    }
  }

  // Fuzzy match: first 10 chars
  const short = textPrefix.slice(0, 10);
  if (short.length >= 5) {
    for (const rec of baseRecords) {
      const recShort = (rec.rawText || '').replace(/\s+/g, '').slice(0, 10);
      if (recShort && short === recShort) {
        return rec;
      }
    }
  }

  return null;
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

async function main() {
  console.log('=== Backfill Images Since April 10 ===\n');

  // 1. Get existing Base records
  console.log('[1/4] Reading Base records...');
  const baseRecords = getBaseRecords();
  console.log(`  ${baseRecords.length} total records`);
  const withoutImages = baseRecords.filter(r => !r.hasImage);
  console.log(`  ${withoutImages.length} records without images\n`);

  // 2. Fetch messages from April 10 to today
  console.log('[2/4] Fetching messages from MKT group...');
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const messages = fetchMessages('2026-04-10', today);
  console.log(`  ${messages.length} total messages\n`);

  // 3. Filter messages with images
  const msgsWithImages = [];
  for (const msg of messages) {
    const keys = extractImageKeys(msg);
    if (keys.length > 0) {
      msgsWithImages.push({ msg, imageKeys: keys });
    }
  }
  console.log(`[3/4] Found ${msgsWithImages.length} messages with images\n`);

  // 4. Download and upload
  let downloaded = 0, uploaded = 0, matched = 0, skipped = 0;

  console.log('[4/4] Processing images...\n');
  for (const { msg, imageKeys } of msgsWithImages) {
    const messageId = msg.message_id;
    const createTime = msg.create_time || '';
    console.log(`  Message ${messageId} (${createTime}) - ${imageKeys.length} image(s)`);

    // Find matching Base record
    const record = findMatchingRecord(msg, baseRecords);

    if (!record) {
      console.log(`    ⚠ No matching Base record found, skipping`);
      skipped++;
      continue;
    }

    if (record.hasImage) {
      console.log(`    ✓ Record ${record.id} already has images, skipping`);
      skipped++;
      continue;
    }

    matched++;
    console.log(`    → Matched to record ${record.id} [${record.brand}] ${record.summary}`);

    for (const imgKey of imageKeys) {
      // Download
      const imgPath = downloadImage(messageId, imgKey);
      if (!imgPath) {
        console.log(`    ✗ Failed to download ${imgKey.slice(0, 30)}`);
        continue;
      }
      downloaded++;
      console.log(`    ↓ Downloaded: ${path.basename(imgPath)}`);

      // Upload to Base
      const ok = uploadToBase(record.id, imgPath);
      if (ok) {
        uploaded++;
        console.log(`    ↑ Uploaded to record ${record.id}`);
      }

      // Rate limit
      await new Promise(r => setTimeout(r, 500));
    }

    // Mark record as having image now
    record.hasImage = true;
  }

  console.log(`\n=== Summary ===`);
  console.log(`Messages with images: ${msgsWithImages.length}`);
  console.log(`Matched to records:   ${matched}`);
  console.log(`Skipped:              ${skipped}`);
  console.log(`Images downloaded:    ${downloaded}`);
  console.log(`Images uploaded:      ${uploaded}`);
  console.log(`\nDone.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
