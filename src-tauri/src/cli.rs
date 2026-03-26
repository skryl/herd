use std::env;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;

use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug)]
struct CliContext {
    socket_path: String,
    agent_pid: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SocketResponse {
    ok: bool,
    data: Option<Value>,
    error: Option<String>,
}

pub fn is_cli_invocation(args: &[String]) -> bool {
    !is_gui_launch_invocation(args)
}

fn is_gui_launch_invocation(args: &[String]) -> bool {
    args.len() <= 1 || args[1..].iter().all(|arg| is_gui_launch_arg(arg))
}

fn is_gui_launch_arg(arg: &str) -> bool {
    arg.starts_with("-psn_")
}

pub fn run(args: Vec<String>) -> Result<(), String> {
    let (ctx, index) = parse_global_flags(&args)?;
    if let Some(command) = args.get(index).map(String::as_str) {
        match command {
            "-h" | "--help" | "help" => {
                print_help();
                return Ok(());
            }
            "-V" | "--version" | "version" => {
                println!("{}", env!("CARGO_PKG_VERSION"));
                return Ok(());
            }
            _ => {}
        }
    }
    let payload = build_command_payload(&ctx, &args[index..])?;
    let output = send_command(&ctx.socket_path, &payload)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&output).map_err(|error| error.to_string())?
    );
    Ok(())
}

fn parse_global_flags(args: &[String]) -> Result<(CliContext, usize), String> {
    let mut socket_path = env::var("HERD_SOCK").unwrap_or_else(|_| crate::runtime::socket_path().to_string());
    let mut agent_pid = None;
    let mut index = 1usize;
    while index < args.len() {
        match args[index].as_str() {
            "--socket" => {
                index += 1;
                let value = args.get(index).ok_or("--socket requires a value")?;
                socket_path = value.clone();
                index += 1;
            }
            "--agent-pid" => {
                index += 1;
                let value = args.get(index).ok_or("--agent-pid requires a value")?;
                agent_pid = Some(value.clone());
                index += 1;
            }
            _ => break,
        }
    }
    Ok((CliContext { socket_path, agent_pid }, index))
}

fn print_help() {
    println!(
        "\
Usage:
  herd [--socket <path>] [--agent-pid <pid>] sudo <message>
  herd [--socket <path>] [--agent-pid <pid>] agent ack-ping [<agent_id>]
  herd [--socket <path>] [--agent-pid <pid>] network list [shell|agent|browser|work]
  herd [--socket <path>] [--agent-pid <pid>] network get <tile_id>
  herd [--socket <path>] [--agent-pid <pid>] network call <tile_id> <action> [json_args]
  herd [--socket <path>] [--agent-pid <pid>] network connect <from_tile> <from_port> <to_tile> <to_port>
  herd [--socket <path>] [--agent-pid <pid>] network disconnect <tile> <port>
  herd [--socket <path>] [--agent-pid <pid>] tile create <shell|agent|browser|work> [--title <text>] [--x <n>] [--y <n>] [--width <n>] [--height <n>] [--parent-session-id <id>] [--parent-tile-id <id>] [--browser-incognito <true|false>] [--browser-path <path>]
  herd [--socket <path>] [--agent-pid <pid>] tile list [shell|agent|browser|work]
  herd [--socket <path>] [--agent-pid <pid>] tile destroy <tile_id>
  herd [--socket <path>] [--agent-pid <pid>] tile get <tile_id>
  herd [--socket <path>] [--agent-pid <pid>] tile call <tile_id> <action> [json_args]
  herd [--socket <path>] [--agent-pid <pid>] tile move <tile_id> <x> <y>
  herd [--socket <path>] [--agent-pid <pid>] tile resize <tile_id> <width> <height>
  herd [--socket <path>] [--agent-pid <pid>] tile rename <tile_id> <title>
  herd [--socket <path>] [--agent-pid <pid>] message direct <agent_id> <message>
  herd [--socket <path>] [--agent-pid <pid>] message public <message> [--mention <agent_id>...]
  herd [--socket <path>] [--agent-pid <pid>] message channel list
  herd [--socket <path>] [--agent-pid <pid>] message channel subscribe <agent_id> <channel>
  herd [--socket <path>] [--agent-pid <pid>] message channel unsubscribe <agent_id> <channel>
  herd [--socket <path>] [--agent-pid <pid>] message channel <channel> <message>
  herd [--socket <path>] [--agent-pid <pid>] message network <message>
  herd [--socket <path>] [--agent-pid <pid>] message root <message>
  herd [--socket <path>] [--agent-pid <pid>] shell send <tile_id> <input>
  herd [--socket <path>] [--agent-pid <pid>] shell exec <tile_id> <command>
  herd [--socket <path>] [--agent-pid <pid>] shell read <tile_id>
  herd [--socket <path>] [--agent-pid <pid>] shell role <tile_id> <regular|claude|output>
  herd [--socket <path>] [--agent-pid <pid>] browser navigate <tile_id> <url>
  herd [--socket <path>] [--agent-pid <pid>] browser load <tile_id> <path>
  herd [--socket <path>] [--agent-pid <pid>] browser drive <tile_id> <click|select|type|dom_query|eval> [json_args]
  herd [--socket <path>] [--agent-pid <pid>] work stage start <work_id>
  herd [--socket <path>] [--agent-pid <pid>] work stage complete <work_id>
  herd [--socket <path>] [--agent-pid <pid>] raw <json>
  herd --help
  herd --version"
    );
}

fn send_command(socket_path: &str, payload: &Value) -> Result<Value, String> {
    let mut payload = payload.clone();
    if let Some(object) = payload.as_object_mut() {
        object.entry("channel".to_string()).or_insert_with(|| json!("cli"));
    }
    let mut stream = UnixStream::connect(socket_path)
        .map_err(|error| format!("failed to connect to Herd socket at {socket_path}: {error}"))?;
    stream
        .write_all(format!("{}\n", payload).as_bytes())
        .map_err(|error| format!("failed to write socket payload: {error}"))?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|error| format!("failed to read socket response: {error}"))?;
    let response: SocketResponse =
        serde_json::from_str(&line).map_err(|error| format!("invalid socket response: {error}"))?;
    if response.ok {
        Ok(response.data.unwrap_or(Value::Null))
    } else {
        Err(response.error.unwrap_or_else(|| "socket request failed".to_string()))
    }
}

fn env_agent_id() -> Option<String> {
    env::var("HERD_AGENT_ID").ok().filter(|value| !value.trim().is_empty())
}

