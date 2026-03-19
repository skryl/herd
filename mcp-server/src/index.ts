import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as net from "node:net";
import * as readline from "node:readline";

const SOCKET_PATH = process.env.HERD_SOCK || "/tmp/herd.sock";

async function sendCommand(
  command: Record<string, unknown>
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH);
    let responded = false;

    socket.on("connect", () => {
      socket.write(JSON.stringify(command) + "\n");
    });

    const rl = readline.createInterface({ input: socket });
    rl.on("line", (line: string) => {
      if (!responded) {
        responded = true;
        try {
          resolve(JSON.parse(line));
        } catch {
          reject(new Error("Invalid JSON response from Herd"));
        }
        rl.close();
        socket.destroy();
      }
    });

    socket.on("error", (err: Error) => {
      if (!responded) {
        responded = true;
        reject(new Error(`Cannot connect to Herd at ${SOCKET_PATH}: ${err.message}`));
      }
    });

    setTimeout(() => {
      if (!responded) {
        responded = true;
        socket.destroy();
        reject(new Error("Timeout connecting to Herd"));
      }
    }, 5000);
  });
}

function errorResult(msg: string) {
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

const server = new McpServer({
  name: "herd",
  version: "0.1.0",
});

// ---- TOOLS ----

server.tool(
  "herd_spawn_shell",
  "Spawn a new terminal shell on the Herd canvas. Returns the session_id needed to interact with it. The shell is immediately visible to the user as a PCB component tile.",
  {
    x: z.number().optional().describe("X position on canvas (default: 100)"),
    y: z.number().optional().describe("Y position on canvas (default: 100)"),
    width: z.number().optional().describe("Tile width in pixels (default: 640)"),
    height: z.number().optional().describe("Tile height in pixels (default: 400)"),
    title: z.string().optional().describe("Display title for the tile (e.g. 'Agent: build runner')"),
  },
  async (params) => {
    try {
      const resp = await sendCommand({
        command: "spawn_shell",
        x: params.x,
        y: params.y,
        width: params.width,
        height: params.height,
        parent_session_id: process.env.HERD_SESSION_ID || undefined,
        parent_pane_id: process.env.TMUX_PANE || process.env.HERD_PANE_ID || undefined,
      });
      if (!resp.ok) return errorResult(resp.error || "Unknown error");

      // Set title if provided
      const data = resp.data as { session_id: string };
      if (params.title && data?.session_id) {
        await sendCommand({
          command: "set_title",
          session_id: data.session_id,
          title: params.title,
        });
      }

      return { content: [{ type: "text", text: JSON.stringify(resp.data) }] };
    } catch (err) {
      return errorResult(String(err));
    }
  }
);

server.tool(
  "herd_list_shells",
  "List all active terminal shells on the Herd canvas",
  {},
  async () => {
    try {
      const resp = await sendCommand({ command: "list_shells" });
      if (!resp.ok) return errorResult(resp.error || "Unknown error");
      return { content: [{ type: "text", text: JSON.stringify(resp.data, null, 2) }] };
    } catch (err) {
      return errorResult(String(err));
    }
  }
);

server.tool(
  "herd_destroy_shell",
  "Destroy a terminal shell by session ID. The tile is removed from the canvas.",
  {
    session_id: z.string().describe("The session ID to destroy"),
  },
  async ({ session_id }) => {
    try {
      const resp = await sendCommand({ command: "destroy_shell", session_id });
      if (!resp.ok) return errorResult(resp.error || "Unknown error");
      return { content: [{ type: "text", text: "Shell destroyed" }] };
    } catch (err) {
      return errorResult(String(err));
    }
  }
);

server.tool(
  "herd_send_input",
  "Send text input to a terminal shell (like typing on a keyboard). Use \\n to press Enter. Example: 'ls -la\\n' runs the ls command.",
  {
    session_id: z.string().describe("Target session ID"),
    input: z.string().describe("Text to send (use \\n for Enter)"),
  },
  async ({ session_id, input }) => {
    try {
      const resp = await sendCommand({ command: "send_input", session_id, input });
      if (!resp.ok) return errorResult(resp.error || "Unknown error");
      return { content: [{ type: "text", text: "Input sent" }] };
    } catch (err) {
      return errorResult(String(err));
    }
  }
);

server.tool(
  "herd_read_output",
  "Read recent terminal output from a shell. Returns buffered output since the last read (up to 64KB). Call after send_input with a short delay to capture command output.",
  {
    session_id: z.string().describe("Target session ID"),
  },
  async ({ session_id }) => {
    try {
      const resp = await sendCommand({ command: "read_output", session_id });
      if (!resp.ok) return errorResult(resp.error || "Unknown error");
      const output = (resp.data as { output: string })?.output ?? "";
      return { content: [{ type: "text", text: output || "(no output)" }] };
    } catch (err) {
      return errorResult(String(err));
    }
  }
);

server.tool(
  "herd_set_title",
  "Set the display title of a terminal tile on the canvas",
  {
    session_id: z.string().describe("Target session ID"),
    title: z.string().describe("New title text"),
  },
  async ({ session_id, title }) => {
    try {
      const resp = await sendCommand({ command: "set_title", session_id, title });
      if (!resp.ok) return errorResult(resp.error || "Unknown error");
      return { content: [{ type: "text", text: "Title updated" }] };
    } catch (err) {
      return errorResult(String(err));
    }
  }
);

// ---- MAIN ----

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr only (stdout is reserved for MCP JSON-RPC)
  console.error(`Herd MCP server running (socket: ${SOCKET_PATH})`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
