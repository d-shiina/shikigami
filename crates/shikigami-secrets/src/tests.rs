use super::*;
use serde_json::json;

fn vault(dir: &Path) -> Vault {
    Vault::with_key_store(dir, Box::new(MemoryKeyStore::default()))
}

fn reference(name: &str, field: SecretField) -> SecretRef {
    SecretRef {
        secret: name.into(),
        field,
    }
}

fn input(name: &str) -> SecretInput {
    SecretInput {
        name: name.into(),
        username: Some("demo".into()),
        password: Some("hunter2".into()),
        sites: Some(vec!["http://127.0.0.1:8787/login".into()]),
        ..SecretInput::default()
    }
}

#[test]
fn values_are_encrypted_at_rest() {
    let dir = tempfile::tempdir().unwrap();
    let v = vault(dir.path());
    v.set(input("受注システム")).unwrap();
    let raw = std::fs::read_to_string(dir.path().join("secrets/vault.json")).unwrap();
    assert!(raw.contains("受注システム"));
    assert!(raw.contains("http://127.0.0.1:8787"));
    assert!(!raw.contains("hunter2"));
    assert!(!raw.contains("demo"));

    let r = v
        .resolve(&reference("受注システム", SecretField::Password))
        .unwrap();
    assert_eq!(r.value, "hunter2");
    assert_eq!(r.sites, ["http://127.0.0.1:8787"]);
}

#[test]
fn updates_keep_values_that_are_not_given() {
    let dir = tempfile::tempdir().unwrap();
    let v = vault(dir.path());
    v.set(input("a")).unwrap();
    v.set(SecretInput {
        name: "a".into(),
        password: Some("new".into()),
        ..SecretInput::default()
    })
    .unwrap();
    let list = v.list().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].username, "demo");
    assert_eq!(
        list[0].fields,
        [SecretField::Username, SecretField::Password]
    );
    assert_eq!(
        v.resolve(&reference("a", SecretField::Password))
            .unwrap()
            .value,
        "new"
    );
    let summaries = v.summaries().unwrap();
    assert_eq!(summaries[0].name, "a");
    assert!(!serde_json::to_string(&summaries).unwrap().contains("demo"));
}

#[test]
fn missing_secrets_and_fields_say_how_to_fix() {
    let dir = tempfile::tempdir().unwrap();
    let v = vault(dir.path());
    let e = v
        .resolve(&reference("nope", SecretField::Password))
        .unwrap_err();
    assert_eq!(e.code, "SECRET_NOT_FOUND");
    assert!(e.hint.unwrap().contains("Studio"));
    v.set(input("a")).unwrap();
    let e = v.resolve(&reference("a", SecretField::Totp)).unwrap_err();
    assert_eq!(e.code, "SECRET_FIELD_EMPTY");
    assert_eq!(v.remove("nope").unwrap_err().code, "SECRET_NOT_FOUND");
    v.remove("a").unwrap();
    assert!(v.list().unwrap().is_empty());
}

#[test]
fn another_key_cannot_read_the_vault() {
    let dir = tempfile::tempdir().unwrap();
    vault(dir.path()).set(input("a")).unwrap();
    // Same folder, other user / PC: no key.
    let e = vault(dir.path())
        .resolve(&reference("a", SecretField::Password))
        .unwrap_err();
    assert_eq!(e.code, "SECRET_KEY_MISSING");
}

#[test]
fn totp_codes_are_generated() {
    let dir = tempfile::tempdir().unwrap();
    let v = vault(dir.path());
    let mut i = input("mfa");
    i.totp = Some("JBSWY3DPEHPK3PXP".into());
    v.set(i).unwrap();
    let code = v
        .resolve(&reference("mfa", SecretField::Totp))
        .unwrap()
        .value;
    assert_eq!(code.len(), 6);
    assert!(code.chars().all(|c| c.is_ascii_digit()));
    let mut bad = input("bad");
    bad.totp = Some("not a key!".into());
    assert_eq!(v.set(bad).unwrap_err().code, "INVALID_TOTP");
}