fn non_empty_env(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.trim().is_empty())
}

fn env_tile_id() -> Option<String> {
    non_empty_env("HERD_TILE_ID")
}

fn require_env_agent_id() -> Result<String, String> {
    env_agent_id().ok_or("HERD_AGENT_ID is required for this command".to_string())
}

fn parse_tile_type(value: &str, command_name: &str) -> Result<String, String> {
    match value {
        "shell" | "agent" | "browser" | "work" => Ok(value.to_string()),
        other => Err(format!("unsupported tile type for {command_name}: {other}")),
    }
}

fn tile_create_payload(args: &[String]) -> Result<Value, String> {
    let tile_type = parse_tile_type(
        args.first().map(String::as_str).ok_or("tile create requires a tile type")?,
        "tile create",
    )?;
    let mut title = None;
    let mut x = None;
    let mut y = None;
    let mut width = None;
    let mut height = None;
    let mut parent_session_id = None;
    let mut parent_tile_id = None;
    let mut browser_incognito = None;
    let mut browser_path = None;
    let mut index = 1usize;
    while index < args.len() {
        let flag = args[index].as_str();
        index += 1;
        let value = args.get(index).ok_or_else(|| format!("{flag} requires a value"))?.clone();
        index += 1;
        match flag {
            "--title" => title = Some(value),
            "--x" => x = value.parse::<f64>().ok(),
            "--y" => y = value.parse::<f64>().ok(),
            "--width" => width = value.parse::<f64>().ok(),
            "--height" => height = value.parse::<f64>().ok(),
            "--parent-session-id" => parent_session_id = Some(value),
            "--parent-tile-id" => parent_tile_id = Some(value),
            "--browser-incognito" => browser_incognito = value.parse::<bool>().ok(),
            "--browser-path" => browser_path = Some(value),
            _ => return Err(format!("unknown tile create flag: {flag}")),
        }
    }
    if tile_type == "work" && title.as_deref().map(str::trim).filter(|value| !value.is_empty()).is_none() {
        return Err("tile create work requires --title <text>".to_string());
    }
    Ok(json!({
        "command": "tile_create",
        "tile_type": tile_type,
        "title": title,
        "x": x,
        "y": y,
        "width": width,
        "height": height,
        "parent_session_id": parent_session_id,
        "parent_tile_id": parent_tile_id,
        "browser_incognito": browser_incognito,
        "browser_path": browser_path,
        "sender_agent_id": env_agent_id(),
        "sender_tile_id": env_tile_id(),
    }))
}

fn parse_optional_tile_type(args: &[String], command_name: &str) -> Result<Option<String>, String> {
    let Some(tile_type) = args.first() else {
        return Ok(None);
    };
    if args.len() > 1 {
        return Err(format!("{command_name} accepts at most one optional tile type"));
    }
    match tile_type.as_str() {
        "shell" | "agent" | "browser" | "work" => Ok(Some(tile_type.clone())),
        other => Err(format!("unsupported tile type for {command_name}: {other}")),
    }
}

fn tile_list_payload(command: &str, tile_type: Option<String>) -> Value {
    let mut payload = json!({
        "command": command,
        "sender_agent_id": env_agent_id(),
        "sender_tile_id": env_tile_id(),
    });
    if let Some(tile_type) = tile_type {
        payload["tile_type"] = json!(tile_type);
    }
    payload
}

fn parse_number_arg(value: Option<&String>, error: &str) -> Result<f64, String> {
    value
        .ok_or_else(|| error.to_string())?
        .parse::<f64>()
        .map_err(|_| error.to_string())
}

fn parse_json_object_arg(raw: Option<String>, error: &str) -> Result<Value, String> {
    let Some(raw) = raw else {
        return Ok(json!({}));
    };
    let value = serde_json::from_str::<Value>(&raw).map_err(|parse_error| format!("{error}: {parse_error}"))?;
    if !value.is_object() {
        return Err(format!("{error}: expected a JSON object"));
    }
    Ok(value)
}

