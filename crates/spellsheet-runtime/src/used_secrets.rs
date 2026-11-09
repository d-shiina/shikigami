//! Which secrets a run used, for its report and the audit trail. The run's
//! steps reach secrets only through the [`SecretProvider`] they are given,
//! so wrapping it catches every use: input values, `http.request` auth,
//! saved browser logins and OAuth tokens. Only names are kept.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use spellsheet_core::secret::{ResolvedSecret, SecretError, SecretProvider, SecretRef};

pub(crate) struct Recording {
    inner: Arc<dyn SecretProvider>,
    used: Arc<Mutex<BTreeSet<String>>>,
}

impl Recording {
    /// The provider to give the run, and the names it will have used.
    pub(crate) fn wrap(
        inner: Arc<dyn SecretProvider>,
    ) -> (Arc<dyn SecretProvider>, Arc<Mutex<BTreeSet<String>>>) {
        let used = Arc::new(Mutex::new(BTreeSet::new()));
        let wrapped = Arc::new(Self {
            inner,
            used: used.clone(),
        });
        (wrapped, used)
    }

    fn note(&self, name: &str) {
        if let Ok(mut used) = self.used.lock() {
            used.insert(name.to_owned());
        }
    }
}

impl SecretProvider for Recording {
    fn resolve(&self, reference: &SecretRef) -> Result<ResolvedSecret, SecretError> {
        let resolved = self.inner.resolve(reference)?;
        self.note(&resolved.name);
        Ok(resolved)
    }

    fn load_session(&self, name: &str) -> Result<Option<Value>, SecretError> {
        let state = self.inner.load_session(name)?;
        if state.is_some() {
            self.note(name);
        }
        Ok(state)
    }

    fn save_session(&self, name: &str, state: &Value) -> Result<(), SecretError> {
        self.inner.save_session(name, state)
    }

    fn load_oauth_tokens(&self, name: &str) -> Result<Option<Value>, SecretError> {
        let tokens = self.inner.load_oauth_tokens(name)?;
        if tokens.is_some() {
            self.note(name);
        }
        Ok(tokens)
    }

    fn lock_oauth_tokens(&self, name: &str) -> Result<Box<dyn Send>, SecretError> {
        self.inner.lock_oauth_tokens(name)
    }

    fn save_oauth_tokens(&self, name: &str, tokens: &Value) -> Result<(), SecretError> {
        self.inner.save_oauth_tokens(name, tokens)?;
        self.note(name);
        Ok(())
    }
}
