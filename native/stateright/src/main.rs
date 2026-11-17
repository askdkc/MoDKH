use std::{fs::File, io::Read, process::ExitCode};
fn main() -> ExitCode {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args == ["--protocol"] {
        println!("{{\"name\":\"modkh-stateright\",\"schemaVersion\":1}}");
        return ExitCode::SUCCESS;
    }
    if args == ["--version"] {
        println!("modkh-stateright {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    let run = || -> Result<_, String> {
        if args.len() != 2 || args[0] != "--check" {
            return Err("Usage: modkh-stateright --check model.json".into());
        }
        let mut bytes = vec![];
        File::open(&args[1])
            .map_err(|e| e.to_string())?
            .take(262145)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        modkh_stateright::check(&bytes)
    };
    match run() {
        Ok(report) => {
            println!("{}", serde_json::to_string(&report).expect("report"));
            ExitCode::from(match report.status {
                "passed" => 0,
                "failed" => 1,
                _ => 2,
            })
        }
        Err(e) => {
            eprintln!("Invalid model: {e}");
            ExitCode::from(2)
        }
    }
}
