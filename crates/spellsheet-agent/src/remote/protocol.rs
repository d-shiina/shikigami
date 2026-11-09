//! The agent ↔ management server protocol, version 1 (docs/remote.md).
//!
//! Everything goes from the PC to the server over HTTPS: the agent asks for
//! work when it is free (long polling), reports progress, and the server
//! answers. Each request after enrollment is signed with the worker's
//! Ed25519 key, so the server needs no shared secret and a stolen request
//! cannot be changed or replayed after a few minutes.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use ring::signature::{ED25519, Ed25519KeyPair, KeyPair, UnparsedPublicKey};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use spellsheet_core::{ErrorPayload, FlowId, RunId};
use spellsheet_runtime::{RunEventEnvelope, RunReport};

/// Path prefix of the protocol.
pub const PREFIX: &str = "/v1";
pub const HEADER_WORKER: &str = "x-spellsheet-worker";
pub const HEADER_TIME: &str = "x-spellsheet-time";
pub const HEADER_SIGNATURE: &str = "x-spellsheet-signature";
/// How far a request's time may be from the server's clock.
pub const MAX_SKEW_SECS: i64 = 300;

/// `POST /v1/enroll`: the one-time code from the server, and the public key
/// the worker made for itself (its private key never leaves the PC).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollRequest {
    pub code: String,
    /// Ed25519 public key, base64.
    pub public_key: String,
    /// Windows computer name.
    pub machine: String,
    /// Windows user name.
    pub user: String,
    /// The workspace folder's name (one worker per PC, user and workspace).
    pub workspace: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollResponse {
    pub worker_id: String,
}

/// A flow this worker may run for the server, and its published version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    pub flow_id: FlowId,
    pub name: String,
    /// The published version's `uid`.
    pub version_uid: String,
}

/// `POST /v1/jobs/claim`: the worker is free and asks for a job it can run.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimRequest {
    /// What `policy.json` lets the server start here, published.
    pub flows: Vec<Offer>,
    /// The screen can be used (signed in, not locked); `None`: not known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop: Option<bool>,
    /// How long the server may hold the request open when it has nothing.
    pub wait_secs: u64,
}

/// A job the server hands to one worker.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub flow_id: FlowId,
    /// Run only this published version (`VERSION_MISMATCH` otherwise).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version_uid: Option<String>,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub inputs: Map<String, Value>,
    /// Who asked for it on the server (recorded as `origin.requestedBy`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_by: Option<String>,
    /// The job goes back to the queue unless the worker says it started
    /// within this many seconds, or keeps sending heartbeats.
    pub lease_secs: u64,
}

/// `POST /v1/jobs/{id}/started`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    pub run_id: RunId,
}

/// `POST /v1/jobs/{id}/rejected`: the worker will not run it (not allowed
/// by `policy.json`, not published, another version…).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rejected {
    pub error: ErrorPayload,
}

/// `POST /v1/jobs/{id}/events`: the run's events from `seq` on (secrets
/// already masked). Sent again after a lost connection; the server keeps
/// the first copy of each `seq`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Events {
    pub events: Vec<RunEventEnvelope>,
}

/// Answer to `events` and `heartbeat`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ack {
    /// Someone cancelled the job on the server: stop the run.
    #[serde(default)]
    pub cancel: bool,
}

/// `POST /v1/jobs/{id}/finished`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finished {
    pub report: RunReport,
}

fn sha256_hex(body: &[u8]) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, body);
    digest.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

/// What a worker signs: the request line, its time and its body.
pub fn signed_text(method: &str, path: &str, time: i64, body: &[u8]) -> String {
    format!(
        "spellsheet-v1\n{}\n{path}\n{time}\n{}",
        method.to_ascii_uppercase(),
        sha256_hex(body)
    )
}

/// A header as workers from before the product's rename send it; servers
/// still accept them until every worker is updated.
pub fn legacy_header(name: &str) -> String {
    spellsheet_core::paths::legacy_spelling(name)
}

/// A worker's key pair, from its 32-byte seed.
pub struct WorkerKey(Ed25519KeyPair);

impl WorkerKey {
    pub fn from_seed(seed: &[u8; 32]) -> Self {
        // A seed of the right length always makes a key pair.
        #[allow(clippy::expect_used)]
        Self(Ed25519KeyPair::from_seed_unchecked(seed).expect("32-byte Ed25519 seed"))
    }

    pub fn public_key(&self) -> String {
        B64.encode(self.0.public_key().as_ref())
    }

    /// The signature headers' value for a request.
    pub fn sign(&self, method: &str, path: &str, time: i64, body: &[u8]) -> String {
        B64.encode(
            self.0
                .sign(signed_text(method, path, time, body).as_bytes()),
        )
    }
}

/// Checks a request's signature against a worker's public key (base64).
pub fn verify(
    public_key: &str,
    signature: &str,
    method: &str,
    path: &str,
    time: i64,
    body: &[u8],
) -> bool {
    let (Ok(key), Ok(sig)) = (B64.decode(public_key), B64.decode(signature)) else {
        return false;
    };
    let text = signed_text(method, path, time, body);
    // Workers from before the rename sign the same text under the old name.
    [spellsheet_core::paths::legacy_spelling(&text), text]
        .iter()
        .any(|text| {
            UnparsedPublicKey::new(&ED25519, &key)
                .verify(text.as_bytes(), &sig)
                .is_ok()
        })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn workers_from_before_the_rename_are_still_accepted() {
        let seed = [9; 32];
        let pair = Ed25519KeyPair::from_seed_unchecked(&seed).unwrap();
        let old_text =
            spellsheet_core::paths::legacy_spelling(&signed_text("POST", "/v1/x", 5, b"{}"));
        let sig = B64.encode(pair.sign(old_text.as_bytes()));
        let public = WorkerKey::from_seed(&seed).public_key();
        assert!(verify(&public, &sig, "POST", "/v1/x", 5, b"{}"));
        assert_ne!(legacy_header(HEADER_TIME), HEADER_TIME);
    }

    #[test]
    fn a_signature_covers_the_method_path_time_and_body() {
        let key = WorkerKey::from_seed(&[7; 32]);
        let public = key.public_key();
        let sig = key.sign("post", "/v1/jobs/claim", 1000, b"{}");
        assert!(verify(&public, &sig, "POST", "/v1/jobs/claim", 1000, b"{}"));
        assert!(!verify(
            &public,
            &sig,
            "POST",
            "/v1/jobs/claim",
            1001,
            b"{}"
        ));
        assert!(!verify(
            &public,
            &sig,
            "POST",
            "/v1/jobs/x/finished",
            1000,
            b"{}"
        ));
        assert!(!verify(
            &public,
            &sig,
            "POST",
            "/v1/jobs/claim",
            1000,
            b"{ }"
        ));
        let other = WorkerKey::from_seed(&[8; 32]).public_key();
        assert!(!verify(&other, &sig, "POST", "/v1/jobs/claim", 1000, b"{}"));
    }
}
