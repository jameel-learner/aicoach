import { PAYMENT_METHODS } from '@aicoach/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '../lib/api';
import {
  cr,
  fmtDate,
  METHOD_LABEL,
  todayIso,
  type CreditRequestView,
  type RequestTo,
} from '../lib/credits';
import { Badge, Button, Card, ErrorText, Field, Input, Select, Table, Td } from './ui';

const STATUS: Record<CreditRequestView['status'], { text: string; tone?: 'good' | 'warn' }> = {
  pending: { text: 'Waiting for reply', tone: 'warn' },
  approved: { text: 'Accepted', tone: 'good' },
  rejected: { text: 'Rejected' },
  cancelled: { text: 'Cancelled' },
};

export function RequestStatus({ r }: { r: CreditRequestView }) {
  const s = STATUS[r.status];
  return (
    <div>
      <Badge tone={s.tone}>{s.text}</Badge>
      {r.status === 'approved' && r.grantedMicro != null && (
        <div className="text-sm">{cr(r.grantedMicro)} added</div>
      )}
      {r.decisionNote && <div className="text-sm text-muted">“{r.decisionNote}”</div>}
    </div>
  );
}

function useRefresh() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['credit-requests'] });
    void qc.invalidateQueries({ queryKey: ['wallet'] });
    void qc.invalidateQueries({ queryKey: ['credits'] });
    void qc.invalidateQueries({ queryKey: ['admin'] });
  };
}

/**
 * Requester side: ask the level above for credits. Requests that go to Admin (institution or
 * direct wallets) must include the payment UTR; Admin verifies it and the credits are issued.
 */
