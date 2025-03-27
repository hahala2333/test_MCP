import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import dotenv from "dotenv";
import { OpenAI } from "openai";
import readline from "readline/promises";
dotenv.config();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BASE_URL = process.env.BASE_URL || undefined;
const MODEL = process.env.MODEL || "Qwen/QwQ-32B";
if (!OPENAI_API_KEY) {
    throw new Error("❌ 请在 .env 文件中设置 OPENAI_API_KEY");
}
class MCPClient {
    mcp;
    openai;
    transport = null;
    tools = [];
    constructor() {
        this.mcp = new Client({ name: "mcp-client-openai", version: "1.0.0" });
        this.openai = new OpenAI({
            apiKey: OPENAI_API_KEY,
            baseURL: BASE_URL,
        });
    }
    async connectToServer(serverScriptPath) {
        const isJs = serverScriptPath.endsWith(".js");
        const isPy = serverScriptPath.endsWith(".py");
        if (!isJs && !isPy) {
            throw new Error("❌ 服务器脚本必须是 .js 或 .py 文件");
        }
        const command = isPy
            ? process.platform === "win32"
                ? "python"
                : "python3"
            : process.execPath;
        this.transport = new StdioClientTransport({
            command,
            args: [serverScriptPath],
        });
        this.mcp.connect(this.transport);
        const toolsResult = await this.mcp.listTools();
        this.tools = toolsResult.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
        }));
        console.log("✅ 已连接服务器，支持工具：", this.tools.map((t) => t.name));
    }
    async processQuery(query) {
        const messages = [
            { role: "system", content: "你是一个智能助手。" },
            { role: "user", content: query },
        ];
        const tools = this.tools.map((tool) => ({
            type: "function",
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.input_schema,
                strict: false, // Qwen 特有字段，OpenAI 可忽略
            },
        }));
        try {
            const response = await this.openai.chat.completions.create({
                model: MODEL,
                messages,
                tools,
                tool_choice: "auto",
                max_tokens: 1000,
                temperature: 0.7,
            });
            const message = response.choices[0].message;
            if (message.tool_calls?.length) {
                const toolCall = message.tool_calls[0];
                const toolName = toolCall.function.name;
                const toolArgs = JSON.parse(toolCall.function.arguments);
                console.log(`\n🔧 调用工具：${toolName}`);
                console.log(`📦 参数：${JSON.stringify(toolArgs)}`);
                const toolResult = await this.mcp.callTool({
                    name: toolName,
                    arguments: toolArgs,
                });
                const resultText = toolResult?.content?.[0]?.text ?? "[工具无结果返回]";
                // 加入对话上下文
                messages.push({
                    role: "assistant",
                    content: null,
                    tool_calls: [toolCall],
                });
                messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: resultText,
                });
                const finalResponse = await this.openai.chat.completions.create({
                    model: MODEL,
                    messages,
                    max_tokens: 1000,
                });
                return finalResponse.choices[0].message?.content || "[无返回内容]";
            }
            return message?.content || "[无返回内容]";
        }
        catch (err) {
            return `❌ OpenAI 请求出错: ${err.message}`;
        }
    }
    async chatLoop() {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        console.log("✅ MCP Client 启动完成");
        console.log("💬 输入你的问题，或输入 'quit' 退出");
        while (true) {
            const input = await rl.question("\nQuery: ");
            if (input.toLowerCase() === "quit")
                break;
            const result = await this.processQuery(input);
            console.log("\n🧠 回复：\n" + result);
        }
        rl.close();
    }
    async cleanup() {
        await this.mcp.close();
    }
}
async function main() {
    if (process.argv.length < 3) {
        console.log("用法: node build/index.js <path_to_server_script>");
        return;
    }
    const mcpClient = new MCPClient();
    try {
        await mcpClient.connectToServer(process.argv[2]);
        await mcpClient.chatLoop();
    }
    finally {
        await mcpClient.cleanup();
        process.exit(0);
    }
}
main();
