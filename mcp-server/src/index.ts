import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { spawnSync } from "node:child_process";
import * as net from "node:net";
import * as readline from "node:readline";
import { z } from "zod";

type HerdMode = "root" | "worker";
type HerdEnv = Partial<Record<"HERD_AGENT_ID" | "HERD_AGENT_ROLE" | "HERD_MCP_MODE", string | undefined>>;

function normalizeHerdMode(value: string | undefined): HerdMode | null {
  if (value === "root" || value === "worker") {
    return value;
  }
  return null;
}

export function resolveAgentRole(env: HerdEnv): HerdMode {
  const explicitRole = normalizeHerdMode(env.HERD_AGENT_ROLE);
  if (explicitRole) {
    return explicitRole;
  }
  if ((env.HERD_AGENT_ID || "").startsWith("root:")) {
    return "root";
  }
  return normalizeHerdMode(env.HERD_MCP_MODE) || "worker";
}

export function resolveMcpMode(env: HerdEnv): HerdMode {
  const resolvedRole = resolveAgentRole(env);
  if (resolvedRole === "root") {
    return "root";
  }
  return normalizeHerdMode(env.HERD_MCP_MODE) || resolvedRole;
}

const HERD_AGENT_ID = process.env.HERD_AGENT_ID || "";
const HERD_TILE_ID = process.env.HERD_TILE_ID || "";
const HERD_SESSION_ID = process.env.HERD_SESSION_ID || "";
const HERD_AGENT_ROLE = resolveAgentRole(process.env);
const HERD_MCP_MODE = resolveMcpMode(process.env);
const IS_ROOT_MODE = HERD_MCP_MODE === "root";

const MESSAGE_TOOLS = {
  direct: "message_direct",
  public: "message_public",
  channel: "message_channel",
  network: "message_network",
  root: "message_root",
} as const;

const SHARED_TOOLS = {
  selfDisplayDraw: "self_display_draw",
  selfLedControl: "self_led_control",
  selfDisplayStatus: "self_display_status",
  selfInfo: "self_info",
  networkList: "network_list",
  networkGet: "network_get",
  networkCall: "network_call",
} as const;

const ROOT_TOOLS = {
  tileCreate: "tile_create",
  tileDestroy: "tile_destroy",
  tileList: "tile_list",
  tileRename: "tile_rename",
  tileCall: "tile_call",
  shellInputSend: "shell_input_send",
  shellExec: "shell_exec",
  shellOutputRead: "shell_output_read",
  shellRoleSet: "shell_role_set",
  browserNavigate: "browser_navigate",
  browserLoad: "browser_load",
  browserDrive: "browser_drive",
  messageChannelList: "message_channel_list",
  messageChannelSubscribe: "message_channel_subscribe",
  messageChannelUnsubscribe: "message_channel_unsubscribe",
  tileGet: "tile_get",
  tileMove: "tile_move",
  tileResize: "tile_resize",
  tileArrangeElk: "tile_arrange_elk",
  networkConnect: "network_connect",
  networkDisconnect: "network_disconnect",
  workStageStart: "work_stage_start",
  workStageComplete: "work_stage_complete",
  workReviewApprove: "work_review_approve",
  workReviewImprove: "work_review_improve",
} as const;

export const MESSAGE_TOOL_NAMES = Object.freeze([...Object.values(MESSAGE_TOOLS)]);
export const SHARED_TOOL_NAMES = Object.freeze([...Object.values(SHARED_TOOLS)]);
export const WORKER_TOOL_NAMES = Object.freeze([...MESSAGE_TOOL_NAMES, ...SHARED_TOOL_NAMES]);
export const ROOT_ONLY_TOOL_NAMES = Object.freeze([...Object.values(ROOT_TOOLS)]);
export const ROOT_TOOL_NAMES = Object.freeze([...WORKER_TOOL_NAMES, ...ROOT_ONLY_TOOL_NAMES]);

type SocketResponse = { ok: boolean; data?: unknown; error?: string };
type HerdToolSchema = Record<string, z.ZodTypeAny>;
const TILE_TYPE_SCHEMA = z.enum(["shell", "agent", "browser", "work"]).optional();
type BrowserImageScreenshotPayload = {
  mimeType: string;
  dataBase64: string;
};
type BrowserTextScreenshotPayload = {
  format: "braille" | "ascii" | "ansi" | "text";
  text: string;
  columns: number;
  rows: number;
};
type AgentStreamEnvelope = {
  type: "event";
  event: {
    kind: "direct" | "public" | "channel" | "network" | "root" | "system" | "ping";
    from_agent_id?: string | null;
    from_display_name: string;
    to_agent_id?: string | null;
    to_display_name?: string | null;
    message: string;
    channels?: string[];
    mentions?: string[];
    replay?: boolean;
    ping_id?: string | null;
    timestamp_ms: number;
  };
};

