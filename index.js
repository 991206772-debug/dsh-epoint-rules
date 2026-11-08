/**
 * Epoint政务BG项目规范流水线插件 (DSH 原生适配版)
 *
 * 负责注册需求分析、架构设计与 TDD 编码流水线核心工具，
 * 将 EpointRulesMCPServer 无缝桥接到 DeepSeek Harness (DSH) 原生 Cordis 工具体系中。
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const EpointRulesMCPServer = require('./core/epoint-engine.js');

export const inject = ['tools'];

export function apply(ctx, config = {}) {
  // 1. 初始化核心规则与流水线引擎
  let engine;
  try {
    engine = new EpointRulesMCPServer();
  } catch (error) {
    console.error('[dsh-epoint-rules] 核心流水线引擎初始化异常:', error);
    throw error;
  }

  // 2. 获取引擎声明的所有工具契约
  const toolDefs = engine.getToolDefinitions();

  // 3. 逐项注册为 DSH 原生 Cordis 工具
  for (const tool of toolDefs) {
    const parameters = tool.inputSchema && typeof tool.inputSchema === 'object'
      ? tool.inputSchema
      : { type: 'object', properties: {} };

    ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [
          { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }
        ]
      },
      async execute(args = {}, execContext) {
        // 项目路径自动补全兜底：如果入参未显式传 projectPath，自动使用当前 Agent 执行工作区路径
        if (typeof args === 'object' && args !== null && !args.projectPath) {
          args.projectPath = process.cwd();
        }

        try {
          const response = await engine.executeTool(tool.name, args);

          // 格式化输出：若为标准 MCP text 载荷且包含 JSON，解析为结构化对象返回给 DSH
          if (response && Array.isArray(response.content) && response.content[0] && typeof response.content[0].text === 'string') {
            const rawText = response.content[0].text;
            try {
              const parsed = JSON.parse(rawText);
              // 如果错误且包含 message，直接提供清晰反馈
              if (response.isError && parsed && parsed.message) {
                return parsed;
              }
              return parsed;
            } catch {
              return rawText;
            }
          }
          return response;
        } catch (err) {
          console.error(`[dsh-epoint-rules] 工具 ${tool.name} 执行失败:`, err);
          return {
            ok: false,
            status: 'error',
            message: `工具执行异常: ${err && err.message ? err.message : String(err)}`
          };
        }
      }
    });
  }

  console.log(`[dsh-epoint-rules] 成功注册 ${toolDefs.length} 个政务BG原生流水线工具。`);
}
