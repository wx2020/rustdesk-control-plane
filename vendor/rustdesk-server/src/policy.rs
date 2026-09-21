use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Arc, time::{Duration, Instant}};
use hbb_common::tokio::{sync::Mutex, time::sleep};

#[derive(Clone)]
pub struct PolicyClient {
    client: Option<reqwest::Client>,
    check_url: String,
    event_url: String,
    token: Option<String>,
    enforce: bool,
    cache_ttl: Duration,
    circuit_open_for: Duration,
    state: Arc<Mutex<PolicyState>>,
}

struct CacheEntry { decision: PolicyDecision, expires_at: Instant }
struct PolicyState { cache: HashMap<String, CacheEntry>, failures: u8, circuit_until: Option<Instant> }

#[derive(Clone)]
pub struct PolicyDecision { pub allowed: bool, pub force_relay: bool }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckRequest<'a> {
    target_id: &'a str,
    action: &'a str,
    source_ip: &'a str,
}

#[derive(Debug, Deserialize)]
struct CheckResponse {
    allowed: bool,
    #[serde(default, rename = "forceRelay")]
    force_relay: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EventRequest {
    event_id: String,
    event_type: String,
    target_id: String,
    session_key: Option<String>,
    source_ip: String,
    details: String,
}

impl PolicyClient {
    pub fn from_env() -> Self {
        let base = crate::common::get_arg("CONTROL_PLANE_URL")
            .trim_end_matches('/')
            .to_owned();
        let token = crate::common::get_arg("CONTROL_PLANE_TOKEN");
        let enforce = matches!(
            crate::common::get_arg("CONTROL_PLANE_ENFORCE")
                .to_ascii_uppercase()
                .as_str(),
            "Y" | "YES" | "TRUE" | "1"
        );
        let cache_ttl = Duration::from_secs(crate::common::get_arg("CONTROL_PLANE_CACHE_TTL").parse().unwrap_or(5));
        let circuit_open_for = Duration::from_secs(crate::common::get_arg("CONTROL_PLANE_CIRCUIT_OPEN_FOR").parse().unwrap_or(15));
        let client = if base.is_empty() {
            None
        } else {
            reqwest::Client::builder()
                .timeout(Duration::from_millis(800))
                .build()
                .ok()
        };
        if !base.is_empty() {
            log::info!(
                "control plane policy: enabled={}, fail_open={}",
                client.is_some(),
                !enforce
            );
        }
        Self {
            client,
            check_url: format!("{base}/api/policy/check"),
            event_url: format!("{base}/api/policy/events"),
            token: (!token.is_empty()).then_some(token),
            enforce,
            cache_ttl,
            circuit_open_for,
            state: Arc::new(Mutex::new(PolicyState { cache: HashMap::new(), failures: 0, circuit_until: None })),
        }
    }

    pub async fn allow(&self, target_id: &str, action: &str, source_ip: &str) -> bool {
        self.decision(target_id, action, source_ip).await.allowed
    }

    pub async fn decision(&self, target_id: &str, action: &str, source_ip: &str) -> PolicyDecision {
        let Some(client) = &self.client else {
            return PolicyDecision { allowed: true, force_relay: false };
        };
        let cache_key = format!("{target_id}:{action}");
        {
            let mut state = self.state.lock().await;
            if let Some(entry) = state.cache.get(&cache_key) {
                if entry.expires_at > Instant::now() { return entry.decision.clone(); }
            }
            state.cache.retain(|_, entry| entry.expires_at > Instant::now());
            if matches!(state.circuit_until, Some(until) if until > Instant::now()) {
                log::warn!("control plane circuit open for {}", cache_key);
                return PolicyDecision { allowed: !self.enforce, force_relay: false };
            }
        }
        let request = client.post(&self.check_url).json(&CheckRequest {
            target_id,
            action,
            source_ip,
        });
        let request = if let Some(token) = &self.token {
            request.bearer_auth(token)
        } else {
            request
        };
        let result = match request.send().await {
            Ok(response) if response.status().is_success() => response.json::<CheckResponse>().await.map(|decision| PolicyDecision { allowed: decision.allowed, force_relay: decision.force_relay }).map_err(|error| error.to_string()),
            Ok(response) => Err(format!("HTTP {}", response.status())),
            Err(error) => Err(error.to_string()),
        };
        match result {
            Ok(decision) => {
                let mut state = self.state.lock().await;
                state.failures = 0;
                state.circuit_until = None;
                state.cache.insert(cache_key, CacheEntry { decision: decision.clone(), expires_at: Instant::now() + self.cache_ttl });
                decision
            }
            Err(reason) => self.failure(reason).await,
        }
    }

    pub fn event(&self, event_type: &str, target_id: &str, source_ip: &str, details: &str) {
        self.event_with_session(event_type, target_id, source_ip, details, None);
    }

    pub fn event_with_session(
        &self,
        event_type: &str,
        target_id: &str,
        source_ip: &str,
        details: &str,
        session_key: Option<&str>,
    ) {
        let Some(client) = self.client.clone() else {
            return;
        };
        let url = self.event_url.clone();
        let token = self.token.clone();
        let request = EventRequest {
            event_id: session_key
                .map(|key| format!("{key}:{event_type}"))
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            event_type: event_type.to_owned(),
            target_id: target_id.to_owned(),
            session_key: session_key.map(str::to_owned),
            source_ip: source_ip.to_owned(),
            details: details.to_owned(),
        };
        tokio::spawn(async move {
            for attempt in 1..=3 {
                let mut call = client.post(&url).json(&request);
                if let Some(token) = &token { call = call.bearer_auth(token); }
                if let Ok(response) = call.send().await {
                    if response.status().is_success() { return; }
                    log::debug!("control plane event attempt {} failed: HTTP {}", attempt, response.status());
                }
                if attempt < 3 { sleep(Duration::from_millis(100 * attempt)).await; }
            }
            log::warn!("control plane event dropped after retries: {}", request.event_id);
        });
    }

    async fn failure(&self, reason: String) -> PolicyDecision {
        log::warn!("control plane policy request failed: {}", reason);
        let mut state = self.state.lock().await;
        state.failures = state.failures.saturating_add(1);
        if state.failures >= 3 {
            state.circuit_until = Some(Instant::now() + self.circuit_open_for);
            state.failures = 0;
        }
        PolicyDecision { allowed: !self.enforce, force_relay: false }
    }
}