fn build_command_payload(ctx: &CliContext, args: &[String]) -> Result<Value, String> {
    let Some(group) = args.first().map(String::as_str) else {
        return Err("missing command group".to_string());
    };

    match group {
        "sudo" => Ok(json!({
            "command": "message_root",
            "message": args.get(1..).ok_or("sudo requires a message")?.join(" "),
            "sender_agent_id": env_agent_id(),
            "sender_tile_id": env_tile_id(),
            "sender_agent_pid": ctx.agent_pid,
        })),
        "network" => {
            let sub = args.get(1).map(String::as_str).ok_or("missing network target")?;
            match sub {
                "list" => Ok(tile_list_payload(
                    "network_list",
                    parse_optional_tile_type(&args[2..], "network list")?,
                )),
                "get" => Ok(json!({
                    "command": "network_get",
                    "tile_id": args.get(2).ok_or("network get requires a tile_id")?,
                    "sender_agent_id": env_agent_id(),
                    "sender_tile_id": env_tile_id(),
                })),
                "call" => {
                    let tile_id = args.get(2).ok_or("network call requires <tile_id> <action> [json_args]")?;
                    let action = args.get(3).ok_or("network call requires <tile_id> <action> [json_args]")?;
                    let args_json = parse_json_object_arg(
                        args.get(4..).filter(|values| !values.is_empty()).map(|values| values.join(" ")),
                        "network call requires valid JSON args",
                    )?;
                    Ok(json!({
                        "command": "network_call",
                        "tile_id": tile_id,
                        "action": action,
                        "args": args_json,
                        "sender_agent_id": env_agent_id(),
                        "sender_tile_id": env_tile_id(),
                    }))
                }
                "connect" => Ok(json!({
                    "command": "network_connect",
                    "from_tile_id": args.get(2).ok_or("network connect requires <from_tile> <from_port> <to_tile> <to_port>")?,
                    "from_port": args.get(3).ok_or("network connect requires <from_tile> <from_port> <to_tile> <to_port>")?,
                    "to_tile_id": args.get(4).ok_or("network connect requires <from_tile> <from_port> <to_tile> <to_port>")?,
                    "to_port": args.get(5).ok_or("network connect requires <from_tile> <from_port> <to_tile> <to_port>")?,
                    "sender_agent_id": env_agent_id(),
                    "sender_tile_id": env_tile_id(),
                })),
                "disconnect" => Ok(json!({
                    "command": "network_disconnect",
                    "tile_id": args.get(2).ok_or("network disconnect requires <tile> <port>")?,
                    "port": args.get(3).ok_or("network disconnect requires <tile> <port>")?,
                    "sender_agent_id": env_agent_id(),
                    "sender_tile_id": env_tile_id(),
                })),
                _ => Err(format!("unknown network target: {sub}")),
            }
        }
        "tile" => {
            let sub = args.get(1).map(String::as_str).ok_or("missing tile target")?;
            match sub {
                "create" => tile_create_payload(&args[2..]),
                "list" => Ok(tile_list_payload(
                    "tile_list",
                    parse_optional_tile_type(&args[2..], "tile list")?,
                )),
                "destroy" => Ok(json!({
                    "command": "tile_destroy",
                    "tile_id": args.get(2).ok_or("tile destroy requires a tile_id")?,
                    "sender_agent_id": env_agent_id(),
                    "sender_tile_id": env_tile_id(),
                })),
                "get" => Ok(json!({
                    "command": "tile_get",
                    "tile_id": args.get(2).ok_or("tile get requires a tile_id")?,
                    "sender_agent_id": env_agent_id(),
                    "sender_tile_id": env_tile_id(),
                })),
                "rename" => Ok(json!({
                    "command": "tile_rename",
                    "tile_id": args.get(2).ok_or("tile rename requires <tile_id> <title>")?,
                    "title": args.get(3..).ok_or("tile rename requires a title")?.join(" "),
                    "sender_agent_id": env_agent_id(),
                    "sender_tile_id": env_tile_id(),
                })),
                "call" => {
                    let tile_id = args.get(2).ok_or("tile call requires <tile_id> <action> [json_args]")?;
                    let action = args.get(3).ok_or("tile call requires <tile_id> <action> [json_args]")?;
                    let args_json = parse_json_object_arg(
                        args.get(4..).filter(|values| !values.is_empty()).map(|values| values.join(" ")),
                        "tile call requires valid JSON args",
                    )?;
                    Ok(json!({
                        "command": "tile_call",
                        "tile_id": tile_id,
                        "action": action,
                        "args": args_json,
                        "sender_agent_id": env_agent_id(),
                        "sender_tile_id": env_tile_id(),
                    }))
                }
                "move" => Ok(json!({
                    "command": "tile_move",
                    "tile_id": args.get(2).ok_or("tile move requires <tile_id> <x> <y>")?,
                    "x": parse_number_arg(args.get(3), "tile move requires <tile_id> <x> <y>")?,
                    "y": parse_number_arg(args.get(4), "tile move requires <tile_id> <x> <y>")?,
                    "sender_agent_id": env_agent_id(),
                    "sender_tile_id": env_tile_id(),
                })),
                "resize" => Ok(json!({
                    "command": "tile_resize",
                    "tile_id": args.get(2).ok_or("tile resize requires <tile_id> <width> <height>")?,
                    "width": parse_number_arg(args.get(3), "tile resize requires <tile_id> <width> <height>")?,
                    "height": parse_number_arg(args.get(4), "tile resize requires <tile_id> <width> <height>")?,
                    "sender_agent_id": env_agent_id(),
                    "sender_tile_id": env_tile_id(),
                })),
                _ => Err(format!("unknown tile target: {sub}")),
            }
        }
        "browser" => {
            let sub = args.get(1).map(String::as_str).ok_or("missing browser target")?;
            match sub {
                "navigate" => Ok(json!({
                    "command": "browser_navigate",
                    "tile_id": args.get(2).ok_or("browser navigate requires <tile_id> <url>")?,
                    "url": args.get(3).ok_or("browser navigate requires a url")?,
                    "sender_agent_id": env_agent_id(),
                    "sender_tile_id": env_tile_id(),
                })),
                "load" => Ok(json!({
                    "command": "browser_load",
                    "tile_id": args.get(2).ok_or("browser load requires <tile_id> <path>")?,
                    "path": args.get(3).ok_or("browser load requires a path")?,
                    "sender_agent_id": env_agent_id(),
                    "sender_tile_id": env_tile_id(),
                })),
                "drive" => {
                    let tile_id = args.get(2).ok_or("browser drive requires <tile_id> <action> [json_args]")?;
                    let action = args.get(3).ok_or("browser drive requires <tile_id> <action> [json_args]")?;
                    let args_json = parse_json_object_arg(
                        args.get(4..).filter(|values| !values.is_empty()).map(|values| values.join(" ")),
                        "browser drive requires valid JSON args",
                    )?;
                    Ok(json!({
                        "command": "browser_drive",
                        "tile_id": tile_id,
                        "action": action,
                        "args": args_json,
                        "sender_agent_id": env_agent_id(),
                        "sender_tile_id": env_tile_id(),
                    }))
                }
                _ => Err(format!("unknown browser target: {sub}")),
            }
        }
        "message" => {
            let sub = args.get(1).map(String::as_str).ok_or("missing message target")?;
            match sub {
                "direct" => {
                    let to_agent_id = args.get(2).ok_or("message direct requires <agent_id> <message>")?;
                    let message = args.get(3..).ok_or("message direct requires a message")?.join(" ");
                    Ok(json!({
                        "command": "message_direct",
                        "to_agent_id": to_agent_id,
                        "message": message,
                        "sender_agent_id": env_agent_id(),
                        "sender_tile_id": env_tile_id(),
                        "sender_agent_pid": ctx.agent_pid,
                    }))
                }
                "public" | "chatter" => {
                    let mut mentions = Vec::new();
                    let mut message_parts = Vec::new();
                    let mut index = 2usize;
                    while index < args.len() {
                        match args[index].as_str() {
                            "--mention" => {
                                index += 1;
                                mentions.push(args.get(index).ok_or("--mention requires a value")?.clone());
                            }
                            value => message_parts.push(value.to_string()),
                        }
                        index += 1;
                    }
                    if message_parts.is_empty() {
                        return Err(format!("message {sub} requires a message"));
                    }
                    Ok(json!({
                        "command": "message_public",
                        "message": message_parts.join(" "),
                        "mentions": mentions,
                        "sender_agent_id": env_agent_id(),
                        "sender_tile_id": env_tile_id(),
                        "sender_agent_pid": ctx.agent_pid,
                    }))
                }
                "network" => Ok(json!({
                    "command": "message_network",
                    "message": args.get(2..).ok_or("message network requires a message")?.join(" "),
                    "sender_agent_id": env_agent_id(),
                    "sender_tile_id": env_tile_id(),
                    "sender_agent_pid": ctx.agent_pid,
                })),
                "root" => Ok(json!({
                    "command": "message_root",
                    "message": args.get(2..).ok_or("message root requires a message")?.join(" "),
                    "sender_agent_id": env_agent_id(),
                    "sender_tile_id": env_tile_id(),
                    "sender_agent_pid": ctx.agent_pid,
                })),
                "channel" => {
                    match args.get(2).map(String::as_str) {
                        Some("list") => {
                            return Ok(json!({
                                "command": "message_channel_list",
                                "sender_agent_id": env_agent_id(),
                                "sender_tile_id": env_tile_id(),
                            }));
                        }
                        Some("subscribe") => {
                            let agent_id = args.get(3).ok_or("message channel subscribe requires <agent_id> <channel>")?;
                            let channel_name = args.get(4).ok_or("message channel subscribe requires a channel")?;
                            return Ok(json!({
                                "command": "message_channel_subscribe",
                                "agent_id": agent_id,
                                "channel_name": channel_name,
                                "sender_agent_id": env_agent_id(),
                                "sender_tile_id": env_tile_id(),
                                "sender_agent_pid": ctx.agent_pid,
                            }));
                        }
                        Some("unsubscribe") => {
                            let agent_id = args.get(3).ok_or("message channel unsubscribe requires <agent_id> <channel>")?;
                            let channel_name = args.get(4).ok_or("message channel unsubscribe requires a channel")?;
                            return Ok(json!({
                                "command": "message_channel_unsubscribe",
                                "agent_id": agent_id,
                                "channel_name": channel_name,
                                "sender_agent_id": env_agent_id(),
                                "sender_tile_id": env_tile_id(),
                                "sender_agent_pid": ctx.agent_pid,
                            }));
                        }
                        _ => {}
                    }
                    let channel_name = args.get(2).ok_or("message channel requires <channel> <message>")?;
                    let message = args.get(3..).ok_or("message channel requires a message")?.join(" ");
                    Ok(json!({
                        "command": "message_channel",
                        "channel_name": channel_name,
                        "message": message,
                        "sender_agent_id": env_agent_id(),
                        "sender_tile_id": env_tile_id(),
                        "sender_agent_pid": ctx.agent_pid,
                    }))
                }
                _ => Err(format!("unknown message target: {sub}")),
            }
        }
        "agent" => {
            let sub = args.get(1).map(String::as_str).ok_or("missing agent target")?;
            match sub {
                "ack-ping" => {
                    let agent_id = args.get(2).cloned().or_else(env_agent_id).ok_or("agent ack-ping requires an agent id or HERD_AGENT_ID")?;
                    Ok(json!({
                        "command": "agent_ping_ack",
                        "agent_id": agent_id,
                    }))
                }
                _ => Err(format!("unknown agent target: {sub}")),
            }
        }
        "shell" => {
            let sub = args.get(1).map(String::as_str).ok_or("missing shell target")?;
            match sub {
                "send" => Ok(json!({
                    "command": "shell_input_send",
                    "tile_id": args.get(2).ok_or("shell send requires <tile_id> <input>")?,
                    "input": args.get(3..).ok_or("shell send requires input")?.join(" "),
                    "sender_agent_id": env_agent_id(),
                    "sender_tile_id": env_tile_id(),
                })),
                "exec" => Ok(json!({
                    "command": "shell_exec",
                    "tile_id": args.get(2).ok_or("shell exec requires <tile_id> <command>")?,
                    "shell_command": args.get(3..).ok_or("shell exec requires a command")?.join(" "),
                    "sender_agent_id": env_agent_id(),
                    "sender_tile_id": env_tile_id(),
                })),
                "read" => Ok(json!({
                    "command": "shell_output_read",
                    "tile_id": args.get(2).ok_or("shell read requires a tile_id")?,
                    "sender_agent_id": env_agent_id(),
                    "sender_tile_id": env_tile_id(),
                })),
                "role" => Ok(json!({
                    "command": "shell_role_set",
                    "tile_id": args.get(2).ok_or("shell role requires <tile_id> <role>")?,
                    "role": args.get(3).ok_or("shell role requires a role")?,
                    "sender_agent_id": env_agent_id(),
                    "sender_tile_id": env_tile_id(),
                })),
                _ => Err(format!("unknown shell target: {sub}")),
            }
        }
        "work" => {
            let sub = args.get(1).map(String::as_str).ok_or("missing work target")?;
            match sub {
                "stage" => {
                    let action = args.get(2).map(String::as_str).ok_or("missing work stage action")?;
                    let work_id = args.get(3).ok_or("work stage requires a work_id")?;
                    match action {
                        "start" => Ok(json!({
                            "command": "work_stage_start",
                            "work_id": work_id,
                            "agent_id": require_env_agent_id()?,
                        })),
                        "complete" => Ok(json!({
                            "command": "work_stage_complete",
                            "work_id": work_id,
                            "agent_id": require_env_agent_id()?,
                        })),
                        _ => Err(format!("unknown work stage action: {action}")),
                    }
                }
                _ => Err(format!("unknown work target: {sub}")),
            }
        }
        "raw" => {
            let raw = args.get(1..).ok_or("raw requires a JSON payload")?.join(" ");
            serde_json::from_str::<Value>(&raw).map_err(|error| format!("invalid raw JSON: {error}"))
        }
        _ => Err(format!("unknown command group: {group}")),
    }
}

