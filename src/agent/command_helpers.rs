use crate::config::AppConfig;

pub fn should_track_status_for_command(command: &str, config: &AppConfig) -> bool {
    let normalized = command.trim().to_lowercase();
    if normalized.is_empty() {
        return false;
    }

    if config.status_track_exact_commands.contains(&normalized) {
        return true;
    }

    config
        .agent_process_markers
        .iter()
        .any(|marker| normalized.contains(marker))
}

pub fn should_highlight_command(command: &str, config: &AppConfig) -> bool {
    let normalized = command.trim().to_lowercase();
    if normalized.is_empty() {
        return false;
    }

    config
        .agent_process_markers
        .iter()
        .any(|marker| normalized.contains(marker))
}

pub fn display_command(command: &str) -> String {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        "(none)".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn agent_name_for_command(command: &str, config: &AppConfig) -> String {
    let normalized = command.trim().to_lowercase();
    if normalized.is_empty() {
        return "none".to_string();
    }

    if let Some(marker) = config
        .agent_process_markers
        .iter()
        .find(|marker| normalized.contains(marker.as_str()))
    {
        return marker.clone();
    }

    if let Some(exact) = config
        .status_track_exact_commands
        .iter()
        .find(|candidate| normalized == **candidate)
    {
        return exact.clone();
    }

    "none".to_string()
}
