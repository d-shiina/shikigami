//! Suggestions for a step type name that does not exist.
//!
//! AI clients sometimes guess a type from what they want to do
//! (`control.pause`, `control.confirm`, `browser.waitForElement`). The
//! guess is never accepted as an alias (one way to write each thing), but
//! the error names the real types for that purpose, so the next try is
//! right instead of another guess.

use crate::registry::{StepRegistry, StepTypeDef};

/// What a guessed name usually means, by words in its action part
/// (after the dot), and the real types for it. Checked in order: the more
/// specific words come first (`waitforhuman` before `waitfor` before `wait`).
/// `waitfor` has seven letters, so it also matches inside longer names.
const PURPOSES: &[(&[&str], &[&str])] = &[
    (
        &[
            "waitforhuman",
            "waitforuser",
            "waitforperson",
            "waitformanual",
            "manual",
            "human",
            "handoff",
            "mfa",
            "captcha",
        ],
        &["browser.waitForHuman", "dialog.message"],
    ),
    (
        &[
            "confirm",
            "approv",
            "ask",
            "askuser",
            "yesno",
            "prompt",
            "alert",
            "messagebox",
            "msgbox",
            "notify",
            "showmessage",
            "message",
            "popup",
        ],
        &["dialog.message", "dialog.input", "browser.waitForHuman"],
    ),
    (
        &["pause", "hold", "break"],
        &["flow.delay", "dialog.message", "browser.waitForHuman"],
    ),
    (&["waituntil", "until", "poll"], &["wait.until"]),
    (
        &["waitfor", "appear", "visible"],
        &["browser.waitFor", "desktop.waitFor", "wait.until"],
    ),
    (
        &["sleep", "delay", "wait", "timeout"],
        &[
            "flow.delay",
            "wait.until",
            "browser.waitFor",
            "desktop.waitFor",
        ],
    ),
    (
        &["input", "form", "askvalue"],
        &[
            "dialog.input",
            "dialog.form",
            "browser.fill",
            "desktop.setValue",
        ],
    ),
    (
        &["log", "print", "echo", "debug", "trace"],
        &["log.message"],
    ),
    (&["set", "assign", "let", "var"], &["variable.set"]),
    (
        &["foreach", "each", "loop", "for", "iterate"],
        &["control.forEach", "control.repeat", "control.while"],
    ),
    (
        &["else", "condition", "when", "branch"],
        &["control.if", "control.switch"],
    ),
    (
        &["throw", "raise", "error", "abort", "stop", "exit"],
        &["control.fail", "log.message"],
    ),
    (&["catch", "retry"], &["control.try"]),
    (&["call", "subflow", "runflow", "invoke"], &["flow.call"]),
    (
        &["goto", "navigate", "visit", "url"],
        &["browser.navigate", "browser.open"],
    ),
];

/// One line on what a commonly confused type is for. Others show their label.
fn purpose_of(step_type: &str) -> Option<&'static str> {
    Some(match step_type {
        "flow.delay" => "wait a fixed time in ms",
        "wait.until" => "wait until a condition becomes true",
        "browser.waitFor" => "wait until an element on the web page is shown or gone",
        "desktop.waitFor" => "wait until an element of a Windows app is shown or gone",
        "browser.waitForHuman" => {
            "pause until the person finishes something in the browser (login, MFA, CAPTCHA)"
        }
        "dialog.message" => {
            "show a message box and wait; buttons \"yesNo\" or \"okCancel\" asks the person to confirm, the output is the button pressed"
        }
        "dialog.input" => "ask the person for one value",
        "dialog.form" => "ask the person for several values at once",
        _ => return None,
    })
}

