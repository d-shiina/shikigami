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
fn mask_replaces_registered_passwords() {
    let dir = tempfile::tempdir().unwrap();
    let v = vault(dir.path());
    assert_eq!(v.mask("no secrets yet"), "no secrets yet");
    v.set(input("受注システム")).unwrap();
    assert_eq!(
        v.mask("textbox \"パスワード\" value=hunter2 / demo"),
        "textbox \"パスワード\" value=*** / demo"
    );
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
    assert!(e.hint.unwrap().contains("Writer"));
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
fn oauth_tokens_are_kept_encrypted_with_the_secret() {
    let dir = tempfile::tempdir().unwrap();
    let v = vault(dir.path());
    v.set(input("Box")).unwrap();
    assert_eq!(v.load_oauth_tokens("Box").unwrap(), None);
    assert!(!v.summaries().unwrap()[0].signed_in);
    let tokens = json!({ "accessToken": "at-s3cr3t", "refreshToken": "rt-s3cr3t" });
    v.save_oauth_tokens("Box", &tokens).unwrap();
    assert_eq!(v.load_oauth_tokens("Box").unwrap(), Some(tokens));
    let raw = std::fs::read_dir(dir.path().join("secrets/oauth"))
        .unwrap()
        .map(|f| std::fs::read_to_string(f.unwrap().path()).unwrap())
        .collect::<String>();
    assert!(!raw.contains("s3cr3t"));
    assert!(v.summaries().unwrap()[0].signed_in);
    assert!(v.list().unwrap()[0].signed_in);
    // The refresh lock is per secret and released on drop.
    drop(v.lock_oauth_tokens("Box").unwrap());
    drop(v.lock_oauth_tokens("Box").unwrap());
    // A session file of the same name is a different thing.
    assert_eq!(v.load_session("Box").unwrap(), None);

    // The token is only for http.request, which reads it from the store.
    let err = v
        .resolve(&reference("Box", SecretField::AccessToken))
        .unwrap_err();
    assert_eq!(err.code, "SECRET_FIELD_NOT_ALLOWED");

    // Signing out forgets them; so does removing the secret.
    assert!(v.remove_session("Box").unwrap());
    assert_eq!(v.load_oauth_tokens("Box").unwrap(), None);
    assert!(!v.remove_session("Box").unwrap());
    v.save_oauth_tokens("Box", &json!({ "accessToken": "x" }))
        .unwrap();
    v.remove("Box").unwrap();
    assert_eq!(v.load_oauth_tokens("Box").unwrap(), None);
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
    assert_eq!(
        normalize_site(" app:Billing.EXE ").unwrap(),
        "app:billing.exe"
    );
    assert!(normalize_site("app:").is_err());
    assert_eq!(normalize_site("plugin:Kintone").unwrap(), "plugin:kintone");
    assert!(normalize_site("plugin:").is_err());
    assert!(normalize_site(r"app:C:\x\a.exe").is_err());
    assert!(normalize_site("example.com").is_err());
    assert!(normalize_site("file:///c:/x").is_err());
    assert_eq!(
        normalize_site(r"db:DB01\SQLEXPRESS").unwrap(),
        r"db:db01\sqlexpress"
    );
    assert_eq!(
        normalize_site("smtp:Mail.Example.co.jp").unwrap(),
        "smtp:mail.example.co.jp"
    );
    assert!(normalize_site("db:").is_err() && normalize_site("smtp://x").is_err());
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

fn ask(name: &str, sites: &[&str], fields: &[SecretField]) -> NewSecretRequest {
    NewSecretRequest {
        name: name.into(),
        kind: None,
        sites: sites.iter().map(|s| (*s).to_owned()).collect(),
        fields: fields.to_vec(),
        reason: Some("ログイン画面が出たため".into()),
    }
}

#[test]
fn requests_are_listed_until_a_registration_answers_them() {
    let dir = tempfile::tempdir().unwrap();
    let v = vault(dir.path());
    let request = v
        .request(ask("Google", &["https://accounts.google.com/signin"], &[]))
        .unwrap();
    assert_eq!(request.sites, ["https://accounts.google.com"]);
    assert_eq!(
        request.fields,
        [SecretField::Username, SecretField::Password]
    );

    let pending = v.requests().unwrap();
    assert_eq!(pending.len(), 1);
    assert!(!pending[0].missing.registered);
    assert!(v.is_requested("Google").unwrap());

    // Registered without the site: still asked for.
    v.set(SecretInput {
        name: "Google".into(),
        username: Some("me".into()),
        password: Some("hunter2".into()),
        ..SecretInput::default()
    })
    .unwrap();
    let pending = v.requests().unwrap();
    assert_eq!(pending[0].missing.sites, ["https://accounts.google.com"]);
    assert!(pending[0].missing.fields.is_empty());

    v.set(SecretInput {
        name: "Google".into(),
        sites: Some(vec!["https://accounts.google.com".into()]),
        ..SecretInput::default()
    })
    .unwrap();
    assert!(v.requests().unwrap().is_empty());
    let raw = std::fs::read_to_string(dir.path().join("secrets/requests.json")).unwrap();
    assert!(!raw.contains("Google"));
}

#[test]
fn requests_merge_and_can_be_dismissed() {
    let dir = tempfile::tempdir().unwrap();
    let v = vault(dir.path());
    v.request(ask(
        "社内",
        &["https://a.example"],
        &[SecretField::Password],
    ))
    .unwrap();
    let merged = v
        .request(NewSecretRequest {
            reason: None,
            ..ask(
                "社内",
                &["https://b.example", "https://a.example"],
                &[SecretField::Totp],
            )
        })
        .unwrap();
    assert_eq!(merged.sites, ["https://a.example", "https://b.example"]);
    assert_eq!(merged.fields, [SecretField::Password, SecretField::Totp]);
    assert_eq!(merged.reason, "ログイン画面が出たため");
    assert_eq!(v.requests().unwrap().len(), 1);

    assert!(v.dismiss_request("社内").unwrap());
    assert!(!v.dismiss_request("社内").unwrap());
    assert!(!v.is_requested("社内").unwrap());
}

#[test]
fn requests_hold_no_values_and_check_their_input() {
    let dir = tempfile::tempdir().unwrap();
    let v = vault(dir.path());
    assert_eq!(
        v.request(ask("{{ x }}", &[], &[])).unwrap_err().code,
        "INVALID_SECRET_NAME"
    );
    assert_eq!(
        v.request(ask("x", &["javascript:alert(1)"], &[]))
            .unwrap_err()
            .code,
        "INVALID_SITE"
    );
    let long = v
        .request(NewSecretRequest {
            reason: Some(format!("a\nb{}", "c".repeat(400))),
            ..ask("x", &[], &[])
        })
        .unwrap();
    assert!(long.reason.starts_with("a b"));
    assert_eq!(long.reason.chars().count(), 300);
}

#[test]
fn missing_secrets_name_themselves() {
    let dir = tempfile::tempdir().unwrap();
    let v = vault(dir.path());
    let e = v
        .resolve(&reference("Google", SecretField::Password))
        .unwrap_err();
    assert_eq!(e.code, "SECRET_NOT_FOUND");
    assert_eq!(e.details().unwrap()["secret"], "Google");
}

#[test]
fn tidying_keeps_requests_merged_with_more_than_is_registered() {
    let dir = tempfile::tempdir().unwrap();
    let v = vault(dir.path());
    v.set(input("社内")).unwrap();
    // One call asks for what is registered, another for one more site.
    v.request(ask("社内", &["http://127.0.0.1:8787"], &[]))
        .unwrap();
    v.request(ask("社内", &["https://b.example"], &[])).unwrap();
    v.tidy_requests().unwrap();
    assert_eq!(
        v.requests().unwrap()[0].missing.sites,
        ["https://b.example"]
    );
}

#[test]
fn empty_fields_name_the_field() {
    let dir = tempfile::tempdir().unwrap();
    let v = vault(dir.path());
    v.set(input("社内")).unwrap();
    let e = v
        .resolve(&reference("社内", SecretField::Totp))
        .unwrap_err();
    assert_eq!(e.code, "SECRET_FIELD_EMPTY");
    assert_eq!(e.details().unwrap()["field"], "totp");
}

#[test]
fn kinds_name_what_a_secret_holds() {
    let dir = tempfile::tempdir().unwrap();
    let v = vault(dir.path());
    v.set(input("受注システム")).unwrap();
    let key = v
        .set(SecretInput {
            name: "受注 API".into(),
            kind: Some(SecretKind::ApiKey),
            password: Some("sk-live-1234".into()),
            sites: Some(vec!["https://api.example.com".into()]),
            ..SecretInput::default()
        })
        .unwrap();
    assert_eq!(key.kind, SecretKind::ApiKey);
    assert_eq!(key.fields, [SecretField::Password]);
    let raw = std::fs::read_to_string(dir.path().join("secrets/vault.json")).unwrap();
    let stored: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(stored["entries"][1]["kind"], "apiKey");
    assert!(!raw.contains("sk-live"));

    let kinds: Vec<_> = v.summaries().unwrap().into_iter().map(|s| s.kind).collect();
    assert_eq!(kinds, [SecretKind::Login, SecretKind::ApiKey]);
    // An update without a kind keeps it.
    let kept = v
        .set(SecretInput {
            name: "受注 API".into(),
            description: Some("本番".into()),
            ..SecretInput::default()
        })
        .unwrap();
    assert_eq!(kept.kind, SecretKind::ApiKey);
    // A kind without a user name drops one left from before.
    let changed = v
        .set(SecretInput {
            kind: Some(SecretKind::ApiKey),
            ..input("受注システム")
        })
        .unwrap();
    assert_eq!(changed.username, "");
    assert_eq!(changed.fields, [SecretField::Password]);
    // The value is used exactly as before.
    assert_eq!(
        v.resolve(&reference("受注 API", SecretField::Password))
            .unwrap()
            .value,
        "sk-live-1234"
    );
}

#[test]
fn entries_from_before_kinds_are_read() {
    let dir = tempfile::tempdir().unwrap();
    let v = vault(dir.path());
    v.set(input("Box")).unwrap();
    v.set(input("社内")).unwrap();
    // Remove the kinds, as in a vault written by an older version.
    let path = dir.path().join("secrets/vault.json");
    let mut stored: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    for entry in stored["entries"].as_array_mut().unwrap() {
        entry.as_object_mut().unwrap().remove("kind").unwrap();
    }
    std::fs::write(&path, stored.to_string()).unwrap();
    v.save_oauth_tokens("Box", &json!({ "accessToken": "x" }))
        .unwrap();
    let kinds: Vec<_> = v
        .list()
        .unwrap()
        .into_iter()
        .map(|s| (s.name, s.kind))
        .collect();
    assert_eq!(
        kinds,
        [
            ("Box".to_owned(), SecretKind::Oauth),
            ("社内".to_owned(), SecretKind::Login)
        ]
    );
}

#[test]
fn oauth_status_shows_expiry_never_tokens() {
    let dir = tempfile::tempdir().unwrap();
    let v = vault(dir.path());
    v.set(SecretInput {
        kind: Some(SecretKind::Oauth),
        ..input("Box")
    })
    .unwrap();
    assert_eq!(v.list().unwrap()[0].oauth, None);
    v.save_oauth_tokens(
        "Box",
        &json!({
            "accessToken": "at-secret",
            "refreshToken": "rt-secret",
            "expiresAt": 1_800_000_000,
            "obtainedAt": 1_799_996_400,
        }),
    )
    .unwrap();
    let info = &v.list().unwrap()[0];
    assert!(info.signed_in);
    let status = info.oauth.clone().unwrap();
    assert_eq!(status.expires_at.as_deref(), Some("2027-01-15T08:00:00Z"));
    assert_eq!(status.obtained_at.as_deref(), Some("2027-01-15T07:00:00Z"));
    assert!(status.refreshable);
    let shown = serde_json::to_string(info).unwrap();
    assert!(!shown.contains("secret\""), "{shown}");
    assert!(!shown.contains("at-secret") && !shown.contains("rt-secret"));
}

#[test]
fn api_key_requests_ask_for_the_key_only() {
    let dir = tempfile::tempdir().unwrap();
    let v = vault(dir.path());
    let request = v
        .request(NewSecretRequest {
            kind: Some(SecretKind::ApiKey),
            ..ask("受注 API", &["https://api.example.com/v1/orders"], &[])
        })
        .unwrap();
    assert_eq!(request.kind, Some(SecretKind::ApiKey));
    assert_eq!(request.fields, [SecretField::Password]);
    // Asked again without a kind (polling with waitMs): the kind and the
    // fields stay, so registering the key answers it.
    let again = v.request(ask("受注 API", &[], &[])).unwrap();
    assert_eq!(again.kind, Some(SecretKind::ApiKey));
    assert_eq!(again.fields, [SecretField::Password]);
    v.set(SecretInput {
        name: "受注 API".into(),
        kind: Some(SecretKind::ApiKey),
        password: Some("sk-live-1234".into()),
        sites: Some(vec!["https://api.example.com".into()]),
        ..SecretInput::default()
    })
    .unwrap();
    assert!(v.requests().unwrap().is_empty());
    // A saved API key asked for a login: only what it can hold is asked.
    let more = v
        .request(ask("受注 API", &["https://api2.example.com"], &[]))
        .unwrap();
    assert_eq!(more.kind, Some(SecretKind::ApiKey));
    assert_eq!(more.fields, [SecretField::Password]);
}

fn linked_vault(dir: &Path) -> (Vault, std::sync::Arc<MemoryWindowsCredentials>) {
    let windows = std::sync::Arc::new(MemoryWindowsCredentials::default());
    let v = vault(dir).with_windows_credentials(Box::new(windows.clone()));
    (v, windows)
}

fn linked(name: &str, target: &str) -> SecretInput {
    SecretInput {
        name: name.into(),
        sites: Some(vec!["https://example.com".into()]),
        windows_credential: Some(target.into()),
        ..SecretInput::default()
    }
}

#[test]
fn a_secret_linked_to_windows_reads_the_current_password_each_time() {
    let dir = tempfile::tempdir().unwrap();
    let (v, windows) = linked_vault(dir.path());
    windows.put("会社/受注", "yamada", "spring-2026");
    let info = v.set(linked("受注", "会社/受注")).unwrap();
    assert_eq!(info.username, "yamada");
    assert_eq!(info.fields, [SecretField::Username, SecretField::Password]);
    assert_eq!(info.windows_credential.as_deref(), Some("会社/受注"));
    let raw = std::fs::read_to_string(dir.path().join("secrets/vault.json")).unwrap();
    assert!(raw.contains("会社/受注"));
    assert!(!raw.contains("spring-2026"));

    let password = |v: &Vault| {
        v.resolve(&reference("受注", SecretField::Password))
            .unwrap()
            .value
    };
    assert_eq!(password(&v), "spring-2026");
    // Changed in Credential Manager: the next use types the new one.
    windows.put("会社/受注", "yamada", "summer-2026");
    assert_eq!(password(&v), "summer-2026");
    assert_eq!(v.mask("pw=summer-2026"), "pw=***");
    assert_eq!(
        v.summaries().unwrap()[0].windows_credential.as_deref(),
        Some("会社/受注")
    );
}

#[test]
fn a_windows_credential_that_is_not_there_says_how_to_add_it() {
    let dir = tempfile::tempdir().unwrap();
    let (v, windows) = linked_vault(dir.path());
    let e = v.set(linked("受注", "会社/受注")).unwrap_err();
    assert_eq!(e.code, "WINDOWS_CREDENTIAL_NOT_FOUND");
    assert!(v.list().unwrap().is_empty());

    windows.put("会社/受注", "yamada", "pw");
    v.set(linked("受注", "会社/受注")).unwrap();
    *windows.logins_for_test() = Default::default();
    let e = v
        .resolve(&reference("受注", SecretField::Password))
        .unwrap_err();
    assert_eq!(e.code, "WINDOWS_CREDENTIAL_NOT_FOUND");
    assert!(e.hint.unwrap_or_default().contains("資格情報マネージャー"));
    // Still listed, so the person can fix it.
    assert_eq!(v.list().unwrap()[0].username, "");
}

#[test]
fn unlinking_goes_back_to_values_kept_in_the_vault() {
    let dir = tempfile::tempdir().unwrap();
    let (v, windows) = linked_vault(dir.path());
    v.set(input("受注")).unwrap();
    windows.put("会社/受注", "yamada", "from-windows");
    v.set(linked("受注", "会社/受注")).unwrap();
    assert_eq!(
        v.resolve(&reference("受注", SecretField::Password))
            .unwrap()
            .value,
        "from-windows"
    );
    // The vault's own values were dropped when it was linked.
    let info = v
        .set(SecretInput {
            name: "受注".into(),
            windows_credential: Some(String::new()),
            ..SecretInput::default()
        })
        .unwrap();
    assert_eq!(info.windows_credential, None);
    assert!(info.fields.is_empty());
    v.set(SecretInput {
        password: Some("typed".into()),
        ..input("受注")
    })
    .unwrap();
    assert_eq!(
        v.resolve(&reference("受注", SecretField::Password))
            .unwrap()
            .value,
        "typed"
    );
}

#[test]
fn windows_passwords_are_read_as_utf16_or_utf8() {
    let utf16 = |t: &str| {
        t.encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<u8>>()
    };
    assert_eq!(
        wincred::blob_text(&utf16("hunter2")).as_deref(),
        Some("hunter2")
    );
    assert_eq!(
        wincred::blob_text(&utf16("パス12")).as_deref(),
        Some("パス12")
    );
    // Their UTF-16 bytes are also valid UTF-8 ("B0D0F0"): still UTF-16.
    let both = |t: &str| wincred::blob_text(&utf16(t));
    assert_eq!(both("あいう").as_deref(), Some("あいう"));
    assert_eq!(both("你好").as_deref(), Some("你好"));
    assert_eq!(both("pw\0").as_deref(), Some("pw"));
    // Not UTF-16 (odd length): UTF-8.
    assert_eq!(wincred::blob_text(b"abc").as_deref(), Some("abc"));
    assert_eq!(
        wincred::blob_text("パス1".as_bytes()).as_deref(),
        Some("パス1")
    );
    assert_eq!(wincred::blob_text(b"").as_deref(), Some(""));
}
