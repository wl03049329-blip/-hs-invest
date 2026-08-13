# Call path after migration

`applyStrategyModes` keeps legacy calculation for rollback, then replaces only `long_term_core` with the canonical adapter. All ranking surfaces compare exact `coreScore`; UI renders floored `coreScoreDisplay`.
