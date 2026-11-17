use serde::Serialize;
use stateright::{Checker, Model, Property};

#[derive(Clone, Copy, Debug)]
pub enum Invariant {
    Good,
    Bad,
}
impl Invariant {
    pub fn name(self) -> &'static str {
        match self {
            Self::Good => "Good",
            Self::Bad => "Bad",
        }
    }
}

/// Port of test/fixtures/formal/Counter.tla, not a TLA+ interpreter.
#[derive(Clone)]
pub struct Counter(pub Invariant);
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub enum Action {
    Increment,
}

impl Model for Counter {
    type State = u8;
    type Action = Action;
    fn init_states(&self) -> Vec<u8> {
        vec![0]
    }
    fn actions(&self, state: &u8, actions: &mut Vec<Action>) {
        if *state < 2 {
            actions.push(Action::Increment);
        }
    }
    fn next_state(&self, state: &u8, _action: Action) -> Option<u8> {
        if *state < 2 {
            Some(*state + 1)
        } else {
            None
        }
    }
    fn properties(&self) -> Vec<Property<Self>> {
        match self.0 {
            Invariant::Good => vec![Property::always("Good", |_, x| *x <= 2)],
            Invariant::Bad => vec![Property::always("Bad", |_, x| *x <= 1)],
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub schema_version: u8,
    pub verifier: &'static str,
    pub model: &'static str,
    pub invariant: &'static str,
    pub status: &'static str,
    pub explored_states: usize,
    pub counterexample: Option<Vec<u8>>,
    pub actions: Option<Vec<Action>>,
    pub scope: &'static str,
}

pub fn check(invariant: Invariant) -> Report {
    let checker = Counter(invariant).checker().threads(1).spawn_bfs().join();
    let path = checker.discovery(invariant.name());
    let status = if path.is_some() {
        "failed"
    } else if checker.is_done() {
        "passed"
    } else {
        "unverified"
    };
    Report {
        schema_version: 1, verifier: "stateright", model: "Counter-v1",
        invariant: invariant.name(), status, explored_states: checker.unique_state_count(),
        counterexample: path.clone().map(|p| p.into_states()),
        actions: path.map(|p| p.into_actions()),
        scope: "Finite Counter model only: x=0; x<2 permits x'=x+1; deadlocks are allowed. No implementation equivalence or TLA+ compatibility claim.",
    }
}
