Complete GSD milestone {M###}.
WORKING_DIR: {WORKING_DIR}
auto_commit: {auto_commit}
milestone_cleanup: {milestone_cleanup}

## Slice Summaries

Read (first 35 lines each): {WORKING_DIR}/.gsd/milestones/{M###}/slices/S*/S*-SUMMARY.md

## Milestone Roadmap

Read: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-ROADMAP.md

## Milestone Summary

Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-SUMMARY.md

## Instructions
1. Write final M###-SUMMARY.md
2. Mark milestone as complete in STATE.md (do modify STATE.md for this)
If auto_commit is true:
3. Write final git tag or note
If auto_commit is false:
3. Skip — do NOT run any git commands.
Return ---GSD-WORKER-RESULT---.
