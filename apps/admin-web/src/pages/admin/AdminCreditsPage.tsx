import { PAYMENT_METHODS } from '@aicoach/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import {
  Badge,
  Button,
  Card,
  ErrorText,
  Field,
  Input,
  PageHeader,
  Select,
  Table,
  Td,
} from '../../components/ui';
import { RequestsInbox } from '../../components/CreditRequests';
import { api, errorMessage } from '../../lib/api';
import { cr, fmtDate, METHOD_LABEL, usd, type WalletSummary } from '../../lib/credits';

interface FloatView {
  feeBps: number;
  usdInrPaise: number;
  outstandingUserMicro: number;
  platformWalletMicro: number;
  requiredAtOpenRouterUsdNano: number;
  openRouter: { balanceUsdNano: number; totalUsdNano: number; usedUsdNano: number } | null;
  openRouterError: string | null;
  shortfallUsdNano: number | null;
  warning: boolean | null;
  lifetime: { rawUsdNano: number; billedMicro: number; feeRevenueMicro: number };
}
interface Payment {
  id: string;
  kind: string;
  payerType: string;
  institutionName: string | null;
  userEmail: string | null;
  amountMinor: number;
  currency: string;
  method: string;
  reference: string | null;
  paidOn: string;
  status: 'pending' | 'verified' | 'rejected';
  createdAt: string;
}
interface Institution {
  id: string;
  name: string;
}

const today = () => new Date().toISOString().slice(0, 10);
/** US$ (nano) with its rupee equivalent at the current rate: "$7.24 (≈ ₹637.12)". */
const usdInr = (nano: number, paise: number) =>
  `${usd(nano, 2)} (≈ ${cr(Math.round((nano * paise) / 100_000))})`;
