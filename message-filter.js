'use strict';

const { botOpenId } = require('./config');

// Dedup: remember processed message IDs (in-memory, last 1000)
const seen = new Set();
const MAX_SEEN = 1000;

/**
 * Returns true if this event should be processed, false if it should be skipped.
 * Reasons to skip:
 *   1. Duplicate message_id
 *   2. Sender is the bot itself
 *   3. Group message that does NOT @mention the bot
 */
function shouldProcess(event) {
  const { message_id, sender_id, chat_type, content, message_type } = event;

  // 1. Dedup
  if (seen.has(message_id)) {
    return false;
  }
  // Trim set if too large
  if (seen.size >= MAX_SEEN) {
    const first = seen.values().next().value;
    seen.delete(first);
  }
  seen.add(message_id);

  // 2. Ignore self
  if (sender_id === botOpenId) {
    return false;
  }

  // 3. For group chats, only respond when @mentioned
  if (chat_type === 'group') {
    return isMentioned(content, message_type);
  }

  // p2p DMs: always respond
  return true;
}

/**
 * Check if the message content contains an @mention of the bot.
 * lark-cli --compact already parses content to human-readable text.
 * For text messages, @mentions are rendered as "@飞书 CLI-sansan".
 * We look specifically for the bot's name to avoid responding to @other_person.
 */
function isMentioned(content, messageType) {
  if (!content) return false;
  // Only respond when the bot itself is @mentioned
  return /@飞书[\s\u00a0]*CLI[-\s\u00a0]*sansan/i.test(content)
      || /@all\b/i.test(content);
}

/**
 * Strip the @mention prefix from a group message content so Claude only
 * sees the actual question.
 */
function stripMention(content) {
  if (!content) return '';
  // Remove leading "@SomeName " patterns
  return content.replace(/^(@\S+\s*)+/, '').trim();
}

module.exports = { shouldProcess, stripMention };
