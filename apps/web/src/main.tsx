import { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
type Attempt = {
  id: number;
  order_id: string;
  attempt_number: number;
  status: string;
  current_order_state: string;
  started_at: number;
  finished_at: number | null;
  hubspot_contact_id: string | null;
  hubspot_deal_id: string | null;
  error_code: string | null;
  error_message: string | null;
};
function App() {
  const [token, setToken] = useState(''),
    [activeToken, setActiveToken] = useState(''),
    [rows, setRows] = useState<Attempt[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!activeToken) return;
    setLoading(true);
    try {
      const r = await fetch('/api/sync-attempts?limit=50', {
        headers: { Authorization: 'Bearer ' + activeToken },
      });
      if (!r.ok)
        throw Error(
          r.status === 401
            ? 'Admin token was rejected.'
            : 'Unable to load attempts.',
        );
      setRows(await r.json());
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to connect');
    } finally {
      setLoading(false);
    }
  }, [activeToken]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [refresh]);
  async function retry(id: string) {
    setBusy(id);
    try {
      const r = await fetch(`/api/orders/${encodeURIComponent(id)}/retry`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + activeToken },
      });
      if (!r.ok)
        throw Error(
          r.status === 409
            ? 'Order is already queued or no longer failed.'
            : 'Retry failed.',
        );
      setRows((current) =>
        current.map((a) =>
          a.order_id === id ? { ...a, current_order_state: 'queued' } : a,
        ),
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Retry failed.');
    } finally {
      setBusy(null);
    }
  }
  return (
    <main>
      <header>
        <p className="eyebrow">OPTIMA SOLUTIONS / OPERATIONS</p>
        <h1>Order sync attempts</h1>
        <p>
          Newest 50 processing attempts. Automatically refreshes every four
          seconds.
        </p>
      </header>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setActiveToken(token);
        }}
      >
        <label htmlFor="token">Development admin token</label>
        <div className="access">
          <input
            id="token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
          />
          <button>Connect</button>
          <button
            type="button"
            disabled={!activeToken || loading}
            onClick={() => void refresh()}
          >
            Refresh
          </button>
          {activeToken && (
            <button
              type="button"
              onClick={() => {
                setActiveToken('');
                setToken('');
                setRows([]);
                setError('');
              }}
            >
              Disconnect
            </button>
          )}
        </div>
        <small>
          Kept in memory for this page only. Use DASHBOARD_ADMIN_TOKEN from your
          local .env.
        </small>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <p role="status">
        {loading
          ? 'Refreshing…'
          : !activeToken
            ? 'Connect to view attempts.'
            : rows.length === 0
              ? 'No attempts yet. Send a signed webhook to begin.'
              : `${rows.length} recent attempts`}
      </p>
      {rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <caption>Persistent attempt history</caption>
            <thead>
              <tr>
                {[
                  'Order / attempt',
                  'Started / finished',
                  'Attempt status',
                  'Current order',
                  'Contact',
                  'Deal',
                  'Error',
                  'Action',
                ].map((s) => (
                  <th key={s} scope="col">
                    {s}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td>
                    {a.order_id}
                    <small>Attempt {a.attempt_number}</small>
                  </td>
                  <td>
                    <time>{new Date(a.started_at).toLocaleString()}</time>
                    <small>
                      {a.finished_at
                        ? new Date(a.finished_at).toLocaleString()
                        : 'In progress'}
                    </small>
                  </td>
                  <td className={a.status}>{a.status}</td>
                  <td>{a.current_order_state}</td>
                  <td>{a.hubspot_contact_id ?? '—'}</td>
                  <td>{a.hubspot_deal_id ?? '—'}</td>
                  <td>
                    {a.error_code && <strong>{a.error_code}</strong>}
                    <small>{a.error_message ?? '—'}</small>
                  </td>
                  <td>
                    {a.current_order_state === 'failed' ? (
                      <button
                        disabled={busy === a.order_id}
                        onClick={() => void retry(a.order_id)}
                      >
                        {busy === a.order_id ? 'Queuing…' : 'Retry'}
                      </button>
                    ) : a.current_order_state === 'queued' ||
                      a.current_order_state === 'processing' ? (
                      <button disabled>{a.current_order_state}</button>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
