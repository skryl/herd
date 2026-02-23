use crate::domain::SessionRef;

use super::LIST_PANES_DELIM;

pub(super) fn parse_control_output_line(line: &str) -> Option<(String, Vec<u8>)> {
    if let Some(rest) = line.strip_prefix("%output ") {
        let (pane_id, value) = rest.split_once(' ')?;
        return Some((pane_id.to_string(), decode_tmux_escaped_value(value)));
    }
    if let Some(rest) = line.strip_prefix("%extended-output ") {
        let (pane_id, metadata_and_value) = rest.split_once(' ')?;
        let value = metadata_and_value
            .split_once(" : ")
            .map(|(_, value)| value)
            .or_else(|| metadata_and_value.split_once(':').map(|(_, value)| value))?;
        return Some((
            pane_id.to_string(),
            decode_tmux_escaped_value(value.trim_start()),
        ));
    }
    None
}

pub(super) fn decode_tmux_escaped_value(value: &str) -> Vec<u8> {
    let mut decoded = Vec::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut index = 0usize;

    while index < bytes.len() {
        if bytes[index] == b'\\'
            && index + 3 < bytes.len()
            && is_octal(bytes[index + 1])
            && is_octal(bytes[index + 2])
            && is_octal(bytes[index + 3])
        {
            let octal = &value[index + 1..index + 4];
            if let Ok(parsed) = u8::from_str_radix(octal, 8) {
                decoded.push(parsed);
                index += 4;
                continue;
            }
        }

        decoded.push(bytes[index]);
        index += 1;
    }

    decoded
}

pub(super) fn parse_list_panes_output(output: &str) -> Result<Vec<SessionRef>, String> {
    let mut sessions = Vec::new();
    for line in output.lines().filter(|line| !line.trim().is_empty()) {
        let parts: Vec<&str> = if line.contains(LIST_PANES_DELIM) {
            line.split(LIST_PANES_DELIM).collect()
        } else if line.contains('\t') {
            line.split('\t').collect()
        } else if line.contains("\\t") {
            line.split("\\t").collect()
        } else {
            vec![line]
        };
        if parts.len() != 11 {
            return Err(format!(
                "unexpected list-panes field count {}, line: {}",
                parts.len(),
                line
            ));
        }

        let window_index = parts[3].parse::<i64>().map_err(|err| {
            format!(
                "invalid window_index value '{}' in line '{}': {err}",
                parts[3], line
            )
        })?;
        let pane_index = parts[6].parse::<i64>().map_err(|err| {
            format!(
                "invalid pane_index value '{}' in line '{}': {err}",
                parts[6], line
            )
        })?;

        let pane_dead = match parts[9] {
            "0" => false,
            "1" => true,
            other => {
                return Err(format!("invalid pane_dead value '{other}' in line: {line}"));
            }
        };

        let pane_last_activity_unix = parts[10].parse::<i64>().map_err(|err| {
            format!(
                "invalid pane_last value '{}' in line '{}': {err}",
                parts[10], line
            )
        })?;

        sessions.push(SessionRef {
            session_id: parts[0].to_string(),
            session_name: parts[1].to_string(),
            window_id: parts[2].to_string(),
            window_index,
            window_name: parts[4].to_string(),
            pane_id: parts[5].to_string(),
            pane_index,
            pane_current_path: parts[7].to_string(),
            pane_current_command: parts[8].to_string(),
            pane_dead,
            pane_last_activity_unix,
        });
    }
    Ok(sessions)
}

fn is_octal(byte: u8) -> bool {
    (b'0'..=b'7').contains(&byte)
}
