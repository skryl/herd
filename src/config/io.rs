use std::fs;
use std::path::{Path, PathBuf};

use crate::rules::load_rule_file;

use super::{
    AppConfig, PartialAppConfig, default_herd_mode_rule_file, uses_legacy_markdown_rule_file,
};

impl AppConfig {
    pub fn load_from_path(path: &Path) -> Result<Self, String> {
        if !path.exists() {
            let defaults = Self::default();
            defaults.save_to_path(path)?;
            return Ok(defaults);
        }
        let raw = fs::read_to_string(path)
            .map_err(|err| format!("failed reading config {:?}: {err}", path))?;
        let partial: PartialAppConfig = serde_json::from_str(&raw)
            .map_err(|err| format!("failed parsing config {:?}: {err}", path))?;
        let mut config = Self::default().merged(partial);
        let migrated_from_markdown = config
            .herd_modes
            .iter()
            .any(|mode| uses_legacy_markdown_rule_file(&mode.rule_file));
        if migrated_from_markdown {
            config.herd_modes = super::default_herd_modes();
        }
        config.save_to_path(path)?;
        Ok(config)
    }

    pub fn save_to_path(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("failed creating config directory {:?}: {err}", parent))?;
        }
        let raw = serde_json::to_string_pretty(self)
            .map_err(|err| format!("failed serializing config: {err}"))?;
        fs::write(path, raw).map_err(|err| format!("failed writing config {:?}: {err}", path))?;
        self.ensure_herd_mode_files(path)?;
        self.normalize_herd_mode_rule_files(path)?;
        Ok(())
    }

    fn ensure_herd_mode_files(&self, settings_path: &Path) -> Result<(), String> {
        let root = settings_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        for mode in &self.herd_modes {
            let prompt_path = root.join(&mode.rule_file);
            if let Some(parent) = prompt_path.parent() {
                fs::create_dir_all(parent).map_err(|err| {
                    format!("failed creating herd mode directory {:?}: {err}", parent)
                })?;
            }
            if !prompt_path.exists() {
                fs::write(&prompt_path, default_herd_mode_rule_file(&mode.name)).map_err(
                    |err| format!("failed writing herd mode prompt {:?}: {err}", prompt_path),
                )?;
            }
        }
        Ok(())
    }

    fn normalize_herd_mode_rule_files(&self, settings_path: &Path) -> Result<(), String> {
        let root = settings_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        for mode in &self.herd_modes {
            let rule_path = root.join(&mode.rule_file);
            if !rule_path.exists() {
                continue;
            }
            let parsed = load_rule_file(&rule_path)?;
            let normalized = serde_json::to_string_pretty(&parsed)
                .map_err(|err| format!("failed serializing rule file {:?}: {err}", rule_path))?;
            fs::write(&rule_path, normalized)
                .map_err(|err| format!("failed normalizing rule file {:?}: {err}", rule_path))?;
        }
        Ok(())
    }
}
