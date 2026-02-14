use std::time::{Duration, SystemTime, UNIX_EPOCH};

use mpris::{PlaybackStatus as MprisPlaybackStatus, Player, PlayerFinder};
use tokio::time;
use tracing::warn;

use crate::{
    model::{BridgeState, ControlAction, PlaybackStatus},
    state::SharedState,
};

pub async fn run_poll_loop(shared: SharedState, interval: Duration) {
    let mut ticker = time::interval(interval);
    loop {
        ticker.tick().await;
        match collect_state() {
            Ok(state) => shared.update(state).await,
            Err(err) => {
                warn!("failed to collect player state: {err}");
                let mut empty = BridgeState::default();
                empty.updated_at_ms = now_ms();
                shared.update(empty).await;
            }
        }
    }
}

pub fn perform_action(action: ControlAction) -> anyhow::Result<()> {
    let player = resolve_active_player()?;
    match action {
        ControlAction::Play => player.play()?,
        ControlAction::Pause => player.pause()?,
        ControlAction::PlayPause => player.play_pause()?,
        ControlAction::Next => player.next()?,
        ControlAction::Previous => player.previous()?,
        ControlAction::Stop => player.stop()?,
    }
    Ok(())
}

fn collect_state() -> anyhow::Result<BridgeState> {
    let player = resolve_active_player()?;
    Ok(player_to_state(&player))
}

fn resolve_active_player() -> anyhow::Result<Player> {
    let finder = PlayerFinder::new()?;
    if let Ok(player) = finder.find_active() {
        return Ok(player);
    }

    let players = finder.find_all()?;
    players
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("no mpris players found"))
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
        updated_at_ms: now_ms(),
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
