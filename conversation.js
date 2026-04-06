'use strict';

const { maxTurns } = require('./config');

// Map<chat_id, Message[]>  — Message is { role: 'user'|'assistant', content: string|array }
const histories = new Map();

function getHistory(chatId) {
  if (!histories.has(chatId)) {
    histories.set(chatId, []);
  }
  return histories.get(chatId);
}

function addUserMessage(chatId, text) {
  const hist = getHistory(chatId);
  hist.push({ role: 'user', content: text });
  prune(chatId);
}

function addAssistantMessage(chatId, content) {
  // content may be a string or an array of content blocks (tool_use)
  const hist = getHistory(chatId);
  hist.push({ role: 'assistant', content });
  prune(chatId);
}

/** Append a tool_result turn (role: user with tool_result blocks) */
function addToolResults(chatId, toolResults) {
  const hist = getHistory(chatId);
  hist.push({ role: 'user', content: toolResults });
  prune(chatId);
}

function clearHistory(chatId) {
  histories.delete(chatId);
}

/** Keep only the last maxTurns messages (a "turn" = one message) */
function prune(chatId) {
  const hist = getHistory(chatId);
  if (hist.length > maxTurns) {
    hist.splice(0, hist.length - maxTurns);
  }
}

function getMessages(chatId) {
  return [...getHistory(chatId)];
}

module.exports = { addUserMessage, addAssistantMessage, addToolResults, getMessages, clearHistory };
