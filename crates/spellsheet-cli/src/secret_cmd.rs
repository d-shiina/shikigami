//! `spellsheet secret`: logins kept in the workspace's vault.

use super::*;
use crate::cli::SecretCmd;

pub(crate) fn parse_secret_kind(text: &str) -> Result<SecretKind, String> {
    SecretKind::parse(text).ok_or_else(|| "login, api-key or oauth".to_owned())
}

pub(crate) fn secret_cmd(vault: &Vault, cmd: &SecretCmd) -> Result<()> {
    match cmd {
        SecretCmd::List { json } => {
            let list = vault.list()?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&list)?);
            } else if list.is_empty() {
                println!("(no secrets; key store: {})", vault.key_location());
            } else {
                for s in list {
                    let fields: Vec<_> = s.fields.iter().map(|f| f.as_str()).collect();
                    let windows = s
                        .windows_credential
                        .map(|t| format!("\twindows={t}"))
                        .unwrap_or_default();
                    println!(
                        "{}\tkind={}\tuser={}\tfields={}\tsites={}{windows}",
                        s.name,
                        s.kind.as_str(),
                        s.username,
                        fields.join(","),
                        s.sites.join(" ")
                    );
                }
            }
        }
        SecretCmd::Set {
            name,
            kind,
            username,
            password_stdin,
            password,
            totp,
            sites,
            description,
            windows_credential,
        } => {
            let known = vault.summaries()?.into_iter().find(|s| &s.name == name);
            let is_new = known.is_none();
            let what = match kind.or(known.map(|s| s.kind)).unwrap_or_default() {
                SecretKind::Login => "パスワード",
                SecretKind::ApiKey => "API キー",
                SecretKind::Oauth => "クライアント シークレット",
            };
            let password = if *password_stdin {
                let mut line = String::new();
                std::io::stdin().read_line(&mut line)?;
                Some(line.trim_end_matches(['\r', '\n']).to_owned())
            } else if *password
                || (is_new
                    && windows_credential.as_deref().is_none_or(str::is_empty)
                    && std::io::stdin().is_terminal())
            {
                Some(rpassword::prompt_password(format!("{name} の{what}: "))?)
            } else {
                None
            };
            let info = vault.set(SecretInput {
                name: name.clone(),
                kind: *kind,
                username: username.clone(),
                password,
                totp: totp.clone(),
                sites: (!sites.is_empty()).then(|| sites.clone()),
                description: description.clone(),
                windows_credential: windows_credential.clone(),
            })?;
            if info.sites.is_empty() {
                eprintln!(
                    "warning: no --site given; browser steps refuse to type this secret until a site is added"
                );
            }
            println!("saved secret '{}' ({})", info.name, vault.key_location());
        }
        SecretCmd::WindowsCredentials => {
            let list = vault.windows_credentials()?;
            if list.is_empty() {
                println!("(no generic credentials in Windows Credential Manager)");
            }
            for c in list {
                println!("{}\tuser={}", c.target, c.username);
            }
        }
        SecretCmd::Remove { name } => {
            vault.remove(name)?;
            println!("removed secret '{name}'");
        }
        SecretCmd::Logout { session } => {
            if vault.remove_session(session)? {
                println!("forgot the saved login '{session}'");
            } else {
                println!("no saved login '{session}'");
            }
        }
        SecretCmd::Reset { yes } => {
            if !*yes {
                bail!(
                    "this deletes every secret and saved login of the workspace; run again with --yes to confirm"
                );
            }
            let count = vault.reset()?;
            println!("deleted {count} secret(s); register them again with `spellsheet secret set`");
        }
    }
    Ok(())
}
