use std::path::{Path, PathBuf};

use clap::{CommandFactory, Parser, Subcommand};

use crate::agent::{
    AgentStatus, ClassifierConfig, HeuristicSessionClassifier, PriorProcessState,
    SessionClassifier, display_command, should_track_status_for_command,
};
use crate::codex::{
    CodexSessionStateProvider, assessment_from_codex_state, collect_codex_cwds_from_sessions,
    is_codex_command, now_unix,
};
use crate::config::{AppConfig, default_config_path, default_state_path};
use crate::herd::HerdRegistry;
use crate::tmux::{SystemTmuxAdapter, TmuxAdapter};
use crate::tui::run_tui;

#[derive(Debug, Parser)]
#[command(name = "herd", about = "Manage Codex/Claude tmux agent sessions")]
struct Cli {
    #[arg(long, global = true, env = "HERD_TMUX_SOCKET")]
    tmux_socket: Option<String>,
    #[arg(long, global = true, env = "HERD_CONFIG")]
    config: Option<PathBuf>,
    #[arg(long, global = true, env = "HERD_STATE")]
    state: Option<PathBuf>,
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Debug, Subcommand)]
enum Commands {
    Tui,
    Sessions,
    Herd {
        #[command(subcommand)]
        command: Option<HerdCommand>,
    },
}

#[derive(Debug, Subcommand)]
enum HerdCommand {
    List,
    Mark { pane_id: String },
    Unmark { pane_id: String },
}

pub fn run() -> i32 {
    match Cli::try_parse() {
        Ok(cli) => run_command(cli),
        Err(err) => {
            let code = err.exit_code();
            let _ = err.print();
            code
        }
    }
}

fn run_command(cli: Cli) -> i32 {
    let config_path = cli.config.unwrap_or_else(default_config_path);
    let state_path = cli.state.unwrap_or_else(default_state_path);
    let config = load_config_or_default(&config_path);
    let socket = cli.tmux_socket;
    match cli.command {
        Some(Commands::Tui) => run_tui_command(socket, config, config_path, state_path),
        Some(Commands::Sessions) => run_sessions(socket, &config),
        Some(Commands::Herd { command }) => run_herd(command, &state_path),
        None => {
            let mut command = Cli::command();
            let _ = command.print_help();
            println!();
            0
        }
    }
}

fn load_config_or_default(path: &Path) -> AppConfig {
    match AppConfig::load_from_path(path) {
        Ok(config) => config,
        Err(err) => {
            eprintln!("warning: {err}");
            AppConfig::default()
        }
    }
}

fn run_tui_command(
    socket: Option<String>,
    config: AppConfig,
    config_path: PathBuf,
    state_path: PathBuf,
) -> i32 {
    match run_tui(socket, config, config_path, state_path) {
        Ok(()) => 0,
        Err(err) => {
            eprintln!("{err}");
            1
        }
    }
}

fn run_sessions(socket: Option<String>, config: &AppConfig) -> i32 {
    let adapter = SystemTmuxAdapter::new(socket);
    let classifier = HeuristicSessionClassifier::new(ClassifierConfig::from(config));
    let mut sessions = match adapter.list_sessions() {
        Ok(sessions) => sessions,
        Err(err) => {
            eprintln!("failed to list tmux sessions: {err}");
            return 1;
        }
    };
    let now = now_unix();
    let mut codex_provider = CodexSessionStateProvider::default();
    let codex_status_by_cwd =
        codex_provider.statuses_for_cwds(&collect_codex_cwds_from_sessions(&sessions), now);
    if let Some(err) = codex_provider.take_last_error() {
        eprintln!("warning: codex status provider unavailable: {err}");
    }

    sessions.sort_by(|a, b| {
        a.session_name
            .cmp(&b.session_name)
            .then(a.window_index.cmp(&b.window_index))
            .then(a.pane_index.cmp(&b.pane_index))
            .then(a.pane_id.cmp(&b.pane_id))
    });

    let mut current_session: Option<String> = None;
    let mut current_window: Option<(i64, String)> = None;
    for session in sessions {
        if current_session.as_deref() != Some(session.session_name.as_str()) {
            println!("session {} ({})", session.session_name, session.session_id);
            current_session = Some(session.session_name.clone());
            current_window = None;
        }
        if current_window
            .as_ref()
            .map(|(index, name)| (*index, name.as_str()))
            != Some((session.window_index, session.window_name.as_str()))
        {
            println!(
                "  window {}:{} ({})",
                session.window_index, session.window_name, session.window_id
            );
            current_window = Some((session.window_index, session.window_name.clone()));
        }

        let command = display_command(&session.pane_current_command);
        if should_track_status_for_command(&session.pane_current_command, config) {
            let status = match adapter.capture_pane(&session.pane_id, config.capture_lines) {
                Ok(mut snapshot) => {
                    snapshot.last_activity_unix = session.pane_last_activity_unix;
                    let prior = PriorProcessState::default();
                    let mut assessment = classifier.assess(&snapshot, prior);
                    if is_codex_command(&session.pane_current_command)
                        && let Some(codex_state) =
                            codex_status_by_cwd.get(&session.pane_current_path)
                    {
                        let captured_at_unix = snapshot
                            .captured_at_unix
                            .max(codex_state.thread_updated_unix);
                        assessment = assessment_from_codex_state(
                            codex_state,
                            prior,
                            captured_at_unix,
                            config.status_waiting_grace_secs(),
                        );
                    }
                    assessment.display_status
                }
                Err(_) => AgentStatus::Unknown,
            };
            println!(
                "    pane {} {} run={} status={}",
                session.pane_index,
                session.pane_id,
                command,
                status.as_str()
            );
        } else {
            println!(
                "    pane {} {} run={}",
                session.pane_index, session.pane_id, command
            );
        }
    }
    0
}

fn run_herd(command: Option<HerdCommand>, state_path: &Path) -> i32 {
    let mut registry = match HerdRegistry::load_from_path(state_path) {
        Ok(registry) => registry,
        Err(err) => {
            eprintln!("failed to load herd state: {err}");
            return 1;
        }
    };

    match command.unwrap_or(HerdCommand::List) {
        HerdCommand::List => {
            println!("pane\therded\tnudges\tlast_nudge");
            for (pane, state) in registry.sessions() {
                if state.herded {
                    println!(
                        "{}\t{}\t{}\t{}",
                        pane,
                        state.herded,
                        state.nudge_count,
                        state
                            .last_nudge_unix
                            .map(|value| value.to_string())
                            .unwrap_or_else(|| "-".to_string())
                    );
                }
            }
            0
        }
        HerdCommand::Mark { pane_id } => {
            registry.set_herded(&pane_id, true);
            if let Err(err) = registry.save_to_path(state_path) {
                eprintln!("failed to save herd state: {err}");
                return 1;
            }
            println!("marked {} as herded", pane_id);
            0
        }
        HerdCommand::Unmark { pane_id } => {
            registry.set_herded(&pane_id, false);
            if let Err(err) = registry.save_to_path(state_path) {
                eprintln!("failed to save herd state: {err}");
                return 1;
            }
            println!("unmarked {} as herded", pane_id);
            0
        }
    }
}
