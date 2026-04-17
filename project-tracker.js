'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

// FH Home 重点项目 Base
const PROJECT_BASE_TOKEN = 'CKbwbrFcvaJnWMssW7Acg6NPnDg';
const TASK_TABLE_ID = 'tblZoCTKMumu5pdT';
const PROJECT_TABLE_ID = 'tbleDYi4OViQPbYD';

const LARK_CLI = process.platform === 'darwin' ? '/opt/homebrew/bin/lark-cli' : 'lark-cli';

// ─────────────────────────────────────────────
// Helper: run lark-cli command
// ─────────────────────────────────────────────

function runLarkCli(args) {
  try {
    const out = execFileSync(LARK_CLI, args, {
      encoding: 'utf8',
      timeout: 30000,
      env: process.env,
    });
    return JSON.parse(out);
  } catch (err) {
    const stdout = (err.stdout || '').trim();
    if (stdout) {
      try { return JSON.parse(stdout); } catch {}
    }
    console.error('[project] lark-cli error:', err.message?.slice(0, 100));
    return { ok: false, error: err.message };
  }
}

// ─────────────────────────────────────────────
// Fetch all task records from Base
// ─────────────────────────────────────────────

function fetchAllRecords() {
  const allRecords = [];
  let offset = 0;
  let fields = null;

  while (true) {
    const resp = runLarkCli([
      'base', '+record-list',
      '--base-token', PROJECT_BASE_TOKEN,
      '--table-id', TASK_TABLE_ID,
      '--limit', '100',
      '--offset', String(offset),
    ]);

    if (!resp.ok || !resp.data || !resp.data.data) break;

    fields = fields || resp.data.fields;
    const rows = resp.data.data;
    const ids = resp.data.record_id_list || [];
    if (rows.length === 0) break;

    rows.forEach((row, i) => {
      const record = {};
      fields.forEach((f, j) => { record[f] = row[j]; });
      record._record_id = ids[i] || null;
      allRecords.push(record);
    });

    offset += rows.length;
    if (rows.length < 100) break;
  }

  return allRecords;
}

function generateDailySummary() {
  const allRecords = fetchAllRecords();

  if (allRecords.length === 0) {
    return '📋 暂无法读取项目数据';
  }

  // Categorize tasks
  const inProgress = [];
  const notStarted = [];
  const noStatus = [];
  const completed = [];

  allRecords.forEach((r) => {
    const task = r['任务'] || '(无任务名)';
    const statusArr = r['进展'];
    const status = statusArr ? (Array.isArray(statusArr) ? statusArr[0] : statusArr) : null;
    const prioArr = r['优先级'];
    const priority = prioArr ? (Array.isArray(prioArr) ? prioArr[0] : prioArr) : '';
    const deptArr = r['部门'];
    const dept = deptArr ? (Array.isArray(deptArr) ? deptArr.join('/') : deptArr) : '';
    const owner = r['负责人'] || '';
    const isDelay = r['是否延期'] || '';
    const desc = r['描述'] || '';

    const item = { task, status, priority, dept, owner, isDelay, desc };

    if (!status || status === '?') {
      noStatus.push(item);
    } else if (status === '进行中') {
      inProgress.push(item);
    } else if (status === '未开始') {
      notStarted.push(item);
    } else if (status === '已完成') {
      completed.push(item);
    }
    // '不用做' ignored
  });

  // Build summary
  const today = new Date().toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });

  let msg = `📋 FH重点项目进展 (${today})\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `总计 ${allRecords.length} 项任务 | 进行中 ${inProgress.length} | 未开始 ${notStarted.length} | 已完成 ${completed.length}\n\n`;

  // P0 tasks first
  const p0InProgress = inProgress.filter(t => t.priority === 'P0');
  if (p0InProgress.length > 0) {
    msg += `🔴 P0 进行中:\n`;
    p0InProgress.forEach(t => {
      msg += `• ${t.task}`;
      if (t.dept) msg += ` [${t.dept}]`;
      if (t.owner) msg += ` @${t.owner.split(' ')[0]}`;
      msg += '\n';
    });
    msg += '\n';
  }

  // Other in-progress
  const otherInProgress = inProgress.filter(t => t.priority !== 'P0');
  if (otherInProgress.length > 0) {
    msg += `🟡 其他进行中 (${otherInProgress.length}项):\n`;
    otherInProgress.forEach(t => {
      const prio = t.priority ? `[${t.priority}] ` : '';
      msg += `• ${prio}${t.task}`;
      if (t.dept) msg += ` [${t.dept}]`;
      msg += '\n';
    });
    msg += '\n';
  }

  // Not started
  if (notStarted.length > 0) {
    msg += `⏳ 未开始 (${notStarted.length}项):\n`;
    notStarted.forEach(t => {
      const prio = t.priority ? `[${t.priority}] ` : '';
      msg += `• ${prio}${t.task}\n`;
    });
    msg += '\n';
  }

  // No status
  if (noStatus.length > 0) {
    msg += `❓ 未填进展 (${noStatus.length}项):\n`;
    noStatus.slice(0, 10).forEach(t => {
      msg += `• ${t.task}\n`;
    });
    if (noStatus.length > 10) {
      msg += `  ...还有 ${noStatus.length - 10} 项\n`;
    }
    msg += '\n';
  }

  msg += `🔗 查看完整列表: https://flashexpress-th.feishu.cn/wiki/L2NowG4HciCsrVk5a15ckOZQn5f?table=${TASK_TABLE_ID}`;
  msg += '\n\n💡 回复我可直接更新，例如:\n"把报价申请SOP改成已完成"\n"把揽收未发出优化改成P0"';

  return msg;
}