#[cfg(test)]
mod tests {
    use super::{build_command_payload, is_cli_invocation, is_gui_launch_arg, CliContext};
    use serde_json::json;
    use std::sync::{Mutex, OnceLock};

    fn ctx() -> CliContext {
        CliContext {
            socket_path: "/tmp/herd-test.sock".to_string(),
            agent_pid: Some("4242".to_string()),
        }
    }

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn with_agent_env<R>(agent_id: &str, f: impl FnOnce() -> R) -> R {
        let _guard = env_lock().lock().unwrap_or_else(|error| error.into_inner());
        let previous = std::env::var("HERD_AGENT_ID").ok();
        let previous_tile = std::env::var("HERD_TILE_ID").ok();
        std::env::set_var("HERD_AGENT_ID", agent_id);
        std::env::remove_var("HERD_TILE_ID");
        let result = f();
        match previous {
            Some(value) => std::env::set_var("HERD_AGENT_ID", value),
            None => std::env::remove_var("HERD_AGENT_ID"),
        }
        match previous_tile {
            Some(value) => std::env::set_var("HERD_TILE_ID", value),
            None => std::env::remove_var("HERD_TILE_ID"),
        }
        result
    }

    fn with_agent_and_tile_env<R>(agent_id: &str, tile_id: &str, f: impl FnOnce() -> R) -> R {
        let _guard = env_lock().lock().unwrap_or_else(|error| error.into_inner());
        let previous_agent = std::env::var("HERD_AGENT_ID").ok();
        let previous_tile = std::env::var("HERD_TILE_ID").ok();
        std::env::set_var("HERD_AGENT_ID", agent_id);
        std::env::set_var("HERD_TILE_ID", tile_id);
        let result = f();
        match previous_agent {
            Some(value) => std::env::set_var("HERD_AGENT_ID", value),
            None => std::env::remove_var("HERD_AGENT_ID"),
        }
        match previous_tile {
            Some(value) => std::env::set_var("HERD_TILE_ID", value),
            None => std::env::remove_var("HERD_TILE_ID"),
        }
        result
    }

