#!/usr/bin/env python3
"""Stream a Claude Code JSONL transcript, printing assistant text and tool calls."""
import sys
import json

for line in sys.stdin:
    try:
        obj = json.loads(line.strip())
        msg = obj.get("message", {})
        role = msg.get("role", "") or obj.get("type", "")
        if role == "assistant":
            content = msg.get("content", [])
            if isinstance(content, str):
                print(content, flush=True)
                continue
            for block in (content if isinstance(content, list) else []):
                if isinstance(block, dict):
                    if block.get("type") == "text":
                        print(block["text"], flush=True)
                    elif block.get("type") == "tool_use":
                        name = block.get("name", "tool")
                        print(f"-> {name}()", flush=True)
    except Exception:
        pass
