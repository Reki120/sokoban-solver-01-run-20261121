# Sokoban Solver — Push-Optimal Rooms

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/Reki120/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/Reki120/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

An entry for the make.fun bounty "Build the best Sokoban solver,
21 November 2026". `main.ts` (Node 22, no dependencies) reads every
instance under `/input/<id>/level.txt` and writes the player's moves
to `/output/<id>/solution.txt`, solving each level in the fewest
pushes possible.

## How it works

make.fun's generated levels are a hallway with small rooms off it,
and each room's boxes belong to that room's goals alone, so a level's
push optimum is the sum of its rooms' optima. The solver:

1. **Finds the rooms.** The dead squares of the player's row (the
   hallway: a box there can reach no goal) are cut out of the floor;
   each remaining part that holds a box is a room, with its own boxes
   and goals.
2. **Solves each room push-optimally** with an A\* search over
   pushes. A state is the boxes' squares plus the player's reachable
   region (named by its lowest square); a step is one push. The
   estimate is a minimum-cost assignment (Hungarian method) of boxes
   to goals over precomputed push distances — the fewest pushes that
   could bring a box from its square to each goal, other boxes
   ignored. One push moves one box by one square, so the estimate
   never overstates the pushes still needed and the first solution
   settled is push-optimal.
3. **Prunes deadlocks**: boxes on dead squares (no push sequence
   brings them to any goal), frozen 2×2 blocks of walls and boxes,
   and boxes frozen against walls or other frozen boxes.
4. **Walks the player on** from where each room's solution leaves
   it, with the other rooms' boxes standing as walls; a level that
   does not split into rooms is searched whole with the same solver.

Everything is decided by work done (a state budget), never by the
clock, and every tie breaks by square and direction order, so two
runs of the program write byte-identical solutions.

## Validation

On the kit's practice set the solver answers all five instances in
exactly the published optimal push counts (13, 16, 29, 47, 60), a
practice score of 1,000,000, in well under a second for the whole
set — against the house baseline plain-astar 1.0.0's 200,000 on the
same set. It was also verified on freshly drawn sets from the kit's
own generator: every level solved at its known optimum.
