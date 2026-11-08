import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { formatRupees } from '@aicoach/core';
import { RequestCreditsCard, RequestsInbox } from '../../components/CreditRequests';
import { Badge, Button, Card, ErrorText, Input, PageHeader, Table, Td } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import {
  cr,
  usd,
  fmtDate,
  OWNER_LABEL,
  type AllotmentView,
  type WalletDetail,
  type WalletSummary,
} from '../../lib/credits';

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl bg-surface-muted p-4">
      <p className="text-sm text-muted">{label}</p>
      <p className="text-2xl font-bold">{value}</p>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

/** One page for every role; the API decides what this viewer may see and do. */
export function WalletPage() {
  const { walletId } = useParams({ strict: false }) as { walletId: string };
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['wallet', walletId],
    queryFn: () => api<WalletDetail>(`/credits/wallets/${walletId}`),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['wallet'] });
    void qc.invalidateQueries({ queryKey: ['credits'] });
  };

  if (q.error) return <ErrorText error={errorMessage(q.error)} />;
  if (!q.data) return <p className="text-muted">Loading…</p>;
  const {
    wallet: w,
    parent,
    children,
    allotments,
    breakdown,
    recentUsage,
    can,
    requestTo,
  } = q.data;

  return (
    <>
      <div className="mb-2 text-sm">
        <Link to="/credits" className="text-primary underline">
          Credits
        </Link>
        {parent && (
          <>
            {' / '}
            <Link
              to="/credits/wallets/$walletId"
              params={{ walletId: parent.id }}
              className="text-primary underline"
            >
              {parent.label}
            </Link>
          </>
        )}
      </div>
      <PageHeader title={w.label} subtitle={`${OWNER_LABEL[w.ownerType]} wallet`} />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Available"
          value={cr(w.availableMicro)}
          hint={w.heldMicro ? `${cr(w.heldMicro)} reserved for requests in progress` : undefined}
        />
        <Stat
          label="Used (24 h)"
          value={cr(w.consumed.last24hMicro)}
          hint="including everything below this wallet"
        />
        <Stat label="Used (30 days)" value={cr(w.consumed.last30dMicro)} />
        <Stat
          label="Used (all time)"
          value={cr(w.consumed.totalMicro)}
          hint={`${w.consumed.calls} AI requests`}
        />
      </div>
      {w.dailyCapMicro != null && (
        <p className="mb-4 text-sm text-muted">Daily limit: {cr(w.dailyCapMicro)}</p>
      )}

      <div className="flex flex-col gap-6">
        {children.length > 0 && (
          <ChildrenCard
            parentId={w.id}
            items={children}
            allot={can.allotToChildren}
            onDone={refresh}
          />
        )}

        {can.manage && w.ownerType !== 'user' && w.ownerType !== 'platform' && (
          <RequestsInbox
            title="Credit requests from your downline"
            parentWalletId={w.id}
            showHistory
            hideWhenEmpty
          />
        )}

        <AllotmentsCard items={allotments} onDone={refresh} />

        {requestTo && <RequestCreditsCard walletId={w.id} to={requestTo} />}

        {(breakdown.byTask.length > 0 || recentUsage.length > 0) && (
          <Card title="Usage (last 30 days)">
            <div className="grid gap-6 lg:grid-cols-2">
              <Table
                head={['By feature', 'Requests', 'Amount']}
                empty={breakdown.byTask.length === 0}
              >
                {breakdown.byTask.map((r) => (
                  <tr key={r.key}>
                    <Td>{r.key}</Td>
                    <Td>{r.calls}</Td>
                    <Td>{cr(r.billed)}</Td>
                  </tr>
                ))}
              </Table>
              {breakdown.byModel && (
                <Table
                  head={['By model (Admin)', 'Requests', 'OpenRouter cost', 'Charged']}
                  empty={breakdown.byModel.length === 0}
                >
                  {breakdown.byModel.map((r) => (
                    <tr key={r.key}>
                      <Td>{r.key}</Td>
                      <Td>{r.calls}</Td>
                      <Td>{usd(r.raw)}</Td>
                      <Td>{cr(r.billed)}</Td>
                    </tr>
                  ))}
                </Table>
              )}
            </div>
            {recentUsage.length > 0 && (
              <div className="mt-6">
                <h3 className="mb-2 font-semibold">Recent requests charged to this wallet</h3>
                <Table
                  head={[
                    'When',
                    'Who',
                    'Feature',
                    ...(recentUsage[0]?.model !== null ? ['Model'] : []),
                    'Tokens',
                    'Charged',
                    'Status',
                  ]}
                >
                  {recentUsage.map((u) => (
                    <tr key={u.id}>
                      <Td className="whitespace-nowrap">{fmtDate(u.createdAt)}</Td>
                      <Td>{u.userName ?? '—'}</Td>
                      <Td>{u.task}</Td>
                      {u.model !== null && <Td>{u.model}</Td>}
                      <Td>
                        {u.promptTokens ?? '—'} / {u.completionTokens ?? '—'}
                      </Td>
                      <Td>
                        {cr(u.billedMicro)}
                        {u.cacheStatus === 'hit' ? ' (cached)' : ''}
                      </Td>
                      <Td>
                        {u.status === 'ok' ? (
                          <Badge tone="good">ok</Badge>
                        ) : (
                          <Badge tone="warn">failed, not charged</Badge>
                        )}
                      </Td>
                    </tr>
                  ))}
                </Table>
              </div>
            )}
          </Card>
        )}
      </div>
    </>
  );
}

