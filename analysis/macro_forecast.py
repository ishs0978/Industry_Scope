"""Does a sector's paired macro indicator forecast that sector's next month?

Every sector page pairs an industry ETF with the FRED series the copy says the
industry keys off. The pairing is an editorial claim about relevance and the
site is careful never to turn it into a claim about prices. This module asks the
narrower question the data can actually answer: standing at the end of a month
with only what had been published by then, does the growth of that indicator
improve a one-month-ahead forecast of the fund's return, against the benchmark
of simply forecasting the average return so far?

Three things decide whether the answer means anything.

Publication lag. A monthly indicator describes a month that ended before it is
released: industrial production for July reaches the public in mid-August. A
forecaster standing on 31 July has June's reading, not July's. Aligning the
indicator to its reference month instead of its release month hands the model
information nobody had, and that alone can manufacture a result. The lag is
measured from the source metadata rather than assumed.

The benchmark. Comparing a model against nothing is not a comparison. The
benchmark here is the expanding mean of the returns seen so far, which is the
standard one for this question, and it is refitted at every origin exactly as
the model is.

Which test. The model nests the benchmark: set the slope to zero and they are
the same forecast. Diebold-Mariano assumes non-nested forecasts and is
undersized here, so the comparison uses the Clark-West MSPE adjustment, which
corrects for the noise a redundant parameter adds under the null.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
import json
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np
import pandas as pd
import statsmodels.api as sm
from statsmodels.stats.diagnostic import acorr_ljungbox, het_breuschpagan
from statsmodels.stats.multitest import multipletests
from statsmodels.stats.stattools import jarque_bera


# Ten years of monthly observations before the first forecast is made, and three
# years of forecasts before a sector is reported. Below that the comparison is
# a coin toss dressed as a number.
MIN_TRAIN_MONTHS = 120
MIN_FORECASTS = 36
# Newey-West lag on the Clark-West mean. One-step-ahead loss differentials are
# serially uncorrelated in theory; carrying three lags widens the interval and
# so can only make significance harder to claim.
HAC_LAGS = 3


@dataclass(frozen=True)
class Pairing:
    """One sector ETF and the macro series its page pairs it with."""

    sector: str
    etf: str
    series_id: str
    label: str
    # Release date minus the reference date of the newest observation, taken
    # from the source's own metadata. See estimated_release.
    lag_days: int


@dataclass(frozen=True)
class Result:
    pairing: Pairing
    forecasts: pd.DataFrame
    rmse_model: float
    rmse_benchmark: float
    rmse_zero: float
    oos_r2: float
    clark_west_t: float
    clark_west_p: float
    slope: float
    slope_ci: tuple[float, float]
    slope_p: float
    next_month_prediction: float
    # Where the average return for this predictor value sits.
    next_month_mean_interval: tuple[float, float]
    # Where a single next month's return could land. Always the wider of the two.
    next_month_interval: tuple[float, float]
    diagnostics: dict[str, float]

    @property
    def n_forecasts(self) -> int:
        return len(self.forecasts)


def month_key(day: date) -> pd.Period:
    return pd.Period(day, freq="M")


def monthly_log_returns(prices: Sequence[tuple[date, float]]) -> pd.Series:
    """Month-end to month-end log return of a dividend-adjusted close."""
    frame = pd.DataFrame(prices, columns=["day", "close"]).sort_values("day")
    frame["month"] = [month_key(day) for day in frame["day"]]
    closes = frame.groupby("month")["close"].last()
    return np.log(closes).diff().dropna()


def estimated_release(reference: date, lag_days: int) -> date:
    """When an observation dated `reference` reached the public.

    The registry stores one release date per series, for its newest
    observation, so the lag it implies is applied to every observation of that
    series. Release calendars are close to fixed by construction - the same
    statistical agency publishes the same series on the same schedule - but this
    is an estimate, and a wrong estimate is only dangerous in one direction. Too
    short a lag hands the model data early. Nothing here rounds the lag down.
    """
    return reference + timedelta(days=lag_days)


def available_growth(observations: Sequence[tuple[date, float]], lag_days: int) -> pd.Series:
    """Indicator growth as a forecaster standing at each month end would see it.

    Indexed by the month of the forecast origin, not by the month the indicator
    describes. A forecaster at the end of August has whatever was released by 31
    August, which for a series published with a six-week lag is July's reading
    at the earliest and June's in most months. When no new reading arrives in a
    month - routine for a slow series - the previous one is still the newest
    thing known, so the predictor repeats rather than going blank. It is a
    stale reading, and the model is entitled to no more than that.
    """
    frame = pd.DataFrame(sorted(observations), columns=["reference", "value"])
    frame["growth"] = np.log(frame["value"]).diff()
    frame = frame.dropna(subset=["growth"])
    if frame.empty:
        return pd.Series(dtype=float)
    frame["known_from"] = [month_key(estimated_release(day, lag_days)) for day in frame["reference"]]
    # Two readings can clear in one month; the later reference date is the one a
    # forecaster would use.
    newest = frame.sort_values(["known_from", "reference"]).groupby("known_from")["growth"].last()
    span = pd.period_range(newest.index.min(), newest.index.max(), freq="M")
    return newest.reindex(span).ffill()


def build_panel(returns: pd.Series, growth: pd.Series) -> pd.DataFrame:
    """Predictor known at the end of month T against the return of month T+1."""
    target = returns.shift(-1)
    panel = pd.DataFrame({"x": growth, "target": target}).dropna()
    return panel.sort_index()


def rolling_origin_forecasts(panel: pd.DataFrame, min_train: int = MIN_TRAIN_MONTHS) -> pd.DataFrame:
    """Expanding-window backtest, refitting both forecasts at every origin.

    Nothing in the training window is dated after the origin, and the benchmark
    is recomputed from the same window, so the two forecasts always see the same
    history.
    """
    rows = []
    for position in range(min_train, len(panel)):
        train = panel.iloc[:position]
        origin = panel.index[position]
        design = sm.add_constant(train[["x"]], has_constant="add")
        fitted = sm.OLS(train["target"], design).fit()
        ahead = pd.DataFrame({"const": [1.0], "x": [panel["x"].iloc[position]]})
        rows.append({
            "origin": origin,
            "actual": panel["target"].iloc[position],
            "model": float(fitted.predict(ahead).iloc[0]),
            "benchmark": float(train["target"].mean()),
        })
    return pd.DataFrame(rows).set_index("origin")


def out_of_sample_r2(forecasts: pd.DataFrame) -> float:
    """Campbell-Thompson: the share of benchmark squared error the model removes.

    Negative means the model is worse than the benchmark, which is the usual
    outcome and is reported as it lands rather than floored at zero.
    """
    model_error = ((forecasts["actual"] - forecasts["model"]) ** 2).sum()
    benchmark_error = ((forecasts["actual"] - forecasts["benchmark"]) ** 2).sum()
    return 1.0 - model_error / benchmark_error


def clark_west(forecasts: pd.DataFrame) -> tuple[float, float]:
    """MSPE-adjusted test of equal accuracy for nested forecasts.

    Returns the t statistic and its one-sided p value against the alternative
    that the model forecasts better. One-sided because the question is whether
    the indicator adds anything; a model that is significantly worse than the
    mean is not a finding about the indicator.
    """
    actual = forecasts["actual"].to_numpy()
    benchmark = forecasts["benchmark"].to_numpy()
    model = forecasts["model"].to_numpy()
    adjusted = (actual - benchmark) ** 2 - ((actual - model) ** 2 - (benchmark - model) ** 2)
    fitted = sm.OLS(adjusted, np.ones(len(adjusted))).fit(
        cov_type="HAC", cov_kwds={"maxlags": HAC_LAGS}
    )
    statistic = float(fitted.tvalues[0])
    return statistic, float(fitted.pvalues[0] / 2 if statistic > 0 else 1 - fitted.pvalues[0] / 2)


def residual_diagnostics(fitted: Any, design: pd.DataFrame) -> dict[str, float]:
    """Whether the residuals behave the way the standard errors assume.

    Reported rather than acted on. The slope interval below already uses
    heteroskedasticity- and autocorrelation-consistent standard errors, so these
    say how far the textbook assumptions are from holding, not whether the
    interval is usable.
    """
    residuals = fitted.resid
    ljung = acorr_ljungbox(residuals, lags=[12], return_df=True)
    _, breusch_p, _, _ = het_breuschpagan(residuals, design)
    _, jarque_p, skew, kurtosis = jarque_bera(residuals)
    return {
        "ljung_box_12_p": float(ljung["lb_pvalue"].iloc[0]),
        "breusch_pagan_p": float(breusch_p),
        "jarque_bera_p": float(jarque_p),
        "skew": float(skew),
        "kurtosis": float(kurtosis),
    }


def evaluate(
    pairing: Pairing,
    returns: pd.Series,
    growth: pd.Series,
    min_train: int = MIN_TRAIN_MONTHS,
) -> Result | None:
    """One sector, end to end. None when the history is too short to judge."""
    panel = build_panel(returns, growth)
    if len(panel) < min_train + MIN_FORECASTS:
        return None
    forecasts = rolling_origin_forecasts(panel, min_train)

    design = sm.add_constant(panel[["x"]], has_constant="add")
    # HAC standard errors: monthly returns are heteroskedastic and the repeated
    # predictor introduces autocorrelation the classical formula would ignore.
    fitted = sm.OLS(panel["target"], design).fit(cov_type="HAC", cov_kwds={"maxlags": HAC_LAGS})
    interval = fitted.conf_int().loc["x"]

    # Two different intervals, and they answer different questions. The one
    # above is a confidence interval on the slope: where the average
    # relationship sits. The one below is a prediction interval for a single
    # future month, which carries the residual spread as well as the estimation
    # error and is therefore far wider. Quoting the first as if it bounded next
    # month's return would understate the uncertainty by an order of magnitude.
    ordinary = sm.OLS(panel["target"], design).fit()
    latest = pd.DataFrame({"const": [1.0], "x": [growth.iloc[-1]]})
    prediction = ordinary.get_prediction(latest)
    bounds = prediction.summary_frame(alpha=0.05).iloc[0]

    zero_rmse = float(np.sqrt((forecasts["actual"] ** 2).mean()))
    statistic, p_value = clark_west(forecasts)
    return Result(
        pairing=pairing,
        forecasts=forecasts,
        rmse_model=float(np.sqrt(((forecasts["actual"] - forecasts["model"]) ** 2).mean())),
        rmse_benchmark=float(np.sqrt(((forecasts["actual"] - forecasts["benchmark"]) ** 2).mean())),
        rmse_zero=zero_rmse,
        oos_r2=out_of_sample_r2(forecasts),
        clark_west_t=statistic,
        clark_west_p=p_value,
        slope=float(fitted.params["x"]),
        slope_ci=(float(interval[0]), float(interval[1])),
        slope_p=float(fitted.pvalues["x"]),
        next_month_prediction=float(bounds["mean"]),
        next_month_mean_interval=(float(bounds["mean_ci_lower"]), float(bounds["mean_ci_upper"])),
        next_month_interval=(float(bounds["obs_ci_lower"]), float(bounds["obs_ci_upper"])),
        diagnostics=residual_diagnostics(fitted, design),
    )


def holm_adjusted(results: Sequence[Result]) -> list[float]:
    """Holm-Bonferroni over the family of sectors tested.

    Twenty tests at the five percent level produce a significant one by chance
    about two thirds of the time. Reporting the smallest raw p value from a
    sweep as though it were a single planned test is the standard way to publish
    noise, so every p value here is adjusted for the size of the sweep it came
    from.
    """
    if not results:
        return []
    return list(multipletests([result.clark_west_p for result in results], method="holm")[1])


# ---------------------------------------------------------------------------
# Loading. The exported payloads are generated at deploy time and are not in the
# repository, so the analysis reads whatever is on disk and says so when there
# is nothing there.
# ---------------------------------------------------------------------------

EXPORT_DIR = Path(__file__).parents[1] / "web" / "data" / "sectors"


def load_pairings(export_dir: Path = EXPORT_DIR) -> list[tuple[Pairing, pd.Series, pd.Series]]:
    """Every sector paired with a monthly FRED series that carries a release date.

    Two exclusions, both for the same reason. Quarterly series are dropped
    because a reading four months stale is not the monthly signal this question
    is about. BLS series are dropped because the payload carries no release date
    for them, so there is no way to establish what was public when - and
    guessing that would defeat the point of the exercise.
    """
    pairings = []
    for path in sorted(export_dir.glob("*.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        etf = payload["sector"]["primary_etf"]
        prices = [
            (date.fromisoformat(row[1]), float(row[2]))
            for row in payload["prices"]["rows"]
            if row[0] == etf and row[2] is not None
        ]
        if not prices:
            continue
        returns = monthly_log_returns(prices)
        observations: dict[str, list[tuple[date, float]]] = {}
        for series_id, day, value in payload["macro"]["series"]["rows"]:
            observations.setdefault(series_id, []).append((date.fromisoformat(day), float(value)))
        for meta in payload["macro"]["meta"]:
            frequency = (meta.get("frequency") or "").split(",")[0].strip().lower()
            release = meta.get("last_release_date")
            series_id = meta["series_id"]
            if frequency != "monthly" or not release or series_id not in observations:
                continue
            history = sorted(observations[series_id])
            lag_days = (date.fromisoformat(release) - history[-1][0]).days
            pairings.append((
                Pairing(
                    sector=payload["sector"]["slug"], etf=etf, series_id=series_id,
                    label=meta.get("label") or series_id, lag_days=lag_days,
                ),
                returns,
                available_growth(history, lag_days),
            ))
    return pairings


def report(export_dir: Path = EXPORT_DIR) -> str:
    pairings = load_pairings(export_dir)
    if not pairings:
        return (
            f"no exported sector payloads under {export_dir}. "
            "Run `npm run export-data` in web/ first."
        )
    results = [result for result in (evaluate(*pairing) for pairing in pairings) if result]
    if not results:
        return "no sector had enough history to backtest."
    adjusted = holm_adjusted(results)
    lines = [
        "One-month-ahead sector return forecasts, expanding-window backtest.",
        "Predictor: growth of the sector's paired macro indicator, lagged to its release date.",
        "Benchmark: expanding mean of past returns, refitted at every origin.",
        "",
        f"{'sector':<24}{'series':<18}{'lag':>4}{'n':>6}{'RMSE model':>12}{'RMSE mean':>11}"
        f"{'OOS R2':>9}{'CW t':>7}{'CW p':>8}{'Holm p':>8}",
    ]
    for result, holm in zip(results, adjusted):
        lines.append(
            f"{result.pairing.sector:<24}{result.pairing.series_id:<18}"
            f"{result.pairing.lag_days:>4}{result.n_forecasts:>6}"
            f"{result.rmse_model:>12.5f}{result.rmse_benchmark:>11.5f}"
            f"{result.oos_r2:>9.4f}{result.clark_west_t:>7.2f}"
            f"{result.clark_west_p:>8.3f}{holm:>8.3f}"
        )
    beat = [result for result in results if result.oos_r2 > 0]
    survive = [result for result, holm in zip(results, adjusted) if holm < 0.05]
    lines += [
        "",
        f"{len(beat)} of {len(results)} pairings beat the expanding mean out of sample.",
        f"{len(survive)} survive Holm correction across the {len(results)} tests.",
        "",
        "Full-sample fit, HAC standard errors, and residual diagnostics.",
        f"{'sector':<24}{'series':<18}{'slope':>9}{'95% CI on the slope':>26}{'p':>7}"
        f"{'LB(12) p':>10}{'BP p':>8}{'JB p':>8}",
    ]
    for result in results:
        low, high = result.slope_ci
        checks = result.diagnostics
        lines.append(
            f"{result.pairing.sector:<24}{result.pairing.series_id:<18}{result.slope:>9.3f}"
            f"{f'[{low:.3f}, {high:.3f}]':>26}{result.slope_p:>7.3f}"
            f"{checks['ljung_box_12_p']:>10.3f}{checks['breusch_pagan_p']:>8.3f}"
            f"{checks['jarque_bera_p']:>8.3f}"
        )

    # Worked in full for the one pairing a reader would be most tempted to
    # believe, because that is where confusing the two intervals would do the
    # most damage.
    best = min(results, key=lambda result: result.clark_west_p)
    mean_low, mean_high = best.next_month_mean_interval
    obs_low, obs_high = best.next_month_interval
    lines += [
        "",
        f"Worked example: {best.pairing.sector} / {best.pairing.series_id}, "
        f"the lowest raw Clark-West p in the sweep.",
        f"  Slope {best.slope:.3f}, 95% confidence interval "
        f"[{best.slope_ci[0]:.3f}, {best.slope_ci[1]:.3f}] - an interval on an estimated average.",
        f"  Next month's point forecast {best.next_month_prediction:+.4f} log return.",
        f"  95% interval for the average return at this predictor value: "
        f"[{mean_low:+.4f}, {mean_high:+.4f}].",
        f"  95% prediction interval for next month itself: [{obs_low:+.4f}, {obs_high:+.4f}], "
        f"{(obs_high - obs_low) / (mean_high - mean_low):.0f}x wider.",
        "  The second is the one that bounds an outcome. The first bounds a parameter.",
    ]
    return "\n".join(lines)


if __name__ == "__main__":  # pragma: no cover
    print(report())
