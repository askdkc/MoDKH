use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use stateright::{Checker, Model, Property};
use std::collections::HashSet;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Spec {
    pub schema_version: u8,
    pub states: Vec<String>,
    pub initial: Vec<String>,
    pub transitions: Vec<Transition>,
    pub invariants: Vec<Invariant>,
    pub check_deadlocks: bool,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Transition {
    pub from: String,
    pub to: String,
    pub action: String,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Invariant {
    pub name: String,
    pub allowed_states: Vec<String>,
}

fn names(values: &[String]) -> bool {
    values
        .iter()
        .all(|s| !s.is_empty() && s.len() <= 128 && !s.chars().any(char::is_control))
        && values.iter().collect::<HashSet<_>>().len() == values.len()
}
impl Spec {
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > 262144 {
            return Err("Model exceeds 256 KiB".into());
        }
        let spec: Self = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
        if spec.schema_version != 1
            || spec.states.is_empty()
            || spec.states.len() > 10000
            || !names(&spec.states)
            || spec.initial.is_empty()
            || !names(&spec.initial)
            || spec.invariants.is_empty()
            || spec.invariants.len() > 64
            || spec.transitions.len() > 50000
        {
            return Err("Invalid model bounds or schema".into());
        }
        let states: HashSet<_> = spec.states.iter().collect();
        if spec.initial.iter().any(|s| !states.contains(s))
            || spec.transitions.iter().any(|t| {
                !states.contains(&t.from)
                    || !states.contains(&t.to)
                    || t.action.is_empty()
                    || t.action.len() > 128
                    || t.action.chars().any(char::is_control)
            })
            || !names(
                &spec
                    .invariants
                    .iter()
                    .map(|p| p.name.clone())
                    .collect::<Vec<_>>(),
            )
            || spec.invariants.iter().any(|p| {
                !names(&p.allowed_states) || p.allowed_states.iter().any(|s| !states.contains(s))
            })
        {
            return Err("Unknown state, duplicate name or invalid transition/invariant".into());
        }
        Ok(spec)
    }
    fn violations(&self, state: &str) -> Vec<String> {
        self.invariants
            .iter()
            .filter(|p| !p.allowed_states.iter().any(|s| s == state))
            .map(|p| p.name.clone())
            .collect()
    }
}
impl Model for Spec {
    type State = String;
    type Action = usize;
    fn init_states(&self) -> Vec<String> {
        self.initial.clone()
    }
    fn actions(&self, state: &String, actions: &mut Vec<usize>) {
        actions.extend(
            self.transitions
                .iter()
                .enumerate()
                .filter(|(_, t)| &t.from == state)
                .map(|(i, _)| i),
        );
    }
    fn next_state(&self, state: &String, action: usize) -> Option<String> {
        self.transitions
            .get(action)
            .filter(|t| &t.from == state)
            .map(|t| t.to.clone())
    }
    fn properties(&self) -> Vec<Property<Self>> {
        vec![Property::always("requirements", |m: &Self, s: &String| {
            m.violations(s).is_empty()
                && (!m.check_deadlocks || m.transitions.iter().any(|t| &t.from == s))
        })]
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub schema_version: u8,
    pub verifier: &'static str,
    pub input_sha256: String,
    pub status: &'static str,
    pub complete: bool,
    pub explored_states: usize,
    pub violated_invariants: Vec<String>,
    pub deadlock: bool,
    pub counterexample: Option<Vec<String>>,
    pub actions: Option<Vec<String>>,
}
pub fn check(bytes: &[u8]) -> Result<Report, String> {
    let model = Spec::parse(bytes)?;
    let checker = model.clone().checker().threads(1).spawn_bfs().join();
    let path = checker.discovery("requirements");
    let violated = path
        .as_ref()
        .map(|p| model.violations(p.last_state()))
        .unwrap_or_default();
    let deadlock = path.as_ref().is_some_and(|p| {
        model.check_deadlocks && !model.transitions.iter().any(|t| &t.from == p.last_state())
    });
    let complete = path.is_none() && checker.is_done();
    Ok(Report {
        schema_version: 1,
        verifier: "stateright",
        input_sha256: format!("{:x}", Sha256::digest(bytes)),
        status: if path.is_some() {
            "failed"
        } else if complete {
            "passed"
        } else {
            "unverified"
        },
        complete,
        explored_states: checker.unique_state_count(),
        violated_invariants: violated,
        deadlock,
        counterexample: path.clone().map(|p| p.into_states()),
        actions: path.map(|p| {
            p.into_actions()
                .into_iter()
                .map(|i| model.transitions[i].action.clone())
                .collect()
        }),
    })
}
