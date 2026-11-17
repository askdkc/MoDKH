use modkh_zenki_prototype::{check, Action, Counter, Invariant};
use stateright::Model;

#[test]
fn good_explores_the_three_reachable_states() {
    let report = check(Invariant::Good);
    assert_eq!(report.status, "passed");
    assert_eq!(report.explored_states, 3);
    assert_eq!(report.counterexample, None);
}

#[test]
fn bad_returns_the_shortest_replayable_counterexample() {
    let report = check(Invariant::Bad);
    assert_eq!(report.status, "failed");
    assert_eq!(report.counterexample, Some(vec![0, 1, 2]));
    assert_eq!(
        report.actions,
        Some(vec![Action::Increment, Action::Increment])
    );
    // Replay against independently specified arithmetic, not the checker's transition helper.
    let states = report.counterexample.unwrap();
    for pair in states.windows(2) {
        assert!(pair[0] < 2);
        assert_eq!(pair[1], pair[0] + 1);
    }
    assert!(states[..states.len() - 1].iter().all(|x| *x <= 1));
    assert!(*states.last().unwrap() > 1);
}

#[test]
fn terminal_state_is_allowed_and_has_no_outgoing_transition() {
    let model = Counter(Invariant::Good);
    let mut actions = vec![];
    model.actions(&2, &mut actions);
    assert!(actions.is_empty());
    assert_eq!(model.next_state(&2, Action::Increment), None);
}

#[test]
fn port_matches_the_existing_fixture_contract() {
    // Deliberately fail on fixture changes: this is a reviewed manual port, not a translator.
    let normalize = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    assert_eq!(normalize(include_str!("../../../test/fixtures/formal/Counter.tla")),
        normalize("---- MODULE Counter ----\nEXTENDS Naturals\nVARIABLE x\nInit == x = 0\nNext == /\\ x < 2 /\\ x' = x + 1\nGood == x <= 2\nBad == x <= 1\n===="));
    assert_eq!(
        normalize(include_str!("../../../test/fixtures/formal/good.cfg")),
        "INIT Init NEXT Next INVARIANT Good CHECK_DEADLOCK FALSE"
    );
    assert_eq!(
        normalize(include_str!("../../../test/fixtures/formal/bad.cfg")),
        "INIT Init NEXT Next INVARIANT Bad CHECK_DEADLOCK FALSE"
    );
}
