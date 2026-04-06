'use strict';

const lark = require('./lark-executor');

// ─────────────────────────────────────────────────────────────────
// Tool schema definitions (passed to Claude API)
// ─────────────────────────────────────────────────────────────────

const toolDefinitions = [
  {
    name: 'query_calendar_agenda',
    description: '查看飞书日历议程。可以查看今天、明天或某段时间的日程安排。',
    input_schema: {
      type: 'object',
      properties: {
        start_date: {
          type: 'string',
          description: '开始日期，格式 YYYY-MM-DD，默认今天',
        },
        end_date: {
          type: 'string',
          description: '结束日期，格式 YYYY-MM-DD，默认与开始日期相同',
        },
      },
    },
  },
  {
    name: 'search_user',
    description: '在飞书通讯录中搜索用户，根据姓名或关键词查找，返回用户的 open_id、姓名、部门等信息。',
    input_schema: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: '搜索关键词，例如用户姓名或英文名',
        },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'send_message',
    description: '通过飞书发送文本消息给某个用户（私信）或群组。',
    input_schema: {
      type: 'object',
      properties: {
        chat_id: {
          type: 'string',
          description: '群组 ID（oc_xxx），与 open_id 二选一',
        },
        open_id: {
          type: 'string',
          description: '用户 open_id（ou_xxx），私信时使用',
        },
        text: {
          type: 'string',
          description: '消息正文',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'create_task',
    description: '在飞书任务中创建一个新待办事项。',
    input_schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: '任务标题',
        },
        due_date: {
          type: 'string',
          description: '截止日期，格式 YYYY-MM-DD',
        },
        notes: {
          type: 'string',
          description: '任务备注或描述',
        },
        assignee_open_id: {
          type: 'string',
          description: '指派给某人的 open_id',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_my_tasks',
    description: '列出我的飞书待办任务（未完成）。',
    input_schema: {
      type: 'object',
      properties: {
        page_size: {
          type: 'number',
          description: '返回数量，默认 20',
        },
      },
    },
  },
  {
    name: 'fetch_document',
    description: '获取飞书文档的内容，需要提供文档链接。',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '飞书文档 URL',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'search_documents',
    description: '在飞书中搜索文档，根据关键词找到相关文档。',
    input_schema: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: '搜索关键词',
        },
      },
      required: ['keyword'],
    },
  },
];

// ─────────────────────────────────────────────────────────────────
// Tool execution handlers
// ─────────────────────────────────────────────────────────────────

async function executeTool(toolName, toolInput, context) {
  console.log(`[tool] ${toolName}`, JSON.stringify(toolInput));

  switch (toolName) {
    case 'query_calendar_agenda': {
      const today = new Date().toISOString().slice(0, 10);
      const result = lark.getAgenda({
        startDate: toolInput.start_date || today,
        endDate:   toolInput.end_date   || toolInput.start_date || today,
      });
      return formatResult(result);
    }

    case 'search_user': {
      const result = lark.searchUser(toolInput.keyword);
      return formatResult(result);
    }

    case 'send_message': {
      const result = lark.sendMessage({
        chatId: toolInput.chat_id,
        openId: toolInput.open_id,
        text:   toolInput.text,
      });
      return formatResult(result);
    }

    case 'create_task': {
      const result = lark.createTask({
        title:           toolInput.title,
        dueDate:         toolInput.due_date,
        notes:           toolInput.notes,
        assigneeOpenId:  toolInput.assignee_open_id,
      });
      return formatResult(result);
    }

    case 'list_my_tasks': {
      const result = lark.listMyTasks({ pageSize: toolInput.page_size });
      return formatResult(result);
    }

    case 'fetch_document': {
      const result = lark.fetchDoc(toolInput.url);
      return formatResult(result);
    }

    case 'search_documents': {
      const result = lark.searchDocs(toolInput.keyword);
      return formatResult(result);
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}

function formatResult(result) {
  if (result && result.error) {
    return `Error: ${result.error}`;
  }
  return JSON.stringify(result, null, 2);
}

module.exports = { toolDefinitions, executeTool };