    fn with_cli_env<R>(
        herd_tile_id: Option<&str>,
        herd_sock: Option<&str>,
        herd_session_id: Option<&str>,
        f: impl FnOnce() -> R,
    ) -> R {
        let _guard = env_lock().lock().unwrap_or_else(|error| error.into_inner());
        let previous_agent = std::env::var("HERD_AGENT_ID").ok();
        let previous_herd_tile = std::env::var("HERD_TILE_ID").ok();
        let previous_herd_sock = std::env::var("HERD_SOCK").ok();
        let previous_herd_session = std::env::var("HERD_SESSION_ID").ok();

        std::env::remove_var("HERD_AGENT_ID");
        match herd_tile_id {
            Some(value) => std::env::set_var("HERD_TILE_ID", value),
            None => std::env::remove_var("HERD_TILE_ID"),
        }
        match herd_sock {
            Some(value) => std::env::set_var("HERD_SOCK", value),
            None => std::env::remove_var("HERD_SOCK"),
        }
        match herd_session_id {
            Some(value) => std::env::set_var("HERD_SESSION_ID", value),
            None => std::env::remove_var("HERD_SESSION_ID"),
        }

        let result = f();

        match previous_agent {
            Some(value) => std::env::set_var("HERD_AGENT_ID", value),
            None => std::env::remove_var("HERD_AGENT_ID"),
        }
        match previous_herd_tile {
            Some(value) => std::env::set_var("HERD_TILE_ID", value),
            None => std::env::remove_var("HERD_TILE_ID"),
        }
        match previous_herd_sock {
            Some(value) => std::env::set_var("HERD_SOCK", value),
            None => std::env::remove_var("HERD_SOCK"),
        }
        match previous_herd_session {
            Some(value) => std::env::set_var("HERD_SESSION_ID", value),
            None => std::env::remove_var("HERD_SESSION_ID"),
        }

        result
    }

    #[test]
    fn serializes_tile_create_agent_payload() {
        with_cli_env(None, None, None, || {
            let payload = build_command_payload(
                &ctx(),
                &[
                    "tile".into(),
                    "create".into(),
                    "agent".into(),
                    "--parent-session-id".into(),
                    "$7".into(),
                    "--parent-tile-id".into(),
                    "tile7".into(),
                ],
            )
            .unwrap();
            assert_eq!(
                payload,
                json!({
                    "command": "tile_create",
                    "tile_type": "agent",
                    "title": null,
                    "x": null,
                    "y": null,
                    "width": null,
                    "height": null,
                    "parent_session_id": "$7",
                    "parent_tile_id": "tile7",
                    "browser_incognito": null,
                    "browser_path": null,
                    "sender_agent_id": null,
                    "sender_tile_id": null,
                })
            );
        });
    }

    #[test]
    fn treats_no_args_and_macos_process_serial_launches_as_gui() {
        assert!(!is_cli_invocation(&["herd".into()]));
        assert!(is_gui_launch_arg("-psn_0_12345"));
        assert!(!is_cli_invocation(&["herd".into(), "-psn_0_12345".into()]));
    }

    #[test]
    fn treats_legacy_and_unknown_argument_invocations_as_cli() {
        assert!(is_cli_invocation(&["herd".into(), "list".into(), "agents".into()]));
        assert!(is_cli_invocation(&[
            "herd".into(),
            "--agent-pid".into(),
            "4242".into(),
            "list".into(),
            "agents".into(),
        ]));
        assert!(is_cli_invocation(&["herd".into(), "--socket".into(), "/tmp/herd.sock".into()]));
    }

    #[test]
    fn serializes_list_network_payload_with_sender_context() {
        with_agent_and_tile_env("agent-7", "tile7", || {
            let payload = build_command_payload(&ctx(), &["network".into(), "list".into()]).unwrap();
            assert_eq!(
                payload,
                json!({
                    "command": "network_list",
                    "sender_agent_id": "agent-7",
                    "sender_tile_id": "tile7",
                })
            );
        });
    }

    #[test]
    fn serializes_network_get_payload_with_sender_context() {
        with_agent_and_tile_env("agent-7", "tile7", || {
            let payload = build_command_payload(
                &ctx(),
                &["network".into(), "get".into(), "tile9".into()],
            )
            .unwrap();
            assert_eq!(
                payload,
                json!({
                    "command": "network_get",
                    "tile_id": "tile9",
                    "sender_agent_id": "agent-7",
                    "sender_tile_id": "tile7",
                })
            );
        });
    }

    #[test]
    fn serializes_network_call_payload_with_sender_context() {
        with_agent_and_tile_env("agent-7", "tile7", || {
            let payload = build_command_payload(
                &ctx(),
                &[
                    "network".into(),
                    "call".into(),
                    "tile9".into(),
                    "input_send".into(),
                    r#"{"input":"ls\n"}"#.into(),
                ],
            )
            .unwrap();
            assert_eq!(
                payload,
                json!({
                    "command": "network_call",
                    "tile_id": "tile9",
                    "action": "input_send",
                    "args": {
                        "input": "ls\n",
                    },
                    "sender_agent_id": "agent-7",
                    "sender_tile_id": "tile7",
                })
            );
        });
    }

    #[test]
    fn serializes_filtered_list_payloads_with_sender_context() {
        with_agent_and_tile_env("agent-7", "tile7", || {
            let network_payload = build_command_payload(
                &ctx(),
                &["network".into(), "list".into(), "agent".into()],
            )
            .unwrap();
            assert_eq!(
                network_payload,
                json!({
                    "command": "network_list",
                    "sender_agent_id": "agent-7",
                    "sender_tile_id": "tile7",
                    "tile_type": "agent",
                })
            );

            let session_payload = build_command_payload(
                &ctx(),
                &["tile".into(), "list".into(), "work".into()],
            )
            .unwrap();
            assert_eq!(
                session_payload,
                json!({
                    "command": "tile_list",
                    "sender_agent_id": "agent-7",
                    "sender_tile_id": "tile7",
                    "tile_type": "work",
                })
            );

        });
    }