/// Up to four existing step types `name` most likely meant: types for the
/// purpose its words suggest (those in the same namespace first), then
/// near spellings.
pub fn suggest_step_types<'a>(registry: &'a StepRegistry, name: &str) -> Vec<&'a StepTypeDef> {
    let (namespace, action) = name.rsplit_once('.').unwrap_or(("", name));
    let action: String = action
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect::<String>()
        .to_ascii_lowercase();

    let mut by_purpose: Vec<&str> = Vec::new();
    if !action.is_empty() {
        // Words of four letters or fewer only as the whole action ("set"
        // must not match "reset", "form" not "format"); longer ones may
        // start it or sit inside it ("waitForElement", "askConfirm").
        let fits = |word: &str| action == word || (word.len() >= 5 && action.contains(word));
        if let Some((_, types)) = PURPOSES
            .iter()
            .find(|(words, _)| words.iter().any(|w| fits(w)))
        {
            by_purpose.extend(types.iter().copied());
        }
    }
    // Same namespace first: `browser.wait` most likely meant browser.waitFor.
    by_purpose.sort_by_key(|t| !t.starts_with(&format!("{namespace}.")));

    let mut out: Vec<&StepTypeDef> = Vec::new();
    let push = |def: Option<&'a StepTypeDef>, out: &mut Vec<&'a StepTypeDef>| {
        if let Some(def) = def
            && !out.iter().any(|d| d.step_type == def.step_type)
        {
            out.push(def);
        }
    };
    for t in by_purpose {
        push(registry.get(t), &mut out);
    }
    // Near spellings (typos: control.fi → control.if).
    push(
        crate::validate::closest(name, registry.iter().map(|d| d.step_type.as_str()))
            .and_then(|t| registry.get(t)),
        &mut out,
    );
    // Longer or shorter forms in the same namespace (browser.wait → browser.waitFor).
    if !namespace.is_empty() && action.len() >= 3 {
        for def in registry.iter() {
            if let Some((ns, act)) = def.step_type.rsplit_once('.')
                && ns == namespace
            {
                let act = act.to_ascii_lowercase();
                if act.starts_with(&action) || action.starts_with(&act) {
                    push(Some(def), &mut out);
                }
            }
        }
    }
    out.truncate(4);
    out
}

/// The hint for an unknown step type: the likely types with what each is
/// for, and where the full list is.
pub fn unknown_step_type_hint(registry: &StepRegistry, name: &str) -> String {
    let suggestions = suggest_step_types(registry, name);
    let list = suggestions
        .iter()
        .map(|d| {
            let what = purpose_of(&d.step_type).unwrap_or(&d.label);
            format!("'{}' ({what})", d.step_type)
        })
        .collect::<Vec<_>>()
        .join(", ");
    let rest = "Use only type names that list_step_types returns; do not guess new ones.";
    if list.is_empty() {
        format!("'{name}' is not a step type. {rest}")
    } else {
        format!("'{name}' is not a step type. Did you mean {list}? {rest}")
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    /// Builtins plus stand-ins for the adapter types, which live in other crates.
    fn registry() -> StepRegistry {
        let mut r = StepRegistry::with_builtins();
        let base = r.get("log.message").expect("log.message").clone();
        for t in [
            "browser.waitFor",
            "browser.waitForHuman",
            "browser.click",
            "desktop.waitFor",
            "dialog.message",
            "dialog.input",
            "dialog.form",
        ] {
            let mut def = base.clone();
            def.step_type = t.into();
            r.register(def);
        }
        r
    }

    fn names(name: &str) -> Vec<String> {
        let r = registry();
        suggest_step_types(&r, name)
            .into_iter()
            .map(|d| d.step_type.clone())
            .collect()
    }

    #[test]
    fn guesses_seen_from_ai_clients_point_at_the_real_types() {
        assert_eq!(names("browser.waitForElement")[0], "browser.waitFor");
        assert_eq!(names("browser.wait")[0], "browser.waitFor");
        assert_eq!(names("control.pause")[0], "flow.delay");
        assert!(names("control.pause").contains(&"dialog.message".to_owned()));
        for guess in ["control.confirm", "interaction.confirm", "interact.confirm"] {
            assert_eq!(names(guess)[0], "dialog.message", "{guess}");
        }
        assert_eq!(names("user.waitForHuman")[0], "browser.waitForHuman");
        assert_eq!(names("desktop.waitForWindow")[0], "desktop.waitFor");
        assert_eq!(names("control.sleep")[0], "flow.delay");
    }

    #[test]
    fn typos_and_short_words() {
        assert_eq!(names("control.fi"), vec!["control.if"]);
        // "reset" does not mean variable.set.
        assert!(!names("file.reset").contains(&"variable.set".to_owned()));
        assert!(names("nope.zzzzzz").is_empty());
    }

    #[test]
    fn hint_says_what_each_is_for() {
        let r = registry();
        let hint = unknown_step_type_hint(&r, "control.confirm");
        assert!(
            hint.contains("'dialog.message' (show a message box"),
            "{hint}"
        );
        assert!(hint.contains("yesNo"), "{hint}");
        assert!(hint.contains("list_step_types"), "{hint}");
        let none = unknown_step_type_hint(&r, "nope.zzzzzz");
        assert!(!none.contains("Did you mean"), "{none}");
    }
}
