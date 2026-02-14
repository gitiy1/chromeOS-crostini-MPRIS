use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeState {
    pub player_name: String,
    pub playback_status: PlaybackStatus,
    pub title: Option<String>,
    pub artist: Vec<String>,
    pub album: Option<String>,
    pub art_url: Option<String>,
    pub duration_us: Option<u64>,
    pub position_us: u64,
    pub playback_rate: f64,
    pub can_go_next: bool,
    pub can_go_previous: bool,
    pub can_play: bool,
    pub can_pause: bool,
    pub can_seek: bool,
    pub active_player_bus_name: Option<String>,
    pub selection_mode: PlayerSelectionMode,
    pub selected_player_bus_name: Option<String>,
    pub available_players: Vec<PlayerDescriptor>,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerDescriptor {
    pub bus_name: String,
    pub player_name: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PlayerSelectionMode {
    Auto,
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSelection {
    pub mode: PlayerSelectionMode,
    pub selected_player_bus_name: Option<String>,
}

impl Default for PlayerSelection {
    fn default() -> Self {
        Self {
            mode: PlayerSelectionMode::Auto,
            selected_player_bus_name: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackStatus {
    Playing,
    Paused,
    Stopped,
    None,
}

impl Default for BridgeState {
    fn default() -> Self {
        Self {
            player_name: "none".to_string(),
            playback_status: PlaybackStatus::None,
            title: None,
            artist: Vec::new(),
            album: None,
            art_url: None,
            duration_us: None,
            position_us: 0,
            playback_rate: 1.0,
            can_go_next: false,
            can_go_previous: false,
            can_play: false,
            can_pause: false,
            can_seek: false,
            active_player_bus_name: None,
            selection_mode: PlayerSelectionMode::Auto,
            selected_player_bus_name: None,
            available_players: Vec::new(),
            updated_at_ms: 0,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub enum ControlAction {
    Play,
    Pause,
    PlayPause,
    Next,
    Previous,
    Stop,
    SeekTo(u64),
    SeekBy(i64),
}