    #[test]
    fn rejects_invalid_optional_tile_type() {
        let error = build_command_payload(
            &ctx(),
            &["network".into(), "list".into(), "invalid".into()],
        )
        .unwrap_err();
        assert!(error.contains("unsupported tile type"));
    }

    #[test]
    fn serializes_tile_get_payload_with_sender_context() {
        with_agent_and_tile_env("agent-7", "tile7", || {
            let payload = build_command_payload(
                &ctx(),
                &["tile".into(), "get".into(), "tile9".into()],
            )
            .unwrap();
            assert_eq!(
                payload,
                json!({
                    "command": "tile_get",
                    "tile_id": "tile9",
                    "sender_agent_id": "agent-7",
                    "sender_tile_id": "tile7",
                })
            );
        });
    }

    #[test]
    fn serializes_tile_rename_payload_with_sender_context() {
        with_agent_and_tile_env("agent-7", "tile7", || {
            let payload = build_command_payload(
                &ctx(),
                &["tile".into(), "rename".into(), "tile9".into(), "Renamed".into(), "Tile".into()],
            )
            .unwrap();
            assert_eq!(
                payload,
                json!({
                    "command": "tile_rename",
                    "tile_id": "tile9",
                    "title": "Renamed Tile",
                    "sender_agent_id": "agent-7",
                    "sender_tile_id": "tile7",
                })
            );
        });
    }

    #[test]
    fn serializes_tile_call_payload_with_sender_context() {
        with_agent_and_tile_env("agent-7", "tile7", || {
            let payload = build_command_payload(
                &ctx(),
                &[
                    "tile".into(),
                    "call".into(),
                    "tile9".into(),
                    "input_send".into(),
                    r#"{"input":"ls\n"}"#.into(),
                ],
            )
            .unwrap();
            assert_eq!(
                payload,
                json!({
                    "command": "tile_call",
                    "tile_id": "tile9",
                    "action": "input_send",
                    "args": {
                        "input": "ls\n",
                    },
                    "sender_agent_id": "agent-7",
                    "sender_tile_id": "tile7",
                })
            );
        });
    }

    #[test]
    fn serializes_tile_move_payload_with_sender_context() {
        with_agent_and_tile_env("agent-7", "tile7", || {
            let payload = build_command_payload(
                &ctx(),
                &["tile".into(), "move".into(), "tile9".into(), "420".into(), "160".into()],
            )
            .unwrap();
            assert_eq!(
                payload,
                json!({
                    "command": "tile_move",
                    "tile_id": "tile9",
                    "x": 420.0,
                    "y": 160.0,
                    "sender_agent_id": "agent-7",
                    "sender_tile_id": "tile7",
                })
            );
        });
    }

    #[test]
    fn serializes_tile_resize_payload_with_sender_context() {
        with_agent_and_tile_env("agent-7", "tile7", || {
            let payload = build_command_payload(
                &ctx(),
                &["tile".into(), "resize".into(), "tile9".into(), "720".into(), "480".into()],
            )
            .unwrap();
            assert_eq!(
                payload,
                json!({
                    "command": "tile_resize",
                    "tile_id": "tile9",
                    "width": 720.0,
                    "height": 480.0,
                    "sender_agent_id": "agent-7",
                    "sender_tile_id": "tile7",
                })
            );
        });
    }

    #[test]
    fn serializes_message_channel_list_payload_with_sender_context() {
        with_agent_and_tile_env("agent-7", "tile7", || {
            let payload = build_command_payload(&ctx(), &["message".into(), "channel".into(), "list".into()]).unwrap();
            assert_eq!(
                payload,
                json!({
                    "command": "message_channel_list",
                    "sender_agent_id": "agent-7",
                    "sender_tile_id": "tile7",
                })
            );
        });
    }

    #[test]
    fn serializes_tile_create_shell_payload() {
        with_cli_env(None, None, None, || {
            let payload = build_command_payload(
                &ctx(),
                &[
                    "tile".into(),
                    "create".into(),
                    "shell".into(),
                    "--x".into(),
                    "180".into(),
                    "--y".into(),
                    "140".into(),
                    "--width".into(),
                    "640".into(),
                    "--height".into(),
                    "400".into(),
                    "--parent-tile-id".into(),
                    "tile1".into(),
                ],
            )
            .unwrap();
            assert_eq!(
                payload,
                json!({
                    "command": "tile_create",
                    "tile_type": "shell",
                    "title": null,
                    "x": 180.0,
                    "y": 140.0,
                    "width": 640.0,
                    "height": 400.0,
                    "parent_session_id": null,
                    "parent_tile_id": "tile1",
                    "browser_incognito": null,
                    "browser_path": null,
                    "sender_agent_id": null,
                    "sender_tile_id": null,
                })
            );
        });
    }