function resolveSessionId() {
  if (HERD_SESSION_ID) {
    return HERD_SESSION_ID;
  }
  const result = spawnSync("tmux", ["display-message", "-p", "#{session_id}"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return "";
  }
  return result.stdout.trim();
}

function resolveSocketPath() {
  if (process.env.HERD_SOCK) {
    return process.env.HERD_SOCK;
  }
  const sessionId = resolveSessionId();
  if (!sessionId) {
    return "/tmp/herd.sock";
  }
  const result = spawnSync("tmux", ["show-environment", "-t", sessionId, "HERD_SOCK"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return "/tmp/herd.sock";
  }
  const line = result.stdout.trim();
  if (!line.startsWith("HERD_SOCK=")) {
    return "/tmp/herd.sock";
  }
  return line.slice("HERD_SOCK=".length) || "/tmp/herd.sock";
}

const SOCKET_PATH = resolveSocketPath();
const INITIAL_PARENT_PID = process.ppid;
let exitWatchInstalled = false;
let exitingForParentLoss = false;
const LED_COMMAND_SCHEMA = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("on"),
    led: z.number().int().min(1).max(8),
    color: z.string(),
  }),
  z.object({
    op: z.literal("off"),
    led: z.number().int().min(1).max(8),
  }),
  z.object({
    op: z.literal("sleep"),
    ms: z.number().int().positive(),
  }),
]);
const LED_PATTERN_ARGS_SCHEMA = z.object({
  primary_color: z.string().optional(),
  secondary_color: z.string().optional(),
  delay_ms: z.number().int().positive().optional(),
}).optional();

function exitWhenParentDisappears(reason: string) {
  if (exitingForParentLoss) {
    return;
  }
  exitingForParentLoss = true;
  console.error(`Herd MCP server exiting: ${reason}`);
  process.exit(0);
}

function installParentExitWatch() {
  if (exitWatchInstalled) {
    return;
  }
  exitWatchInstalled = true;

  process.stdin.on("end", () => exitWhenParentDisappears("stdin ended"));
  process.stdin.on("close", () => exitWhenParentDisappears("stdin closed"));

  const interval = setInterval(() => {
    if (process.ppid !== INITIAL_PARENT_PID) {
      exitWhenParentDisappears(`parent pid changed from ${INITIAL_PARENT_PID} to ${process.ppid}`);
    }
  }, 1000);
  interval.unref();
}

async function sendCommand(command: Record<string, unknown>): Promise<SocketResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH);
    const rl = readline.createInterface({ input: socket });
    let responded = false;
    const payload = { channel: "mcp", ...command };

    socket.on("connect", () => {
      socket.write(JSON.stringify(payload) + "\n");
    });

    rl.on("line", (line) => {
      if (responded) return;
      responded = true;
      rl.close();
      socket.destroy();
      try {
        resolve(JSON.parse(line) as SocketResponse);
      } catch {
        reject(new Error("Invalid JSON response from Herd"));
      }
    });

    socket.on("error", (err) => {
      if (responded) return;
      responded = true;
      reject(new Error(`Cannot connect to Herd at ${SOCKET_PATH}: ${err.message}`));
    });

    setTimeout(() => {
      if (responded) return;
      responded = true;
      rl.close();
      socket.destroy();
      reject(new Error("Timeout connecting to Herd"));
    }, 5000);
  });
}

function jsonText(value: unknown) {
  return value === undefined ? "{}" : JSON.stringify(value, null, 2);
}

function isBrowserImageScreenshotPayload(value: unknown): value is BrowserImageScreenshotPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const payload = value as Partial<BrowserImageScreenshotPayload>;
  return typeof payload.mimeType === "string" && typeof payload.dataBase64 === "string";
}

function isBrowserTextScreenshotPayload(value: unknown): value is BrowserTextScreenshotPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const payload = value as Partial<BrowserTextScreenshotPayload>;
  return (
    (payload.format === "braille"
      || payload.format === "ascii"
      || payload.format === "ansi"
      || payload.format === "text") &&
    typeof payload.text === "string" &&
    typeof payload.columns === "number" &&
    typeof payload.rows === "number"
  );
}

function screenshotPayloadResult(payload: unknown, invalidMessage: string): CallToolResult {
  if (isBrowserImageScreenshotPayload(payload)) {
    return {
      content: [{ type: "image", data: payload.dataBase64, mimeType: payload.mimeType }],
    };
  }
  if (isBrowserTextScreenshotPayload(payload)) {
    return {
      content: [{ type: "text", text: payload.text }],
    };
  }
  return errorResult(invalidMessage);
}

