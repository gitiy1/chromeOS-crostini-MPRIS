use std::time::{Duration, SystemTime, UNIX_EPOCH};

use mpris::{PlaybackStatus as MprisPlaybackStatus, Player, PlayerFinder};
use tokio::time;
use tracing::warn;

use crate::{
    model::{
        BridgeState, ControlAction, PlaybackStatus, PlayerDescriptor, PlayerSelection,
        PlayerSelectionMode,
    },
    state::{SharedSelection, SharedState},
};

pub async fn run_poll_loop(shared: SharedState, selection: SharedSelection, interval: Duration) {
    let mut ticker = time::interval(interval);
    loop {
        ticker.tick().await;
        let current_selection = selection.snapshot().await;
        match collect_state(&current_selection) {
            Ok(state) => shared.update(state).await,
            Err(err) => {
                warn!("failed to collect player state: {err}");
                let mut empty = BridgeState {
                    selection_mode: current_selection.mode,
                    selected_player_bus_name: current_selection.selected_player_bus_name,
                    ..BridgeState::default()
                };
                empty.updated_at_ms = now_ms();
                shared.update(empty).await;
            }
        }
    }
}

pub async fn perform_action(
    action: ControlAction,
    selection: &SharedSelection,
) -> anyhow::Result<()> {
    let current_selection = selection.snapshot().await;
    let player = resolve_active_player(&current_selection)?;
    match action {
        ControlAction::Play => player.play()?,
        ControlAction::Pause => player.pause()?,
        ControlAction::PlayPause => player.play_pause()?,
        ControlAction::Next => player.next()?,
        ControlAction::Previous => player.previous()?,
        ControlAction::Stop => player.stop()?,
        ControlAction::SeekTo(position_us) => seek_to_position(&player, position_us)?,
        ControlAction::SeekBy(offset_us) => player.seek(offset_us)?,
    }
    Ok(())
}

fn collect_state(selection: &PlayerSelection) -> anyhow::Result<BridgeState> {
    let finder = PlayerFinder::new()?;
    let mut players = finder.find_all()?;

    let available_players = players
        .iter()
        .map(|player| PlayerDescriptor {
            bus_name: player.bus_name().to_string(),
            player_name: player.identity().to_string(),
        })
        .collect::<Vec<_>>();

    if let Some(player) = pick_player(&finder, &mut players, selection) {
        let mut state = player_to_state(&player);
        state.available_players = available_players;
        state.active_player_bus_name = Some(player.bus_name().to_string());
        state.selection_mode = selection.mode;
        state.selected_player_bus_name = selection.selected_player_bus_name.clone();
        return Ok(state);
    }

    Ok(BridgeState {
        available_players,
        selection_mode: selection.mode,
        selected_player_bus_name: selection.selected_player_bus_name.clone(),
        updated_at_ms: now_ms(),
        ..BridgeState::default()
    })
}

fn resolve_active_player(selection: &PlayerSelection) -> anyhow::Result<Player> {
    let finder = PlayerFinder::new()?;
    let mut players = finder.find_all()?;

    pick_player(&finder, &mut players, selection)
        .ok_or_else(|| anyhow::anyhow!("no mpris players found for current selection"))
}

fn pick_player(
    finder: &PlayerFinder,
    players: &mut Vec<Player>,
    selection: &PlayerSelection,
) -> Option<Player> {
    if selection.mode == PlayerSelectionMode::Manual {
        if let Some(bus_name) = selection.selected_player_bus_name.as_deref() {
            if let Some(index) = players
                .iter()
                .position(|player| player.bus_name() == bus_name)
            {
                return Some(players.swap_remove(index));
            }
        }
    }

    if let Ok(active) = finder.find_active() {
        return Some(active);
    }

    players.pop()
}

fn player_to_state(player: &Player) -> BridgeState {
    let metadata = player.get_metadata().ok();

    let art_url = metadata
        .as_ref()
        .and_then(|m| m.art_url())
        .map(|url| url.to_string());

    let artist = metadata
        .as_ref()
        .and_then(|m| m.artists())
        .unwrap_or_default()
        .into_iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();

    let duration_us = metadata.as_ref().and_then(|m| m.length_in_microseconds());
    let title = metadata
        .as_ref()
        .and_then(|m| m.title())
        .map(ToString::to_string);
    let album = metadata
        .as_ref()
        .and_then(|m| m.album_name())
        .map(ToString::to_string);

    let position_us = player
        .get_position()
        .map(|dur| dur.as_micros() as u64)
        .unwrap_or_default();

    let status = player
        .get_playback_status()
        .unwrap_or(MprisPlaybackStatus::Stopped);

    BridgeState {
        player_name: player.identity().to_string(),
        playback_status: map_status(status),
        title,
        artist,
        album,
        art_url,
        duration_us,
        position_us,
        playback_rate: if status == MprisPlaybackStatus::Playing {
            1.0
        } else {
            0.0
        },
        can_go_next: player.can_go_next().unwrap_or(false),
        can_go_previous: player.can_go_previous().unwrap_or(false),
        can_play: player.can_play().unwrap_or(false),
        can_pause: player.can_pause().unwrap_or(false),
        can_seek: player.can_seek().unwrap_or(false),
        updated_at_ms: now_ms(),
        ..BridgeState::default()
    }
}

fn map_status(status: MprisPlaybackStatus) -> PlaybackStatus {
    match status {
        MprisPlaybackStatus::Playing => PlaybackStatus::Playing,
        MprisPlaybackStatus::Paused => PlaybackStatus::Paused,
        MprisPlaybackStatus::Stopped => PlaybackStatus::Stopped,
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn seek_to_position(player: &Player, position_us: u64) -> anyhow::Result<()> {
    let metadata = player.get_metadata().ok();
    let track_id = metadata
        .and_then(|m| m.track_id())
        .ok_or_else(|| anyhow::anyhow!("track_id not available for seek"))?;

    player.set_position_in_microseconds(track_id, position_us)?;
    Ok(())
}
