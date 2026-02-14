use std::sync::Arc;

use tokio::sync::{broadcast, RwLock};

use crate::model::BridgeState;

#[derive(Clone)]
pub struct SharedState {
    inner: Arc<RwLock<BridgeState>>,
    tx: broadcast::Sender<BridgeState>,
}

impl SharedState {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(64);
        Self {
            inner: Arc::new(RwLock::new(BridgeState::default())),
            tx,
        }
    }

    pub async fn update(&self, next: BridgeState) {
        {
            let mut guard = self.inner.write().await;
            *guard = next.clone();
        }
        let _ = self.tx.send(next);
    }

    pub async fn snapshot(&self) -> BridgeState {
        self.inner.read().await.clone()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<BridgeState> {
        self.tx.subscribe()
    }
}
