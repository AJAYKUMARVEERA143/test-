import { useCallback, useEffect, useState } from "react";
import { Loader2, Wallet } from "lucide-react";
import { getCostRollup } from "../../services/CreatorStudioApiClient.js";
import "./CreatorCostPanel.css";

function money(currency, amount) {
  return `${currency} ${Number(amount || 0).toFixed(2)}`;
}

/**
 * Estimate-vs-actual cost rollup, currency-separated. projectId omitted rolls
 * up the global (cross-project) scope — the scope every Phase D/E resource
 * lives in today (see CreatorAssetLibrary.jsx's design note on why).
 */
export default function CreatorCostPanel({ projectId = null, refreshKey = 0 }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const rollup = await getCostRollup({ projectId });
      setRows(rollup || []);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);

  const byCurrency = {};
  for (const row of rows) {
    const bucket = byCurrency[row.currency] || (byCurrency[row.currency] = { estimate: 0, actual: 0, calls: 0 });
    if (row.is_estimate) bucket.estimate += Number(row.total_cost || 0);
    else bucket.actual += Number(row.total_cost || 0);
    bucket.calls += Number(row.call_count || 0);
  }
  const currencies = Object.keys(byCurrency);

  return (
    <section className="creator-cost-panel" aria-label="Cost estimate vs actual">
      <header>
        <Wallet size={14} /> <span>Spend (estimate vs. actual)</span>
      </header>
      {error ? <div className="creator-cost-error">{error}</div> : null}
      {loading ? (
        <div className="creator-cost-loading"><Loader2 size={14} className="creator-cost-spin" /></div>
      ) : currencies.length === 0 ? (
        <p className="creator-cost-empty">No spend recorded yet.</p>
      ) : (
        <div className="creator-cost-grid">
          {currencies.map((currency) => (
            <article key={currency}>
              <b>{currency}</b>
              <div>
                <span>Estimate</span>
                <strong>{money(currency, byCurrency[currency].estimate)}</strong>
              </div>
              <div>
                <span>Actual</span>
                <strong>{money(currency, byCurrency[currency].actual)}</strong>
              </div>
              <small>{byCurrency[currency].calls} calls</small>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