function nestedScreenshotPayload(
  action: string,
  args: Record<string, unknown> | undefined,
  data: unknown,
): unknown | null {
  const isExtensionScreenshot = action === "extension_call" && typeof args?.method === "string" && args.method === "screenshot";
  const isDriveScreenshot = action === "drive" && typeof args?.action === "string" && args.action === "screenshot";
  if (!isExtensionScreenshot && !isDriveScreenshot) {
    return null;
  }
  if (!data || typeof data !== "object") {
    return undefined;
  }
  return (data as { result?: unknown }).result;
}

export function unwrapNestedScreenshotResult(
  action: string,
  args: Record<string, unknown> | undefined,
  data: unknown,
  invalidMessage: string,
): CallToolResult | null {
  const payload = nestedScreenshotPayload(action, args, data);
  if (payload === null) {
    return null;
  }
  return screenshotPayloadResult(payload, invalidMessage);
}

async function sendToolCommand(
  toolName: string,
  toolArgs: Record<string, unknown>,
  command: Record<string, unknown>,
) {
  void toolName;
  void toolArgs;
  return sendCommand(command);
}

function errorResult(msg: string) {
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

function safeMetaValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return value.join(",");
  return String(value);
}

function buildChannelMeta(event: AgentStreamEnvelope["event"]) {
  const entries = {
    kind: event.kind,
    from_agent_id: event.from_agent_id,
    from_display_name: event.from_display_name,
    to_agent_id: event.to_agent_id,
    to_display_name: event.to_display_name,
    channels: event.channels?.join(","),
    mentions: event.mentions?.join(","),
    replay: event.replay ? "true" : "false",
    timestamp_ms: String(event.timestamp_ms),
  };
  return Object.fromEntries(
    Object.entries(entries)
      .map(([key, value]) => [key, safeMetaValue(value)])
      .filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

async function pushChannelEvent(server: McpServer, event: AgentStreamEnvelope["event"]) {
  if (event.kind === "ping") {
    await sendCommand({
      command: "agent_ping_ack",
      agent_id: HERD_AGENT_ID,
    }).catch((error) => {
      console.error("Failed to ack Herd ping:", error);
    });
    return;
  }

  await server.server.notification({
    method: "notifications/claude/channel",
    params: {
      content: event.message,
      meta: buildChannelMeta(event),
    },
  });
}

function subscribeAgentEvents(server: McpServer, agentId: string) {
  const socket = net.createConnection(SOCKET_PATH);
  const rl = readline.createInterface({ input: socket });
  let initialized = false;

  socket.on("connect", () => {
    socket.write(JSON.stringify({ command: "agent_events_subscribe", agent_id: agentId }) + "\n");
  });

  socket.on("error", (error) => {
    console.error("Herd event subscription error:", error.message);
  });

  rl.on("line", async (line) => {
    if (!initialized) {
      initialized = true;
      try {
        const response = JSON.parse(line) as SocketResponse;
        if (!response.ok) {
          console.error("Herd event subscription failed:", response.error);
          socket.destroy();
        }
      } catch (error) {
        console.error("Invalid Herd subscription response:", error);
        socket.destroy();
      }
      return;
    }

    try {
      const envelope = JSON.parse(line) as AgentStreamEnvelope;
      if (envelope.type !== "event") return;
      await pushChannelEvent(server, envelope.event);
    } catch (error) {
      console.error("Failed to process Herd agent event:", error);
    }
  });

  return () => {
    rl.close();
    socket.destroy();
  };
}

const server = new McpServer(
  {
    name: "herd",
    version: "0.1.0",
  },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
      },
    },
    instructions:
      (IS_ROOT_MODE
        ? 'Messages arrive as <channel source="herd" kind="..."> with metadata including from_agent_id, from_display_name, to_agent_id, to_display_name, channels, mentions, replay, and timestamp_ms. kind="direct" is private coordination. kind="public" is session-wide chatter. kind="channel" is subscription-gated channel chatter. kind="network" is local network coordination. kind="root" is traffic for the session root agent. kind="system" is Herd lifecycle information. Treat replay="true" as historical context rather than a fresh request, and treat replay="false" as live traffic. If you want Herd or other agents to see your reply, respond through the Herd messaging tools such as message_direct, message_public, message_channel, message_network, or message_root. Plain assistant text in the local session does not publish a reply back onto the Herd channels. Use self_info to inspect your own tile, self_display_draw for the drawer, self_led_control for the chrome LED strip, and self_display_status for the chrome status line. Use the LED strip and status line for concise user-visible status updates, and reserve self_display_draw for richer frame output. For local tool interaction, inspect local tiles with network_list or network_get, use network_call or tile_call with the tile-specific message names exposed in responds_to, and inspect message_api on the returned tile payload for the required args and browser drive subcommands. Root may also use browser_drive for click, select, type, dom_query, eval, or screenshot on browser tiles in the current session.'
        : 'Messages arrive as <channel source="herd" kind="..."> with metadata including from_agent_id, from_display_name, to_agent_id, to_display_name, channels, mentions, replay, and timestamp_ms. kind="direct" is private coordination. kind="public" is session-wide chatter. kind="channel" is subscription-gated channel chatter. kind="network" is local network coordination. kind="root" is traffic for the session root agent. kind="system" is Herd lifecycle information. Treat replay="true" as historical context rather than a fresh request, and treat replay="false" as live traffic. If you want Herd or other agents to see your reply, respond through the Herd messaging tools such as message_direct, message_public, message_channel, message_network, or message_root. Plain assistant text in the local session does not publish a reply back onto the Herd channels. Use self_info to inspect your own tile, self_display_draw for the drawer, self_led_control for the chrome LED strip, and self_display_status for the chrome status line. Use the LED strip and status line for concise user-visible status updates, and reserve self_display_draw for richer frame output. For local tool interaction, inspect your connected component with network_list or network_get, use network_call with the tile-specific message names exposed in responds_to for local-network tiles, and inspect message_api on the returned tile payload for the required args and browser drive subcommands.'),
  },
);