    #[test]
    fn serializes_browser_command_payloads() {
        with_agent_and_tile_env("agent-7", "tile7", || {
            let create = build_command_payload(
                &ctx(),
                &[
                    "tile".into(),
                    "create".into(),
                    "browser".into(),
                    "--parent-session-id".into(),
                    "$1".into(),
                ],
            )
            .unwrap();
            assert_eq!(
                create,
                json!({
                    "command": "tile_create",
                    "tile_type": "browser",
                    "title": null,
                    "x": null,
                    "y": null,
                    "width": null,
                    "height": null,
                    "parent_session_id": "$1",
                    "parent_tile_id": null,
                    "browser_incognito": null,
                    "browser_path": null,
                    "sender_agent_id": "agent-7",
                    "sender_tile_id": "tile7",
                })
            );

            let incognito_create = build_command_payload(
                &ctx(),
                &[
                    "tile".into(),
                    "create".into(),
                    "browser".into(),
                    "--browser-incognito".into(),
                    "true".into(),
                ],
            )
            .unwrap();
            assert_eq!(
                incognito_create,
                json!({
                    "command": "tile_create",
                    "tile_type": "browser",
                    "title": null,
                    "x": null,
                    "y": null,
                    "width": null,
                    "height": null,
                    "parent_session_id": null,
                    "parent_tile_id": null,
                    "browser_incognito": true,
                    "browser_path": null,
                    "sender_agent_id": "agent-7",
                    "sender_tile_id": "tile7",
                })
            );

            let extension_create = build_command_payload(
                &ctx(),
                &[
                    "tile".into(),
                    "create".into(),
                    "browser".into(),
                    "--browser-path".into(),
                    "extensions/browser/checkers/index.html".into(),
                ],
            )
            .unwrap();
            assert_eq!(
                extension_create,
                json!({
                    "command": "tile_create",
                    "tile_type": "browser",
                    "title": null,
                    "x": null,
                    "y": null,
                    "width": null,
                    "height": null,
                    "parent_session_id": null,
                    "parent_tile_id": null,
                    "browser_incognito": null,
                    "browser_path": "extensions/browser/checkers/index.html",
                    "sender_agent_id": "agent-7",
                    "sender_tile_id": "tile7",
                })
            );

            let destroy = build_command_payload(
                &ctx(),
                &["tile".into(), "destroy".into(), "tile9".into()],
            )
            .unwrap();
            assert_eq!(
                destroy,
                json!({
                    "command": "tile_destroy",
                    "tile_id": "tile9",
                    "sender_agent_id": "agent-7",
                    "sender_tile_id": "tile7",
                })
            );

            let navigate = build_command_payload(
                &ctx(),
                &["browser".into(), "navigate".into(), "tile9".into(), "https://example.com".into()],
            )
            .unwrap();
            assert_eq!(
                navigate,
                json!({
                    "command": "browser_navigate",
                    "tile_id": "tile9",
                    "url": "https://example.com",
                    "sender_agent_id": "agent-7",
                    "sender_tile_id": "tile7",
                })
            );

            let load = build_command_payload(
                &ctx(),
                &["browser".into(), "load".into(), "tile9".into(), "./fixtures/index.html".into()],
            )
            .unwrap();
            assert_eq!(
                load,
                json!({
                    "command": "browser_load",
                    "tile_id": "tile9",
                    "path": "./fixtures/index.html",
                    "sender_agent_id": "agent-7",
                    "sender_tile_id": "tile7",
                })
            );

            let drive = build_command_payload(
                &ctx(),
                &[
                    "browser".into(),
                    "drive".into(),
                    "tile9".into(),
                    "click".into(),
                    "{\"selector\":\"#go\"}".into(),
                ],
            )
            .unwrap();
            assert_eq!(
                drive,
                json!({
                    "command": "browser_drive",
                    "tile_id": "tile9",
                    "action": "click",
                    "args": {
                        "selector": "#go",
                    },
                    "sender_agent_id": "agent-7",
                    "sender_tile_id": "tile7",
                })
            );
        });
    }

    #[test]
    fn serializes_message_public_payload() {
        with_agent_and_tile_env("agent-7", "tile7", || {
            let payload = build_command_payload(
                &ctx(),
                &[
                    "message".into(),
                    "public".into(),
                    "sync".into(),
                    "on".into(),
                    "#prd-7".into(),
                    "--mention".into(),
                    "agent-2".into(),
                ],
            )
            .unwrap();
            assert_eq!(
                payload,
                json!({
                    "command": "message_public",
                    "message": "sync on #prd-7",
                    "sender_agent_id": "agent-7",
                    "sender_tile_id": "tile7",
                    "sender_agent_pid": "4242",
                    "mentions": ["agent-2"],
                })
            );
        });
    }

    #[test]
    fn serializes_message_channel_payload() {
        with_agent_and_tile_env("agent-7", "tile7", || {
            let payload = build_command_payload(
                &ctx(),
                &[
                    "message".into(),
                    "channel".into(),
                    "#alpha".into(),
                    "sync".into(),
                    "now".into(),
                ],
            )
            .unwrap();
            assert_eq!(
                payload,
                json!({
                    "command": "message_channel",
                    "channel_name": "#alpha",
                    "message": "sync now",
                    "sender_agent_id": "agent-7",
                    "sender_tile_id": "tile7",
                    "sender_agent_pid": "4242",
                })
            );
        });
    }

    #[test]
    fn serializes_message_network_and_root_payloads() {
        with_agent_and_tile_env("agent-7", "tile7", || {
            let network = build_command_payload(
                &ctx(),
                &["message".into(), "network".into(), "hello".into(), "team".into()],
            )
            .unwrap();
            assert_eq!(
                network,
                json!({
                    "command": "message_network",
                    "message": "hello team",
                    "sender_agent_id": "agent-7",
                    "sender_tile_id": "tile7",
                    "sender_agent_pid": "4242",
                })
            );

            let root = build_command_payload(
                &ctx(),
                &["message".into(), "root".into(), "need".into(), "help".into()],
            )
            .unwrap();
            assert_eq!(
                root,
                json!({
                    "command": "message_root",
                    "message": "need help",
                    "sender_agent_id": "agent-7",
                    "sender_tile_id": "tile7",
                    "sender_agent_pid": "4242",
                })
            );
        });
    }

    #[test]
    fn serializes_sudo_payload_as_message_root() {
        with_agent_and_tile_env("agent-7", "tile7", || {
            let payload = build_command_payload(
                &ctx(),
                &["sudo".into(), "please".into(), "take".into(), "over".into()],
            )
            .unwrap();
            assert_eq!(
                payload,
                json!({
                    "command": "message_root",
                    "message": "please take over",
                    "sender_agent_id": "agent-7",
                    "sender_tile_id": "tile7",
                    "sender_agent_pid": "4242",
                })
            );
        });
    }

    #[test]
    fn serializes_network_connect_and_disconnect_payloads() {
        with_agent_and_tile_env("agent-7", "tile7", || {
            let connect = build_command_payload(
                &ctx(),
                &[
                    "network".into(),
                    "connect".into(),
                    "tile7".into(),
                    "left".into(),
                    "work:work-s4-001".into(),
                    "left".into(),
                ],
            )
            .unwrap();
            assert_eq!(
                connect,
                json!({
                    "command": "network_connect",
                    "from_tile_id": "tile7",
                    "from_port": "left",
                    "to_tile_id": "work:work-s4-001",
                    "to_port": "left",
                    "sender_agent_id": "agent-7",
                    "sender_tile_id": "tile7",
                })
            );

            let disconnect = build_command_payload(
                &ctx(),
                &["network".into(), "disconnect".into(), "tile7".into(), "left".into()],
            )
            .unwrap();
            assert_eq!(
                disconnect,
                json!({
                    "command": "network_disconnect",
                    "tile_id": "tile7",
                    "port": "left",
                    "sender_agent_id": "agent-7",
                    "sender_tile_id": "tile7",
                })
            );
        });
    }