// ─────────────────────────────────────────────
// Update task in Base
// ─────────────────────────────────────────────

function findAndUpdateTask(taskKeyword, fieldName, newValue) {
  const allData = fetchAllRecords();

  // Find matching task
  const matches = allData.filter(r => {
    const task = r['任务'] || '';
    return task.includes(taskKeyword);
  });

  if (matches.length === 0) {
    return { ok: false, message: `找不到包含"${taskKeyword}"的任务` };
  }

  if (matches.length > 1) {
    const names = matches.map(m => `• ${m['任务']}`).join('\n');
    return {
      ok: false,
      message: `找到 ${matches.length} 个匹配的任务，请说得更具体:\n${names}`,
    };
  }

  const target = matches[0];
  const recordId = target._record_id;

  if (!recordId) {
    return { ok: false, message: '找到任务但无法获取记录ID，请直接在Base里修改' };
  }

  // Map field name to actual field and value format
  let updateField = null;
  let updateValue = null;

  if (fieldName === '进展' || fieldName === '状态') {
    updateField = '进展';
    // Validate value
    const validStatus = ['进行中', '已完成', '未开始', '不用做'];
    if (!validStatus.includes(newValue)) {
      return { ok: false, message: `进展只能是: ${validStatus.join('、')}` };
    }
    updateValue = [newValue]; // select field needs array
  } else if (fieldName === '优先级') {
    updateField = '优先级';
    const validPrio = ['P0', 'P1', 'P2'];
    if (!validPrio.includes(newValue)) {
      return { ok: false, message: `优先级只能是: ${validPrio.join('、')}` };
    }
    updateValue = [newValue];
  } else if (fieldName === '描述') {
    updateField = '描述';
    updateValue = newValue;
  } else if (fieldName === '结果') {
    updateField = '结果';
    updateValue = newValue;
  } else {
    return { ok: false, message: `暂不支持修改"${fieldName}"字段` };
  }

  // Update the record
  const updateData = {};
  updateData[updateField] = updateValue;

  const result = runLarkCli([
    'base', '+record-upsert',
    '--base-token', PROJECT_BASE_TOKEN,
    '--table-id', TASK_TABLE_ID,
    '--record-id', recordId,
    '--json', JSON.stringify(updateData),
  ]);

  if (result.ok || (result.data && !result.error)) {
    return {
      ok: true,
      message: `✅ 已更新: "${target['任务']}" 的${updateField}改为"${newValue}"`,
    };
  }

  return {
    ok: false,
    message: `更新失败: ${JSON.stringify(result.error || result).slice(0, 200)}`,
  };
}

// ─────────────────────────────────────────────
// Parse user command for project updates
// ─────────────────────────────────────────────

function parseProjectCommand(text) {
  let match;

  // Pattern 1: 把<task>的<field>改成<value>
  match = text.match(/把[「「]?(.+?)[」」]?的?(进展|状态|优先级|描述|结果)(?:改成|改为|更新为|设为)\s*[「「]?(.+?)[」」]?\s*$/);
  if (match) {
    return { task: match[1].trim(), field: match[2].trim(), value: match[3].trim() };
  }

  // Pattern 2: 把<task>改成<status>
  match = text.match(/把[「「]?(.+?)[」」]?\s*(?:改成|改为|更新为|设为)\s*[「「]?(已完成|进行中|未开始|不用做|P0|P1|P2)[」」]?\s*$/);
  if (match) {
    const value = match[2].trim();
    const field = ['P0', 'P1', 'P2'].includes(value) ? '优先级' : '进展';
    return { task: match[1].trim(), field, value };
  }

  // Pattern 3: <task>已完成 / <task>完成了
  match = text.match(/[「「]?(.+?)[」」]?\s*(已完成|完成了|做完了)\s*$/);
  if (match) {
    return { task: match[1].trim(), field: '进展', value: '已完成' };
  }

  return null;
}

// Parse multi-line batch commands
// Format:
//   • task1
//   • task2
//   已完成/进行中/未开始
function parseMultiProjectCommands(text) {
  const lines = text.split(/\n/).map(l => l.replace(/^[\s•·\-\*]+/, '').trim()).filter(Boolean);
  if (lines.length < 2) return null;

  // Check if last line is a status
  const lastLine = lines[lines.length - 1];
  const statusMatch = lastLine.match(/^(已完成|进行中|未开始|不用做|P0|P1|P2)$/);
  if (!statusMatch) return null;

  const value = statusMatch[1];
  const field = ['P0', 'P1', 'P2'].includes(value) ? '优先级' : '进展';
  const tasks = lines.slice(0, -1).filter(l => l.length >= 2 && !/^(已完成|进行中|未开始|不用做|P0|P1|P2)$/.test(l));

  if (tasks.length === 0) return null;

  return tasks.map(task => ({ task, field, value }));
}

module.exports = {
  generateDailySummary,
  findAndUpdateTask,
  parseProjectCommand,
  parseMultiProjectCommands,
  PROJECT_BASE_TOKEN,
  TASK_TABLE_ID,
};