function senderContext() {
  return {
    sender_agent_id: HERD_AGENT_ID || undefined,
    sender_tile_id: HERD_TILE_ID || undefined,
  };
}

function registerTool(
  name: string,
  description: string,
  schema: HerdToolSchema,
  handler: (args: any) => Promise<CallToolResult>,
) {
  server.tool(name, description, schema, handler);
}

function registerMessageTools() {
  registerTool(
    MESSAGE_TOOLS.direct,
    "Send a direct message to another agent in the current session.",
    {
      to_agent_id: z.string(),
      message: z.string(),
    },
    async ({ to_agent_id, message }) => {
      try {
        const resp = await sendToolCommand(
          MESSAGE_TOOLS.direct,
          { to_agent_id, message },
          {
            command: "message_direct",
            to_agent_id,
            message,
            ...senderContext(),
          },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        return { content: [{ type: "text", text: "Direct message sent" }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(
    MESSAGE_TOOLS.public,
    "Send a public message to the current session chatter stream.",
    {
      message: z.string(),
      mentions: z.array(z.string()).optional(),
    },
    async ({ message, mentions }) => {
      try {
        const resp = await sendToolCommand(
          MESSAGE_TOOLS.public,
          { message, mentions: mentions ?? [] },
          {
            command: "message_public",
            message,
            mentions: mentions ?? [],
            ...senderContext(),
          },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        return { content: [{ type: "text", text: "Public message sent" }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(
    MESSAGE_TOOLS.channel,
    "Send a message to a subscribed channel in the current session.",
    {
      channel_name: z.string(),
      message: z.string(),
      mentions: z.array(z.string()).optional(),
    },
    async ({ channel_name, message, mentions }) => {
      try {
        const resp = await sendToolCommand(
          MESSAGE_TOOLS.channel,
          { channel_name, message, mentions: mentions ?? [] },
          {
            command: "message_channel",
            channel_name,
            message,
            mentions: mentions ?? [],
            ...senderContext(),
          },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        return { content: [{ type: "text", text: "Channel message sent" }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(
    MESSAGE_TOOLS.network,
    "Send a message to all other agents on the sender's local network.",
    {
      message: z.string(),
    },
    async ({ message }) => {
      try {
        const resp = await sendToolCommand(
          MESSAGE_TOOLS.network,
          { message },
          {
            command: "message_network",
            message,
            ...senderContext(),
          },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        return { content: [{ type: "text", text: "Network message sent" }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(
    MESSAGE_TOOLS.root,
    "Send a message to the current session root agent.",
    {
      message: z.string(),
    },
    async ({ message }) => {
      try {
        const resp = await sendToolCommand(
          MESSAGE_TOOLS.root,
          { message },
          {
            command: "message_root",
            message,
            ...senderContext(),
          },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        return { content: [{ type: "text", text: "Root message sent" }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

}

function registerSharedTools() {
  registerTool(
    SHARED_TOOLS.selfDisplayDraw,
    "Draw a full ANSI frame into your own Herd display drawer. This only updates the calling agent's tile and requires explicit frame dimensions on every call.",
    {
      text: z.string(),
      columns: z.number().int().positive(),
      rows: z.number().int().positive(),
    },
    async ({ text, columns, rows }) => {
      try {
        const resp = await sendToolCommand(
          SHARED_TOOLS.selfDisplayDraw,
          { text, columns, rows },
          {
            command: "self_display_draw",
            text,
            columns,
            rows,
            ...senderContext(),
          },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        return { content: [{ type: "text", text: "Display frame updated" }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(
    SHARED_TOOLS.selfLedControl,
    "Control your own tile's 8-LED chrome strip for user-visible status signals with a looping command sequence or a named pattern.",
    {
      commands: z.array(LED_COMMAND_SCHEMA).optional(),
      pattern_name: z.string().optional(),
      pattern_args: LED_PATTERN_ARGS_SCHEMA,
    },
    async ({ commands, pattern_name, pattern_args }) => {
      if ((commands ? 1 : 0) + (pattern_name ? 1 : 0) !== 1) {
        return errorResult("Provide exactly one of commands or pattern_name");
      }
      try {
        const resp = await sendToolCommand(
          SHARED_TOOLS.selfLedControl,
          {
            ...(commands ? { commands } : {}),
            ...(pattern_name ? { pattern_name } : {}),
            ...(pattern_args ? { pattern_args } : {}),
          },
          {
            command: "self_led_control",
            commands,
            pattern_name,
            pattern_args,
            ...senderContext(),
          },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        return { content: [{ type: "text", text: "LED strip updated" }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(
    SHARED_TOOLS.selfDisplayStatus,
    "Update your own tile's single-line ANSI status strip for concise user-visible progress. Long text scrolls automatically in the tile chrome.",
    {
      text: z.string(),
    },
    async ({ text }) => {
      try {
        const resp = await sendToolCommand(
          SHARED_TOOLS.selfDisplayStatus,
          { text },
          {
            command: "self_display_status",
            text,
            ...senderContext(),
          },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        return { content: [{ type: "text", text: "Status strip updated" }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(
    SHARED_TOOLS.selfInfo,
    "Return the calling tile's own tile payload using its native get path.",
    {},
    async () => {
      try {
        const resp = await sendToolCommand(
          SHARED_TOOLS.selfInfo,
          {},
          {
            command: "self_info",
            ...senderContext(),
          },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        return { content: [{ type: "text", text: jsonText(resp.data) }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(
    SHARED_TOOLS.networkList,
    "List tiles on the sender's current session network component.",
    { tile_type: TILE_TYPE_SCHEMA },
    async ({ tile_type }) => {
      try {
        const resp = await sendToolCommand(
          SHARED_TOOLS.networkList,
          tile_type ? { tile_type } : {},
          {
            command: "network_list",
            tile_type,
            ...senderContext(),
          },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        return { content: [{ type: "text", text: jsonText(resp.data) }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(
    SHARED_TOOLS.networkGet,
    "Get one tile from the sender's current session network component, including its responds_to list and structured message_api metadata.",
    {
      tile_id: z.string(),
    },
    async ({ tile_id }) => {
      try {
        const resp = await sendToolCommand(
          SHARED_TOOLS.networkGet,
          { tile_id },
          {
            command: "network_get",
            tile_id,
            ...senderContext(),
          },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        return { content: [{ type: "text", text: jsonText(resp.data) }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(
    SHARED_TOOLS.networkCall,
    "Call a tile message on a tile in the sender's current session network component. Use network_list or network_get first, pass one of the tile-specific message names exposed in responds_to, and inspect message_api for required args or browser drive subcommands.",
    {
      tile_id: z.string(),
      action: z.string(),
      args: z.record(z.unknown()).optional(),
    },
    async ({ tile_id, action, args }) => {
      try {
        const resp = await sendToolCommand(
          SHARED_TOOLS.networkCall,
          { tile_id, action, args: args ?? {} },
          {
            command: "network_call",
            tile_id,
            action,
            args: args ?? {},
            ...senderContext(),
          },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        const screenshotResult = unwrapNestedScreenshotResult(
          action,
          args ?? {},
          resp.data,
          "network_call screenshot returned an invalid screenshot payload",
        );
        if (screenshotResult) {
          return screenshotResult;
        }
        return { content: [{ type: "text", text: jsonText(resp.data) }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

}

function registerRootTools() {
  registerTool(
    ROOT_TOOLS.browserDrive,
    "Drive a browser tile in the current session. Supported actions: click, select, type, dom_query, eval, screenshot. `screenshot` accepts `{ format: \"image\" | \"braille\" | \"ascii\" | \"ansi\" | \"text\", columns?: number }`.",
    {
      tile_id: z.string(),
      action: z.enum(["click", "select", "type", "dom_query", "eval", "screenshot"]),
      args: z.record(z.unknown()).optional(),
    },
    async ({ tile_id, action, args }) => {
      try {
        const resp = await sendToolCommand(
          ROOT_TOOLS.browserDrive,
          { tile_id, action, args: args ?? {} },
          {
            command: "browser_drive",
            tile_id,
            action,
            args: args ?? {},
            ...senderContext(),
          },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        if (action === "screenshot") {
          return screenshotPayloadResult(resp.data, "browser_drive screenshot returned an invalid screenshot payload");
        }
        return { content: [{ type: "text", text: jsonText(resp.data) }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(
    ROOT_TOOLS.tileCall,
    "Call a tile message on any tile in the current session. Pass one of the tile-specific message names exposed in responds_to and inspect message_api for required args or browser drive subcommands.",
    {
      tile_id: z.string(),
      action: z.string(),
      args: z.record(z.unknown()).optional(),
    },
    async ({ tile_id, action, args }) => {
      try {
        const resp = await sendToolCommand(
          ROOT_TOOLS.tileCall,
          { tile_id, action, args: args ?? {} },
          {
            command: "tile_call",
            tile_id,
            action,
            args: args ?? {},
            ...senderContext(),
          },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        const screenshotResult = unwrapNestedScreenshotResult(
          action,
          args ?? {},
          resp.data,
          "tile_call screenshot returned an invalid screenshot payload",
        );
        if (screenshotResult) {
          return screenshotResult;
        }
        return { content: [{ type: "text", text: jsonText(resp.data) }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(
    ROOT_TOOLS.tileCreate,
    "Create a new tile on the Herd canvas in the current session.",
    {
      tile_type: z.enum(["shell", "agent", "browser", "work"]),
      title: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      parent_session_id: z.string().optional(),
      parent_tile_id: z.string().optional(),
      browser_incognito: z.boolean().optional(),
    },
    async (params) => {
      if (params.tile_type === "work" && !params.title?.trim()) {
        return errorResult("tile_create for work requires title");
      }
      const parentSessionId = params.parent_session_id ?? (HERD_SESSION_ID || undefined);
      const parentTileId = params.parent_tile_id ?? (HERD_TILE_ID || undefined);
      try {
        const resp = await sendToolCommand(
          ROOT_TOOLS.tileCreate,
          params,
          {
            command: "tile_create",
            tile_type: params.tile_type,
            title: params.title,
            x: params.x,
            y: params.y,
            width: params.width,
            height: params.height,
            parent_session_id: parentSessionId,
            parent_tile_id: parentTileId,
            browser_incognito: params.browser_incognito,
            ...senderContext(),
          },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        return { content: [{ type: "text", text: jsonText(resp.data) }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(
    ROOT_TOOLS.tileDestroy,
    "Destroy a tile in the current session by tile id.",
    { tile_id: z.string() },
    async ({ tile_id }) => {
      try {
        const resp = await sendToolCommand(
          ROOT_TOOLS.tileDestroy,
          { tile_id },
          { command: "tile_destroy", tile_id, ...senderContext() },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        return { content: [{ type: "text", text: "Tile destroyed" }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(
    ROOT_TOOLS.shellInputSend,
    "Send text input to a shell.",
    { tile_id: z.string(), input: z.string() },
    async ({ tile_id, input }) => {
      try {
        const resp = await sendToolCommand(
          ROOT_TOOLS.shellInputSend,
          { tile_id, input },
          { command: "shell_input_send", tile_id, input, ...senderContext() },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        return { content: [{ type: "text", text: "Input sent" }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(
    ROOT_TOOLS.shellExec,
    "Execute a shell command in an existing Herd shell without replacing the pane process.",
    { tile_id: z.string(), command: z.string() },
    async ({ tile_id, command }) => {
      try {
        const resp = await sendToolCommand(
          ROOT_TOOLS.shellExec,
          { tile_id, command },
          {
            command: "shell_exec",
            tile_id,
            shell_command: command,
            ...senderContext(),
          },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        return { content: [{ type: "text", text: jsonText(resp.data) }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(
    ROOT_TOOLS.shellOutputRead,
    "Read recent terminal output from a shell.",
    { tile_id: z.string() },
    async ({ tile_id }) => {
      try {
        const resp = await sendToolCommand(
          ROOT_TOOLS.shellOutputRead,
          { tile_id },
          { command: "shell_output_read", tile_id, ...senderContext() },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        const output = (resp.data as { output?: string } | undefined)?.output ?? "";
        return { content: [{ type: "text", text: output || "(no output)" }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(
    ROOT_TOOLS.tileRename,
    "Rename a tile in the current session.",
    { tile_id: z.string(), title: z.string() },
    async ({ tile_id, title }) => {
      try {
        const resp = await sendToolCommand(
          ROOT_TOOLS.tileRename,
          { tile_id, title },
          { command: "tile_rename", tile_id, title, ...senderContext() },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        return { content: [{ type: "text", text: jsonText(resp.data) }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(
    ROOT_TOOLS.shellRoleSet,
    "Set the logical role of a Herd tile.",
    { tile_id: z.string(), role: z.string() },
    async ({ tile_id, role }) => {
      try {
        const resp = await sendToolCommand(
          ROOT_TOOLS.shellRoleSet,
          { tile_id, role },
          { command: "shell_role_set", tile_id, role, ...senderContext() },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        return { content: [{ type: "text", text: "Role updated" }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(
    ROOT_TOOLS.browserNavigate,
    "Navigate an existing browser tile to a URL.",
    { tile_id: z.string(), url: z.string() },
    async ({ tile_id, url }) => {
      try {
        const resp = await sendToolCommand(
          ROOT_TOOLS.browserNavigate,
          { tile_id, url },
          { command: "browser_navigate", tile_id, url, ...senderContext() },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        return { content: [{ type: "text", text: jsonText(resp.data) }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(
    ROOT_TOOLS.browserLoad,
    "Load a local file into an existing browser tile.",
    { tile_id: z.string(), path: z.string() },
    async ({ tile_id, path }) => {
      try {
        const resp = await sendToolCommand(
          ROOT_TOOLS.browserLoad,
          { tile_id, path },
          { command: "browser_load", tile_id, path, ...senderContext() },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        return { content: [{ type: "text", text: jsonText(resp.data) }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(ROOT_TOOLS.messageChannelList, "List channels in the current session.", {}, async () => {
    try {
      const resp = await sendToolCommand(
        ROOT_TOOLS.messageChannelList,
        {},
        { command: "message_channel_list", ...senderContext() },
      );
      if (!resp.ok) return errorResult(resp.error || "Unknown error");
      return { content: [{ type: "text", text: jsonText(resp.data) }] };
    } catch (err) {
      return errorResult(String(err));
    }
  });

  registerTool(
    ROOT_TOOLS.messageChannelSubscribe,
    "Subscribe an agent to a channel in the current session.",
    { agent_id: z.string(), channel_name: z.string() },
    async ({ agent_id, channel_name }) => {
      try {
        const resp = await sendToolCommand(
          ROOT_TOOLS.messageChannelSubscribe,
          { agent_id, channel_name },
          { command: "message_channel_subscribe", agent_id, channel_name, ...senderContext() },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        return { content: [{ type: "text", text: jsonText(resp.data) }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(
    ROOT_TOOLS.messageChannelUnsubscribe,
    "Unsubscribe an agent from a channel in the current session.",
    { agent_id: z.string(), channel_name: z.string() },
    async ({ agent_id, channel_name }) => {
      try {
        const resp = await sendToolCommand(
          ROOT_TOOLS.messageChannelUnsubscribe,
          { agent_id, channel_name },
          { command: "message_channel_unsubscribe", agent_id, channel_name, ...senderContext() },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        return { content: [{ type: "text", text: jsonText(resp.data) }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(
    ROOT_TOOLS.tileList,
    "List current-session tiles and connections. Use tile_type to narrow to shell, agent, browser, or work tiles.",
    { tile_type: TILE_TYPE_SCHEMA },
    async ({ tile_type }) => {
      try {
        const resp = await sendToolCommand(
          ROOT_TOOLS.tileList,
          tile_type ? { tile_type } : {},
          {
            command: "tile_list",
            tile_type,
            ...senderContext(),
          },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        return { content: [{ type: "text", text: jsonText(resp.data) }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(
    ROOT_TOOLS.tileGet,
    "Get a single tile from the current session, including type-specific details.",
    { tile_id: z.string() },
    async ({ tile_id }) => {
      try {
        const resp = await sendToolCommand(
          ROOT_TOOLS.tileGet,
          { tile_id },
          {
            command: "tile_get",
            tile_id,
            ...senderContext(),
          },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        return { content: [{ type: "text", text: jsonText(resp.data) }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(
    ROOT_TOOLS.tileMove,
    "Move a tile on the Herd canvas.",
    {
      tile_id: z.string(),
      x: z.number(),
      y: z.number(),
    },
    async ({ tile_id, x, y }) => {
      try {
        const resp = await sendToolCommand(
          ROOT_TOOLS.tileMove,
          { tile_id, x, y },
          {
            command: "tile_move",
            tile_id,
            x,
            y,
            ...senderContext(),
          },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        return { content: [{ type: "text", text: jsonText(resp.data) }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(
    ROOT_TOOLS.tileResize,
    "Resize a tile on the Herd canvas.",
    {
      tile_id: z.string(),
      width: z.number(),
      height: z.number(),
    },
    async ({ tile_id, width, height }) => {
      try {
        const resp = await sendToolCommand(
          ROOT_TOOLS.tileResize,
          { tile_id, width, height },
          {
            command: "tile_resize",
            tile_id,
            width,
            height,
            ...senderContext(),
          },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        return { content: [{ type: "text", text: jsonText(resp.data) }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(
    ROOT_TOOLS.tileArrangeElk,
    "Arrange all current-session tiles with the ELK layout based on their existing tile sizes and network connections.",
    {},
    async () => {
      try {
        const resp = await sendToolCommand(
          ROOT_TOOLS.tileArrangeElk,
          {},
          {
            command: "tile_arrange_elk",
            ...senderContext(),
          },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        return { content: [{ type: "text", text: jsonText(resp.data ?? { ok: true }) }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(
    ROOT_TOOLS.networkConnect,
    "Connect two tile ports on the current session network.",
    {
      from_tile_id: z.string(),
      from_port: z.string(),
      to_tile_id: z.string(),
      to_port: z.string(),
    },
    async ({ from_tile_id, from_port, to_tile_id, to_port }) => {
      try {
        const resp = await sendToolCommand(
          ROOT_TOOLS.networkConnect,
          { from_tile_id, from_port, to_tile_id, to_port },
          {
            command: "network_connect",
            from_tile_id,
            from_port,
            to_tile_id,
            to_port,
            ...senderContext(),
          },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        return { content: [{ type: "text", text: jsonText(resp.data ?? { ok: true }) }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(
    ROOT_TOOLS.networkDisconnect,
    "Disconnect the current edge attached to a tile port.",
    { tile_id: z.string(), port: z.string() },
    async ({ tile_id, port }) => {
      try {
        const resp = await sendToolCommand(
          ROOT_TOOLS.networkDisconnect,
          { tile_id, port },
          { command: "network_disconnect", tile_id, port, ...senderContext() },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        return { content: [{ type: "text", text: jsonText(resp.data ?? { ok: true }) }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(
    ROOT_TOOLS.workStageStart,
    "Mark a work item's current stage as in progress for the given owner agent.",
    { work_id: z.string(), agent_id: z.string() },
    async ({ work_id, agent_id }) => {
      try {
        const resp = await sendToolCommand(
          ROOT_TOOLS.workStageStart,
          { work_id, agent_id },
          { command: "work_stage_start", work_id, agent_id },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        return { content: [{ type: "text", text: jsonText(resp.data) }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(
    ROOT_TOOLS.workStageComplete,
    "Mark a work item's current stage as completed for the given owner agent.",
    { work_id: z.string(), agent_id: z.string() },
    async ({ work_id, agent_id }) => {
      try {
        const resp = await sendToolCommand(
          ROOT_TOOLS.workStageComplete,
          { work_id, agent_id },
          { command: "work_stage_complete", work_id, agent_id },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        return { content: [{ type: "text", text: jsonText(resp.data) }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(
    ROOT_TOOLS.workReviewApprove,
    "Approve the current stage of a work item.",
    { work_id: z.string() },
    async ({ work_id }) => {
      try {
        const resp = await sendToolCommand(
          ROOT_TOOLS.workReviewApprove,
          { work_id },
          { command: "work_review_approve", work_id },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        return { content: [{ type: "text", text: jsonText(resp.data) }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );

  registerTool(
    ROOT_TOOLS.workReviewImprove,
    "Send a work item stage back to in-progress with an improvement comment.",
    { work_id: z.string(), comment: z.string() },
    async ({ work_id, comment }) => {
      try {
        const resp = await sendToolCommand(
          ROOT_TOOLS.workReviewImprove,
          { work_id, comment },
          { command: "work_review_improve", work_id, comment },
        );
        if (!resp.ok) return errorResult(resp.error || "Unknown error");
        return { content: [{ type: "text", text: jsonText(resp.data) }] };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  );
}

registerMessageTools();
registerSharedTools();
if (IS_ROOT_MODE) {
  registerRootTools();
}

export async function main() {
  installParentExitWatch();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Herd MCP server running (socket: ${SOCKET_PATH})`);

  if (HERD_AGENT_ID && HERD_TILE_ID) {
    const registration = await sendCommand({
      command: "agent_register",
      agent_id: HERD_AGENT_ID,
      agent_type: "claude",
      agent_role: HERD_AGENT_ROLE,
      tile_id: HERD_TILE_ID,
      agent_pid: Number(process.ppid) || undefined,
      title: HERD_AGENT_ROLE === "root" ? "Root" : "Agent",
    });
    if (!registration.ok) {
      console.error("Failed to register Herd agent:", registration.error);
    } else {
      subscribeAgentEvents(server, HERD_AGENT_ID);
    }
  }
}