#[test]
fn sessions_round_trip_encrypted() {
    let dir = tempfile::tempdir().unwrap();
    let v = vault(dir.path());
    assert_eq!(v.load_session("受注").unwrap(), None);
    let state = json!({ "cookies": [{ "name": "sid", "value": "s3cr3t" }] });
    v.save_session("受注", &state).unwrap();
    assert_eq!(v.load_session("受注").unwrap(), Some(state));
    let files: Vec<_> = std::fs::read_dir(dir.path().join("secrets/sessions"))
        .unwrap()
        .collect();
    assert_eq!(files.len(), 1);
    let raw = std::fs::read_to_string(files[0].as_ref().unwrap().path()).unwrap();
    assert!(!raw.contains("s3cr3t"));
    assert!(v.remove_session("受注").unwrap());
    assert_eq!(v.load_session("受注").unwrap(), None);
}

#[test]
fn sites_are_normalized_to_origins() {
    assert_eq!(
        normalize_site("HTTPS://Example.com:443/login?x=1").unwrap(),
        "https://example.com"
    );
    assert_eq!(
        normalize_site("http://127.0.0.1:8787/").unwrap(),
        "http://127.0.0.1:8787"
    );
    assert!(normalize_site("example.com").is_err());
    assert!(normalize_site("file:///c:/x").is_err());
    let dir = tempfile::tempdir().unwrap();
    let mut i = input("a");
    i.sites = Some(vec!["ftp://x".into()]);
    assert_eq!(vault(dir.path()).set(i).unwrap_err().code, "INVALID_SITE");
}

/// One key store seen by several vaults (as Studio, the CLI and the MCP
/// server share Windows Credential Manager).
struct Shared(std::sync::Arc<MemoryKeyStore>);

impl KeyStore for Shared {
    fn load(&self, vault_id: &str) -> Result<Option<Key>, SecretError> {
        self.0.load(vault_id)
    }
    fn store(&self, vault_id: &str, key: &Key) -> Result<(), SecretError> {
        self.0.store(vault_id, key)
    }
    fn remove(&self, vault_id: &str) -> Result<(), SecretError> {
        self.0.remove(vault_id)
    }
    fn describe(&self) -> String {
        "shared".into()
    }
}

#[test]
fn concurrent_clients_do_not_lose_updates() {
    let dir = tempfile::tempdir().unwrap();
    let keys = std::sync::Arc::new(MemoryKeyStore::default());
    std::thread::scope(|scope| {
        for i in 0..8 {
            let keys = keys.clone();
            let root = dir.path();
            scope.spawn(move || {
                // Each client has its own vault, as separate processes do.
                let v = Vault::with_key_store(root, Box::new(Shared(keys)));
                v.set(input(&format!("s{i}"))).unwrap();
            });
        }
    });
    let v = Vault::with_key_store(dir.path(), Box::new(Shared(keys)));
    let list = v.list().unwrap();
    assert_eq!(list.len(), 8);
    for i in 0..8 {
        let r = v
            .resolve(&reference(&format!("s{i}"), SecretField::Password))
            .unwrap();
        assert_eq!(r.value, "hunter2");
    }
}

#[test]
fn a_copied_workspace_can_be_reset_and_registered_again() {
    let dir = tempfile::tempdir().unwrap();
    let original = vault(dir.path());
    original.set(input("a")).unwrap();
    original.save_session("a", &json!({"cookies": []})).unwrap();

    // Same files, another PC / Windows user: the key is not there.
    let copy = vault(dir.path());
    assert!(copy.key_missing().unwrap());
    let err = copy.set(input("b")).unwrap_err();
    assert_eq!(err.code, "SECRET_KEY_MISSING");
    assert!(err.hint.unwrap().contains("secret reset"));
    assert_eq!(copy.summaries().unwrap().len(), 1);

    assert_eq!(copy.reset().unwrap(), 1);
    assert!(!copy.key_missing().unwrap());
    assert!(copy.summaries().unwrap().is_empty());
    assert_eq!(copy.load_session("a").unwrap(), None);
    copy.set(input("b")).unwrap();
    assert_eq!(
        copy.resolve(&reference("b", SecretField::Password))
            .unwrap()
            .value,
        "hunter2"
    );
}
