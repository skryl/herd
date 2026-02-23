use std::collections::{HashMap, HashSet};
use std::sync::mpsc::{self, Receiver, Sender};

use super::control;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ControlOutputEvent {
    pub pane_id: String,
    pub content: String,
    pub captured_at_unix: i64,
}

#[derive(Debug)]
pub struct ControlModeMultiplexer {
    socket_name: Option<String>,
    sender: Sender<ControlOutputEvent>,
    receiver: Receiver<ControlOutputEvent>,
    clients: HashMap<String, control::ControlSessionClient>,
}

impl ControlModeMultiplexer {
    pub fn new(socket_name: Option<String>) -> Self {
        let (sender, receiver) = mpsc::channel();
        Self {
            socket_name,
            sender,
            receiver,
            clients: HashMap::new(),
        }
    }

    pub fn sync_sessions(&mut self, session_names: &HashSet<String>) -> Result<(), String> {
        let exited_sessions = self
            .clients
            .iter_mut()
            .filter_map(|(name, client)| client.is_exited().then_some(name.clone()))
            .collect::<Vec<_>>();
        for session_name in exited_sessions {
            if let Some(client) = self.clients.remove(&session_name) {
                client.stop();
            }
        }

        let stale_sessions = self
            .clients
            .keys()
            .filter(|name| !session_names.contains(*name))
            .cloned()
            .collect::<Vec<_>>();
        for session_name in stale_sessions {
            if let Some(client) = self.clients.remove(&session_name) {
                client.stop();
            }
        }

        for session_name in session_names {
            if self.clients.contains_key(session_name) {
                continue;
            }
            let client = control::spawn_control_session_client(
                self.socket_name.as_deref(),
                session_name,
                self.sender.clone(),
            )?;
            self.clients.insert(session_name.clone(), client);
        }
        Ok(())
    }

    pub fn drain_events(&self) -> Vec<ControlOutputEvent> {
        let mut events = Vec::new();
        while let Ok(event) = self.receiver.try_recv() {
            events.push(event);
        }
        events
    }
}

impl Drop for ControlModeMultiplexer {
    fn drop(&mut self) {
        let clients = std::mem::take(&mut self.clients);
        for (_, client) in clients {
            client.stop();
        }
    }
}
