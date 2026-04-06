'use strict';

require('dotenv').config();

const required = [
  'LARK_APP_ID',
  'LARK_APP_SECRET',
  'LARK_BOT_OPEN_ID',
];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`[config] Missing required env var: ${key}`);
    process.exit(1);
  }
}

module.exports = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  larkAppId:       process.env.LARK_APP_ID,
  larkAppSecret:   process.env.LARK_APP_SECRET,
  botOpenId:       process.env.LARK_BOT_OPEN_ID,
  myOpenId:        process.env.MY_OPEN_ID || '',

  // Claude model
  claudeModel: 'claude-opus-4-5',

  // Max conversation turns to keep per chat (older turns are pruned)
  maxTurns: 20,

  // Max agentic loop iterations per user message
  maxToolIterations: 8,

  // System prompt injected into every Claude conversation
  systemPrompt: `你是飞书群聊机器人"飞书 CLI-sansan"，由 Claude AI 驱动。

你的职责：
- 你在后台自动监听MKT市场信息收集群，自动提取竞对/黄牛情报并分析，标记新旧和总部重点
- 你会将情报写入飞书多维表格和市场信息收集表
- 如果有人问你在做什么、监听什么群，如实告知

重要规则：
- 不要读取任何文件，不要使用任何工具，不要请求任何权限
- 直接用纯文字回答，语气亲切、简洁
- 如果用户问日程/任务/文档等飞书操作，告诉他功能正在开发中，目前你是对话模式
- 用中文回复（除非用户用其他语言）

当前日期: ${new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}`,
};
