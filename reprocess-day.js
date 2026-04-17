'use strict';

/**
 * Re-process all MKT group messages for a specific date.
 * Deletes existing Base records for that date, then re-runs the full pipeline.
 *
 * Usage: node reprocess-day.js 2026-04-17
 */

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const marketIntel = require('./market-intel');

const MKT_GROUP_ID      = 'oc_12fc8f4549a84a7baead445c0dc1eb05';
const NEW_BASE_TOKEN    = 'G0s6bQp3maWmOrsEry3ckCdVnId';
const NEW_BASE_TABLE_ID = 'tbla6yLcFRaLpbhk';
const LARK_CLI          = 'lark-cli';

const CHILD_ENV = { ...process.env, FORCE_COLOR: '0' };

const targetDate = process.argv[2];
if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
  console.error('Usage: node reprocess-day.js YYYY-MM-DD');
  console.error('Example: node reprocess-day.js 2026-04-17');
  process.exit(1);
}

// External user mapping
const EXTERNAL_USERS = {};
try {
  const mapPath = path.join(__dirname, 'external_user_mapping.json');
  if (fs.existsSync(mapPath)) {
    Object.assign(EXTERNAL_USERS, JSON.parse(fs.readFileSync(mapPath, 'utf8')));
  }
} catch {}

// ─────────────────────────────────────────────
// Step 1: Delete existing Base records for target date
// ─────────────────────────────────────────────

function deleteRecordsForDate(dateStr) {
  const records = [];
  let offset = 0;

  // Read all records
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
        const timeIdx = fi['发送时间'];
        let timeVal = '';
        if (timeIdx !== undefined && timeIdx < row.length) {
          const v = row[timeIdx];
          timeVal = v ? String(v) : '';
        }

        // Check if timestamp falls on target date (Bangkok time)
        // 发送时间 is stored as epoch ms
        const ts = parseInt(timeVal);
        if (ts > 0) {
          const bkk = new Date(ts + 7 * 3600 * 1000);
          const recDate = bkk.toISOString().slice(0, 10);
          if (recDate === dateStr) {
            records.push(rids[i]);
          }
        } else if (timeVal.slice(0, 10) === dateStr) {
          records.push(rids[i]);
        }
      }

      if (!data.has_more) break;
      offset += rows.length;
    } catch (err) {
      console.error('[reprocess] base read error:', (err.message || '').slice(0, 100));
      break;
    }
  }

  console.log(`  Found ${records.length} records for ${dateStr}`);

  // Delete each record
  let deleted = 0;
  for (const rid of records) {
    try {
      execFileSync(LARK_CLI, [
        'base', '+record-delete',
        '--as', 'bot',
        '--base-token', NEW_BASE_TOKEN,
        '--table-id', NEW_BASE_TABLE_ID,
        '--record-id', rid,
      ], { encoding: 'utf8', timeout: 15000, env: CHILD_ENV });
      deleted++;
    } catch (err) {
      console.error(`  delete error [${rid}]:`, (err.message || '').slice(0, 60));
    }
  }

  console.log(`  Deleted ${deleted}/${records.length} records\n`);
  return deleted;
}

// ─────────────────────────────────────────────
// Step 2: Fetch messages for target date
// ─────────────────────────────────────────────

function fetchMessages(dateStr) {
  const startISO = `${dateStr}T00:00:00.000+07:00`;
  const endISO   = `${dateStr}T23:59:59.000+07:00`;

  console.log(`  Fetching messages for ${dateStr}...`);

  try {
    const out = execFileSync(LARK_CLI, [
      'im', '+chat-messages-list', '--as', 'user',
      '--chat-id', MKT_GROUP_ID,
      '--start', startISO, '--end', endISO,
      '--page-size', '50', '--format', 'json',
    ], { encoding: 'utf8', timeout: 30000, env: CHILD_ENV });

    const resp = JSON.parse(out);
    const msgs = resp?.data?.messages || resp?.data?.items || [];

    // Filter out bot messages, sort by time
    const filtered = msgs
      .filter(m => m.sender && m.sender.sender_type !== 'bot')
      .sort((a, b) => (a.create_time || '').localeCompare(b.create_time || ''));

    console.log(`  Found ${filtered.length} user messages (${msgs.length} total)\n`);
    return filtered;
  } catch (err) {
    console.error(`  fetch error:`, (err.stderr || err.message || '').slice(0, 200));
    return [];
  }
}

// ─────────────────────────────────────────────
// Step 3: Extract text and image keys from message
// ─────────────────────────────────────────────

function extractContent(msg) {
  const contentStr = msg.body?.content || '';
  const msgType = msg.msg_type || msg.message_type || '';

  let text = '';
  try {
    const parsed = JSON.parse(contentStr);
    if (parsed.text) text = parsed.text;
    if (parsed.content && Array.isArray(parsed.content)) {
      for (const line of parsed.content) {
        if (Array.isArray(line)) {
          for (const el of line) {
            if (el.tag === 'text' && el.text) text += el.text + ' ';
            if (el.tag === 'a' && el.text) text += el.text + ' ';
          }
        }
      }
    }
    if (parsed.title) text = parsed.title + ' ' + text;
  } catch {
    text = contentStr;
  }

  // Extract image keys
  let imageKeys = (contentStr || '').match(/img_v3_\S+/g) || [];
  if (msgType === 'image' && imageKeys.length === 0) {
    const imgMatch = (contentStr || '').match(/img_\S+/g);
    if (imgMatch) imageKeys = imgMatch;
  }
  imageKeys = imageKeys.map(k => k.replace(/[\]\)"'}\s]+$/, ''));

  return { text: text.trim(), imageKeys };
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

async function main() {
  console.log(`=== Re-process MKT Messages for ${targetDate} ===\n`);

  // 1. Delete existing records
  console.log('[1/3] Deleting existing Base records...');
  deleteRecordsForDate(targetDate);

  // 2. Fetch messages
  console.log('[2/3] Fetching messages from MKT group...');
  const messages = fetchMessages(targetDate);

  if (messages.length === 0) {
    console.log('No messages found. Done.');
    return;
  }

  // 3. Process each message
  console.log(`[3/3] Processing ${messages.length} messages...\n`);

  let processed = 0, skipped = 0, errors = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const messageId = msg.message_id;
    const { text, imageKeys } = extractContent(msg);

    // Resolve sender name
    const senderId = msg.sender?.sender_id?.open_id || '';
    let senderName = EXTERNAL_USERS[senderId] || '';

    console.log(`  [${i + 1}/${messages.length}] ${messageId}`);
    console.log(`    Text: ${(text || '(无)').slice(0, 60)}`);
    console.log(`    Images: ${imageKeys.length}`);

    if (!text && imageKeys.length === 0) {
      console.log(`    → Skipped (empty)`);
      skipped++;
      continue;
    }

    try {
      const result = marketIntel.processMessage(text, messageId, 30, {
        imageKeys,
        senderId,
        senderName,
      });

      if (result.skip) {
        console.log(`    → Skipped`);
        skipped++;
      } else {
        console.log(`    → ${result.mark} [${result.intel?.brand || '?'}] ${result.intel?.summary || '?'}`);
        processed++;
      }
    } catch (err) {
      console.error(`    ✗ Error: ${(err.message || '').slice(0, 100)}`);
      errors++;
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n=== Summary ===`);
  console.log(`Total messages: ${messages.length}`);
  console.log(`Processed:      ${processed}`);
  console.log(`Skipped:        ${skipped}`);
  console.log(`Errors:         ${errors}`);
  console.log(`\nDone.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