const money = (minor: number, currency: string) =>
  `${currency === 'INR' ? '₹' : '$'}${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const KIND_LABEL: Record<string, string> = {
  credit_purchase: 'Credit purchase',
  onboarding_fee: 'Onboarding fee',
  platform_topup: 'Platform top-up (OpenRouter)',
};

export function AdminCreditsPage() {
  const qc = useQueryClient();
  const float = useQuery({
    queryKey: ['admin', 'float'],
    queryFn: () => api<FloatView>('/admin/credits/float'),
  });
  const payments = useQuery({
    queryKey: ['admin', 'payments'],
    queryFn: () => api<Payment[]>('/admin/credits/payments'),
  });
  const institutions = useQuery({
    queryKey: ['admin', 'institutions'],
    queryFn: () => api<Institution[]>('/admin/institutions'),
  });
  const topLevel = useQuery({
    queryKey: ['admin', 'top-level'],
    queryFn: () => api<WalletSummary[]>('/admin/credits/top-level'),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['admin'] });
    void qc.invalidateQueries({ queryKey: ['wallet'] });
  };

  // ---- Record payment
  const [pay, setPay] = useState({
    kind: 'credit_purchase',
    payerType: 'institution',
    institutionId: '',
    userEmail: '',
    amount: '',
    currency: 'INR',
    method: 'bank_transfer',
    reference: '',
    paidOn: today(),
  });
  const record = useMutation({
    mutationFn: () =>
      api<Payment>('/admin/credits/payments', {
        method: 'POST',
        body: {
          ...pay,
          institutionId: pay.payerType === 'institution' ? pay.institutionId : undefined,
          userEmail: pay.payerType === 'user' ? pay.userEmail : undefined,
          reference: pay.reference || undefined,
        },
      }),
    onSuccess: (p) => {
      refresh();
      if (p.kind !== 'onboarding_fee') {
        // Functional updates: these run after the request, so never spread stale render state.
        setIssue((s) => ({
          ...s,
          // 1 credit = ₹1: an INR credit purchase pre-fills the same amount
          credits: p.currency === 'INR' && p.kind === 'credit_purchase' ? pay.amount : '',
          paymentId: p.id,
          targetType: p.payerType as 'institution' | 'user' | 'platform',
          institutionId: pay.institutionId,
          email: pay.userEmail,
        }));
      }
      setPay((s) => ({ ...s, amount: '', reference: '' }));
    },
  });

  // ---- Issue credits
  const [issue, setIssue] = useState({
    targetType: 'institution' as 'institution' | 'user' | 'platform',
    institutionId: '',
    email: '',
    credits: '',
    paymentId: '',
    note: '',
  });
  const doIssue = useMutation({
    mutationFn: () =>
      api('/admin/credits/issue', {
        method: 'POST',
        body: {
          target:
            issue.targetType === 'institution'
              ? { type: 'institution', institutionId: issue.institutionId }
              : issue.targetType === 'user'
                ? { type: 'user', email: issue.email }
                : { type: 'platform' },
          credits: issue.credits,
          paymentId: issue.paymentId || undefined,
          note: issue.note || undefined,
        },
      }),
    onSuccess: () => {
      setIssue((s) => ({ ...s, credits: '', paymentId: '', note: '' }));
      refresh();
    },
  });

  // ---- Exchange rate
  const [rate, setRate] = useState('');
  const saveRate = useMutation({
    mutationFn: () => api('/admin/credits/rate', { method: 'PUT', body: { rate } }),
    onSuccess: () => {
      setRate('');
      refresh();
    },
  });

  // ---- Fee
  const [fee, setFee] = useState('');
  const saveFee = useMutation({
    mutationFn: () =>
      api('/admin/credits/fee', { method: 'PUT', body: { feeBps: Math.round(Number(fee) * 100) } }),
    onSuccess: () => {
      setFee('');
      refresh();
    },
  });

  const f = float.data;
  const onRecord = (e: FormEvent) => {
    e.preventDefault();
    record.mutate();
  };
  const onIssue = (e: FormEvent) => {
    e.preventDefault();
    doIssue.mutate();
  };

  return (
    <>
      <PageHeader
        title="Credits & payments"
        subtitle="Verify payments, issue credits, and check the OpenRouter balance can cover them. All amounts are in rupees except OpenRouter (US$)."
      />
      <div className="mb-6">
        <RequestsInbox title="Payments to verify" />
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Platform float">
          {float.error && <ErrorText error={errorMessage(float.error)} />}
          {f && (
            <div className="flex flex-col gap-2">
              {f.warning && (
                <p role="alert" className="rounded-lg border border-danger p-3 text-danger">
                  Top up OpenRouter: it's {usdInr(f.shortfallUsdNano ?? 0, f.usdInrPaise)} short of
                  what users' balances and the platform wallet could spend.
                </p>
              )}
              {f.warning === false && (
                <p className="text-accent">OpenRouter balance covers all outstanding balances.</p>
              )}
              {f.openRouterError && (
                <p className="text-warning">
                  Couldn't read the OpenRouter balance: {f.openRouterError}
                </p>
              )}
              <Table head={['', 'Amount']}>
                <tr>
                  <Td>OpenRouter balance</Td>
                  <Td className="font-semibold">
                    {f.openRouter ? usdInr(f.openRouter.balanceUsdNano, f.usdInrPaise) : '—'}
                  </Td>
                </tr>
                <tr>
                  <Td>Held by users (all wallets except platform)</Td>
                  <Td>{cr(f.outstandingUserMicro)}</Td>
                </tr>
                <tr>
                  <Td>Platform wallet (ingestion, admin use, at cost)</Td>
                  <Td>{cr(f.platformWalletMicro)}</Td>
                </tr>
                <tr>
                  <Td className="font-semibold">
                    Needed at OpenRouter (users ÷ {1 + f.feeBps / 10000}, all ÷ ₹
                    {(f.usdInrPaise / 100).toFixed(2)})
                  </Td>
                  <Td className="font-semibold">{usd(f.requiredAtOpenRouterUsdNano, 2)}</Td>
                </tr>
                <tr>
                  <Td>Lifetime: OpenRouter cost / charged / fee revenue</Td>
                  <Td>
                    {usd(f.lifetime.rawUsdNano, 4)} / {cr(f.lifetime.billedMicro)} /{' '}
                    {cr(f.lifetime.feeRevenueMicro)}
                  </Td>
                </tr>
              </Table>
            </div>
          )}
        </Card>

        <Card title="Fee and exchange rate (Admin only)">
          <p className="mb-3">
            Platform fee: <strong>{f ? f.feeBps / 100 : '…'}%</strong> on every AI charge (not on
            the platform's own use). Users never see the fee; they only see rupee amounts.
          </p>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              saveFee.mutate();
            }}
          >
            <Input
              inputMode="decimal"
              placeholder="e.g. 10"
              value={fee}
              onChange={(e) => setFee(e.target.value)}
              aria-label="New fee percent"
              className="w-32"
            />
            <Button type="submit" variant="secondary" disabled={!fee || saveFee.isPending}>
              Set fee %
            </Button>
          </form>
          <ErrorText error={saveFee.error ? errorMessage(saveFee.error) : null} />
          <p className="mb-3 mt-5">
            USD→INR rate: <strong>₹{f ? (f.usdInrPaise / 100).toFixed(2) : '…'} per US$</strong>.
            OpenRouter bills in dollars; each AI call is converted at this rate (stored per call).
            Set it at or a little above the market rate. Changes apply to new calls only.
          </p>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              saveRate.mutate();
            }}
          >
            <Input
              inputMode="decimal"
              placeholder="e.g. 88.50"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              aria-label="New USD to INR rate"
              className="w-32"
            />
            <Button type="submit" variant="secondary" disabled={!rate || saveRate.isPending}>
              Set rate
            </Button>
          </form>
          <ErrorText error={saveRate.error ? errorMessage(saveRate.error) : null} />
        </Card>

        <Card title="1. Record an offline payment">
          <form onSubmit={onRecord} className="grid gap-3 sm:grid-cols-2">
            <Field label="Type">
              <Select
                value={pay.kind}
                onChange={(e) =>
                  setPay({
                    ...pay,
                    kind: e.target.value,
                    payerType:
                      e.target.value === 'platform_topup'
                        ? 'platform'
                        : pay.payerType === 'platform'
                          ? 'institution'
                          : pay.payerType,
                  })
                }
              >
                {Object.entries(KIND_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            {pay.kind !== 'platform_topup' && (
              <Field label="Paid by">
                <Select
                  value={pay.payerType}
                  onChange={(e) => setPay({ ...pay, payerType: e.target.value })}
                >
                  <option value="institution">Institution</option>
                  <option value="user">Teacher / student (direct)</option>
                </Select>
              </Field>
            )}
            {pay.payerType === 'institution' && (
              <Field label="Institution">
                <Select
                  required
                  value={pay.institutionId}
                  onChange={(e) => setPay({ ...pay, institutionId: e.target.value })}
                >
                  <option value="">Choose…</option>
                  {institutions.data?.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {pay.payerType === 'user' && (
              <Field label="Payer's email">
                <Input
                  type="email"
                  required
                  value={pay.userEmail}
                  onChange={(e) => setPay({ ...pay, userEmail: e.target.value })}
                />
              </Field>
            )}
            <Field label="Amount paid">
              <div className="flex gap-2">
                <Select
                  value={pay.currency}
                  onChange={(e) => setPay({ ...pay, currency: e.target.value })}
                  aria-label="Currency"
                  className="w-24"
                >
                  <option value="INR">INR</option>
                  <option value="USD">USD</option>
                </Select>
                <Input
                  required
                  inputMode="decimal"
                  className="flex-1"
                  value={pay.amount}
                  onChange={(e) => setPay({ ...pay, amount: e.target.value })}
                  aria-label="Amount"
                />
              </div>
            </Field>
            <Field label="Method">
              <Select
                value={pay.method}
                onChange={(e) => setPay({ ...pay, method: e.target.value })}
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {METHOD_LABEL[m]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reference (UTR, cheque no.)">
              <Input
                value={pay.reference}
                onChange={(e) => setPay({ ...pay, reference: e.target.value })}
              />
            </Field>
            <Field label="Paid on">
              <Input
                type="date"
                required
                value={pay.paidOn}
                onChange={(e) => setPay({ ...pay, paidOn: e.target.value })}
              />
            </Field>
            <div className="sm:col-span-2">
              <ErrorText error={record.error ? errorMessage(record.error) : null} />
              <Button type="submit" disabled={record.isPending}>
                Record payment
              </Button>
              <p className="mt-2 text-sm text-muted">
                After recording a credit purchase or top-up, step 2 is pre-filled to issue the
                credits.
              </p>
            </div>
          </form>
        </Card>

        <Card title="2. Issue credits">
          <form onSubmit={onIssue} className="grid gap-3 sm:grid-cols-2">
            <Field label="To">
              <Select
                value={issue.targetType}
                onChange={(e) =>
                  setIssue({ ...issue, targetType: e.target.value as typeof issue.targetType })
                }
              >
                <option value="institution">Institution</option>
                <option value="user">Teacher / student (direct)</option>
                <option value="platform">Platform wallet (own use)</option>
              </Select>
            </Field>
            {issue.targetType === 'institution' && (
              <Field label="Institution">
                <Select
                  required
                  value={issue.institutionId}
                  onChange={(e) => setIssue({ ...issue, institutionId: e.target.value })}
                >
                  <option value="">Choose…</option>
                  {institutions.data?.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {issue.targetType === 'user' && (
              <Field label="Email">
                <Input
                  type="email"
                  required
                  value={issue.email}
                  onChange={(e) => setIssue({ ...issue, email: e.target.value })}
                />
              </Field>
            )}
            <Field label="Amount (₹)">
              <Input
                required
                inputMode="decimal"
                value={issue.credits}
                onChange={(e) => setIssue({ ...issue, credits: e.target.value })}
              />
            </Field>
            <Field label="For payment">
              <Select
                value={issue.paymentId}
                onChange={(e) => setIssue({ ...issue, paymentId: e.target.value })}
              >
                <option value="">(none)</option>
                {payments.data
                  ?.filter((p) => p.kind !== 'onboarding_fee' && p.status === 'verified')
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.paidOn} · {p.institutionName ?? p.userEmail ?? 'Platform'} ·{' '}
                      {money(p.amountMinor, p.currency)}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Note">
              <Input
                value={issue.note}
                onChange={(e) => setIssue({ ...issue, note: e.target.value })}
              />
            </Field>
            <div className="sm:col-span-2">
              <ErrorText error={doIssue.error ? errorMessage(doIssue.error) : null} />
              <Button type="submit" disabled={doIssue.isPending}>
                Issue credits
              </Button>
            </div>
          </form>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card title="Top-level wallets">
          <Table head={['Wallet', 'Available', 'Used 30 days']} empty={topLevel.data?.length === 0}>
            {topLevel.data?.map((w) => (
              <tr key={w.id}>
                <Td>
                  <Link
                    to="/credits/wallets/$walletId"
                    params={{ walletId: w.id }}
                    className="text-primary underline"
                  >
                    {w.label}
                  </Link>
                </Td>
                <Td>{cr(w.availableMicro)}</Td>
                <Td>{cr(w.consumed.last30dMicro)}</Td>
              </tr>
            ))}
          </Table>
          <p className="mt-2 text-sm text-muted">
            Open a wallet to drill down to any class or student.
          </p>
        </Card>
        <Card title="Payments">
          <Table
            head={['Paid on', 'Type', 'Payer', 'Amount', 'Ref', 'Status']}
            empty={payments.data?.length === 0}
          >
            {payments.data?.map((p) => (
              <tr key={p.id}>
                <Td className="whitespace-nowrap">{p.paidOn}</Td>
                <Td>
                  <Badge tone={p.kind === 'onboarding_fee' ? 'warn' : 'neutral'}>
                    {KIND_LABEL[p.kind]}
                  </Badge>
                </Td>
                <Td>{p.institutionName ?? p.userEmail ?? 'Platform'}</Td>
                <Td>{money(p.amountMinor, p.currency)}</Td>
                <Td>
                  {p.reference ?? '—'}
                  <div className="text-xs text-muted">
                    {METHOD_LABEL[p.method] ?? p.method} · recorded {fmtDate(p.createdAt)}
                  </div>
                </Td>
                <Td>
                  {p.status === 'pending' ? (
                    <Badge tone="warn">To verify</Badge>
                  ) : p.status === 'rejected' ? (
                    <Badge>Rejected</Badge>
                  ) : (
                    <Badge tone="good">Verified</Badge>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </>
  );
}