export function RequestCreditsCard({ walletId, to }: { walletId: string; to: RequestTo }) {
  const refresh = useRefresh();
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState('');
  const [utr, setUtr] = useState('');
  const [method, setMethod] = useState<(typeof PAYMENT_METHODS)[number]>('upi');
  const [paidOn, setPaidOn] = useState(todayIso());
  const [sent, setSent] = useState(false);
  const mine = useQuery({
    queryKey: ['credit-requests', 'mine'],
    queryFn: () => api<CreditRequestView[]>('/credits/requests?scope=mine'),
  });
  const send = useMutation({
    mutationFn: () =>
      api('/credits/requests', {
        method: 'POST',
        body: {
          walletId,
          credits: amount,
          message: message || undefined,
          payment: to?.toAdmin ? { reference: utr, method, paidOn } : undefined,
        },
      }),
    onSuccess: () => {
      setSent(true);
      setAmount('');
      setMessage('');
      setUtr('');
      refresh();
    },
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api(`/credits/requests/${id}/cancel`, { method: 'POST', body: {} }),
    onSuccess: refresh,
  });
  if (!to) return null;
  const history = (mine.data ?? []).filter((r) => r.wallet.id === walletId);
  const hasPending = history.some((r) => r.status === 'pending');

  return (
    <Card title={to.toAdmin ? 'Buy credits from AI Coach' : 'Need more credits?'}>
      {to.toAdmin ? (
        <p className="mb-3 text-sm text-muted">
          Pay AI Coach offline (UPI or bank transfer), then enter the amount and the UTR /
          transaction reference here. Admin checks the payment and adds the credits.
        </p>
      ) : (
        <p className="mb-3 text-sm text-muted">Your request goes to {to.label}.</p>
      )}
      {sent && <p className="mb-3 text-accent">Request sent. You'll see the reply below.</p>}
      {!hasPending && (
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            send.mutate();
          }}
        >
          <Field label={to.toAdmin ? 'Amount paid (₹)' : 'Amount (₹)'}>
            <Input
              inputMode="decimal"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          {to.toAdmin && (
            <>
              <Field label="UTR / transaction reference" hint="12-digit UPI UTR or bank reference">
                <Input required value={utr} onChange={(e) => setUtr(e.target.value)} />
              </Field>
              <Field label="Paid by">
                <Select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {METHOD_LABEL[m]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Paid on">
                <Input
                  type="date"
                  required
                  value={paidOn}
                  onChange={(e) => setPaidOn(e.target.value)}
                />
              </Field>
            </>
          )}
          <Field label="Message (optional)">
            <Input value={message} onChange={(e) => setMessage(e.target.value)} />
          </Field>
          <div className="flex items-end">
            <Button type="submit" disabled={send.isPending || !amount || (to.toAdmin && !utr)}>
              {to.toAdmin ? 'Submit payment' : 'Request credits'}
            </Button>
          </div>
        </form>
      )}
      <ErrorText error={send.error ? errorMessage(send.error) : null} />
      {history.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-2 font-semibold">Your requests</h3>
          <Table head={['When', 'Amount', 'Status', '']}>
            {history.map((r) => (
              <tr key={r.id}>
                <Td className="whitespace-nowrap">{fmtDate(r.createdAt)}</Td>
                <Td>
                  {cr(r.amountMicro)}
                  {r.payment && <div className="text-xs text-muted">UTR {r.payment.reference}</div>}
                </Td>
                <Td>
                  <RequestStatus r={r} />
                </Td>
                <Td>
                  {r.can.cancel && (
                    <Button
                      variant="secondary"
                      className="min-h-9 px-3 text-sm"
                      onClick={() => cancel.mutate(r.id)}
                    >
                      Cancel
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
          <ErrorText error={cancel.error ? errorMessage(cancel.error) : null} />
        </div>
      )}
    </Card>
  );
}

/**
 * Giver side: requests from the immediate downline (teacher/POC), or payments to verify (Admin).
 * `parentWalletId` limits the list to one wallet; `showHistory` also lists decided requests.
 */
export function RequestsInbox({
  title,
  parentWalletId,
  showHistory = false,
  hideWhenEmpty = false,
}: {
  title: string;
  parentWalletId?: string;
  showHistory?: boolean;
  hideWhenEmpty?: boolean;
}) {
  const refresh = useRefresh();
  const q = useQuery({
    queryKey: ['credit-requests', 'inbox'],
    queryFn: () => api<CreditRequestView[]>('/credits/requests?scope=inbox'),
  });
  const [amount, setAmount] = useState<Record<string, string>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approve' | 'reject' }) =>
      api(`/credits/requests/${id}/decide`, {
        method: 'POST',
        body: {
          decision,
          credits: decision === 'approve' && amount[id] ? amount[id] : undefined,
          note: note[id] || undefined,
        },
      }),
    onSuccess: refresh,
  });

  const all = (q.data ?? []).filter((r) => !parentWalletId || r.parentWalletId === parentWalletId);
  const items = showHistory ? all : all.filter((r) => r.status === 'pending');
  if (hideWhenEmpty && items.length === 0) return null;
  const isAdmin = items.some((r) => r.toAdmin);

  return (
    <Card title={title}>
      {isAdmin && (
        <p className="mb-3 text-sm text-muted">
          Check each UTR against the bank statement. <strong>Confirm</strong> marks the payment
          verified and issues the credits (change the amount if less was received).{' '}
          <strong>Reject</strong> needs a reason, which the payer sees.
        </p>
      )}
      <ErrorText error={q.error ? errorMessage(q.error) : null} />
      <Table
        head={['When', 'From', isAdmin ? 'Payment' : 'Asked for', 'Decision']}
        empty={items.length === 0}
      >
        {items.map((r) => (
          <tr key={r.id}>
            <Td className="whitespace-nowrap">{fmtDate(r.createdAt)}</Td>
            <Td>
              <div className="font-medium">{r.wallet.label}</div>
              <div className="text-xs text-muted">
                {r.requester.name} · {r.requester.email}
              </div>
              {r.message && <div className="text-sm text-muted">“{r.message}”</div>}
            </Td>
            <Td>
              <div className="font-semibold">{cr(r.amountMicro)}</div>
              {r.payment && (
                <div className="text-xs text-muted">
                  UTR <span className="font-mono">{r.payment.reference}</span>
                  <br />
                  {METHOD_LABEL[r.payment.method] ?? r.payment.method} · paid {r.payment.paidOn}
                </div>
              )}
            </Td>
            <Td>
              {r.can.decide ? (
                <div className="flex min-w-56 flex-col gap-2">
                  <Input
                    className="min-h-9"
                    inputMode="decimal"
                    placeholder={`Amount to give (default ${cr(r.amountMicro)})`}
                    aria-label={`Amount for ${r.wallet.label}`}
                    value={amount[r.id] ?? ''}
                    onChange={(e) => setAmount({ ...amount, [r.id]: e.target.value })}
                  />
                  <Input
                    className="min-h-9"
                    placeholder="Comment (required to reject)"
                    aria-label={`Comment for ${r.wallet.label}`}
                    value={note[r.id] ?? ''}
                    onChange={(e) => setNote({ ...note, [r.id]: e.target.value })}
                  />
                  <div className="flex gap-2">
                    <Button
                      className="min-h-9 px-3 text-sm"
                      disabled={decide.isPending}
                      onClick={() => decide.mutate({ id: r.id, decision: 'approve' })}
                    >
                      {r.toAdmin ? 'Confirm & issue' : 'Accept'}
                    </Button>
                    <Button
                      variant="danger"
                      className="min-h-9 px-3 text-sm"
                      disabled={decide.isPending || (note[r.id] ?? '').trim().length < 3}
                      onClick={() => decide.mutate({ id: r.id, decision: 'reject' })}
                    >
                      Reject
                    </Button>
                  </div>
                </div>
              ) : (
                <RequestStatus r={r} />
              )}
            </Td>
          </tr>
        ))}
      </Table>
      <ErrorText error={decide.error ? errorMessage(decide.error) : null} />
    </Card>
  );
}