    #[test]
    fn serializes_tile_create_work_payload() {
        with_agent_and_tile_env("agent-1", "tile7", || {
            let payload = build_command_payload(
                &ctx(),
                &[
                    "tile".into(),
                    "create".into(),
                    "work".into(),
                    "--title".into(),
                    "Socket refactor".into(),
                ],
            )
            .unwrap();
            assert_eq!(
                payload,
                json!({
                    "command": "tile_create",
                    "tile_type": "work",
                    "title": "Socket refactor",
                    "x": null,
                    "y": null,
                    "width": null,
                    "height": null,
                    "parent_session_id": null,
                    "parent_tile_id": null,
                    "browser_incognito": null,
                    "browser_path": null,
                    "sender_agent_id": "agent-1",
                    "sender_tile_id": "tile7",
                })
            );
        });
    }

    #[test]
    fn rejects_work_show_command() {
        with_agent_and_tile_env("agent-7", "tile7", || {
            let error = build_command_payload(
                &ctx(),
                &["work".into(), "show".into(), "work-s4-001".into()],
            )
            .unwrap_err();
            assert!(error.contains("unknown work target"));
        });
    }

    #[test]
    fn serializes_work_stage_start_and_complete_payloads() {
        with_agent_env("owner-1", || {
            let start = build_command_payload(
                &ctx(),
                &["work".into(), "stage".into(), "start".into(), "work-s4-001".into()],
            )
            .unwrap();
            assert_eq!(
                start,
                json!({
                    "command": "work_stage_start",
                    "work_id": "work-s4-001",
                    "agent_id": "owner-1",
                })
            );

            let complete = build_command_payload(
                &ctx(),
                &["work".into(), "stage".into(), "complete".into(), "work-s4-001".into()],
            )
            .unwrap();
            assert_eq!(
                complete,
                json!({
                    "command": "work_stage_complete",
                    "work_id": "work-s4-001",
                    "agent_id": "owner-1",
                })
            );
        });
    }

    #[test]
    fn serializes_message_channel_subscribe_and_unsubscribe_payloads() {
        with_agent_env("owner-1", || {
            let subscribe = build_command_payload(
                &ctx(),
                &["message".into(), "channel".into(), "subscribe".into(), "agent-9".into(), "#prd-7".into()],
            )
            .unwrap();
            assert_eq!(
                subscribe,
                json!({
                    "command": "message_channel_subscribe",
                    "agent_id": "agent-9",
                    "channel_name": "#prd-7",
                    "sender_agent_id": "owner-1",
                    "sender_tile_id": serde_json::Value::Null,
                    "sender_agent_pid": "4242",
                })
            );

            let unsubscribe = build_command_payload(
                &ctx(),
                &["message".into(), "channel".into(), "unsubscribe".into(), "agent-9".into(), "#prd-7".into()],
            )
            .unwrap();
            assert_eq!(
                unsubscribe,
                json!({
                    "command": "message_channel_unsubscribe",
                    "agent_id": "agent-9",
                    "channel_name": "#prd-7",
                    "sender_agent_id": "owner-1",
                    "sender_tile_id": serde_json::Value::Null,
                    "sender_agent_pid": "4242",
                })
            );
        });
    }

    #[test]
    fn rejects_legacy_top_level_cli_groups() {
        let list_error = build_command_payload(&ctx(), &["list".into(), "agents".into()]).unwrap_err();
        assert_eq!(list_error, "unknown command group: list");

        let subscribe_error =
            build_command_payload(&ctx(), &["subscribe".into(), "topic".into(), "#prd-7".into()]).unwrap_err();
        assert_eq!(subscribe_error, "unknown command group: subscribe");

        let unsubscribe_error =
            build_command_payload(&ctx(), &["unsubscribe".into(), "topic".into(), "#prd-7".into()]).unwrap_err();
        assert_eq!(unsubscribe_error, "unknown command group: unsubscribe");
    }

    #[test]
    fn rejects_removed_specific_list_and_create_destroy_commands() {
        assert_eq!(
            build_command_payload(&ctx(), &["agent".into(), "list".into()]).unwrap_err(),
            "unknown agent target: list"
        );
        assert_eq!(
            build_command_payload(&ctx(), &["shell".into(), "list".into()]).unwrap_err(),
            "unknown shell target: list"
        );
        assert_eq!(
            build_command_payload(&ctx(), &["work".into(), "list".into()]).unwrap_err(),
            "unknown work target: list"
        );
        assert_eq!(
            build_command_payload(&ctx(), &["session".into(), "list".into()]).unwrap_err(),
            "unknown command group: session"
        );
        assert_eq!(
            build_command_payload(&ctx(), &["shell".into(), "create".into()]).unwrap_err(),
            "unknown shell target: create"
        );
        assert_eq!(
            build_command_payload(&ctx(), &["shell".into(), "destroy".into(), "tile1".into()]).unwrap_err(),
            "unknown shell target: destroy"
        );
        assert_eq!(
            build_command_payload(&ctx(), &["browser".into(), "create".into()]).unwrap_err(),
            "unknown browser target: create"
        );
        assert_eq!(
            build_command_payload(&ctx(), &["browser".into(), "destroy".into(), "tile1".into()]).unwrap_err(),
            "unknown browser target: destroy"
        );
        assert_eq!(
            build_command_payload(&ctx(), &["agent".into(), "create".into()]).unwrap_err(),
            "unknown agent target: create"
        );
        assert_eq!(
            build_command_payload(&ctx(), &["work".into(), "create".into(), "Title".into()]).unwrap_err(),
            "unknown work target: create"
        );
    }

    #[test]
    fn uses_herd_tile_id_for_sender_context() {
        with_cli_env(Some("tile1"), None, None, || {
            let payload = build_command_payload(&ctx(), &["tile".into(), "list".into(), "shell".into()]).unwrap();
            assert_eq!(
                payload,
                json!({
                    "command": "tile_list",
                    "sender_agent_id": null,
                    "sender_tile_id": "tile1",
                    "tile_type": "shell",
                })
            );
        });
    }

    #[test]
    fn ignores_socket_and_session_env_without_herd_tile_id() {
        with_cli_env(None, Some("/tmp/herd.sock"), Some("$1"), || {
            let payload = build_command_payload(&ctx(), &["tile".into(), "list".into(), "shell".into()]).unwrap();
            assert_eq!(
                payload,
                json!({
                    "command": "tile_list",
                    "sender_agent_id": null,
                    "sender_tile_id": null,
                    "tile_type": "shell",
                })
            );
        });
    }
}