function ChildrenCard({
  parentId,
  items,
  allot,
  onDone,
}: {
  parentId: string;
  items: WalletSummary[];
  allot: boolean;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState<Record<string, string>>({});
  const [cap, setCap] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const give = useMutation({
    mutationFn: (to: string) =>
      api('/credits/allotments', {
        method: 'POST',
        body: { fromWalletId: parentId, toWalletId: to, credits: amount[to] ?? '' },
      }),
    onSuccess: (_d, to) => {
      setAmount({ ...amount, [to]: '' });
      setError(null);
      onDone();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const setDailyCap = useMutation({
    mutationFn: (id: string) =>
      api(`/credits/wallets/${id}/daily-cap`, {
        method: 'PUT',
        body: { credits: cap[id] ? cap[id] : null },
      }),
    onSuccess: () => {
      setError(null);
      onDone();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <Card title="Your downline">
      <Table
        head={[
          'Name',
          'Available',
          'Used 30 days',
          'Daily limit',
          ...(allot ? ['Give credits'] : []),
        ]}
      >
        {items.map((c) => (
          <tr key={c.id}>
            <Td className="font-medium">
              <Link
                to="/credits/wallets/$walletId"
                params={{ walletId: c.id }}
                className="text-primary underline"
              >
                {c.label}
              </Link>
              <div className="text-xs text-muted">{OWNER_LABEL[c.ownerType]}</div>
            </Td>
            <Td>{cr(c.availableMicro)}</Td>
            <Td>{cr(c.consumed.last30dMicro)}</Td>
            <Td>
              {allot ? (
                <form
                  className="flex gap-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    setDailyCap.mutate(c.id);
                  }}
                >
                  <Input
                    className="min-h-9 w-20"
                    placeholder={c.dailyCapMicro != null ? cr(c.dailyCapMicro) : 'none'}
                    value={cap[c.id] ?? ''}
                    onChange={(e) => setCap({ ...cap, [c.id]: e.target.value })}
                    aria-label={`Daily limit for ${c.label}`}
                  />
                  <Button type="submit" variant="secondary" className="min-h-9 px-2 text-sm">
                    Set
                  </Button>
                </form>
              ) : c.dailyCapMicro != null ? (
                cr(c.dailyCapMicro)
              ) : (
                'none'
              )}
            </Td>
            {allot && (
              <Td>
                <form
                  className="flex gap-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    give.mutate(c.id);
                  }}
                >
                  <Input
                    className="min-h-9 w-24"
                    inputMode="decimal"
                    placeholder="₹"
                    value={amount[c.id] ?? ''}
                    onChange={(e) => setAmount({ ...amount, [c.id]: e.target.value })}
                    aria-label={`Amount for ${c.label}`}
                  />
                  <Button
                    type="submit"
                    className="min-h-9 px-3 text-sm"
                    disabled={give.isPending || !amount[c.id]}
                  >
                    Give
                  </Button>
                </form>
              </Td>
            )}
          </tr>
        ))}
      </Table>
      <ErrorText error={error} />
      {allot && (
        <p className="mt-3 text-sm text-muted">
          Leave the daily limit empty and press Set to remove it.
        </p>
      )}
    </Card>
  );
}

function AllotmentsCard({ items, onDone }: { items: AllotmentView[]; onDone: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [newAmount, setNewAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'acknowledge' | 'lock' }) =>
      api(`/credits/allotments/${id}/${action}`, { method: 'POST', body: {} }),
    onSuccess: () => {
      setError(null);
      onDone();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const edit = useMutation({
    mutationFn: (id: string) =>
      api(`/credits/allotments/${id}`, { method: 'PATCH', body: { credits: newAmount, reason } }),
    onSuccess: () => {
      setEditing(null);
      setNewAmount('');
      setReason('');
      setError(null);
      onDone();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <Card title="Allotments">
      <p className="mb-3 text-sm text-muted">
        Credits can be used as soon as they arrive. The receiver confirms the amount is right, then
        the giver locks it. Until it's locked, the giver can correct the amount (e.g. a typo); a
        correction needs a fresh confirmation.
      </p>
      <Table head={['When', 'From → To', 'Amount', 'Status', '']} empty={items.length === 0}>
        {items.map((a) => (
          <tr key={a.id}>
            <Td className="whitespace-nowrap">{fmtDate(a.createdAt)}</Td>
            <Td>
              {a.from.label} → {a.to.label}
              {a.note && <div className="text-xs text-muted">{a.note}</div>}
              {a.edits.map((e, i) => (
                <div key={i} className="text-xs text-muted">
                  Corrected {cr(e.oldAmountMicro)} → {cr(e.newAmountMicro)} ({e.reason}) on{' '}
                  {fmtDate(e.at)}
                </div>
              ))}
            </Td>
            <Td className="font-semibold">
              {a.direction === 'in' ? '+' : '−'}
              {cr(a.amountMicro)}
            </Td>
            <Td>
              {a.status === 'locked' ? (
                <Badge tone="good">Locked</Badge>
              ) : a.acknowledgedAt ? (
                <Badge>Confirmed by receiver</Badge>
              ) : (
                <Badge tone="warn">Waiting for receiver</Badge>
              )}
            </Td>
            <Td className="whitespace-nowrap">
              <div className="flex flex-wrap gap-2">
                {a.can.acknowledge && (
                  <Button
                    className="min-h-9 px-3 text-sm"
                    onClick={() => act.mutate({ id: a.id, action: 'acknowledge' })}
                  >
                    Confirm received
                  </Button>
                )}
                {a.can.lock && (
                  <Button
                    variant="secondary"
                    className="min-h-9 px-3 text-sm"
                    onClick={() => act.mutate({ id: a.id, action: 'lock' })}
                  >
                    Lock
                  </Button>
                )}
                {a.can.edit && editing !== a.id && (
                  <Button
                    variant="secondary"
                    className="min-h-9 px-3 text-sm"
                    onClick={() => {
                      setEditing(a.id);
                      setNewAmount(formatRupees(a.amountMicro, 6, 0).replace(/,/g, ''));
                    }}
                  >
                    Correct
                  </Button>
                )}
              </div>
              {editing === a.id && (
                <form
                  className="mt-2 flex flex-col gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    edit.mutate(a.id);
                  }}
                >
                  <Input
                    className="min-h-9"
                    inputMode="decimal"
                    value={newAmount}
                    onChange={(e) => setNewAmount(e.target.value)}
                    aria-label="Corrected amount"
                  />
                  <Input
                    className="min-h-9"
                    placeholder="Reason (e.g. typo)"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    aria-label="Reason"
                  />
                  <div className="flex gap-2">
                    <Button
                      type="submit"
                      className="min-h-9 px-3 text-sm"
                      disabled={edit.isPending}
                    >
                      Save
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      className="min-h-9 px-3 text-sm"
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              )}
            </Td>
          </tr>
        ))}
      </Table>
      <ErrorText error={error} />
    </Card>
  );
}
