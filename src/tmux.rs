use crate::domain::{PaneSnapshot, SessionRef};

mod control;
mod multiplexer;
mod parser;
mod system;

pub use multiplexer::{ControlModeMultiplexer, ControlOutputEvent};
pub use system::SystemTmuxAdapter;

const LIST_PANES_DELIM: &str = "__HERD_FIELD__";

pub trait TmuxAdapter {
    fn list_sessions(&self) -> Result<Vec<SessionRef>, String>;
    fn capture_pane(&self, pane_id: &str, lines: usize) -> Result<PaneSnapshot, String>;
    fn pane_height(&self, pane_id: &str) -> Result<usize, String>;
    fn send_keys(&mut self, pane_id: &str, message: &str) -> Result<(), String>;
}

pub fn parse_list_panes_output(output: &str) -> Result<Vec<SessionRef>, String> {
    parser::parse_list_panes_output(output)
}

#[cfg(test)]
mod tests {
    use super::parser::{decode_tmux_escaped_value, parse_control_output_line};
    use super::system::is_tmux_empty_target_error;

    #[test]
    fn parse_output_line_decodes_octal_sequences() {
        let line = "%output %1 hello\\040world\\012next";
        let parsed = parse_control_output_line(line).expect("line should parse");
        assert_eq!(parsed.0, "%1");
        assert_eq!(parsed.1, b"hello world\nnext");
    }

    #[test]
    fn parse_extended_output_line_decodes_value_section() {
        let line = "%extended-output %7 3 0 : \\033[31mred\\033[0m";
        let parsed = parse_control_output_line(line).expect("line should parse");
        assert_eq!(parsed.0, "%7");
        assert_eq!(parsed.1, b"\x1b[31mred\x1b[0m");
    }

    #[test]
    fn decode_non_octal_backslashes_as_literal() {
        let decoded = decode_tmux_escaped_value("path\\\\name\\x");
        assert_eq!(decoded, b"path\\\\name\\x");
    }

    #[test]
    fn detects_empty_target_errors_but_not_server_down() {
        assert!(is_tmux_empty_target_error(
            "tmux [\"list-panes\"] failed: no current target"
        ));
        assert!(is_tmux_empty_target_error(
            "tmux [\"list-panes\"] failed: can't find session: alpha"
        ));
        assert!(!is_tmux_empty_target_error(
            "tmux [\"list-panes\"] failed: no server running on /tmp/tmux-501/default"
        ));
    }
}
