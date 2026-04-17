'use strict';

const { execFileSync } = require('child_process');

/**
 * Execute a lark-cli command and return parsed JSON result.
 * Uses execFileSync with args array (no shell) to safely handle
 * multi-line text and special characters in arguments.
 */
function run(args, opts = {}) {
  const { asUser = false, timeoutMs = 30000, noFormat = false } = opts;
  const identity = asUser ? ['--as', 'user'] : ['--as', 'bot'];
  const fmt = noFormat ? [] : ['--format', 'json'];
  const allArgs = [...args, ...identity, ...fmt];

  try {
    const raw = execFileSync('lark-cli', allArgs, {
      timeout: timeoutMs,
      encoding: 'utf8',
      env: process.env,
    });
    try {
      return JSON.parse(raw);
    } catch {
      return { raw };
    }
  } catch (err) {
    const stderr = (err.stderr || '').toString();
    const stdout = (err.stdout || '').toString();
    // Try to parse stderr as JSON error from lark-cli
    try {
      return { error: JSON.parse(stderr), raw: stdout };
    } catch {
      return { error: stderr || err.message, raw: stdout };
    }
  }
}

// ─────────────────────────────────────────────
// High-level helpers used by tool handlers
// ─────────────────────────────────────────────

/** Send a text message to a chat (by chat_id) or user (by open_id) */
function sendMessage({ chatId, openId, text }) {
  if (chatId) {
    return run(['im', '+messages-send', '--chat-id', chatId, '--text', text], { noFormat: true });
  }
  return run(['im', '+messages-send', '--user-id', openId, '--text', text], { noFormat: true });
}

/** Send a text reply to a specific message */
function replyMessage({ messageId, text }) {
  return run(['im', '+messages-reply', '--message-id', messageId, '--text', text], { noFormat: true });
}

/** Search Feishu users by keyword */
function searchUser(keyword) {
  return run(['contact', '+search-user', '--keyword', keyword], { asUser: true });
}

/** Get calendar agenda for a date range */
function getAgenda({ startDate, endDate }) {
  const args = ['calendar', '+agenda'];
  if (startDate) args.push('--start', startDate);
  if (endDate)   args.push('--end', endDate);
  return run(args, { asUser: true });
}

/** Create a task */
function createTask({ title, dueDate, notes, assigneeOpenId }) {
  const args = ['task', '+create', '--title', title];
  if (dueDate)        args.push('--due', dueDate);
  if (notes)          args.push('--notes', notes);
  if (assigneeOpenId) args.push('--assignee', assigneeOpenId);
  return run(args, { asUser: true });
}

/** List my tasks */
function listMyTasks({ pageSize = 20 } = {}) {
  return run(['task', '+list', '--page-size', String(pageSize)], { asUser: true });
}

/** Fetch a Feishu document */
function fetchDoc(docUrl) {
  return run(['doc', '+fetch', '--url', docUrl], { asUser: true });
}

/** Search documents */
function searchDocs(keyword) {
  return run(['docs', '+search', '--query', keyword], { asUser: true });
}

/** Get recent messages from a chat */
function getChatMessages({ chatId, limit = 20 }) {
  return run(['im', 'message', 'list',
    '--params', JSON.stringify({ container_id_type: 'chat', container_id: chatId, page_size: limit }),
    '--as', 'user',
  ]);
}

module.exports = {
  run,
  sendMessage,
  replyMessage,
  searchUser,
  getAgenda,
  createTask,
  listMyTasks,
  fetchDoc,
  searchDocs,
  getChatMessages,
};
