import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  MESSAGE_TOOL_NAMES,
  SHARED_TOOL_NAMES,
  ROOT_ONLY_TOOL_NAMES,
  ROOT_TOOL_NAMES,
  resolveAgentRole,
  resolveMcpMode,
  unwrapNestedScreenshotResult,
  WORKER_TOOL_NAMES,
} from "./index.js";

describe("mcp tool surface parity", () => {
  it("keeps the message tool surface stable", () => {
    expect(MESSAGE_TOOL_NAMES).toEqual([
      "message_direct",
      "message_public",
      "message_channel",
      "message_network",
      "message_root",
    ]);
  });

  it("exposes worker-safe shared tools separately from root-only tools", () => {
    expect(SHARED_TOOL_NAMES).toEqual([
      "network_list",
      "network_get",
      "network_call",
    ]);
    expect(WORKER_TOOL_NAMES).toEqual([...MESSAGE_TOOL_NAMES, ...SHARED_TOOL_NAMES]);
  });

  it("exposes the full latest root tool surface", () => {
    expect(ROOT_ONLY_TOOL_NAMES).toEqual([
      "tile_create",
      "tile_destroy",
      "tile_list",
      "tile_rename",
      "tile_call",
      "shell_input_send",
      "shell_exec",
      "shell_output_read",
      "shell_role_set",
      "browser_navigate",
      "browser_load",
      "browser_drive",
      "message_channel_list",
      "message_channel_subscribe",
      "message_channel_unsubscribe",
      "tile_get",
      "tile_move",
      "tile_resize",
      "tile_arrange_elk",
      "network_connect",
      "network_disconnect",
      "work_stage_start",
      "work_stage_complete",
      "work_review_approve",
      "work_review_improve",
    ]);
    expect(ROOT_TOOL_NAMES).toEqual([...WORKER_TOOL_NAMES, ...ROOT_ONLY_TOOL_NAMES]);
  });

  it("does not expose internal lifecycle or test commands through MCP", () => {
    const disallowed = new Set([
      "agent_register",
      "agent_unregister",
      "agent_events_subscribe",
      "agent_ping_ack",
      "test_driver",
      "test_dom_query",
      "test_dom_keys",
    ]);
    for (const name of ROOT_TOOL_NAMES) {
      expect(disallowed.has(name)).toBe(false);
    }
  });
});

describe("mcp role and launcher resolution", () => {
  it("prefers the explicit herd agent role when resolving root mode", () => {
    expect(resolveAgentRole({ HERD_AGENT_ROLE: "root", HERD_MCP_MODE: "worker" })).toBe("root");
    expect(resolveMcpMode({ HERD_AGENT_ROLE: "root", HERD_MCP_MODE: "worker" })).toBe("root");
    expect(resolveMcpMode({ HERD_AGENT_ID: "root:$1" })).toBe("root");
    expect(resolveMcpMode({})).toBe("worker");
  });

  it("keeps the checked-in launcher wrapper neutral", () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const wrapper = readFileSync(resolve(repoRoot, "bin/herd-mcp-server"), "utf8");
    expect(wrapper).not.toContain("HERD_MCP_MODE=worker");
    expect(wrapper).not.toContain("HERD_MCP_MODE=root");
  });
});

describe("nested screenshot unwrapping", () => {
  it("unwraps extension_call image screenshots into MCP image content", () => {
    const payload = {
      tile_id: "tile-1",
      action: "extension_call",
      result: {
        mimeType: "image/png",
        dataBase64: "Zm9v",
      },
    };
    const result = unwrapNestedScreenshotResult(
      "extension_call",
      { method: "screenshot", args: { format: "image" } },
      payload,
      "invalid screenshot payload",
    );
    expect(result).toEqual({
      content: [{ type: "image", data: "Zm9v", mimeType: "image/png" }],
    });
  });

  it("unwraps drive text screenshots into MCP text content", () => {
    const payload = {
      tile_id: "tile-1",
      action: "drive",
      result: {
        format: "ascii",
        text: "##..\n..##",
        columns: 4,
        rows: 2,
      },
    };
    const result = unwrapNestedScreenshotResult(
      "drive",
      { action: "screenshot", args: { format: "ascii", columns: 4 } },
      payload,
      "invalid screenshot payload",
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "##..\n..##" }],
    });
  });

  it("returns an error result for malformed nested screenshot payloads", () => {
    const result = unwrapNestedScreenshotResult(
      "extension_call",
      { method: "screenshot", args: { format: "image" } },
      { tile_id: "tile-1", action: "extension_call", result: { nope: true } },
      "invalid screenshot payload",
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "Error: invalid screenshot payload" }],
      isError: true,
    });
  });

  it("ignores non-screenshot nested calls", () => {
    const result = unwrapNestedScreenshotResult(
      "extension_call",
      { method: "state" },
      { tile_id: "tile-1", action: "extension_call", result: { loaded: true } },
      "invalid screenshot payload",
    );
    expect(result).toBeNull();
  });
});
