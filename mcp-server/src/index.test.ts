import { describe, expect, it } from "vitest";

import {
  MESSAGE_TOOL_NAMES,
  SHARED_TOOL_NAMES,
  ROOT_ONLY_TOOL_NAMES,
  ROOT_TOOL_NAMES,
  WORKER_TOOL_NAMES,
} from "./index.js";

describe("mcp tool surface parity", () => {
  it("keeps the message tool surface stable", () => {
    expect(MESSAGE_TOOL_NAMES).toEqual([
      "message_direct",
      "message_public",
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
      "message_topic_list",
      "message_topic_subscribe",
      "message_topic_unsubscribe",
      "tile_get",
      "tile_move",
      "tile_resize",
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
