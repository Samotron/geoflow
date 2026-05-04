# Contributing to GeoFlow

Thanks for your interest. Until v0.1 ships, the contribution model is light:

1. Open an issue describing the change before sending a PR.
2. `cargo fmt --all` and `cargo clippy --all-targets -- -D warnings` must pass.
3. `cargo test --workspace` must pass on Linux, macOS, and Windows.
4. New behaviour gets a fixture under `tests/fixtures/` and a golden test.
5. Use commit prefixes that match the milestone IDs in
   [`spec/003_locked_plan.md`](spec/003_locked_plan.md), e.g.
   `M1.3: assemble groups from HEADING/UNIT/TYPE/DATA rows`.

By contributing, you agree that your contributions will be licensed under
the MIT license (see [`LICENSE`](LICENSE)).
