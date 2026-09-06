from datetime import date, timedelta

import numpy as np
import pandas as pd
import pytest

from analysis.macro_forecast import (
    MIN_FORECASTS,
    Pairing,
    available_growth,
    build_panel,
    clark_west,
    estimated_release,
    evaluate,
    holm_adjusted,
    month_key,
    monthly_log_returns,
    out_of_sample_r2,
    rolling_origin_forecasts,
)


def month_starts(count: int, first: date = date(2000, 1, 1)) -> list[date]:
    return [date(first.year + (first.month - 1 + step) // 12,
                 (first.month - 1 + step) % 12 + 1, 1) for step in range(count)]


def synthetic(count: int, *, slope: float, seed: int, noise: float = 0.04):
    """A panel where the indicator's growth explains `slope` of next month.

    The returns are constructed month by month so the predictor genuinely leads
    the target, which is the only way to check that the pipeline can find a
    relationship when one is there.
    """
    generator = np.random.default_rng(seed)
    months = pd.period_range("2000-01", periods=count, freq="M")
    growth = pd.Series(generator.normal(0, 0.01, count), index=months)
    returns = pd.Series(
        slope * growth.shift(1).fillna(0.0).to_numpy() + generator.normal(0, noise, count),
        index=months,
    )
    return returns, growth


def test_a_reading_is_not_available_in_the_month_it_describes():
    # Industrial production for July is published in mid-August, so a forecaster
    # standing on 31 July has June's reading at best.
    assert estimated_release(date(2026, 7, 1), 48) == date(2026, 8, 18)
    growth = available_growth(
        [(date(2026, 5, 1), 100.0), (date(2026, 6, 1), 101.0), (date(2026, 7, 1), 102.0)],
        lag_days=48,
    )
    assert month_key(date(2026, 7, 15)) in growth.index
    # July's own growth only enters the August origin.
    assert growth.loc[pd.Period("2026-08", freq="M")] == pytest.approx(np.log(102 / 101))
    assert growth.loc[pd.Period("2026-07", freq="M")] == pytest.approx(np.log(101 / 100))


def test_a_reading_stays_the_newest_thing_known_until_the_next_one_lands():
    # A gap in the release calendar does not give the forecaster a blank month;
    # it gives them the same stale number again.
    growth = available_growth(
        [(date(2026, 1, 1), 100.0), (date(2026, 2, 1), 102.0), (date(2026, 8, 1), 104.0)],
        lag_days=40,
    )
    repeated = growth.loc[pd.Period("2026-03", freq="M"):pd.Period("2026-08", freq="M")]
    assert repeated.nunique() == 1
    assert repeated.iloc[0] == pytest.approx(np.log(102 / 100))


def test_the_target_is_the_month_after_the_predictor():
    returns = pd.Series([0.1, 0.2, 0.3], index=pd.period_range("2000-01", periods=3, freq="M"))
    growth = pd.Series([1.0, 2.0, 3.0], index=pd.period_range("2000-01", periods=3, freq="M"))
    panel = build_panel(returns, growth)
    assert list(panel.index.astype(str)) == ["2000-01", "2000-02"]
    assert list(panel["x"]) == [1.0, 2.0]
    assert list(panel["target"]) == [0.2, 0.3]


def test_a_forecast_does_not_move_when_the_future_is_rewritten():
    # The sharpest check there is on look-ahead: replace everything after an
    # origin with nonsense. A forecast that used the future would change.
    returns, growth = synthetic(200, slope=3.0, seed=7)
    panel = build_panel(returns, growth)
    honest = rolling_origin_forecasts(panel, min_train=60)

    corrupted = panel.copy()
    corrupted.iloc[120:, :] = corrupted.iloc[120:, :] * 100 + 5
    tampered = rolling_origin_forecasts(corrupted, min_train=60)

    shared = honest.index[:60]
    pd.testing.assert_frame_equal(honest.loc[shared], tampered.loc[shared])


def test_the_backtest_finds_a_relationship_that_is_really_there():
    # Positive control. A negative result from a pipeline that cannot detect a
    # planted signal says nothing about the data.
    returns, growth = synthetic(260, slope=6.0, seed=11, noise=0.02)
    forecasts = rolling_origin_forecasts(build_panel(returns, growth), min_train=120)
    statistic, p_value = clark_west(forecasts)
    assert out_of_sample_r2(forecasts) > 0.05
    assert statistic > 0
    assert p_value < 0.01


def test_the_backtest_does_not_find_a_relationship_that_is_not_there():
    # The other half of the control, on a fixed seed: an indicator with no link
    # to the returns must not clear the benchmark.
    returns, growth = synthetic(260, slope=0.0, seed=11, noise=0.02)
    forecasts = rolling_origin_forecasts(build_panel(returns, growth), min_train=120)
    assert out_of_sample_r2(forecasts) < 0
    assert clark_west(forecasts)[1] > 0.05


def test_out_of_sample_r2_is_negative_when_the_model_loses():
    forecasts = pd.DataFrame({"actual": [1.0, 2.0, 3.0], "model": [0.0, 0.0, 0.0],
                              "benchmark": [1.0, 2.0, 2.5]})
    assert out_of_sample_r2(forecasts) < 0


def test_holm_adjusts_for_the_size_of_the_sweep():
    results = [_result_with(p) for p in (0.01, 0.20, 0.60, 0.90)]
    adjusted = holm_adjusted(results)
    assert adjusted[0] == pytest.approx(0.04)
    assert all(after >= before for before, after in zip((0.01, 0.20, 0.60, 0.90), adjusted))


def test_a_prediction_interval_is_wider_than_the_interval_on_the_slope():
    # A confidence interval bounds an average; a prediction interval bounds one
    # future month and carries the residual spread as well. Quoting the first
    # where the second belongs understates next month's uncertainty.
    returns, growth = synthetic(200, slope=3.0, seed=5)
    result = evaluate(_pairing(), returns, growth, min_train=120)
    assert result is not None
    mean_low, mean_high = result.next_month_mean_interval
    obs_low, obs_high = result.next_month_interval
    assert obs_low < mean_low and mean_high < obs_high
    assert (obs_high - obs_low) > 5 * (mean_high - mean_low)


def test_a_short_history_is_not_judged():
    returns, growth = synthetic(120 + MIN_FORECASTS - 1, slope=3.0, seed=3)
    assert evaluate(_pairing(), returns, growth, min_train=120) is None


def test_monthly_returns_use_the_last_close_of_each_month():
    prices = [(date(2000, 1, 5), 100.0), (date(2000, 1, 31), 110.0), (date(2000, 2, 29), 121.0)]
    returns = monthly_log_returns(prices)
    assert list(returns.index.astype(str)) == ["2000-02"]
    assert returns.iloc[0] == pytest.approx(np.log(121 / 110))


def _pairing() -> Pairing:
    return Pairing(sector="test", etf="TEST", series_id="TESTSERIES", label="Test", lag_days=48)


def _result_with(p_value: float):
    class Stub:
        clark_west_p = p_value

    return Stub()
