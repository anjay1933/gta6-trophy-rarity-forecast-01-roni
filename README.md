# Vice Rarity Forecast — GTA VI Trophy Earn Rates, Week One

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/anjay1933/gta6-trophy-rarity-forecast-01-roni/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/anjay1933/gta6-trophy-rarity-forecast-01-roni/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Entry for the [make.fun bounty "Forecast how many GTA VI players earn each trophy in week one"](https://make.fun/bounty/gta6-trophy-rarity-forecast-01). One program, `main.ts` (Node 22, standard library only, no network), reads a case file and writes five quantiles (0.05 / 0.25 / 0.5 / 0.75 / 0.95) of every trophy's Exophase earn rate at the target, for all 55 PlayStation 5 trophies (1 Platinum, 2 Gold, 6 Silver, 46 Bronze).

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

It reads every `<id>.in` in the input directory and writes `<id>.out` to the output directory: `{"trophies":[{"id":n,"q":[q05,q25,q50,q75,q95]}]}`. Two runs produce byte-identical output. Run time is about 0.6 s per case, far under the 8 s cap.

## How it forecasts

The program picks one of two regimes from the case data itself.

**Flat history: first-refresh dilution.** When every read is identical, the page has not refreshed yet, so the target sits just after Exophase's first refresh. RULES.txt discloses that refresh: 638 to 3,868 players tracked, every rate but the 100% one lower. Earners barely move across one refresh (the new profiles are fresh players), so the median is the frozen earner count over the refreshed player count. The 100% trophy stays at 100%.

**Moving history: earners over players, then averaged with a direct trend.** The earn rate is a ratio, and the two sides move differently: earners grow as players progress through the game, players tracked surges at launch and then saturates. So the program fits a saturating player curve, `P(t) = P_inf * (t/(t+tau))^gamma`, by grid search on log players; fits log earners per trophy as linear in `ln(1 + hours since release)` over the last 36 hours, with each slope shrunk 25% toward its description-class median (story, early activity, grind, other); and fits a direct logit-rate trend over the same window. The median is the geometric mean of the decomposition forecast and the direct trend (55/45). Spread grows with horizon and fit residual, slightly wider downward, since a late sync wave can still dilute rates. The near-universal trophy (last rate at or above 99.5%) is forecast from its lacker share instead, which grows with the square root of player growth.

## Local checks

Practice cases (frozen-earner answers reconstructed from the disclosed 3,868-player refresh; the house text says the baseline scores about 1.51 there, the leaderboard's top practice entries score near 0.06):

| case | this entry | house baseline |
|---|---|---|
| p00 pinball loss | 0.0462 | 1.6877 |
| p01 pinball loss | 0.0462 | 1.6877 |
| typical miss / 90% coverage | 0.002 pts / 1.000 | 0.725 pts / 0.000 |

The final case cannot be graded locally (its answer is recorded at 26 Nov 00:00 UTC), so the trend regime was checked on simulated final-like cases calibrated on the two real snapshots available: the launch-night reads (638 players) and the live Exophase page on 19 Nov 13:17 UTC. Across four scenarios (base, slow player growth, fast progression, slow progression) this entry scores 0.145–0.159 mean pinball loss, against about 0.31 for the house trend baseline and 0.70–0.96 for persistence. It still wins under a 1.8x post-cutoff player surge (0.20 vs 0.28). One open weakness: if earners stopped growing entirely after the cutoff, the forecast would overshoot (loss about 1.25); nothing in the launch data suggests that, since earners grew 2–44x in the first ten hours, but the spread does not cover a full halt.

## Sources

Trophy names, descriptions and tiers: the bounty kit's practice cases (which quote Exophase's trophy page). The first-refresh numbers (638 to 3,868 players): RULES.txt. The live calibration snapshot: https://www.exophase.com/game/grand-theft-auto-vi-psn/trophies/ as read on 19 Nov 2026 13:17 UTC. No other data is used, and the program itself reads only the case file it is given.
